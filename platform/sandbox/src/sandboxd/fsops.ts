// Read-side workspace operations, run by sandboxd as root. Every open uses O_NOFOLLOW and is re-verified through
// /proc/self/fd, so a symlink swapped into a path component can never expose a file outside the root.
import { createHash } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { posix } from "node:path";
import type { FileEntry, SandboxOutputFile, SandboxOutputsManifest } from "@managed-copilot/protocol";
import { isWithin, joinWorkspace, PathError } from "../shared/paths.js";

function fsError(error: unknown, path: string): PathError {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return new PathError("not_found", `"${path}" does not exist.`);
  if (code === "ELOOP") return new PathError("forbidden", `"${path}" is a symbolic link; links are not followed.`);
  if (code === "EACCES" || code === "EPERM") return new PathError("forbidden", `"${path}" is not readable.`);
  if (code === "EISDIR") return new PathError("invalid_request", `"${path}" is a directory.`);
  return new PathError("invalid_request", `"${path}" cannot be read (${code ?? "error"}).`);
}

async function realPathOf(handle: FileHandle, fallback: string): Promise<string> {
  try {
    return (await fs.readlink(`/proc/self/fd/${handle.fd}`)).replace(/ \(deleted\)$/, "");
  } catch {
    return fs.realpath(fallback);
  }
}

export interface OpenedFile {
  readonly handle: FileHandle;
  readonly stat: Stats;
}

/** Opens a regular file under `root` for reading, refusing symlinks, special files, and escapes. */
export async function openRegularFile(root: string, relative: string): Promise<OpenedFile> {
  const absolute = joinWorkspace(root, relative);
  let handle: FileHandle;
  try {
    handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch (error) {
    throw fsError(error, relative);
  }
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) throw new PathError("invalid_request", `"${relative}" is a directory; list it instead.`);
    if (!stat.isFile()) throw new PathError("invalid_request", `"${relative}" is not a regular file.`);
    const real = await realPathOf(handle, absolute);
    if (!isWithin(await fs.realpath(root), real)) throw new PathError("forbidden", `"${relative}" resolves outside ${root}.`);
    return { handle, stat };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function entryFor(relative: string, stat: Stats): FileEntry {
  return { path: relative, type: stat.isDirectory() ? "directory" : "file", size: stat.isDirectory() ? 0 : stat.size, modifiedAt: stat.mtime.toISOString() };
}

/**
 * Lists a workspace directory (or describes one file). Symbolic links and special files are omitted; directories
 * are not followed through links. Recursive listings fail rather than truncate when they exceed `limit`.
 */
export async function listEntries(root: string, relative: string, options: { recursive?: boolean; limit: number }): Promise<FileEntry[]> {
  const absolute = joinWorkspace(root, relative);
  const rootReal = await fs.realpath(root);
  let real: string;
  try {
    real = await fs.realpath(absolute);
  } catch (error) {
    throw fsError(error, relative || ".");
  }
  if (!isWithin(rootReal, real)) throw new PathError("forbidden", `"${relative}" resolves outside ${root}.`);
  const top = await fs.lstat(real);
  if (top.isFile()) return [entryFor(relative, top)];
  if (!top.isDirectory()) throw new PathError("invalid_request", `"${relative}" is not a file or directory.`);

  const entries: FileEntry[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let names;
    try {
      names = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw fsError(error, prefix || ".");
    }
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of names) {
      if (!dirent.isFile() && !dirent.isDirectory()) continue;
      const childRelative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      const childAbsolute = posix.join(directory, dirent.name);
      let stat: Stats;
      try {
        stat = await fs.lstat(childAbsolute);
      } catch {
        continue;
      }
      if (!stat.isFile() && !stat.isDirectory()) continue;
      if (entries.length >= options.limit) {
        throw new PathError("invalid_request", `More than ${options.limit} entries under "${relative || "."}"; list a narrower path.`);
      }
      entries.push(entryFor(childRelative, stat));
      if (options.recursive && stat.isDirectory()) await walk(childAbsolute, childRelative);
    }
  };
  await walk(real, relative);
  return entries;
}

export interface ManifestLimits {
  readonly count: number;
  readonly fileBytes: number;
  readonly totalBytes: number;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

/** Hashes one opened file, failing if it changes while being read. */
async function hashStable(opened: OpenedFile): Promise<{ sha256: string; size: number } | { changed: true }> {
  const hash = createHash("sha256");
  let size = 0;
  const stream = opened.handle.createReadStream({ autoClose: false, start: 0 });
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  const after = await opened.handle.stat();
  const before = opened.stat;
  if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) return { changed: true };
  return { sha256: hash.digest("hex"), size };
}

/**
 * Describes the publishable files under `outputsRoot` (spec section 6): bounded regular files, each hashed while
 * checking it did not change. Symlinks, special files, changing files, and anything over the limits are rejected
 * with a reason rather than silently skipped.
 */
export async function outputsManifest(outputsRoot: string, limits: ManifestLimits): Promise<SandboxOutputsManifest> {
  let top: Stats;
  try {
    top = await fs.lstat(outputsRoot);
  } catch {
    return { files: [], rejected: [] };
  }
  if (top.isSymbolicLink()) return { files: [], rejected: [{ path: ".", reason: "outputs is a symbolic link" }] };
  if (!top.isDirectory()) return { files: [], rejected: [{ path: ".", reason: "outputs is not a directory" }] };

  const files: SandboxOutputFile[] = [];
  const rejected: { path: string; reason: string }[] = [];
  let total = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const names = await fs.readdir(directory, { withFileTypes: true });
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of names) {
      const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      const absolute = posix.join(directory, dirent.name);
      if (dirent.isSymbolicLink()) {
        rejected.push({ path: relative, reason: "symbolic link" });
        continue;
      }
      if (dirent.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (!dirent.isFile()) {
        rejected.push({ path: relative, reason: "not a regular file" });
        continue;
      }
      if (files.length >= limits.count) {
        rejected.push({ path: relative, reason: `more than ${limits.count} files` });
        continue;
      }
      let opened: OpenedFile;
      try {
        opened = await openRegularFile(outputsRoot, relative);
      } catch (error) {
        rejected.push({ path: relative, reason: (error as Error).message });
        continue;
      }
      try {
        if (opened.stat.size > limits.fileBytes) {
          rejected.push({ path: relative, reason: `larger than ${formatBytes(limits.fileBytes)}` });
          continue;
        }
        if (total + opened.stat.size > limits.totalBytes) {
          rejected.push({ path: relative, reason: `outputs exceed ${formatBytes(limits.totalBytes)} in total` });
          continue;
        }
        const result = await hashStable(opened);
        if ("changed" in result) {
          rejected.push({ path: relative, reason: "changed while being published" });
          continue;
        }
        total += result.size;
        files.push({ path: relative, size: result.size, sha256: result.sha256, modifiedAt: opened.stat.mtime.toISOString() });
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
    }
  };
  await walk(outputsRoot, "");
  return { files, rejected };
}
