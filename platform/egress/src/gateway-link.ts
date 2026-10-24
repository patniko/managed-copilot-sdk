/**
 * The egress proxy's link to the gateway: announces itself (publishing the CA certificate), follows the
 * registration stream, authorizes each vault credential use, and reports blocked attempts.
 */
import {
  EGRESS_KEY_HEADER,
  EGRESS_ROUTES,
  type EgressHello,
  type EgressHelloResponse,
  type EgressRegistration,
  type EgressReport,
  type EgressSecretRequest,
  type EgressSecretResponse,
  type EgressSnapshot,
} from "@managed-copilot/protocol";
import type { Logger } from "./log.js";
import type { Registry } from "./registry.js";

export interface SecretResolver {
  /** Authorizes one use of a vault credential and returns its value, or throws `SecretUnavailableError`. */
  resolveSecret(request: EgressSecretRequest): Promise<string>;
}

export interface Reporter {
  report(report: EgressReport): void;
}

export class SecretUnavailableError extends Error {
  readonly reason: "credential_revoked" | "policy_unavailable";

  constructor(reason: "credential_revoked" | "policy_unavailable", message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface GatewayLinkOptions {
  readonly url: string;
  readonly key: string;
  readonly registry: Registry;
  readonly hello: EgressHello;
  readonly log: Logger;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class GatewayLink implements SecretResolver, Reporter {
  readonly #options: GatewayLinkOptions;
  readonly #base: string;
  #stopped = false;
  #abort: AbortController | undefined;
  #heartbeatMs = 15_000;
  #queue: EgressReport[] = [];
  #flushTimer: NodeJS.Timeout | undefined;
  readonly #recent = new Map<string, number>();
  #running: Promise<void> | undefined;

  constructor(options: GatewayLinkOptions) {
    this.#options = options;
    this.#base = options.url.replace(/\/+$/, "");
  }

  start(): void {
    this.#running ??= this.#run();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abort?.abort();
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    await this.#flush();
    await this.#running?.catch(() => undefined);
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { [EGRESS_KEY_HEADER]: this.#options.key, ...extra };
  }

  async #run(): Promise<void> {
    let backoff = 500;
    while (!this.#stopped) {
      try {
        await this.#hello();
        await this.#stream();
        backoff = 500;
      } catch (error) {
        if (this.#stopped) break;
        this.#options.log.warn("Gateway link interrupted; retrying", { error: (error as Error).message, retryInMs: backoff });
      }
      this.#options.registry.markDisconnected();
      if (this.#stopped) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 10_000);
    }
  }

  async #hello(): Promise<void> {
    const response = await fetch(`${this.#base}${EGRESS_ROUTES.hello}`, {
      method: "POST",
      headers: this.#headers({ "content-type": "application/json" }),
      body: JSON.stringify(this.#options.hello),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`hello failed with HTTP ${response.status}`);
    const body = (await response.json()) as EgressHelloResponse;
    if (typeof body.heartbeatSeconds === "number" && body.heartbeatSeconds > 0) this.#heartbeatMs = body.heartbeatSeconds * 1000;
  }

  async #stream(): Promise<void> {
    const controller = new AbortController();
    this.#abort = controller;
    let watchdog: NodeJS.Timeout | undefined;
    const arm = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(new Error("Gateway stream went silent")), this.#heartbeatMs * 2.5);
    };
    arm();
    try {
      const response = await fetch(`${this.#base}${EGRESS_ROUTES.stream}`, { headers: this.#headers({ accept: "text/event-stream" }), signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`stream failed with HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let event = "message";
      let data: string[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        arm();
        buffer += decoder.decode(value, { stream: true });
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line === "") {
            if (data.length > 0) this.#dispatch(event, data.join("\n"));
            event = "message";
            data = [];
          } else if (!line.startsWith(":")) {
            const colon = line.indexOf(":");
            const field = colon < 0 ? line : line.slice(0, colon);
            const fieldValue = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
            if (field === "event") event = fieldValue;
            else if (field === "data") data.push(fieldValue);
          }
        }
      }
      throw new Error("Gateway stream ended");
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }

  #dispatch(event: string, data: string): void {
    const registry = this.#options.registry;
    try {
      switch (event) {
        case "snapshot": {
          const snapshot = JSON.parse(data) as EgressSnapshot;
          registry.replaceAll(snapshot.registrations);
          this.#options.log.info("Synchronized sandbox registrations", { sandboxes: snapshot.registrations.length });
          break;
        }
        case "upsert":
          registry.upsert(JSON.parse(data) as EgressRegistration);
          break;
        case "remove":
          registry.remove((JSON.parse(data) as { sandboxId: string }).sandboxId);
          break;
        default:
          break;
      }
    } catch (error) {
      this.#options.log.error("Ignoring malformed gateway event", { event, error: (error as Error).message });
    }
  }

  async resolveSecret(request: EgressSecretRequest): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.#base}${EGRESS_ROUTES.secret}`, {
        method: "POST",
        headers: this.#headers({ "content-type": "application/json" }),
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new SecretUnavailableError("policy_unavailable", "The egress proxy could not reach the Managed Copilot gateway to authorize this vault credential.");
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
      throw new SecretUnavailableError("credential_revoked", body?.error?.message ?? `The gateway refused this vault credential (HTTP ${response.status}).`);
    }
    const body = (await response.json()) as Partial<EgressSecretResponse>;
    if (typeof body.value !== "string") throw new SecretUnavailableError("policy_unavailable", "The gateway returned an invalid vault response.");
    return body.value;
  }

  report(report: EgressReport): void {
    const key = `${report.sandboxId}|${report.reason}|${report.host ?? ""}|${report.port ?? ""}`;
    const now = Date.now();
    const last = this.#recent.get(key);
    if (last !== undefined && now - last < 5_000) return;
    this.#recent.set(key, now);
    if (this.#recent.size > 5_000) {
      for (const [entry, at] of this.#recent) if (now - at >= 5_000) this.#recent.delete(entry);
    }
    if (this.#queue.length >= 1_000) return;
    this.#queue.push(report);
    this.#flushTimer ??= setTimeout(() => void this.#flush(), 250);
  }

  async #flush(): Promise<void> {
    this.#flushTimer = undefined;
    const batch = this.#queue.splice(0, 100);
    if (batch.length === 0) return;
    try {
      const response = await fetch(`${this.#base}${EGRESS_ROUTES.reports}`, {
        method: "POST",
        headers: this.#headers({ "content-type": "application/json" }),
        body: JSON.stringify({ reports: batch }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      this.#options.log.warn("Could not deliver blocked-attempt reports", { count: batch.length, error: (error as Error).message });
    }
    if (this.#queue.length > 0 && !this.#stopped) this.#flushTimer ??= setTimeout(() => void this.#flush(), 250);
  }
}
