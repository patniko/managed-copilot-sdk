// The connection to Managed Copilot: one stock CopilotClient for the research-swarm orchestrator environment, kept
// healthy, plus the platform events and REST reads a run needs. Everything here is the public SDK.
import type { CopilotClient, MessageOptions, SessionConfig } from "@github/copilot-sdk";
import { SANDBOX_SIZES } from "@managed-copilot/protocol";
import { isManagedCopilotError, ManagedCopilot, type DeploymentInfo, type PlatformEvent, type SessionInfo, type WorkerInfo } from "@managed-copilot/sdk";
import type { PlatformStatus, SwarmInfo } from "../shared/types.js";
import type { SwarmConfig } from "./config.js";
import { SwarmError } from "./errors.js";
import { log } from "./log.js";

/** The parts of a stock `CopilotSession` a run uses. */
export interface LeadSession {
  readonly sessionId: string;
  send(options: MessageOptions): Promise<string>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

/** What runs need from Managed Copilot. Implemented by `Platform`; faked in tests. */
export interface SwarmPlatform {
  readonly status: PlatformStatus;
  readonly swarm: SwarmInfo | undefined;
  onStatus(listener: (status: PlatformStatus) => void): () => void;
  /** Worker and network events of the caller's sessions. */
  onEvent(listener: (event: PlatformEvent) => void): () => void;
  createSession(config: SessionConfig): Promise<LeadSession>;
  deleteSession(sessionId: string): Promise<void>;
  workers(sessionId: string): Promise<WorkerInfo[]>;
  readFile(sessionId: string, path: string): Promise<string>;
  sessionInfo(sessionId: string): Promise<SessionInfo>;
}

const EVENTS = ["worker.started", "worker.idle", "worker.failed", "worker.stopped", "network.blocked"] as const;

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
    if (error.code === "authentication_required") return "Sign in to GitHub (gh auth login) or set GH_TOKEN, then Research Swarm connects by itself.";
    if (error.code === "forbidden") return "This GitHub account can't use this Managed Copilot deployment.";
    return error.message;
  }
  const message = (error as Error)?.message ?? String(error);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|did not answer/i.test(message)) return "Managed Copilot isn't reachable yet. Start it with `aspire run`, or set MANAGED_COPILOT_URL.";
  return message;
}

/** The lead's environment and its researchers' environment, as the deployment declares them. */
export function describeSwarm(info: DeploymentInfo, config: Pick<SwarmConfig, "environment" | "model" | "researcherModel">): { swarm?: SwarmInfo; problem?: string } {
  const lead = info.environments.find((environment) => environment.name === config.environment);
  if (!lead) return { problem: `This deployment has no "${config.environment}" environment. Add Research Swarm's environments to the AppHost (demos/research-swarm/apphost.mts).` };
  if (lead.type !== "orchestrator") return { problem: `"${config.environment}" is a ${lead.type} environment; Research Swarm needs an orchestrator.` };
  if ((lead.execution ?? "delegate") !== "delegate") return { problem: `"${config.environment}" is declared with execution "${lead.execution}"; Research Swarm's lead delegates to researchers.` };
  const workers = info.environments.find((environment) => environment.name === lead.workers?.[0]);
  if (!workers) return { problem: `"${config.environment}" names no researcher environment for its workers.` };
  const size = workers.size ?? "small";
  const swarm: SwarmInfo = {
    lead: { environment: lead.name, model: config.model },
    researchers: {
      environment: workers.name,
      model: config.researcherModel,
      max: lead.maxWorkers ?? 4,
      ...(size in SANDBOX_SIZES ? { size } : {}),
      hosts: workers.network.access === "restricted" ? [...workers.network.allowedDomains] : [],
    },
  };
  if (!info.capabilities.includes("orchestrator")) return { swarm, problem: "Sandboxes aren't ready on this deployment yet. Research Swarm keeps checking." };
  return { swarm };
}

export class Platform implements SwarmPlatform {
  readonly #config: SwarmConfig;
  #managed: ManagedCopilot | undefined;
  #client: CopilotClient | undefined;
  #status: PlatformStatus = { state: "connecting" };
  #swarm: SwarmInfo | undefined;
  readonly #statusListeners = new Set<(status: PlatformStatus) => void>();
  readonly #eventListeners = new Set<(event: PlatformEvent) => void>();
  #attempt = 0;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #connecting: Promise<void> | undefined;

  constructor(config: SwarmConfig) {
    this.#config = config;
  }

  get status(): PlatformStatus {
    return this.#status;
  }

  get swarm(): SwarmInfo | undefined {
    return this.#swarm;
  }

  onStatus(listener: (status: PlatformStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
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
    if (client) await deadline(client.forceStop(), 5_000, "Stopping the client").catch(() => undefined);
    await this.#managed?.close().catch(() => undefined);
  }

  async createSession(config: SessionConfig): Promise<LeadSession> {
    this.#requireManaged();
    if (!this.#client) throw new SwarmError("upstream_unavailable", "Managed Copilot isn't connected yet.");
    return this.#client.createSession(config);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#requireManaged().sessions.delete(sessionId);
  }

  workers(sessionId: string): Promise<WorkerInfo[]> {
    return this.#requireManaged().workers(sessionId).list();
  }

  readFile(sessionId: string, path: string): Promise<string> {
    return this.#requireManaged().files(sessionId).read(path);
  }

  sessionInfo(sessionId: string): Promise<SessionInfo> {
    return this.#requireManaged().sessions.get(sessionId);
  }

  #requireManaged(): ManagedCopilot {
    if (!this.#managed || this.#status.state !== "connected") throw new SwarmError("upstream_unavailable", this.#status.message ?? "Managed Copilot isn't connected yet.");
    return this.#managed;
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
        const connecting = ManagedCopilot.connect({ clientName: "research-swarm" });
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
      const described = describeSwarm(managed.info, this.#config);
      this.#swarm = described.swarm;
      const account = managed.account;
      const base = {
        url: managed.url,
        mode: managed.info.mode,
        deployment: managed.info.name,
        account: { login: account.login, ...(account.name ? { name: account.name } : {}), ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}) },
      };
      if (described.problem) {
        this.#setStatus({ state: "unavailable", ...base, message: described.problem });
        // The deployment can change (for example sandboxes coming up): check again, and re-read its description.
        this.#managed = undefined;
        await managed.close().catch(() => undefined);
        this.#schedule(++this.#attempt);
        return;
      }
      const old = this.#client;
      this.#client = undefined;
      if (old) await deadline(old.forceStop(), 5_000, "Stopping the old client").catch(() => undefined);
      const starting = managed.client(this.#config.environment);
      let client: CopilotClient;
      try {
        client = await deadline(starting, 30_000, "Starting the lead's client");
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
      this.#setStatus({ state: "connected", ...base });
      log.info(previous.state === "connected" ? "Reconnected to Managed Copilot" : "Connected to Managed Copilot", { url: managed.url, environment: this.#config.environment });
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
        log.warn("A platform event listener failed", { error: (error as Error).message });
      }
    }
  }
}
