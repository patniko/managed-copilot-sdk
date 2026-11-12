// The connection to Managed Copilot: one stock CopilotClient for the help desk's shared environment, kept healthy.
// Every customer's session is created on this one client. Everything here is the public SDK.
import type { CopilotClient, CopilotSession, MessageOptions, ModelInfo, ResumeSessionConfig, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { isManagedCopilotError, ManagedCopilot, type DeploymentInfo, type SessionInfo } from "@managed-copilot/sdk";
import type { PlatformStatus } from "../shared/types.js";
import { MODEL_PREFERENCES, type HelpDeskConfig } from "./config.js";
import { HelpDeskError } from "./errors.js";
import { log } from "./log.js";

/** The parts of a stock `CopilotSession` a customer's ticket uses. */
export interface SupportSession {
  readonly sessionId: string;
  send(options: MessageOptions): Promise<string>;
  getEvents(): Promise<SessionEvent[]>;
  disconnect(): Promise<void>;
  readonly rpc: { readonly usage: { getMetrics(): Promise<{ readonly totalPremiumRequestCost: number }> } };
}

/** What the help desk needs from Managed Copilot. Implemented by `Platform`; faked in tests. */
export interface DeskPlatform {
  readonly status: PlatformStatus;
  /** The model customers' sessions use, chosen once connected. */
  readonly model: string | undefined;
  /** Where the environment places sessions: `shared` for the help desk's shared environment. */
  readonly placement: "shared" | "sandbox" | undefined;
  onStatus(listener: (status: PlatformStatus) => void): () => void;
  /** Runs after each (re)connection: sessions must be resumed on the new client. */
  onConnected(listener: () => void): () => void;
  createSession(config: SessionConfig): Promise<SupportSession>;
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<SupportSession>;
  deleteSession(sessionId: string): Promise<void>;
  /** The caller's sessions in the help desk's environment. */
  listSessions(): Promise<SessionInfo[]>;
  sessionInfo(sessionId: string): Promise<SessionInfo>;
}

/** Retry delay after the `attempt`-th consecutive failure: exponential to 30 s, then 50–100 % of that (jitter). */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

function deadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Plain words for why connecting failed. */
export function describeConnectError(error: unknown): string {
  if (isManagedCopilotError(error)) {
    if (error.code === "authentication_required") return "Sign in to GitHub (gh auth login) or set GH_TOKEN, then Help Desk connects by itself.";
    if (error.code === "forbidden") return "This GitHub account can't use this Managed Copilot deployment.";
    return error.message;
  }
  const message = (error as Error)?.message ?? String(error);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|did not answer/i.test(message)) return "Managed Copilot isn't reachable yet. Start it with `aspire run`, or set MANAGED_COPILOT_URL.";
  return message;
}

/** Why the deployment can't run the help desk, if it can't. */
export function environmentProblem(info: DeploymentInfo, environment: string): string | undefined {
  const declared = info.environments.find((candidate) => candidate.name === environment);
  if (!declared) return `This deployment has no "${environment}" environment. Add Help Desk's environment to the AppHost (demos/help-desk/apphost.mts).`;
  if (declared.type !== "shared") return `"${environment}" is a ${declared.type} environment; Help Desk needs a shared one.`;
  return undefined;
}

/** The model for customers' sessions: the override, else the first preference the account offers. */
export function chooseModel(available: readonly Pick<ModelInfo, "id" | "policy">[] | undefined, override?: string): string {
  if (override) return override;
  const usable = available ? new Set(available.filter((model) => !model.policy || model.policy.state === "enabled").map((model) => model.id)) : undefined;
  return MODEL_PREFERENCES.find((id) => !usable || usable.has(id)) ?? MODEL_PREFERENCES[0];
}

export class Platform implements DeskPlatform {
  readonly #config: HelpDeskConfig;
  #managed: ManagedCopilot | undefined;
  #client: CopilotClient | undefined;
  #status: PlatformStatus = { state: "connecting" };
  #model: string | undefined;
  readonly #statusListeners = new Set<(status: PlatformStatus) => void>();
  readonly #connectedListeners = new Set<() => void>();
  #attempt = 0;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #connecting: Promise<void> | undefined;

  constructor(config: HelpDeskConfig) {
    this.#config = config;
  }

  get status(): PlatformStatus {
    return this.#status;
  }

  get model(): string | undefined {
    return this.#model;
  }

  get placement(): "shared" | "sandbox" | undefined {
    return this.#client ? "shared" : undefined;
  }

  onStatus(listener: (status: PlatformStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onConnected(listener: () => void): () => void {
    this.#connectedListeners.add(listener);
    return () => this.#connectedListeners.delete(listener);
  }

  start(): void {
    void this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    const client = this.#client;
    this.#client = undefined;
    await client?.forceStop().catch(() => undefined);
    await this.#managed?.close().catch(() => undefined);
  }

  async createSession(config: SessionConfig): Promise<CopilotSession> {
    return this.#requireClient().createSession(config);
  }

  async resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<SupportSession> {
    return this.#requireClient().resumeSession(sessionId, config);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#requireManaged().sessions.delete(sessionId);
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.#requireManaged().sessions.list({ environment: this.#config.environment, limit: 200 });
  }

  sessionInfo(sessionId: string): Promise<SessionInfo> {
    return this.#requireManaged().sessions.get(sessionId);
  }

  #requireManaged(): ManagedCopilot {
    if (!this.#managed || this.#status.state !== "connected") throw new HelpDeskError("platform_unavailable", this.#status.message ?? "Managed Copilot isn't connected yet.", 503);
    return this.#managed;
  }

  #requireClient(): CopilotClient {
    this.#requireManaged();
    if (!this.#client) throw new HelpDeskError("platform_unavailable", "Managed Copilot isn't connected yet.", 503);
    return this.#client;
  }

  #setStatus(status: PlatformStatus): void {
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }

  #connect(): Promise<void> {
    this.#connecting ??= this.#connectOnce().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #connectOnce(): Promise<void> {
    if (this.#stopped) return;
    const previous = this.#status;
    try {
      const connecting = ManagedCopilot.connect({ clientName: "help-desk" });
      let managed: ManagedCopilot;
      try {
        managed = await deadline(connecting, 20_000, "Managed Copilot");
      } catch (error) {
        // A connection that completes after the deadline is closed, not leaked.
        void connecting.then((late) => late.close()).catch(() => undefined);
        throw error;
      }
      if (this.#stopped) return void (await managed.close().catch(() => undefined));
      const account = managed.account;
      const base = {
        url: managed.url,
        mode: managed.info.mode,
        deployment: managed.info.name,
        account: { login: account.login, ...(account.name ? { name: account.name } : {}), ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}) },
      };
      const problem = environmentProblem(managed.info, this.#config.environment);
      if (problem) {
        await managed.close().catch(() => undefined);
        this.#setStatus({ state: "unavailable", ...base, message: problem });
        this.#schedule(++this.#attempt);
        return;
      }
      const starting = managed.client(this.#config.environment);
      let client: CopilotClient;
      try {
        client = await deadline(starting, 30_000, "Starting the help desk's client");
      } catch (error) {
        void starting.then((late) => late.forceStop()).catch(() => undefined);
        await managed.close().catch(() => undefined);
        throw error;
      }
      const models = await deadline(client.listModels(), 15_000, "Listing models").catch((error: unknown) => {
        log.warn("Couldn't list models; using the first preference", { error: (error as Error).message });
        return undefined;
      });
      if (this.#stopped) {
        await client.forceStop().catch(() => undefined);
        return void (await managed.close().catch(() => undefined));
      }
      const stale = { client: this.#client, managed: this.#managed };
      this.#managed = managed;
      this.#client = client;
      this.#model = chooseModel(models, this.#config.model);
      void stale.client?.forceStop().catch(() => undefined);
      void stale.managed?.close().catch(() => undefined);
      this.#attempt = 0;
      this.#setStatus({ state: "connected", ...base });
      log.info(previous.state === "connected" ? "Reconnected to Managed Copilot" : "Connected to Managed Copilot", { url: managed.url, environment: this.#config.environment, model: this.#model });
      for (const listener of this.#connectedListeners) listener();
      this.#schedule(0);
    } catch (error) {
      if (this.#stopped) return;
      const message = describeConnectError(error);
      log.warn("Managed Copilot isn't available", { error: message });
      this.#setStatus({ ...this.#status, state: previous.state === "connected" || previous.state === "reconnecting" ? "reconnecting" : "unavailable", message });
      this.#schedule(++this.#attempt);
    }
  }

  /** Checks the connection (`attempt` 0) or tries again after a failure. */
  #schedule(attempt: number): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    const delay = attempt === 0 ? this.#config.healthIntervalMs : reconnectDelay(attempt);
    this.#timer = setTimeout(() => void (attempt === 0 ? this.#check() : this.#connect()), delay);
    this.#timer.unref?.();
  }

  async #check(): Promise<void> {
    const client = this.#client;
    if (!client || this.#stopped) return this.#schedule(1);
    try {
      await deadline(client.ping(), 8_000, "Managed Copilot");
      this.#schedule(0);
    } catch (error) {
      if (this.#stopped) return;
      log.warn("Lost the connection to Managed Copilot; reconnecting", { error: (error as Error).message });
      this.#setStatus({ ...this.#status, state: "reconnecting", message: "Reconnecting to Managed Copilot…" });
      const stale = { client: this.#client, managed: this.#managed };
      this.#client = undefined;
      this.#managed = undefined;
      void stale.client?.forceStop().catch(() => undefined);
      void stale.managed?.close().catch(() => undefined);
      void this.#connect();
    }
  }
}
