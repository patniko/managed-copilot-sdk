// Workspace writes, executed in a short-lived process running as the sandbox's workload identity (uid 10001), so a
// write can never reach anything the workload itself could not write. Invoked by sandboxd:
//   node fsworker.js write <relative> <overwrite 0|1> <maxBytes> [expectedBytes]   (content on stdin)
//   node fsworker.js mkdir <relative>
// Prints a JSON result on stdout; on failure prints {"code","message"} on stderr and exits with status 2.
import { createHash, randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { posix } from "node:path";
import { isWithin, normalizeWorkspacePath, PathError } from "../shared/paths.js";

const root = process.env.SANDBOXD_WORKSPACE_ROOT ?? "/workspace";
let tempPath: string | undefined;

function fail(code: string, message: string): never {
  process.stderr.write(`${JSON.stringify({ code, message })}\n`);
  process.exit(2);
}

async function cleanup(): Promise<void> {
  if (tempPath) await fs.unlink(tempPath).catch(() => undefined);
}

process.on("SIGTERM", () => {
  void cleanup().finally(() => process.exit(3));
});

async function resolveParent(relative: string): Promise<{ parentReal: string; name: string }> {
  const target = posix.join(root, relative);
  const parent = posix.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const rootReal = await fs.realpath(root);
  const parentReal = await fs.realpath(parent);
  if (!isWithin(rootReal, parentReal)) throw new PathError("forbidden", `"${relative}" resolves outside the workspace.`);
  return { parentReal, name: posix.basename(target) };
}

async function write(relative: string, overwrite: boolean, maxBytes: number, expected: number | undefined): Promise<void> {
  const { parentReal, name } = await resolveParent(relative);
  const finalPath = posix.join(parentReal, name);
  try {
    const existing = await fs.lstat(finalPath);
    if (existing.isSymbolicLink()) throw new PathError("forbidden", `"${relative}" is a symbolic link; refusing to replace it.`);
    if (existing.isDirectory()) throw new PathError("invalid_request", `"${relative}" is a directory.`);
    if (!overwrite) throw new PathError("conflict", `"${relative}" already exists; pass overwrite to replace it.`);
  } catch (error) {
    if (error instanceof PathError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  tempPath = posix.join(parentReal, `.mc-upload-${randomBytes(6).toString("hex")}`);
  const handle = await fs.open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
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
    await fs.rename(tempPath, finalPath);
  } else {
    try {
      await fs.link(tempPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PathError("conflict", `"${relative}" already exists; pass overwrite to replace it.`);
      throw error;
    }
    await fs.unlink(tempPath);
  }
  tempPath = undefined;
  const stat = await fs.stat(finalPath);
  process.stdout.write(JSON.stringify({ path: relative, type: "file", size: stat.size, modifiedAt: stat.mtime.toISOString(), sha256: hash.digest("hex") }));
}

async function mkdir(relative: string): Promise<void> {
  const absolute = posix.join(root, relative);
  await fs.mkdir(absolute, { recursive: true });
  const rootReal = await fs.realpath(root);
  if (!isWithin(rootReal, await fs.realpath(absolute))) throw new PathError("forbidden", `"${relative}" resolves outside the workspace.`);
  const stat = await fs.stat(absolute);
  process.stdout.write(JSON.stringify({ path: relative, type: "directory", size: 0, modifiedAt: stat.mtime.toISOString() }));
}

async function main(): Promise<void> {
  const [op, rawPath, ...rest] = process.argv.slice(2);
  const relative = normalizeWorkspacePath(rawPath, { root });
  if (op === "write") {
    const [overwrite, maxBytes, expected] = rest;
    await write(relative, overwrite === "1", Number(maxBytes), expected && expected !== "-" ? Number(expected) : undefined);
  } else if (op === "mkdir") {
    await mkdir(relative);
  } else {
    throw new PathError("invalid_request", `Unknown operation "${op}".`);
  }
}

main().catch(async (error: unknown) => {
  await cleanup();
  if (error instanceof PathError) fail(error.code, error.message);
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOSPC") fail("invalid_request", "The sandbox workspace is out of space.");
  if (code === "EACCES" || code === "EPERM") fail("forbidden", "The workspace path is not writable.");
  if (code === "ENOTDIR" || code === "EISDIR") fail("invalid_request", "A parent of the path is not a directory.");
  fail("internal", `Write failed (${code ?? "error"}).`);
});
