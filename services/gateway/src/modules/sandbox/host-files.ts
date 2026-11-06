// Workspace files of a shared session with `unsafeHostTools` live in its working directory on the platform host.
// The agent's own host tools can already reach anything there, so these do not guard against links.
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ManagedCopilotError, type FileEntry } from "@managed-copilot/protocol";

function resolve(root: string, path: string): string {
  const segments = path.replace(/\\/g, "/").replace(/^\/workspace(\/|$)/, "").split("/").filter((s) => s && s !== ".");
  if (segments.includes("..")) throw new ManagedCopilotError("invalid_request", `"${path}" leaves the workspace.`);
  return join(root, ...segments);
}

async function entry(root: string, full: string): Promise<FileEntry> {
  const stat = await fs.stat(full).catch(() => {
    throw new ManagedCopilotError("not_found", `"${relative(root, full)}" does not exist.`);
  });
  const directory = stat.isDirectory();
  return { path: relative(root, full).split(sep).join("/"), type: directory ? "directory" : "file", size: directory ? 0 : stat.size, modifiedAt: stat.mtime.toISOString() };
}

export async function listHostFiles(root: string, path: string, recursive: boolean): Promise<FileEntry[]> {
  const start = resolve(root, path);
  const names = await fs.readdir(start, { recursive }).catch(() => {
    throw new ManagedCopilotError("not_found", `"${path}" is not a directory.`);
  });
  return Promise.all(names.map((name) => entry(root, join(start, name))));
}

export async function readHostFile(root: string, path: string): Promise<{ entry: FileEntry; body: Readable }> {
  const full = resolve(root, path);
  return { entry: await entry(root, full), body: createReadStream(full) };
}

export async function writeHostFile(root: string, path: string, body: Readable, overwrite: boolean): Promise<FileEntry> {
  const full = resolve(root, path);
  await fs.mkdir(dirname(full), { recursive: true });
  await pipeline(body, createWriteStream(full, { flags: overwrite ? "w" : "wx" })).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "EEXIST" ? new ManagedCopilotError("conflict", `"${path}" already exists; pass overwrite to replace it.`) : error;
  });
  return entry(root, full);
}
