// The connection to Managed Copilot: one stock CopilotClient for Data Desk's promotable environment, kept healthy,
// plus the platform events and REST helpers analyses use. Everything here is the public SDK.
import type { CopilotClient, MessageOptions, ResumeSessionConfig, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { isManagedCopilotError, ManagedCopilot, type ArtifactInfo, type DeploymentInfo, type PlatformEvent, type SessionInfo } from "@managed-copilot/sdk";
import type { EnvironmentView, PlatformStatus } from "../shared/types.js";
import type { DeskConfig } from "./config.js";
import { DeskError, errorText } from "./errors.js";
import { log } from "./log.js";

/** The parts of a stock `CopilotSession` an analysis uses. */
export interface DeskSession {
  readonly sessionId: string;
  on(handler: (event: SessionEvent) => void): () => void;
  send(options: MessageOptions): Promise<string>;
  getEvents(): Promise<SessionEvent[]>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  readonly rpc: { readonly usage: { getMetrics(): Promise<{ readonly totalPremiumRequestCost: number }> } };
}

/** What analyses need from Managed Copilot. Implemented by `Platform`; faked in tests. */
export interface DeskPlatform {
  readonly status: PlatformStatus;
  readonly environments: readonly EnvironmentView[];
  onStatus(listener: (status: PlatformStatus) => void): () => void;
  /** Runs after each (re)connection: sessions must be resumed on the new client. */
  onConnected(listener: () => void): () => void;
  /** `session.promoted`, `artifact.published`, and `session.deleted` platform events. */
  onEvent(listener: (event: PlatformEvent) => void): () => void;
  createSession(config: SessionConfig): Promise<DeskSession>;
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<DeskSession>;
  deleteSession(sessionId: string): Promise<void>;
  /** The caller's sessions in Data Desk's environment. */
  listSessions(): Promise<SessionInfo[]>;
  sessionInfo(sessionId: string): Promise<SessionInfo>;
  /** Writes a file into a session's sandbox workspace. */
  writeFile(sessionId: string, path: string, data: Uint8Array): Promise<void>;
  /** The newest version of each file the session published under `outputs/`. */
  outputs(sessionId: string): Promise<ArtifactInfo[]>;
  readOutput(sessionId: string, path: string, version: number): Promise<Uint8Array>;
}

const EVENTS = ["session.promoted", "artifact.published", "session.deleted"] as const;

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
    if (error.code === "authentication_required") return "Sign in to GitHub (gh auth login) or set GH_TOKEN, then Data Desk connects by itself.";
    if (error.code === "forbidden") return "This GitHub account can't use this Managed Copilot deployment.";
    return error.message;
  }
  const message = errorText(error);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|did not answer/i.test(message)) return "Managed Copilot isn't reachable yet. Start it with `aspire run`, or set MANAGED_COPILOT_URL.";
  return message;
}

/** Data Desk's environments as the deployment declares them, and what's wrong when they can't be used. */
export function describeDeployment(info: DeploymentInfo, environment: string): { environments: EnvironmentView[]; problem?: string; warning?: string } {
  const declared = info.environments.find((candidate) => candidate.name === environment);
  if (!declared) {
    return { environments: [], problem: `This deployment has no "${environment}" environment. Add Data Desk's environments to the AppHost (demos/data-desk/apphost.mts).` };
  }
  if (declared.type !== "promotable") return { environments: [], problem: `"${environment}" is a ${declared.type} environment; Data Desk needs a promotable one.` };
  const target = declared.promoteTo ? info.environments.find((candidate) => candidate.name === declared.promoteTo) : undefined;
  const view = (env: typeof declared): EnvironmentView => ({ name: env.name, type: env.type, network: env.network.access, ...(env.type === "isolated" && env.size ? { size: env.size } : {}) });
  const environments = [view(declared), ...(target ? [view(target)] : [])];
  if (!info.capabilities.includes("promotion")) return { environments, warning: "Sandboxes aren't available on this deployment right now, so analyses can't move into one yet." };
  return { environments };
}

export class Platform implements DeskPlatform {
  readonly #config: DeskConfig;
  #managed: ManagedCopilot | undefined;
  #client: CopilotClient | undefined;
  #status: PlatformStatus = { state: "connecting" };
  #environments: EnvironmentView[] = [];
  readonly #statusListeners = new Set<(status: PlatformStatus) => void>();
  readonly #connectedListeners = new Set<() => void>();
  readonly #eventListeners = new Set<(event: PlatformEvent) => void>();
  #attempt = 0;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #connecting: Promise<void> | undefined;

  constructor(config: DeskConfig) {
    this.#config = config;
  }

  get status(): PlatformStatus {
    return this.#status;
  }

  get environments(): readonly EnvironmentView[] {
    return this.#environments;
  }

  onStatus(listener: (status: PlatformStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onConnected(listener: () => void): () => void {
    this.#connectedListeners.add(listener);
    return () => this.#connectedListeners.delete(listener);
  }

  onEvent(listener: (event: PlatformEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
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

  async createSession(config: SessionConfig): Promise<DeskSession> {
    return this.#requireClient().createSession(config);
  }

  async resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<DeskSession> {
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

  async writeFile(sessionId: string, path: string, data: Uint8Array): Promise<void> {
    await this.#requireManaged().files(sessionId).write(path, data);
  }

  outputs(sessionId: string): Promise<ArtifactInfo[]> {
    return this.#requireManaged().artifacts(sessionId).list({ versions: "latest" });
  }

  readOutput(sessionId: string, path: string, version: number): Promise<Uint8Array> {
    return this.#requireManaged().artifacts(sessionId).readBytes(path, { version });
  }

  #requireManaged(): ManagedCopilot {
    if (!this.#managed || this.#status.state !== "connected") throw new DeskError("platform_unavailable", this.#status.message ?? "Managed Copilot isn't connected yet.", 503);
    return this.#managed;
  }

  #requireClient(): CopilotClient {
    this.#requireManaged();
    if (!this.#client) throw new DeskError("platform_unavailable", "Managed Copilot isn't connected yet.", 503);
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
      if (!this.#managed) {
        const connecting = ManagedCopilot.connect({ clientName: "data-desk" });
        let managed: ManagedCopilot;
        try {
          managed = await deadline(connecting, 20_000, "Managed Copilot");
        } catch (error) {
          // A connection that completes after the deadline is closed, not leaked.
          void connecting.then((late) => late.close()).catch(() => undefined);
          throw error;
        }
        if (this.#stopped) return void (await managed.close().catch(() => undefined));
        this.#managed = managed;
        for (const type of EVENTS) managed.on(type, (event) => this.#event(event));
      }
      const managed = this.#managed;
      const described = describeDeployment(managed.info, this.#config.environment);
      this.#environments = described.environments;
      const account = managed.account;
      const base = {
        url: managed.url,
        mode: managed.info.mode,
        deployment: managed.info.name,
        account: { login: account.login, ...(account.name ? { name: account.name } : {}), ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}) },
      };
      if (described.problem) {
        this.#setStatus({ state: "unavailable", ...base, message: described.problem });
        // The deployment can change (a new AppHost run): check again, and re-read its description.
        this.#managed = undefined;
        await managed.close().catch(() => undefined);
        this.#schedule(++this.#attempt);
        return;
      }
      const old = this.#client;
      this.#client = undefined;
      await old?.forceStop().catch(() => undefined);
      const starting = managed.client(this.#config.environment);
      let client: CopilotClient;
      try {
        client = await deadline(starting, 30_000, "Starting Data Desk's client");
      } catch (error) {
        // A client that finishes starting after the deadline is stopped, not leaked.
        void starting.then((late) => late.forceStop()).catch(() => undefined);
        throw error;
      }
      if (this.#stopped || this.#managed !== managed) {
        await client.forceStop().catch(() => undefined);
        return;
      }
      this.#client = client;
      this.#attempt = 0;
      this.#setStatus({ state: "connected", ...base, ...(described.warning ? { message: described.warning } : {}) });
      log.info(previous.state === "connected" ? "Reconnected to Managed Copilot" : "Connected to Managed Copilot", { url: managed.url, environment: this.#config.environment });
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
      log.warn("Lost the connection to Managed Copilot; reconnecting", { error: errorText(error) });
      this.#setStatus({ ...this.#status, state: "reconnecting", message: "Reconnecting to Managed Copilot…" });
      // Connect afresh: the deployment may be back at another address or with other environments.
      const stale = this.#managed;
      this.#managed = undefined;
      this.#client = undefined;
      void client.forceStop().catch(() => undefined);
      void stale?.close().catch(() => undefined);
      void this.#connect();
    }
  }

  #event(event: PlatformEvent): void {
    for (const listener of this.#eventListeners) {
      try {
        listener(event);
      } catch (error) {
        log.warn("A platform event listener failed", { type: event.type, error: errorText(error) });
      }
    }
  }
}
