import { posix } from "node:path";

export type PathErrorCode = "invalid_request" | "forbidden" | "not_found" | "conflict";

/** A rejected or unusable workspace path. `code` maps to the platform's stable error codes. */
export class PathError extends Error {
  readonly code: PathErrorCode;
  constructor(code: PathErrorCode, message: string) {
    super(message);
    this.name = "PathError";
    this.code = code;
  }
}

const MAX_PATH_LENGTH = 4096;
const MAX_SEGMENT_BYTES = 255;

/**
 * Normalizes a workspace-relative POSIX path. Accepts `/workspace/...` for convenience and rejects absolute paths
 * elsewhere, Windows paths, control characters, and any `..` segment. Returns "" for the workspace root when allowed.
 */
export function normalizeWorkspacePath(input: unknown, options: { allowRoot?: boolean; root?: string } = {}): string {
  const root = options.root ?? "/workspace";
  if (typeof input !== "string") throw new PathError("invalid_request", "A workspace path is required.");
  if (input.length > MAX_PATH_LENGTH) throw new PathError("invalid_request", "The path is too long.");
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new PathError("invalid_request", "The path contains control characters.");
  if (input.includes("\\")) throw new PathError("invalid_request", `Use forward slashes in sandbox paths (got "${input}").`);
  if (/^[A-Za-z]:/.test(input)) throw new PathError("invalid_request", `"${input}" is a Windows path; sandbox paths are relative to ${root}.`);
  let value = input;
  if (value === root || value.startsWith(`${root}/`)) value = value.slice(root.length);
  else if (value.startsWith("/")) throw new PathError("forbidden", `"${input}" is outside the workspace; paths are relative to ${root}.`);
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new PathError("forbidden", `"${input}" escapes the workspace.`);
    if (Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES) throw new PathError("invalid_request", "A path segment is too long.");
    segments.push(segment);
  }
  const result = segments.join("/");
  if (!result && !options.allowRoot) throw new PathError("invalid_request", "A file path is required, not the workspace root.");
  return result;
}

/** True when `candidate` is `root` or inside it (both absolute POSIX paths). */
export function isWithin(root: string, candidate: string): boolean {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  return candidate === base || candidate.startsWith(`${base}/`);
}

export function joinWorkspace(root: string, relative: string): string {
  return relative ? posix.join(root, relative) : root;
}
