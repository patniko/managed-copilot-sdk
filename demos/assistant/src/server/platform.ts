/**
 * The connection to the Managed Copilot deployment: `ManagedCopilot.connect()` with retry, status for the UI, and
 * explicit failure states (no silent fallback to a local agent or another account).
 */
import { isManagedCopilotError, ManagedCopilot } from "@managed-copilot/sdk";
import type { PlatformStatus } from "../shared/protocol.js";
import type { AssistantConfig } from "./config.js";
import { errorMessage, type Logger } from "./log.js";

const MIN_RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;

/** Short, actionable copy for connection failures (the UI adds "Start it with `aspire run`"). */
export function friendlyPlatformError(message: string): string {
  const unreachable = /Cannot reach the Managed Copilot deployment at (\S+?):? (?:fetch failed|connect ECONNREFUSED.*)$/i.exec(message);
  if (unreachable) return `Nothing is answering at ${unreachable[1]}.`;
  return /[.!?]$/.test(message.trim()) ? message.trim() : `${message.trim()}.`;
}

export class Platform {
  readonly #config: AssistantConfig;
  readonly #log: Logger;
  readonly #listeners = new Set<(status: PlatformStatus) => void>();
  #managed: ManagedCopilot | undefined;
  #status: PlatformStatus;
  #attempt = 0;
  #timer: NodeJS.Timeout | undefined;
  #connecting: Promise<void> | undefined;
  #stopped = false;

  constructor(config: AssistantConfig, log: Logger) {
    this.#config = config;
    this.#log = log;
    this.#status = { state: "connecting", environment: config.environment };
  }

  get status(): PlatformStatus {
    return this.#status;
  }

  get managed(): ManagedCopilot | undefined {
    return this.#managed;
  }

  onStatus(listener: (status: PlatformStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(status: PlatformStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }

  start(): void {
    void this.connect();
  }

  /** Connects now (or joins an attempt in progress). */
  connect(): Promise<void> {
    if (this.#managed || this.#stopped) return Promise.resolve();
    clearTimeout(this.#timer);
    this.#connecting ??= this.#connect().finally(() => (this.#connecting = undefined));
    return this.#connecting;
  }

  async #connect(): Promise<void> {
    const environment = this.#config.environment;
    if (this.#status.state !== "connecting") this.#set({ ...this.#status, state: "connecting", message: undefined, retryAt: undefined });
    let managed: ManagedCopilot | undefined;
    try {
      managed = await ManagedCopilot.connect({ clientName: "assistant-demo" });
      const env = managed.info.environments.find((candidate) => candidate.name === environment);
      if (!env) {
        await managed.close();
        this.#retry(
          {
            state: "misconfigured",
            environment,
            url: managed.url,
            message: `This deployment has no "${environment}" environment. Add the assistant's AppHost fragment (demos/assistant/apphost.mts) to your AppHost and restart it.`,
          },
          MAX_RETRY_MS,
        );
        return;
      }
      this.#managed = managed;
      this.#attempt = 0;
      this.#set({
        state: "ready",
        environment,
        url: managed.url,
        deployment: { name: managed.info.name, mode: managed.info.mode, version: managed.info.version },
        message: env.scheduling ? undefined : `The "${environment}" environment doesn't allow agent scheduling (scheduling: true), so reminders are unavailable.`,
      });
      this.#log.info("Connected to Managed Copilot", { url: managed.url, account: managed.account.login, environment });
    } catch (error) {
      await managed?.close().catch(() => undefined);
      if (isManagedCopilotError(error, "authentication_required")) {
        this.#retry({ state: "unauthenticated", environment, message: friendlyPlatformError(errorMessage(error)) }, MAX_RETRY_MS);
      } else {
        const delay = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** this.#attempt++);
        this.#retry({ state: "unavailable", environment, message: friendlyPlatformError(errorMessage(error)) }, delay);
      }
    }
  }

  #retry(status: Omit<PlatformStatus, "retryAt">, delayMs: number): void {
    if (this.#stopped) return;
    this.#set({ ...status, retryAt: new Date(Date.now() + delayMs).toISOString() });
    this.#log.warn("Managed Copilot is not ready; retrying", { state: status.state, message: status.message, retryInMs: delayMs });
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.connect(), delayMs);
    this.#timer.unref();
  }

  /** Drops the current connection (for example after the gateway restarted) and reconnects. */
  async reconnect(reason: string): Promise<void> {
    const old = this.#managed;
    this.#managed = undefined;
    if (old) {
      this.#log.warn("Reconnecting to Managed Copilot", { reason });
      await old.close().catch(() => undefined);
    }
    this.#set({ ...this.#status, state: "connecting", message: undefined, retryAt: undefined });
    await this.connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#managed?.close().catch(() => undefined);
    this.#managed = undefined;
  }
}
