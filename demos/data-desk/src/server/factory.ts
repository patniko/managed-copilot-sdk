// Software Factory, where an analysis's insight goes to be built: its work-order API, called server to server over
// plain HTTP, and the tracker that follows the work orders Data Desk sent until they finish. Data Desk polls the
// factory's list while any of them is active (after a restart too), and records each status change on its analysis.
import { ACTIVE_STATUSES, FACTORY_NOT_CONNECTED, STATUS_LABEL } from "../shared/factory.js";
import type { FactoryRoutingView, WorkOrderStatus } from "../shared/types.js";
import { DeskError, errorText } from "./errors.js";
import { log } from "./log.js";
import type { Store, StoredRouting } from "./store.js";

/** How Data Desk names itself on the work orders it sends. */
export const ORIGIN_APP = "data-desk";
export const ORIGIN_NAME = "Data Desk";

/** Reference material: the factory writes it to `.factory/context/<path>` in every sandbox, and its planner reads it. */
export interface ContextFile {
  readonly path: string;
  readonly content: string;
  readonly description?: string;
}

/** Where a work order came from: the factory shows it, and links back. */
export interface WorkOrderOrigin {
  readonly app: string;
  readonly name: string;
  readonly label?: string;
  readonly url?: string;
  readonly key?: string;
}

/**
 * `POST /api/work-orders` as Data Desk sends it: no `project` (the factory builds something new from the insight), and
 * the factory's default mode.
 */
export interface WorkOrderRequest {
  readonly title: string;
  readonly brief: string;
  readonly maxReviewRounds: 1 | 2 | 3;
  readonly origin: WorkOrderOrigin;
  readonly context: readonly ContextFile[];
}

/** What Data Desk reads of a work order, and of each summary in the factory's list. */
export interface WorkOrderInfo {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly status: WorkOrderStatus;
  readonly createdAt?: string;
  readonly error?: { readonly message: string };
  readonly origin?: WorkOrderOrigin;
}

/** Software Factory as Data Desk uses it. Implemented by `SoftwareFactory`; faked in tests. */
export interface FactoryClient {
  /** Whether `SOFTWARE_FACTORY_URL` is set. */
  readonly configured: boolean;
  /** The factory's address for people: `SOFTWARE_FACTORY_PUBLIC_URL`, else `SOFTWARE_FACTORY_URL`. */
  readonly publicUrl?: string;
  create(request: WorkOrderRequest): Promise<WorkOrderInfo>;
  /** Every work order, newest first. */
  list(): Promise<WorkOrderInfo[]>;
}

/** A work order's page in Software Factory. */
export const workOrderUrl = (publicUrl: string, id: string): string => `${publicUrl}/#/wo/${encodeURIComponent(id)}`;

/** A factory address from the environment: http or https, no credentials or query, no trailing slash. */
export function parseFactoryUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return undefined;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

const STATUSES: ReadonlySet<string> = new Set(Object.keys(STATUS_LABEL));

/** A work order from the factory's answer, or undefined when it isn't one. */
function workOrderInfo(value: unknown): WorkOrderInfo | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const order = value as Record<string, unknown>;
  const { id, number, title, status, createdAt } = order;
  if (typeof id !== "string" || !id || typeof number !== "number" || !Number.isFinite(number) || typeof status !== "string" || !STATUSES.has(status)) return undefined;
  const error = order["error"] as { message?: unknown } | null | undefined;
  const origin = order["origin"] as Partial<Record<keyof WorkOrderOrigin, unknown>> | null | undefined;
  return {
    id,
    number,
    title: typeof title === "string" ? title : "",
    status: status as WorkOrderStatus,
    ...(typeof createdAt === "string" ? { createdAt } : {}),
    ...(typeof error?.message === "string" ? { error: { message: error.message } } : {}),
    ...(typeof origin?.app === "string" && typeof origin.name === "string"
      ? { origin: { app: origin.app, name: origin.name, ...(typeof origin.key === "string" ? { key: origin.key } : {}) } }
      : {}),
  };
}

/** The factory's error body: `{ error: { code, message } }`, its message written for people. */
function errorBody(value: unknown): { code: string; message: string } | undefined {
  const error = (value as { error?: { code?: unknown; message?: unknown } } | null | undefined)?.error;
  return typeof error?.code === "string" && typeof error.message === "string" && error.message.trim() ? { code: error.code, message: error.message.trim() } : undefined;
}

export interface SoftwareFactoryOptions {
  /** Where Data Desk's server reaches the factory's API (`SOFTWARE_FACTORY_URL`). */
  readonly url: string;
  /** The factory's address for people (`SOFTWARE_FACTORY_PUBLIC_URL`); defaults to `url`. */
  readonly publicUrl?: string;
  readonly timeoutMs?: number;
  /** Replaces the global `fetch` (tests). */
  readonly fetch?: typeof fetch;
}

/** Software Factory's API, server to server: JSON, a deadline on every call, and failures in plain words. */
export class SoftwareFactory implements FactoryClient {
  readonly configured = true;
  readonly publicUrl: string;
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: SoftwareFactoryOptions) {
    this.#url = options.url;
    this.publicUrl = options.publicUrl ?? options.url;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetch = options.fetch ?? fetch;
  }

  get url(): string {
    return this.#url;
  }

  async create(request: WorkOrderRequest): Promise<WorkOrderInfo> {
    const created = workOrderInfo(await this.#call("POST", "/api/work-orders", request));
    if (!created) throw this.#unexpected();
    return created;
  }

  async list(): Promise<WorkOrderInfo[]> {
    const listed = await this.#call("GET", "/api/work-orders");
    if (!Array.isArray(listed)) throw this.#unexpected();
    return listed.flatMap((value) => {
      const order = workOrderInfo(value);
      return order ? [order] : [];
    });
  }

  #unreachable(): DeskError {
    return new DeskError("factory_unreachable", `Software Factory didn't answer at ${this.#url}.`, 502);
  }

  #unexpected(): DeskError {
    return new DeskError("factory_error", `Software Factory at ${this.#url} sent an answer Data Desk doesn't understand.`, 502);
  }

  async #call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let status: number;
    let text: string;
    try {
      const response = await this.#fetch(`${this.#url}${path}`, {
        method,
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      log.debug("Software Factory didn't answer", { url: this.#url, path, error: errorText(error) });
      throw this.#unreachable();
    }
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (status >= 200 && status < 300) {
      if (parsed === undefined) throw this.#unexpected();
      return parsed;
    }
    const failure = errorBody(parsed);
    if (status >= 400 && status < 500) {
      // The factory's own words: a title that's too long, context that's too large. The person can act on them.
      if (failure) throw new DeskError(failure.code, failure.message, status === 400 || status === 413 ? status : 502);
      throw new DeskError("factory_error", `Software Factory at ${this.#url} answered ${status}. Check SOFTWARE_FACTORY_URL.`, 502);
    }
    if (failure) throw new DeskError("factory_unavailable", `Software Factory couldn't take it: ${failure.message}`, 502);
    throw this.#unreachable();
  }
}

const notConnected = (): DeskError => new DeskError("factory_unavailable", FACTORY_NOT_CONNECTED, 503);

/** No `SOFTWARE_FACTORY_URL`: sending is off, and every call says why. */
export const NO_FACTORY: FactoryClient = {
  configured: false,
  create: () => Promise.reject(notConnected()),
  list: () => Promise.reject(notConnected()),
};

export function createFactory(config: { readonly factoryUrl?: string; readonly factoryPublicUrl?: string }): FactoryClient {
  if (!config.factoryUrl) return NO_FACTORY;
  return new SoftwareFactory({ url: config.factoryUrl, ...(config.factoryPublicUrl ? { publicUrl: config.factoryPublicUrl } : {}) });
}

export function routingView(routing: StoredRouting): FactoryRoutingView {
  return {
    workOrderId: routing.workOrderId,
    number: routing.number,
    title: routing.title,
    url: routing.url,
    status: routing.status,
    sentAt: routing.sentAt,
    items: routing.items,
    ...(routing.error ? { error: routing.error } : {}),
    ...(routing.gone ? { gone: true } : {}),
  };
}

const isActive = (routing: StoredRouting): boolean => ACTIVE_STATUSES.has(routing.status) && !routing.gone;

/** The `n` for an analysis's next routing key (`<analysis id>:<n>`): one more than any it has. */
export function nextRoutingNumber(routings: readonly StoredRouting[]): number {
  let highest = 0;
  for (const routing of routings) highest = Math.max(highest, Number(routing.key.slice(routing.key.lastIndexOf(":") + 1)) || 0);
  return Math.max(highest, routings.length) + 1;
}

/** How long to wait before asking again while the factory doesn't answer. */
const RETRY_MS = 15_000;
/** Answers a work order may be missing from before Data Desk stops following it (deleted in the factory). */
const MISSES = 3;

/**
 * Follows the work orders Data Desk sent: reads `GET /api/work-orders` every few seconds while any of them is active,
 * records each status change on its analysis, and says which analysis changed. After a restart it picks up from Data
 * Desk's records, and finds work orders sent just before the restart (never recorded) by their `origin.key`.
 */
export class FactoryTracker {
  readonly #factory: FactoryClient;
  readonly #store: Store;
  readonly #changed: (analysisId: string) => void;
  readonly #intervalMs: number;
  readonly #misses = new Map<string, number>();
  #timer: NodeJS.Timeout | undefined;
  #polling: Promise<boolean> | undefined;
  #failing = false;
  #closed = false;

  constructor(factory: FactoryClient, store: Store, changed: (analysisId: string) => void, intervalMs = 5_000) {
    this.#factory = factory;
    this.#store = store;
    this.#changed = changed;
    this.#intervalMs = intervalMs;
  }

  /** Whether any work order Data Desk sent is still being worked on. */
  get active(): boolean {
    return this.#store.list().some((analysis) => (analysis.factory ?? []).some(isActive));
  }

  /** Whether a poll is scheduled. */
  get following(): boolean {
    return this.#timer !== undefined;
  }

  /** Catches up once (Data Desk may have restarted), then follows what's still active. */
  start(): void {
    if (this.#store.list().length > 0) this.#schedule(0);
  }

  /** A work order was just sent: follow it. */
  follow(): void {
    this.#schedule(this.#intervalMs);
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Reads the factory's work orders once and records what changed. Resolves whether the factory answered. */
  poll(): Promise<boolean> {
    this.#polling ??= this.#poll().finally(() => {
      this.#polling = undefined;
    });
    return this.#polling;
  }

  #schedule(ms: number): void {
    if (this.#closed || this.#timer || !this.#factory.configured) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.poll().then((answered) => {
        if (this.active) this.#schedule(answered ? this.#intervalMs : RETRY_MS);
      });
    }, ms);
    this.#timer.unref?.();
  }

  async #poll(): Promise<boolean> {
    let orders: WorkOrderInfo[];
    try {
      orders = await this.#factory.list();
    } catch (error) {
      if (!this.#failing && this.active) log.warn("Couldn't read Software Factory's work orders; trying again", { error: errorText(error) });
      this.#failing = true;
      return false;
    }
    if (this.#failing && this.active) log.info("Software Factory answers again");
    this.#failing = false;
    const byId = new Map(orders.map((order) => [order.id, order]));
    for (const analysis of this.#store.list()) {
      const before = analysis.factory ?? [];
      const after = this.#update(analysis.id, before, orders, byId);
      if (after === before) continue;
      this.#store.update(analysis.id, (stored) => {
        stored.factory = after;
      });
      this.#changed(analysis.id);
    }
    return true;
  }

  /** An analysis's routings with the factory's latest; the same array when nothing changed. */
  #update(analysisId: string, routings: StoredRouting[], orders: readonly WorkOrderInfo[], byId: ReadonlyMap<string, WorkOrderInfo>): StoredRouting[] {
    let changed = false;
    const next = routings.map((routing): StoredRouting => {
      if (!isActive(routing)) return routing;
      const order = byId.get(routing.workOrderId);
      if (!order) {
        const misses = (this.#misses.get(routing.workOrderId) ?? 0) + 1;
        this.#misses.set(routing.workOrderId, misses);
        if (misses < MISSES) return routing;
        this.#misses.delete(routing.workOrderId);
        changed = true;
        log.info("A work order Data Desk sent isn't in Software Factory anymore", { sessionId: analysisId, workOrderId: routing.workOrderId });
        return { ...routing, gone: true };
      }
      this.#misses.delete(routing.workOrderId);
      const error = order.status === "failed" ? order.error?.message : undefined;
      if (order.status === routing.status && error === routing.error) return routing;
      changed = true;
      const updated: StoredRouting = { ...routing, status: order.status };
      if (error) updated.error = error;
      else delete updated.error;
      return updated;
    });
    // Sent just before a restart, before Data Desk recorded it: its key says which analysis it came from.
    for (const order of orders) {
      const key = order.origin?.app === ORIGIN_APP ? order.origin.key : undefined;
      if (!key?.startsWith(`${analysisId}:`) || next.some((routing) => routing.workOrderId === order.id)) continue;
      changed = true;
      log.info("Found a work order Data Desk sent but hadn't recorded", { sessionId: analysisId, workOrderId: order.id });
      next.push({
        workOrderId: order.id,
        number: order.number,
        title: order.title,
        url: workOrderUrl(this.#factory.publicUrl ?? "", order.id),
        status: order.status,
        sentAt: order.createdAt ?? new Date().toISOString(),
        items: [],
        key,
        ...(order.status === "failed" && order.error ? { error: order.error.message } : {}),
      });
    }
    return changed ? next.sort((a, b) => a.sentAt.localeCompare(b.sentAt)) : routings;
  }
}
