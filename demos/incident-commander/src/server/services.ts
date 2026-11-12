// Services Incident Commander knows, in this order: your own services' folders (INCIDENT_SERVICES_DIR: code, tests,
// and the logs you export there), services that publish their folder over HTTP (INCIDENT_SERVICE_URLS), and the bundled
// demo service (its production logs generated per incident). The coordinator gets a copy of the service's folder in its
// own sandbox; diffs and deploys compare against these originals. A service over HTTP is read again every time: its code
// changes when a fix is deployed to it.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { RemoteService } from "./config.js";
import { DEMO_SERVICE, demoProduction, type DemoSeed, type DemoStats } from "./demo.js";
import { AppError, errorText } from "./errors.js";

const SKIPPED = new Set(["node_modules", ".git", "dist", "build", "coverage", ".venv", "__pycache__"]);
const MAX_FILES = 400;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
/** How long a service over HTTP has to answer. */
const REMOTE_TIMEOUT_MS = 10_000;
/** JSON escaping makes an answer larger than its files; anything larger than this is refused before it's parsed. */
const MAX_RESPONSE_BYTES = 2 * MAX_TOTAL_BYTES;
const MB = 1024 * 1024;

/** A service's name: what alerts name it, its folder, and its key in INCIDENT_SERVICE_URLS. */
export const SERVICE_NAME = /^[a-z0-9][a-z0-9._-]{0,59}$/;

/** The incident's evidence in a service's folder (its logs and deploy history), not the service's code. */
export const isEvidence = (path: string): boolean => /^(logs|deploys)\//.test(path);

export interface ServiceEntry {
  readonly name: string;
  /** The bundled demo service: its "production" is simulated by this app. */
  readonly demo: boolean;
  readonly version?: string;
}

/** A service over HTTP couldn't be loaded: `Couldn't load <name> from <url>: <why>`, in plain words. */
export class ServiceLoadError extends AppError {
  constructor(
    readonly service: string,
    readonly url: string,
    reason: string,
  ) {
    super("service_unavailable", `Couldn't load ${service} from ${url}: ${reason}`, 502);
    this.name = "ServiceLoadError";
  }
}

/** A service folder's text files, by path relative to the folder (POSIX separators). */
async function readFolder(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.size >= MAX_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const size = (await stat(full)).size;
      if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) continue;
      const bytes = await readFile(full);
      // Text only: the agent greps and edits these.
      if (bytes.includes(0)) continue;
      total += size;
      files.set(relative(root, full).split(sep).join("/"), bytes.toString("utf8").replace(/\r\n/g, "\n"));
    }
  };
  await walk(root);
  return files;
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The version in a package.json, if it has one. */
function manifestVersion(manifest: string | undefined): string | undefined {
  try {
    const parsed = JSON.parse(manifest ?? "") as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    // Not a Node service, or no version: deploys then name no version.
    return undefined;
  }
}

// ─── Services over HTTP ──────────────────────────────────────────────────────────────────────────────────────

/** What a service over HTTP answered: its version and its files (code, tests, logs, and deploy history) by path. */
interface RemoteSnapshot {
  readonly version?: string;
  readonly files: Map<string, string>;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Text from the service, for a message: one line, at most `max` characters. */
function line(text: string, max: number): string {
  const flat = text.replace(/[\s\p{Cc}]+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A relative POSIX path inside the service's folder: no leading slash, backslashes, or `.` and `..` parts. */
function insideFolder(path: string): boolean {
  return path.length <= 400 && !path.startsWith("/") && !/[\\\p{Cc}]/u.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Why the service's answer can't be used. */
class InvalidAnswer extends Error {}

/** The service's answer, checked: its name, version, and files, within the same limits as a folder. */
function readSnapshot(name: string, value: unknown): RemoteSnapshot {
  if (!isObject(value)) throw new InvalidAnswer("its answer isn't a JSON object with name, version, and files.");
  if (typeof value.name !== "string") throw new InvalidAnswer(`its answer doesn't name the service ("name": "${name}").`);
  if (value.name !== name) throw new InvalidAnswer(`its answer is for "${line(value.name, 60)}", not "${name}".`);
  if (value.version !== undefined && value.version !== null && typeof value.version !== "string") throw new InvalidAnswer("its version isn't a string.");
  if (!Array.isArray(value.files)) throw new InvalidAnswer("its answer has no files list.");
  if (value.files.length === 0) throw new InvalidAnswer("it sent no files.");
  if (value.files.length > MAX_FILES) throw new InvalidAnswer(`it sent ${value.files.length} files; Incident Commander takes at most ${MAX_FILES}.`);
  const files = new Map<string, string>();
  let total = 0;
  for (const [index, file] of value.files.entries()) {
    const path: unknown = isObject(file) ? file.path : undefined;
    const content: unknown = isObject(file) ? file.content : undefined;
    if (typeof path !== "string" || !path) throw new InvalidAnswer(`file ${index + 1} has no path.`);
    if (!insideFolder(path)) throw new InvalidAnswer(`"${line(path, 80)}" isn't a relative path inside the service's folder.`);
    if (files.has(path)) throw new InvalidAnswer(`it sent ${path} twice.`);
    if (typeof content !== "string") throw new InvalidAnswer(`${path} has no text content.`);
    // Text only: the agent greps and edits these.
    if (content.includes("\u0000")) throw new InvalidAnswer(`${path} isn't text.`);
    const size = Buffer.byteLength(content, "utf8");
    if (size > MAX_FILE_BYTES) throw new InvalidAnswer(`${path} is larger than ${MAX_FILE_BYTES / MB} MB.`);
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new InvalidAnswer(`its files add up to more than ${MAX_TOTAL_BYTES / MB} MB.`);
    files.set(path, content.replace(/\r\n/g, "\n"));
  }
  const version = typeof value.version === "string" && value.version.trim() ? line(value.version, 100) : manifestVersion(files.get("package.json"));
  return { files, ...(version ? { version } : {}) };
}

/** The body as text, or undefined when it's larger than `limit` bytes. */
async function readCapped(response: Response, limit: number): Promise<string | undefined> {
  if (Number(response.headers.get("content-length") ?? 0) > limit) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** What an error answer says about itself (`{ error: { message } }` or `{ message }`), as a sentence to append. */
function explanation(body: string | undefined): string {
  let message: unknown;
  try {
    const parsed = JSON.parse(body ?? "") as { error?: { message?: unknown }; message?: unknown };
    message = parsed.error?.message ?? parsed.message;
  } catch {
    return "";
  }
  return typeof message === "string" && message.trim() ? ` ${line(message, 200)}` : "";
}

/** Why the call didn't get an answer. */
function unreachable(error: unknown): string {
  const name = (error as Error | undefined)?.name;
  if (name === "TimeoutError" || name === "AbortError") return `it didn't answer within ${REMOTE_TIMEOUT_MS / 1000} s.`;
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
  const detail = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : (error as Error | undefined)?.message;
  return `it isn't reachable${detail ? ` (${line(detail, 120)})` : ""}.`;
}

// ─── The catalog ─────────────────────────────────────────────────────────────────────────────────────────────

export interface CatalogOptions {
  /** Services that publish their folder over HTTP (INCIDENT_SERVICE_URLS). */
  readonly remote?: readonly RemoteService[];
  /** How this server calls them; the global `fetch` by default. */
  readonly fetch?: typeof fetch;
}

type Source = { readonly kind: "folder"; readonly path: string; readonly demo: boolean } | { readonly kind: "remote"; readonly service: RemoteService };

/**
 * The services Incident Commander has files for. For a service over HTTP, `find`, `originals`, and `workspace` each read
 * it again and throw `ServiceLoadError` when it can't be loaded: an incident never gets an empty folder in its place.
 */
export class ServiceCatalog {
  readonly #demoDir: string;
  readonly #ownDir: string | undefined;
  readonly #remote: ReadonlyMap<string, RemoteService>;
  readonly #fetch: typeof fetch | undefined;

  constructor(demoDir: string, ownDir?: string, options: CatalogOptions = {}) {
    this.#demoDir = demoDir;
    this.#ownDir = ownDir;
    this.#remote = new Map((options.remote ?? []).map((service) => [service.name, service]));
    this.#fetch = options.fetch;
  }

  /** Where a service's files come from: your own folder first, then the service over HTTP, then the bundled demo service. */
  async #source(name: string): Promise<Source | undefined> {
    if (!SERVICE_NAME.test(name)) return undefined;
    if (this.#ownDir && (await isFolder(join(this.#ownDir, name)))) return { kind: "folder", path: join(this.#ownDir, name), demo: false };
    const remote = this.#remote.get(name);
    if (remote) return { kind: "remote", service: remote };
    if (name === DEMO_SERVICE && (await isFolder(join(this.#demoDir, name)))) return { kind: "folder", path: join(this.#demoDir, name), demo: true };
    return undefined;
  }

  /** `GET <url>`, server to server: `{ name, version, files: [{ path, content }] }`, checked. */
  async #load(service: RemoteService): Promise<RemoteSnapshot> {
    const failed = (reason: string) => new ServiceLoadError(service.name, service.url, reason);
    let response: Response;
    let body: string | undefined;
    try {
      response = await (this.#fetch ?? fetch)(service.url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
      body = await readCapped(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      throw failed(unreachable(error));
    }
    if (!response.ok) throw failed(`it answered HTTP ${response.status}.${explanation(body)}`);
    if (body === undefined) throw failed(`its answer is larger than ${MAX_RESPONSE_BYTES / MB} MB.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw failed("its answer isn't JSON.");
    }
    try {
      return readSnapshot(service.name, parsed);
    } catch (error) {
      if (error instanceof InvalidAnswer) throw failed(error.message);
      throw failed(`its answer can't be read: ${errorText(error)}.`);
    }
  }

  async find(name: string): Promise<ServiceEntry | undefined> {
    const source = await this.#source(name);
    if (!source) return undefined;
    if (source.kind === "remote") {
      const { version } = await this.#load(source.service);
      return { name, demo: false, ...(version ? { version } : {}) };
    }
    const version = manifestVersion(await readFile(join(source.path, "package.json"), "utf8").catch(() => undefined));
    return { name, demo: source.demo, ...(version ? { version } : {}) };
  }

  /** What deployed today: the service's code and tests as they are (a service over HTTP: without its logs and deploy history). */
  async originals(name: string): Promise<Map<string, string>> {
    const source = await this.#source(name);
    if (!source) return new Map();
    if (source.kind === "folder") return readFolder(source.path);
    const { files } = await this.#load(source.service);
    return new Map([...files].filter(([path]) => !isEvidence(path)));
  }

  /**
   * The files to copy into the coordinator's sandbox. The demo service adds its generated logs and deploy history; a
   * service over HTTP sends its own, and its version.
   */
  async workspace(name: string, demo: DemoSeed | undefined): Promise<{ readonly files: Map<string, string>; readonly stats?: DemoStats; readonly version?: string }> {
    const source = await this.#source(name);
    if (!source) return { files: new Map() };
    if (source.kind === "remote") return this.#load(source.service);
    const files = await readFolder(source.path);
    if (!source.demo || !demo) return { files };
    const production = demoProduction(
      { discounts: files.get("src/discounts.js") ?? "", cart: files.get("src/cart.js") ?? "", server: files.get("src/server.js") ?? "" },
      demo,
    );
    files.set("logs/checkout.log", production.log);
    files.set("deploys/HISTORY.md", production.history);
    return { files, stats: production.stats };
  }
}