import type { ManagedCopilotConfig, PlatformEvent, WebhookEnvelope } from "@managed-copilot/protocol";
import { WEBHOOK_HEADERS } from "@managed-copilot/protocol";
import type { Database } from "../../../db.js";
import type { Logger } from "../../../log.js";
import type { ActionsService, PlatformEventMeta, WebhookDeliveryInfo, WebhookDeliveryState, WebhooksService } from "../contract.js";
import { newId, parseJson, toIso } from "../ids.js";
import { signWebhook } from "./signing.js";

export interface WebhooksOptions {
  /** Delivery attempts before a delivery is marked `failed`. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly requestTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly concurrency: number;
}

export const DEFAULT_WEBHOOKS_OPTIONS: WebhooksOptions = {
  maxAttempts: 10,
  baseDelayMs: 2_000,
  maxDelayMs: 5 * 60_000,
  requestTimeoutMs: 10_000,
  pollIntervalMs: 500,
  concurrency: 4,
};

export interface WebhookSubscription {
  readonly name: string;
  readonly url: string;
  readonly environments: readonly string[];
  readonly events: readonly string[];
  /** Undefined when the AppHost secret is missing: deliveries fail visibly instead of going out unsigned. */
  readonly secret: string | undefined;
}

export interface WebhooksDeps {
  readonly db: Database;
  readonly log: Logger;
  readonly deployment: ManagedCopilotConfig;
  readonly mode: "local" | "azure";
  /** Resolves `{ secretEnv }` references. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly actions: () => ActionsService | undefined;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  readonly options?: Partial<WebhooksOptions>;
}

interface DeliveryRow {
  readonly id: string;
  readonly webhook: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly session_id: string | null;
  readonly environment: string | null;
  readonly owner_id: number | null;
  readonly event: string;
  readonly state: WebhookDeliveryState;
  readonly attempts: number;
  readonly next_attempt_at: number;
  readonly last_status: number | null;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly delivered_at: number | null;
}

const USER_AGENT = "ManagedCopilot-Webhooks/0.1";

/** Loads the AppHost's webhook subscriptions, resolving secrets from the gateway environment. */
export function loadSubscriptions(deployment: ManagedCopilotConfig, env: Readonly<Record<string, string | undefined>>): Map<string, WebhookSubscription> {
  const subscriptions = new Map<string, WebhookSubscription>();
  for (const [name, decl] of Object.entries(deployment.webhooks ?? {})) {
    subscriptions.set(name, { name, url: decl.url, environments: decl.environments, events: decl.events, secret: env[decl.secret.secretEnv] || undefined });
  }
  return subscriptions;
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname.endsWith(".localhost");
}

/**
 * Signed, at-least-once delivery of platform events to the AppHost's webhook subscriptions (spec section 12).
 * Every delivery is persisted first (outbox), retried with bounded exponential backoff, and ends `delivered` or
 * `failed` (operator-visible). Action events get a fresh short-lived capability per attempt, covering only the
 * session's listed actions that are still pending.
 */
export class DurableWebhooks implements WebhooksService {
  readonly #deps: WebhooksDeps;
  readonly #log: Logger;
  readonly #options: WebhooksOptions;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;
  readonly #subscriptions: Map<string, WebhookSubscription>;
  readonly #inFlight = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #pumping: Promise<void> | undefined;
  #stopped = false;

  constructor(deps: WebhooksDeps) {
    this.#deps = deps;
    this.#log = deps.log;
    this.#options = { ...DEFAULT_WEBHOOKS_OPTIONS, ...deps.options };
    this.#now = deps.now ?? Date.now;
    this.#fetch = deps.fetch ?? fetch;
    this.#subscriptions = loadSubscriptions(deps.deployment, deps.env);
    for (const subscription of this.#subscriptions.values()) {
      const url = new URL(subscription.url);
      if (!subscription.secret) this.#log.error("Webhook has no signing secret; its deliveries will fail until it is set", { webhook: subscription.name });
      if (url.protocol === "http:" && !isLoopback(url) && deps.mode === "azure") {
        this.#log.warn("Webhook uses plain HTTP; use HTTPS for deployed environments", { webhook: subscription.name });
      }
    }
  }

  get subscriptionNames(): string[] {
    return [...this.#subscriptions.keys()];
  }

  subscription(name: string): WebhookSubscription | undefined {
    return this.#subscriptions.get(name);
  }

  /** Recovers deliveries interrupted by a restart (at-least-once) and starts the delivery loop. */
  start(): void {
    this.#stopped = false;
    const now = this.#now();
    this.#deps.db.prepare("UPDATE durable_webhook_deliveries SET state = 'pending', next_attempt_at = ?, updated_at = ? WHERE state = 'delivering'").run(now, now);
    if (this.#options.pollIntervalMs > 0) {
      this.#timer = setInterval(() => void this.pump(), this.#options.pollIntervalMs);
      this.#timer.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#pumping;
  }

  subscribers(environment: string, eventType: string): string[] {
    return [...this.#subscriptions.values()]
      .filter((subscription) => subscription.environments.includes(environment) && (subscription.events.includes(eventType) || subscription.events.includes("*")))
      .map((subscription) => subscription.name);
  }

  enqueue(event: PlatformEvent, meta: PlatformEventMeta): number {
    if (!event.environment) return 0;
    const now = this.#now();
    let queued = 0;
    for (const name of this.subscribers(event.environment, event.type)) {
      const result = this.#deps.db
        .prepare(
          `INSERT OR IGNORE INTO durable_webhook_deliveries (id, webhook, event_id, event_type, session_id, environment, owner_id, event, state,
             attempts, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(newId("whd"), name, event.id, event.type, event.sessionId ?? null, event.environment, meta.ownerId, JSON.stringify(event), now, now, now);
      queued += Number(result.changes);
    }
    if (queued > 0) queueMicrotask(() => void this.pump());
    return queued;
  }

  deliveries(options: { readonly state?: WebhookDeliveryState; readonly limit?: number } = {}): WebhookDeliveryInfo[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const rows = (
      options.state
        ? this.#deps.db.prepare("SELECT * FROM durable_webhook_deliveries WHERE state = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(options.state, limit)
        : this.#deps.db.prepare("SELECT * FROM durable_webhook_deliveries ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit)
    ) as unknown as DeliveryRow[];
    return rows.map(toDeliveryInfo);
  }

  /** Delivers every due delivery (bounded concurrency). Safe to call concurrently; overlapping calls share one pass. */
  pump(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (!this.#pumping) {
      this.#pumping = this.#pumpOnce().finally(() => {
        this.#pumping = undefined;
      });
    }
    return this.#pumping;
  }

  async #pumpOnce(): Promise<void> {
    for (;;) {
      const due = this.#deps.db
        .prepare("SELECT * FROM durable_webhook_deliveries WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, rowid LIMIT ?")
        .all(this.#now(), this.#options.concurrency * 4) as unknown as DeliveryRow[];
      const batch = due.filter((row) => !this.#inFlight.has(row.id));
      if (batch.length === 0 || this.#stopped) return;
      for (let i = 0; i < batch.length; i += this.#options.concurrency) {
        await Promise.all(batch.slice(i, i + this.#options.concurrency).map((row) => this.#attempt(row)));
      }
    }
  }

  async #attempt(row: DeliveryRow): Promise<void> {
    this.#inFlight.add(row.id);
    try {
      const attempt = row.attempts + 1;
      const startedAt = this.#now();
      const claimed = this.#deps.db
        .prepare("UPDATE durable_webhook_deliveries SET state = 'delivering', attempts = ?, updated_at = ? WHERE id = ? AND state = 'pending'")
        .run(attempt, startedAt, row.id);
      if (Number(claimed.changes) !== 1) return;

      const subscription = this.#subscriptions.get(row.webhook);
      if (!subscription) return this.#finish(row, attempt, { ok: false, error: "The webhook is no longer declared in the AppHost", final: true });
      if (!subscription.secret) return this.#finish(row, attempt, { ok: false, error: "The webhook's signing secret is not configured", final: true });

      const event = parseJson<PlatformEvent>(row.event);
      if (!event) return this.#finish(row, attempt, { ok: false, error: "The stored event is unreadable", final: true });
      const envelope: WebhookEnvelope = { ...event, deployment: this.#deps.deployment.name };
      if (event.type === "session.action_required" && event.sessionId) {
        const ids = ((event.data.actions as { id?: unknown }[] | undefined) ?? []).map((action) => action.id).filter((id): id is string => typeof id === "string");
        const capability = this.#deps.actions()?.mintCapability(event.sessionId, ids, row.webhook);
        if (capability) Object.assign(envelope, { capability });
      }
      const body = JSON.stringify(envelope);
      const headers = {
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        [WEBHOOK_HEADERS.signature]: signWebhook(subscription.secret, body, Math.floor(this.#now() / 1000)),
        [WEBHOOK_HEADERS.eventId]: event.id,
        [WEBHOOK_HEADERS.deliveryAttempt]: String(attempt),
      };
      let response: Response;
      try {
        response = await this.#fetch(subscription.url, {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(this.#options.requestTimeoutMs),
        });
      } catch (error) {
        const reason = (error as Error)?.name === "TimeoutError" ? `No response within ${this.#options.requestTimeoutMs / 1000}s` : `Could not reach the webhook (${(error as Error).message})`;
        return this.#finish(row, attempt, { ok: false, error: reason });
      }
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 200 && response.status < 300) return this.#finish(row, attempt, { ok: true, status: response.status });
      return this.#finish(row, attempt, { ok: false, status: response.status, error: `The webhook answered HTTP ${response.status}` });
    } finally {
      this.#inFlight.delete(row.id);
    }
  }

  #finish(row: DeliveryRow, attempt: number, outcome: { ok: boolean; status?: number; error?: string; final?: boolean }): void {
    const now = this.#now();
    if (outcome.ok) {
      this.#deps.db
        .prepare("UPDATE durable_webhook_deliveries SET state = 'delivered', last_status = ?, last_error = NULL, delivered_at = ?, updated_at = ? WHERE id = ?")
        .run(outcome.status ?? null, now, now, row.id);
      this.#log.debug("Webhook delivered", { webhook: row.webhook, eventId: row.event_id, eventType: row.event_type, attempt });
      return;
    }
    if (outcome.final || attempt >= this.#options.maxAttempts) {
      this.#deps.db
        .prepare("UPDATE durable_webhook_deliveries SET state = 'failed', last_status = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(outcome.status ?? null, outcome.error ?? null, now, row.id);
      this.#log.warn("Webhook delivery failed permanently", { webhook: row.webhook, eventId: row.event_id, eventType: row.event_type, attempts: attempt, reason: outcome.error });
      return;
    }
    const backoff = Math.min(this.#options.maxDelayMs, this.#options.baseDelayMs * 2 ** (attempt - 1));
    const jittered = Math.round(backoff * (0.8 + Math.random() * 0.4));
    this.#deps.db
      .prepare("UPDATE durable_webhook_deliveries SET state = 'pending', next_attempt_at = ?, last_status = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(now + jittered, outcome.status ?? null, outcome.error ?? null, now, row.id);
    this.#log.info("Webhook delivery will be retried", { webhook: row.webhook, eventId: row.event_id, attempt, retryInMs: jittered, reason: outcome.error });
  }
}

function toDeliveryInfo(row: DeliveryRow): WebhookDeliveryInfo {
  return {
    id: row.id,
    webhook: row.webhook,
    eventId: row.event_id,
    eventType: row.event_type,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    state: row.state,
    attempts: row.attempts,
    ...(row.last_status !== null ? { lastStatus: row.last_status } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.state === "pending" ? { nextAttemptAt: toIso(row.next_attempt_at)! } : {}),
    createdAt: toIso(row.created_at)!,
    ...(row.delivered_at !== null ? { deliveredAt: toIso(row.delivered_at)! } : {}),
  };
}
