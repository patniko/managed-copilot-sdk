// What another app routes to the factory with a work order: where it came from (`origin`), reference material
// (`context`), and an existing project to change (`project`). The files are kept as the `intake` station's artifacts,
// so the floor lists and shows them like any other station's files, and every sandbox is seeded from them.
import { createHash } from "node:crypto";
import type { CreateWorkOrderRequest, InputFile, ReleaseChange, WorkOrderInputs, WorkOrderOrigin } from "../../shared/types.js";
import { StationError } from "./errors.js";
import { normalizeWorkspacePath } from "./plan.js";

/** The station ID routed inputs are kept under (as artifacts); the floor's intake panel shows them. */
export const INTAKE_STATION = "intake";
export const CONTEXT_PREFIX = "context/";
export const PROJECT_PREFIX = "project/";
/** Where context files are in every sandbox. */
export const CONTEXT_DIR = ".factory/context";

export const INPUT_LIMITS = {
  contextFiles: 12,
  contextFileBytes: 256 * 1024,
  contextBytes: 512 * 1024,
  projectFiles: 300,
  projectFileBytes: 512 * 1024,
  projectBytes: 2 * 1024 * 1024,
} as const;

const APP_ID = /^[a-z][a-z0-9-]{0,39}$/;
const RESERVED_PREFIXES = [".factory/", "outputs/", "node_modules/", ".git/"];

/** Routed inputs, validated: paths normalized, sizes within the limits. */
export interface RoutedInputs {
  readonly origin?: WorkOrderOrigin;
  readonly context: readonly InputFile[];
  readonly project?: { readonly name: string; readonly files: readonly InputFile[] };
}

/** Routed files as the pipeline uses them: path → content. */
export interface LoadedInputs {
  readonly context: ReadonlyMap<string, string>;
  readonly project?: { readonly name: string; readonly files: ReadonlyMap<string, string> };
}

const invalid = (message: string): StationError => new StationError("invalid_request", message);

function kilobytes(bytes: number): string {
  return `${Math.round(bytes / 1024).toLocaleString("en-US")} KB`;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalid(`${field} must be a string.`);
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > max) throw invalid(`${field} can be at most ${max} characters.`);
  return text || undefined;
}

function parseOrigin(value: unknown): WorkOrderOrigin | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("origin must be an object with the routing app's app and name.");
  const input = value as Record<string, unknown>;
  const app = typeof input.app === "string" ? input.app.trim() : "";
  if (!APP_ID.test(app)) throw invalid('origin.app must be lowercase letters, digits, and hyphens, like "help-desk".');
  const name = optionalText(input.name, "origin.name", 60);
  if (!name) throw invalid('origin.name is required: the app\'s name for people, like "Help Desk".');
  const label = optionalText(input.label, "origin.label", 120);
  const key = optionalText(input.key, "origin.key", 200);
  let url: string | undefined;
  if (input.url !== undefined && input.url !== null && input.url !== "") {
    if (typeof input.url !== "string" || input.url.length > 2000) throw invalid("origin.url must be an http or https URL of at most 2,000 characters.");
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw invalid("origin.url must be an http or https URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw invalid("origin.url must be an http or https URL.");
    url = parsed.href;
  }
  return { app, name, ...(label ? { label } : {}), ...(url ? { url } : {}), ...(key ? { key } : {}) };
}

function parseFiles(
  value: unknown,
  field: string,
  limits: { readonly files: number; readonly fileBytes: number; readonly totalBytes: number },
): InputFile[] {
  if (!Array.isArray(value)) throw invalid(`${field} must be a list of { path, content } files.`);
  if (value.length > limits.files) throw invalid(`${field} has ${value.length} files; the factory takes up to ${limits.files}.`);
  const seen = new Set<string>();
  const files: InputFile[] = [];
  let total = 0;
  for (const [index, item] of value.entries()) {
    const label = `${field}[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw invalid(`${label} must be a { path, content } object.`);
    const { path: rawPath, content, description } = item as Record<string, unknown>;
    if (typeof rawPath !== "string" || rawPath.length > 200) throw invalid(`${label}.path must be a relative path of at most 200 characters.`);
    const path = normalizeWorkspacePath(rawPath);
    if (!path) throw invalid(`${label}.path "${rawPath}" isn't a safe relative path.`);
    if (RESERVED_PREFIXES.some((prefix) => path.startsWith(prefix))) throw invalid(`${label}.path "${path}" is inside a folder the factory reserves.`);
    if (seen.has(path)) throw invalid(`${field} lists "${path}" twice.`);
    seen.add(path);
    if (typeof content !== "string") throw invalid(`${label}.content must be the file's text.`);
    if (content.includes("\u0000")) throw invalid(`${path} looks binary; send text files only.`);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > limits.fileBytes) throw new StationError("payload_too_large", `${path} is ${kilobytes(bytes)}; ${field} files can be up to ${kilobytes(limits.fileBytes)}.`);
    total += bytes;
    if (total > limits.totalBytes) throw new StationError("payload_too_large", `${field} is over ${kilobytes(limits.totalBytes)} in all; send fewer or smaller files.`);
    const note = optionalText(description, `${label}.description`, 200);
    files.push({ path, content, ...(note ? { description: note } : {}) });
  }
  return files;
}

/** Validates a work order's routed inputs. Problems are `invalid_request` (or `payload_too_large`) for the routing app. */
export function parseRoutedInputs(request: CreateWorkOrderRequest): RoutedInputs {
  const origin = parseOrigin(request.origin);
  const context =
    request.context === undefined || request.context === null
      ? []
      : parseFiles(request.context, "context", { files: INPUT_LIMITS.contextFiles, fileBytes: INPUT_LIMITS.contextFileBytes, totalBytes: INPUT_LIMITS.contextBytes });
  let project: RoutedInputs["project"];
  if (request.project !== undefined && request.project !== null) {
    if (typeof request.project !== "object" || Array.isArray(request.project)) throw invalid("project must be { name, files }.");
    const name = optionalText(request.project.name, "project.name", 100);
    if (!name) throw invalid("project.name is required: the project's name for people, like its package name.");
    const files = parseFiles(request.project.files, "project.files", {
      files: INPUT_LIMITS.projectFiles,
      fileBytes: INPUT_LIMITS.projectFileBytes,
      totalBytes: INPUT_LIMITS.projectBytes,
    });
    if (files.length === 0) throw invalid("project.files is empty: send the project's files, or leave project out to start from scratch.");
    project = { name, files };
  }
  return { ...(origin ? { origin } : {}), context, ...(project ? { project } : {}) };
}

/** What the floor lists about routed inputs; undefined when there are none. */
export function describeInputs(inputs: RoutedInputs): WorkOrderInputs | undefined {
  if (inputs.context.length === 0 && !inputs.project) return undefined;
  return {
    context: inputs.context.map((file) => ({ path: file.path, size: Buffer.byteLength(file.content, "utf8"), ...(file.description ? { description: file.description } : {}) })),
    ...(inputs.project
      ? {
          project: {
            name: inputs.project.name,
            files: inputs.project.files.length,
            bytes: inputs.project.files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0),
          },
        }
      : {}),
  };
}

export function digestOf(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/**
 * Whether the release harness bundles a project path: like factory-check's `listProjectFiles`, it skips directories
 * whose names start with a dot (`.github/`), `node_modules/`, and `outputs/`. The release leaves other paths alone.
 */
export function releasable(path: string): boolean {
  const folders = path.split("/").slice(0, -1);
  return folders[0] !== "outputs" && !folders.some((folder) => folder.startsWith(".") || folder === "node_modules");
}

/** A released file: its content when the factory kept it, and its SHA-256 (hex) from the release manifest. */
export interface ReleasedFile {
  readonly content?: string;
  readonly sha256?: string;
}

/**
 * What a release changed in the project a work order brought: files it added, changed, or no longer has. A file whose
 * content the factory didn't keep is compared by its manifest SHA-256. Paths the harness never bundles (dot-directories)
 * aren't part of the release, so they never count as removed.
 */
export function projectChanges(project: ReadonlyMap<string, string>, released: ReadonlyMap<string, ReleasedFile>): ReleaseChange[] {
  const changes: ReleaseChange[] = [];
  for (const [path, file] of released) {
    const before = project.get(path);
    if (before === undefined) changes.push({ path, status: "added" });
    else if (file.content !== undefined ? file.content !== before : file.sha256 !== undefined && file.sha256.toLowerCase() !== digestOf(before).slice("sha256:".length)) {
      changes.push({ path, status: "modified" });
    }
  }
  for (const path of project.keys()) if (releasable(path) && !released.has(path)) changes.push({ path, status: "deleted" });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}
