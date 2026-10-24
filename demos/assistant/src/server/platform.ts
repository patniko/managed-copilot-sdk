/**
 * The connection to the Managed Copilot deployment: `ManagedCopilot.connect()` with retry, status for the UI, and
 * explicit failure states (no silent fallback to a local agent or another account).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isManagedCopilotError, ManagedCopilot, ManagedCopilotError } from "@managed-copilot/sdk";
import type { PlatformStatus } from "../shared/protocol.js";
import type { AssistantConfig } from "./config.js";
import { errorMessage, type Logger } from "./log.js";

const MIN_RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

/** The SDK's documented token lookup for `ManagedCopilot.connect()`: these variables in order, then `gh auth token`. */
export const TOKEN_ENVS = ["MANAGED_COPILOT_GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

async function ghAuthToken(): Promise<string | undefined> {
  const { stdout } = await execFileAsync("gh", ["auth", "token"], { windowsHide: true, timeout: 10_000 });
  return stdout.trim() || undefined;
}

/**
 * This server's GitHub token, found the same way `ManagedCopilot.connect()` finds one. The server passes it to
 * `connect` explicitly, so platform routes the SDK doesn't wrap yet (background sign-in) act as exactly the account
 * the connection does.
 */
export async function resolveGitHubToken(
  env: Readonly<Record<string, string | undefined>> = process.env,
  gh: () => Promise<string | undefined> = ghAuthToken,
): Promise<string> {
  for (const name of TOKEN_ENVS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  const fromGh = await gh().catch(() => undefined);
  if (fromGh) return fromGh;
  throw new ManagedCopilotError("authentication_required", `Sign in with GitHub first: set ${TOKEN_ENVS[0]}, or run \`gh auth login\`.`);
}

/** Short, actionable copy for connection failures (the UI adds "Start it with `aspire run`"). */
export function friendlyPlatformError(message: string): string {
  const unreachable = /Cannot reach the Managed Copilot deployment at (\S+?):? (?:fetch failed|connect ECONNREFUSED.*)$/i.exec(message);
  if (unreachable) return `Nothing is answering at ${unreachable[1]}.`;
  return /[.!?]$/.test(message.trim()) ? message.trim() : `${message.trim()}.`;
}

export class Platform {
  readonly #config: AssistantConfig;
  readonly #log: Logger;
  readonly #fetch: typeof fetch;
  readonly #listeners = new Set<(status: PlatformStatus) => void>();
  #managed: ManagedCopilot | undefined;
  /** The GitHub token `#managed` connected with; it never leaves this process except to the deployment. */
  #token: string | undefined;
  #status: PlatformStatus;
  #attempt = 0;
  #timer: NodeJS.Timeout | undefined;
  #connecting: Promise<void> | undefined;
  #stopped = false;

  constructor(config: AssistantConfig, log: Logger, options: { fetch?: typeof fetch } = {}) {
    this.#config = config;
    this.#log = log;
    this.#fetch = options.fetch ?? fetch;
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
      const token = await resolveGitHubToken();
      managed = await ManagedCopilot.connect({ clientName: "assistant-demo", gitHubToken: token });
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
      this.#token = token;
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
    this.#token = undefined;
    if (old) {
      this.#log.warn("Reconnecting to Managed Copilot", { reason });
      await old.close().catch(() => undefined);
    }
    this.#set({ ...this.#status, state: "connecting", message: undefined, retryAt: undefined });
    await this.connect();
  }

  /**
   * Calls a platform REST route as this server's GitHub account, for features the SDK doesn't wrap yet (background
   * sign-in, `/v1/credentials/background`). Errors become `ManagedCopilotError`, as they do in the SDK.
   */
  async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const managed = this.#managed;
    const token = this.#token;
    if (!managed || !token) throw new ManagedCopilotError("capability_unavailable", "Managed Copilot isn't connected.", { reason: "not_connected" });
    let response: Response;
    try {
      response = await this.#fetch(`${managed.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        // The token goes to the deployment `connect` validated, and nowhere else.
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ManagedCopilotError("capability_unavailable", `Cannot reach the Managed Copilot deployment at ${managed.url}: ${errorMessage(error)}`, { reason: "unreachable" });
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    if (!response.ok) throw ManagedCopilotError.fromBody(payload, response.status);
    return payload as T;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#managed?.close().catch(() => undefined);
    this.#managed = undefined;
    this.#token = undefined;
  }
}
