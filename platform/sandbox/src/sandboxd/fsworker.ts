// Workspace file operations, executed in a short-lived process running as the sandbox's workload identity (uid 10001),
// so no operation can reach anything the workload itself could not. Paths are walked one segment at a time with
// `chdir`, refusing symbolic links and verifying the real working directory after every step; the final component is
// opened relative to that verified directory with O_NOFOLLOW. A symlink swapped in at any moment therefore cannot
// redirect an operation outside the root.
//
//   node fsworker.js write <scope> <relative> <overwrite 0|1> <maxBytes> [expectedBytes]   (content on stdin)
//   node fsworker.js mkdir <scope> <relative>
//   node fsworker.js read <scope> <relative>          → one JSON header line, then the bytes
//   node fsworker.js list <scope> <relative> <recursive 0|1> <limit>
//   node fsworker.js manifest <scope> <count> <fileBytes> <totalBytes>
// where <scope> is `workspace` (/workspace) or `outputs` (/workspace/outputs).
//
// Prints results on stdout; on failure prints {"code","message"} on stderr and exits with status 2.
import { createHash, randomBytes } from "node:crypto";
import { constants, promises as fs, lstatSync, mkdirSync, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { posix } from "node:path";
import { normalizeWorkspacePath, PathError } from "../shared/paths.js";

/** The workspace mount; every operation starts here. */
const BASE = "/workspace";
/** Scopes map to a fixed prefix under the base: the workspace itself, or `outputs/` for artifact publication. */
const SCOPES: Record<string, { readonly prefix: readonly string[]; readonly root: string }> = {
  workspace: { prefix: [], root: "/workspace" },
  outputs: { prefix: ["outputs"], root: "/workspace/outputs" },
};

let tempName: string | undefined;

function fail(code: string, message: string): never {
  process.stderr.write(`${JSON.stringify({ code, message })}\n`);
  process.exit(2);
}

process.on("SIGTERM", () => {
  void (tempName ? fs.unlink(tempName).catch(() => undefined) : Promise.resolve()).finally(() => process.exit(3));
});

function segmentsOf(relative: string): string[] {
  return relative ? relative.split("/") : [];
}

/**
 * Enters `base/segments…` (optionally creating directories), refusing symlinks. After every `chdir` the real working
 * directory must be exactly the verified parent plus that segment, so a component swapped for a link at any moment is
 * detected. `base` is the /workspace mount, which the workload cannot replace.
 */
function enter(base: string, segments: readonly string[], create: boolean, display: string): string {
  process.chdir(base);
  let current = process.cwd();
  for (const segment of segments) {
    let stat: Stats;
    try {
      stat = lstatSync(segment);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) throw new PathError("not_found", `"${display}" does not exist.`);
      try {
        mkdirSync(segment, { mode: 0o755 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      stat = lstatSync(segment);
    }
    if (stat.isSymbolicLink()) throw new PathError("forbidden", `"${display}" goes through a symbolic link; links are not followed.`);
    if (!stat.isDirectory()) throw new PathError(create ? "invalid_request" : "not_found", `A parent of "${display}" is not a directory.`);
    process.chdir(segment);
    const next = process.cwd();
    if (next !== posix.join(current, segment)) throw new PathError("forbidden", `"${display}" changed while it was being opened.`);
    current = next;
  }
  return current;
}

/** Opens a regular file in the current (verified) directory without following links. */
async function openHere(name: string, display: string): Promise<{ handle: FileHandle; stat: Stats }> {
  let handle: FileHandle;
  try {
    handle = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new PathError("not_found", `"${display}" does not exist.`);
    if (code === "ELOOP") throw new PathError("forbidden", `"${display}" is a symbolic link; links are not followed.`);
    if (code === "EACCES" || code === "EPERM") throw new PathError("forbidden", `"${display}" is not readable.`);
    throw error;
  }
  const stat = await handle.stat();
  if (stat.isDirectory()) {
    await handle.close();
    throw new PathError("invalid_request", `"${display}" is a directory; list it instead.`);
  }
  if (!stat.isFile()) {
    await handle.close();
    throw new PathError("invalid_request", `"${display}" is not a regular file.`);
  }
  return { handle, stat };
}

function splitParent(relative: string): { parent: string[]; name: string } {
  const segments = segmentsOf(relative);
  const name = segments.pop();
  if (!name) throw new PathError("invalid_request", "A file path is required, not the workspace root.");
  return { parent: segments, name };
}

type Scope = { readonly prefix: readonly string[]; readonly root: string };

async function write(scope: Scope, relative: string, overwrite: boolean, maxBytes: number, expected: number | undefined): Promise<void> {
  const { parent, name } = splitParent(relative);
  enter(BASE, [...scope.prefix, ...parent], true, relative);
  try {
    const existing = lstatSync(name);
    if (existing.isSymbolicLink()) throw new PathError("forbidden", `"${relative}" is a symbolic link; refusing to replace it.`);
    if (existing.isDirectory()) throw new PathError("invalid_request", `"${relative}" is a directory.`);
    if (!overwrite) throw new PathError("conflict", `"${relative}" already exists; pass overwrite to replace it.`);
  } catch (error) {
    if (error instanceof PathError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  tempName = `.mc-upload-${randomBytes(6).toString("hex")}`;
  const handle = await fs.open(tempName, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > maxBytes) throw new PathError("invalid_request", `The file is larger than the ${maxBytes}-byte limit.`);
      hash.update(buffer);
      await handle.write(buffer);
    }
    if (expected !== undefined && size !== expected) throw new PathError("invalid_request", `The upload ended after ${size} of ${expected} bytes.`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (overwrite) {
    await fs.rename(tempName, name);
  } else {
    try {
      await fs.link(tempName, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PathError("conflict", `"${relative}" already exists; pass overwrite to replace it.`);
      throw error;
    }
    await fs.unlink(tempName);
  }
  tempName = undefined;
  const stat = await fs.lstat(name);
  process.stdout.write(JSON.stringify({ path: relative, type: "file", size: stat.size, modifiedAt: stat.mtime.toISOString(), sha256: hash.digest("hex") }));
}

async function makeDirectory(scope: Scope, relative: string): Promise<void> {
  enter(BASE, [...scope.prefix, ...segmentsOf(relative)], true, relative);
  const stat = await fs.stat(".");
  process.stdout.write(JSON.stringify({ path: relative, type: "directory", size: 0, modifiedAt: stat.mtime.toISOString() }));
}

async function read(scope: Scope, relative: string): Promise<void> {
  const { parent, name } = splitParent(relative);
  enter(BASE, [...scope.prefix, ...parent], false, relative);
  const { handle, stat } = await openHere(name, relative);
  try {
    process.stdout.write(`${JSON.stringify({ size: stat.size, modifiedAt: stat.mtime.toISOString() })}\n`);
    let remaining = stat.size;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (remaining > 0) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining));
      if (bytesRead === 0) break;
      remaining -= bytesRead;
      if (!process.stdout.write(Buffer.from(buffer.subarray(0, bytesRead)))) await new Promise((resolve) => process.stdout.once("drain", resolve));
    }
    if (remaining !== 0) throw new PathError("conflict", `"${relative}" changed while it was being read.`);
  } finally {
    await handle.close();
  }
}

interface Entry {
  path: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: string;
}

async function list(scope: Scope, relative: string, recursive: boolean, limit: number): Promise<void> {
  const segments = segmentsOf(relative);
  if (segments.length > 0) {
    const { parent, name } = splitParent(relative);
    enter(BASE, [...scope.prefix, ...parent], false, relative);
    let stat: Stats;
    try {
      stat = lstatSync(name);
    } catch {
      throw new PathError("not_found", `"${relative}" does not exist.`);
    }
    if (stat.isSymbolicLink()) throw new PathError("forbidden", `"${relative}" is a symbolic link; links are not followed.`);
    if (stat.isFile()) {
      process.stdout.write(JSON.stringify([{ path: relative, type: "file", size: stat.size, modifiedAt: stat.mtime.toISOString() }]));
      return;
    }
    if (!stat.isDirectory()) throw new PathError("invalid_request", `"${relative}" is not a file or directory.`);
  }
  const entries: Entry[] = [];
  const walk = async (dirSegments: readonly string[]): Promise<void> => {
    enter(BASE, [...scope.prefix, ...dirSegments], false, dirSegments.join("/") || ".");
    const names = (await fs.readdir(".", { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirectories: string[][] = [];
    for (const dirent of names) {
      if (!dirent.isFile() && !dirent.isDirectory()) continue;
      let stat: Stats;
      try {
        stat = lstatSync(dirent.name);
      } catch {
        continue;
      }
      if (!stat.isFile() && !stat.isDirectory()) continue;
      if (entries.length >= limit) throw new PathError("invalid_request", `More than ${limit} entries under "${relative || "."}"; list a narrower path.`);
      const childSegments = [...dirSegments, dirent.name];
      entries.push({ path: childSegments.join("/"), type: stat.isDirectory() ? "directory" : "file", size: stat.isDirectory() ? 0 : stat.size, modifiedAt: stat.mtime.toISOString() });
      if (recursive && stat.isDirectory()) subdirectories.push(childSegments);
    }
    for (const child of subdirectories) await walk(child);
  };
  await walk(segments);
  process.stdout.write(JSON.stringify(entries));
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

/** Hashes the bounded regular files under `root`, rejecting links, special files, changing files, and overflows. */
async function manifest(scope: Scope, count: number, fileBytes: number, totalBytes: number): Promise<void> {
  const files: { path: string; size: number; sha256: string; modifiedAt: string }[] = [];
  const rejected: { path: string; reason: string }[] = [];
  let total = 0;
  try {
    enter(BASE, scope.prefix, false, ".");
  } catch (error) {
    // A missing outputs folder publishes nothing; a linked or replaced one is rejected.
    if (error instanceof PathError && error.code === "not_found") process.stdout.write(JSON.stringify({ files, rejected }));
    else process.stdout.write(JSON.stringify({ files, rejected: [{ path: ".", reason: (error as Error).message }] }));
    return;
  }
  const walk = async (dirSegments: readonly string[]): Promise<void> => {
    try {
      enter(BASE, [...scope.prefix, ...dirSegments], false, dirSegments.join("/"));
    } catch (error) {
      rejected.push({ path: dirSegments.join("/"), reason: (error as Error).message });
      return;
    }
    const names = (await fs.readdir(".", { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirectories: string[][] = [];
    for (const dirent of names) {
      const relative = [...dirSegments, dirent.name].join("/");
      if (dirent.isSymbolicLink()) {
        rejected.push({ path: relative, reason: "symbolic link" });
        continue;
      }
      if (dirent.isDirectory()) {
        subdirectories.push([...dirSegments, dirent.name]);
        continue;
      }
      if (!dirent.isFile()) {
        rejected.push({ path: relative, reason: "not a regular file" });
        continue;
      }
      if (files.length >= count) {
        rejected.push({ path: relative, reason: `more than ${count} files` });
        continue;
      }
      let opened: { handle: FileHandle; stat: Stats };
      try {
        opened = await openHere(dirent.name, relative);
      } catch (error) {
        rejected.push({ path: relative, reason: (error as Error).message });
        continue;
      }
      try {
        const before = opened.stat;
        if (before.size > fileBytes) {
          rejected.push({ path: relative, reason: `larger than ${formatBytes(fileBytes)}` });
          continue;
        }
        if (total + before.size > totalBytes) {
          rejected.push({ path: relative, reason: `outputs exceed ${formatBytes(totalBytes)} in total` });
          continue;
        }
        const hash = createHash("sha256");
        let size = 0;
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (;;) {
          const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length);
          if (bytesRead === 0) break;
          size += bytesRead;
          hash.update(buffer.subarray(0, bytesRead));
          if (size > before.size) break;
        }
        const after = await opened.handle.stat();
        if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          rejected.push({ path: relative, reason: "changed while being published" });
          continue;
        }
        total += size;
        files.push({ path: relative, size, sha256: hash.digest("hex"), modifiedAt: before.mtime.toISOString() });
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
    }
    for (const child of subdirectories) await walk(child);
  };
  await walk([]);
  process.stdout.write(JSON.stringify({ files, rejected }));
}

async function main(): Promise<void> {
  const [op, scopeName, ...rest] = process.argv.slice(2);
  const scope = SCOPES[scopeName ?? ""];
  if (!scope) throw new PathError("invalid_request", `Unknown scope "${scopeName}".`);
  const root = scope.root;
  switch (op) {
    case "write": {
      const [rawPath, overwrite, maxBytes, expected] = rest;
      await write(scope, normalizeWorkspacePath(rawPath, { root }), overwrite === "1", Number(maxBytes), expected && expected !== "-" ? Number(expected) : undefined);
      return;
    }
    case "mkdir":
      await makeDirectory(scope, normalizeWorkspacePath(rest[0], { root, allowRoot: true }));
      return;
    case "read":
      await read(scope, normalizeWorkspacePath(rest[0], { root }));
      return;
    case "list":
      await list(scope, normalizeWorkspacePath(rest[0] ?? "", { root, allowRoot: true }), rest[1] === "1", Number(rest[2] ?? 10_000));
      return;
    case "manifest":
      await manifest(scope, Number(rest[0]), Number(rest[1]), Number(rest[2]));
      return;
    default:
      throw new PathError("invalid_request", `Unknown operation "${op}".`);
  }
}

main().catch(async (error: unknown) => {
  if (tempName) await fs.unlink(tempName).catch(() => undefined);
  if (error instanceof PathError) fail(error.code, error.message);
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOSPC") fail("invalid_request", "The sandbox workspace is out of space.");
  if (code === "EACCES" || code === "EPERM") fail("forbidden", "The workspace path is not accessible.");
  if (code === "ENOTDIR" || code === "EISDIR") fail("invalid_request", "A parent of the path is not a directory.");
  if (code === "ENOENT") fail("not_found", "The workspace path does not exist.");
  fail("internal", `Workspace operation failed (${code ?? (error as Error)?.message ?? "error"}).`);
});
