// Software Factory's work-order API, as Help Desk uses it: create a work order for a software issue, and list work
// orders to follow their status. Server to server, with a timeout; every failure becomes a HelpDeskError in plain words.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { WORK_ORDER_STATUSES, type WorkOrderStatus } from "../shared/types.js";
import { HelpDeskError } from "./errors.js";

const TIMEOUT_MS = 10_000;

export const FACTORY_NOT_CONNECTED = "Software Factory isn't connected. Start it with `aspire run`, or set SOFTWARE_FACTORY_URL.";

/** Where a work order came from: shown on Software Factory's floor, and the key finds it again. */
export interface WorkOrderOrigin {
  readonly app: string;
  readonly name: string;
  readonly label?: string;
  readonly url?: string;
  readonly key?: string;
}

/** A text file of a work order's context or project, by relative POSIX path. */
export interface FactoryFile {
  readonly path: string;
  readonly content: string;
  readonly description?: string;
}

/** The body of `POST /api/work-orders`. */
export interface WorkOrderRequest {
  readonly title: string;
  /** Markdown: what to do and why. */
  readonly brief: string;
  readonly mode?: "agent" | "classic";
  readonly maxReviewRounds?: 1 | 2 | 3;
  readonly origin?: WorkOrderOrigin;
  /** Reference material for the planner. */
  readonly context?: readonly FactoryFile[];
  /** The codebase to change. */
  readonly project?: { readonly name: string; readonly files: readonly FactoryFile[] };
}

/** The parts of a work order Help Desk reads. */
export interface WorkOrderSummary {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly status: WorkOrderStatus;
  readonly error?: { readonly code: string; readonly message: string };
  readonly origin?: WorkOrderOrigin;
}

/** What Help Desk needs from Software Factory. Implemented by `SoftwareFactory`; faked in tests. */
export interface FactoryClient {
  /** `SOFTWARE_FACTORY_URL` is set. */
  readonly configured: boolean;
  /** Where people open Software Factory. */
  readonly publicUrl: string | undefined;
  create(request: WorkOrderRequest): Promise<WorkOrderSummary>;
  /** Every work order, newest first. */
  list(): Promise<WorkOrderSummary[]>;
}

/** How work orders are named on Software Factory's floor: `WO-0012`. */
export function workOrderName(number: number): string {
  return `WO-${String(number).padStart(4, "0")}`;
}

/** A work order's page in Software Factory. */
export function workOrderUrl(publicUrl: string, id: string): string {
  return `${publicUrl}/#/wo/${encodeURIComponent(id)}`;
}

/** A base URL without its trailing slashes, or nothing. */
export function baseUrl(value: string | undefined): string | undefined {
  return value?.trim().replace(/\/+$/, "") || undefined;
}

const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const STATUSES: ReadonlySet<string> = new Set(WORK_ORDER_STATUSES);

function parseOrigin(value: unknown): WorkOrderOrigin | undefined {
  const origin = record(value);
  if (typeof origin?.["app"] !== "string" || typeof origin["name"] !== "string") return undefined;
  const optional = (key: "label" | "url" | "key") => (typeof origin[key] === "string" ? { [key]: origin[key] } : {});
  return { app: origin["app"], name: origin["name"], ...optional("label"), ...optional("url"), ...optional("key") };
}

/** A work order as Software Factory sent it, if it has what Help Desk reads. */
export function parseWorkOrder(value: unknown): WorkOrderSummary | undefined {
  const order = record(value);
  if (!order || typeof order["id"] !== "string" || typeof order["number"] !== "number" || !STATUSES.has(order["status"] as string)) return undefined;
  const error = record(order["error"]);
  const origin = parseOrigin(order["origin"]);
  return {
    id: order["id"],
    number: order["number"],
    title: typeof order["title"] === "string" ? order["title"] : "",
    status: order["status"] as WorkOrderStatus,
    ...(typeof error?.["message"] === "string" ? { error: { code: typeof error["code"] === "string" ? error["code"] : "failed", message: error["message"] } } : {}),
    ...(origin ? { origin } : {}),
  };
}

export class SoftwareFactory implements FactoryClient {
  readonly #url: string | undefined;
  readonly publicUrl: string | undefined;
  readonly #fetch: typeof fetch;

  /** `url`: the API's base URL for this server; `publicUrl`: the address people open (defaults to `url`). */
  constructor(url: string | undefined, publicUrl: string | undefined = url, fetcher: typeof fetch = fetch) {
    this.#url = baseUrl(url);
    this.publicUrl = this.#url ? (baseUrl(publicUrl) ?? this.#url) : undefined;
    this.#fetch = fetcher;
  }

  get configured(): boolean {
    return this.#url !== undefined;
  }

  async create(request: WorkOrderRequest): Promise<WorkOrderSummary> {
    const created = parseWorkOrder(await this.#call("POST", "/api/work-orders", request));
    if (!created) throw new HelpDeskError("factory_error", "Software Factory took the work order but answered with something Help Desk couldn't read.", 502);
    return created;
  }

  async list(): Promise<WorkOrderSummary[]> {
    const listed = await this.#call("GET", "/api/work-orders");
    if (!Array.isArray(listed)) throw new HelpDeskError("factory_error", "Software Factory answered with something Help Desk couldn't read.", 502);
    return listed.flatMap((value) => parseWorkOrder(value) ?? []);
  }

  async #call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const base = this.#url;
    if (!base) throw new HelpDeskError("factory_unavailable", FACTORY_NOT_CONNECTED, 503);
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await response.text();
    } catch {
      throw new HelpDeskError("factory_unreachable", `Software Factory didn't answer at ${base}. Check that it's running, or set SOFTWARE_FACTORY_URL.`, 502);
    }
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (response.ok) return parsed;
    const message = record(record(parsed)?.["error"])?.["message"];
    const said = typeof message === "string" && message.trim() ? message.trim() : undefined;
    // Its messages are written for people: a refusal is shown as it is; an outage says whose it is.
    if (response.status < 500) throw new HelpDeskError("factory_rejected", said ?? `Software Factory refused the request (HTTP ${response.status}).`, 502);
    throw new HelpDeskError("factory_unavailable", said ? `Software Factory isn't available right now: ${said}` : `Software Factory isn't available right now (HTTP ${response.status}).`, 503);
  }
}

// A project's limits, from Software Factory's API.
const MAX_PROJECT_FILES = 300;
const MAX_PROJECT_FILE_BYTES = 512 * 1024;
const MAX_PROJECT_BYTES = 2 * 1024 * 1024;
const SKIPPED = new Set(["node_modules", ".git", "dist", "coverage"]);

/**
 * A codebase as a work order's project: `package.json`, `README.md`, and every text file under `src` and `test`, with
 * POSIX paths and LF line endings, in a stable order.
 */
export async function readProject(root: string): Promise<FactoryFile[]> {
  const files: FactoryFile[] = [];
  let total = 0;
  const walk = async (path: string): Promise<void> => {
    const info = await stat(path).catch(() => undefined);
    if (info?.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) if (!SKIPPED.has(entry)) await walk(join(path, entry));
      return;
    }
    if (!info?.isFile()) return;
    const bytes = await readFile(path);
    // Text only: builders read and edit these.
    if (bytes.includes(0)) return;
    total += bytes.length;
    if (files.length >= MAX_PROJECT_FILES || bytes.length > MAX_PROJECT_FILE_BYTES || total > MAX_PROJECT_BYTES) {
      throw new HelpDeskError("project_too_large", `The storefront codebase is larger than Software Factory takes (${MAX_PROJECT_FILES} files, 512 KB each, 2 MB in all).`, 500);
    }
    files.push({ path: relative(root, path).split(sep).join("/"), content: bytes.toString("utf8").replace(/\r\n/g, "\n") });
  };
  for (const entry of ["package.json", "README.md", "src", "test"]) await walk(join(root, entry));
  if (!files.some((file) => file.path === "package.json")) throw new HelpDeskError("project_missing", "The storefront codebase (demos/help-desk/storefront) is missing from this Help Desk build.", 500);
  return files;
}
