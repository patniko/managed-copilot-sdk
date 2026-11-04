// The connection to Managed Copilot: one stock CopilotClient per lane's environment, kept healthy, plus the REST helpers
// the race reads sessions and workers with. Everything here is the public SDK.
import type { AssistantMessageEvent, CopilotClient, MessageOptions, ModelInfo, SessionConfig, SessionEvent, UsageGetMetricsResult } from "@github/copilot-sdk";
import { isManagedCopilotError, ManagedCopilot, type DeploymentInfo, type PlatformEvent, type SessionInfo, type WorkerInfo } from "@managed-copilot/sdk";
import { LANES, laneById, type LaneId } from "../shared/lanes.js";
import type { LaneAvailability, PlatformStatus } from "../shared/types.js";
import type { RaceConfig } from "./config.js";
import { RaceError } from "./errors.js";
import { log } from "./log.js";

/** The parts of a stock `CopilotSession` a lane uses. */
export interface LaneSession {
  readonly sessionId: string;
  on(handler: (event: SessionEvent) => void): () => void;
  sendAndWait(options: MessageOptions, timeout?: number): Promise<AssistantMessageEvent | undefined>;
  abort(): Promise<void>;
  readonly rpc: { readonly usage: { getMetrics(): Promise<UsageGetMetricsResult> } };
}

/** What a race needs from Managed Copilot. Implemented by `Platform`; faked in tests. */
export interface RacePlatform {
  readonly status: PlatformStatus;
  readonly lanes: readonly LaneAvailability[];
  /** The model every lane asks for, and its display name. */
  readonly model: { readonly id: string; readonly name: string };
  /** A model's premium request multiplier, when the deployment reports one. */
  multiplier(model: string): number | undefined;
  /** Status or lane availability changed. */
  onChange(listener: () => void): () => void;
  /** `session.promoted` and `worker.*` platform events. */
  onEvent(listener: (event: PlatformEvent) => void): () => void;
  createSession(lane: LaneId, config: SessionConfig): Promise<LaneSession>;
  deleteSession(lane: LaneId, sessionId: string): Promise<void>;
  sessionInfo(sessionId: string): Promise<SessionInfo>;
  workers(sessionId: string): Promise<WorkerInfo[]>;
  /** Deletes the account's sessions in the lanes' environments whose IDs start with `prefix` (a race cut short). */
  deleteLeftovers(prefix: string): Promise<number>;
}

const EVENTS = ["session.promoted", "worker.started", "worker.idle", "worker.failed", "worker.stopped"] as const;

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
  if (isManagedCopilotError(error, "authentication_required")) return "Sign in to GitHub (gh auth login) or set GH_TOKEN, then Pattern Race connects by itself.";
  if (isManagedCopilotError(error, "forbidden")) return "This GitHub account can't use this Managed Copilot deployment.";
  const message = (error as Error)?.message ?? String(error);
  if (/cannot reach|ECONNREFUSED|fetch failed|ENOTFOUND|did not answer/i.test(message)) return "Managed Copilot isn't reachable yet. Start it with `aspire run`, or set MANAGED_COPILOT_URL.";
  return message;
}

const CAPABILITIES: Record<"shared" | "isolated" | "promotable" | "orchestrator", readonly string[]> = {
  shared: ["shared"],
  isolated: ["isolated"],
  promotable: ["shared", "promotion"],
  orchestrator: ["shared", "orchestrator"],
};

/** Reasons that can clear up by themselves (Docker starting, say), so the platform looks again between races. */
const NOT_RUNNING = "The shared runtime isn't running on this deployment.";
const NOT_READY = "Sandboxes aren't ready on this deployment yet.";

/** Which lanes this deployment can race: each lane's environment declared as its pattern needs, allowing the model, and working now. */
export function describeLanes(info: DeploymentInfo, model: string): LaneAvailability[] {
  const capabilities = new Set(info.capabilities);
  return LANES.map((lane): LaneAvailability => {
    const unavailable = (reason: string): LaneAvailability => ({ lane: lane.id, available: false, reason });
    const declared = info.environments.find((environment) => environment.name === lane.environment);
    if (!declared) return unavailable(`This deployment has no "${lane.environment}" environment.`);
    if (declared.type !== lane.type) return unavailable(`"${lane.environment}" is a ${declared.type} environment, not ${lane.type}.`);
    const execution = declared.execution ?? "delegate";
    if (lane.execution && execution !== lane.execution) return unavailable(`"${lane.environment}" works ${execution}, not ${lane.execution}.`);
    if (declared.models?.length && !declared.models.includes(model)) return unavailable(`"${lane.environment}" doesn't allow ${model}, the model every lane uses.`);
    const missing = CAPABILITIES[lane.type].filter((capability) => !capabilities.has(capability));
    if (missing.includes("shared")) return unavailable(NOT_RUNNING);
    if (missing.length) return unavailable(NOT_READY);
    const sandboxEnvironment = lane.type === "isolated" ? lane.environment : lane.type === "promotable" ? declared.promoteTo : declared.workers?.[0];
    return { lane: lane.id, available: true, ...(sandboxEnvironment ? { sandboxEnvironment } : {}) };
  });
}

export class Platform implements RacePlatform {
  readonly #config: RaceConfig;
  readonly #isBusy: () => boolean;
  #managed: ManagedCopilot | undefined;
  #clients = new Map<LaneId, CopilotClient>();
  #status: PlatformStatus = { state: "connecting" };
  #lanes: LaneAvailability[] = LANES.map((lane) => ({ lane: lane.id, available: false, reason: "Connecting to Managed Copilot…" }));
  #models = new Map<string, ModelInfo>();
  readonly #changeListeners = new Set<() => void>();
  readonly #eventListeners = new Set<(event: PlatformEvent) => void>();
  #attempt = 0;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #connecting: Promise<void> | undefined;

  /** `isBusy` tells whether a race is running: lanes that weren't ready are looked at again only between races. */
  constructor(config: RaceConfig, isBusy: () => boolean = () => false) {
    this.#config = config;
    this.#isBusy = isBusy;
  }

  get status(): PlatformStatus {
    return this.#status;
  }

  get lanes(): readonly LaneAvailability[] {
    return this.#lanes;
  }

  get model(): { readonly id: string; readonly name: string } {
    const id = this.#config.model;
    return { id, name: this.#models.get(id)?.name ?? id };
  }

  multiplier(model: string): number | undefined {
    return this.#models.get(model)?.billing?.multiplier;
  }

  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
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
    await this.#release();
  }

  async createSession(lane: LaneId, config: SessionConfig): Promise<LaneSession> {
    return this.#client(lane).createSession(config);
  }

  async deleteSession(lane: LaneId, sessionId: string): Promise<void> {
    await this.#client(lane).deleteSession(sessionId);
  }

  sessionInfo(sessionId: string): Promise<SessionInfo> {
    return this.#requireManaged().sessions.get(sessionId);
  }

  workers(sessionId: string): Promise<WorkerInfo[]> {
    return this.#requireManaged().workers(sessionId).list();
  }

  async deleteLeftovers(prefix: string): Promise<number> {
    const managed = this.#requireManaged();
    let deleted = 0;
    for (const environment of new Set(LANES.map((lane) => lane.environment))) {
      if (!managed.info.environments.some((candidate) => candidate.name === environment)) continue;
      for (const session of await managed.sessions.list({ environment, limit: 200 })) {
        if (!session.id.startsWith(prefix)) continue;
        await managed.sessions.delete(session.id);
        deleted++;
      }
    }
    return deleted;
  }

  #requireManaged(): ManagedCopilot {
    if (!this.#managed || this.#status.state !== "connected") throw new RaceError("platform_unavailable", this.#status.message ?? "Managed Copilot isn't connected yet.", 503);
    return this.#managed;
  }

  #client(lane: LaneId): CopilotClient {
    this.#requireManaged();
    const client = this.#clients.get(lane);
    if (!client) {
      const reason = this.#lanes.find((candidate) => candidate.lane === lane)?.reason;
      throw new RaceError("lane_unavailable", reason ?? `The ${laneById(lane).pattern} lane isn't available on this deployment.`, 503);
    }
    return client;
  }

  #changed(): void {
    for (const listener of this.#changeListeners) listener();
  }

  #setStatus(status: PlatformStatus): void {
    this.#status = status;
    this.#changed();
  }

  async #release(): Promise<void> {
    const clients = [...this.#clients.values()];
    const managed = this.#managed;
    this.#clients = new Map();
    this.#managed = undefined;
    await Promise.all(clients.map((client) => deadline(client.forceStop(), 5_000, "Stopping a client").catch(() => undefined)));
    await managed?.close().catch(() => undefined);
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
    await this.#release();
    let managed: ManagedCopilot | undefined;
    const clients = new Map<LaneId, CopilotClient>();
    try {
      const connecting = ManagedCopilot.connect({ clientName: "pattern-race" });
      try {
        managed = await deadline(connecting, 20_000, "Managed Copilot");
      } catch (error) {
        // A connection that completes after the deadline is closed, not leaked.
        void connecting.then((late) => late.close()).catch(() => undefined);
        throw error;
      }
      const lanes = describeLanes(managed.info, this.#config.model);
      await Promise.all(
        lanes
          .filter((lane) => lane.available)
          .map(async ({ lane }) => {
            const starting = managed!.client(laneById(lane).environment);
            try {
              clients.set(lane, await deadline(starting, 30_000, "Starting a client"));
            } catch (error) {
              // A client that finishes starting after the deadline is stopped, not leaked.
              void starting.then((late) => late.forceStop()).catch(() => undefined);
              throw error;
            }
          }),
      );
      const models = await this.#readModels([...clients.values()][0]);
      if (this.#stopped) throw new Error("stopped");
      for (const type of EVENTS) managed.on(type, (event) => this.#event(event));
      this.#managed = managed;
      this.#clients = clients;
      this.#lanes = lanes;
      this.#models = models;
      this.#attempt = 0;
      const account = managed.account;
      this.#setStatus({
        state: "connected",
        url: managed.url,
        mode: managed.info.mode,
        deployment: managed.info.name,
        account: { login: account.login, ...(account.name ? { name: account.name } : {}), ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}) },
      });
      log.info(previous.state === "connected" ? "Reconnected to Managed Copilot" : "Connected to Managed Copilot", {
        url: managed.url,
        lanes: lanes.map((lane) => `${lane.lane}=${lane.available ? "ready" : "unavailable"}`).join(" "),
      });
      this.#schedule(0);
    } catch (error) {
      await Promise.all([...clients.values()].map((client) => client.forceStop().catch(() => undefined)));
      await managed?.close().catch(() => undefined);
      if (this.#stopped) return;
      const message = describeConnectError(error);
      log.warn("Managed Copilot isn't available", { error: message });
      this.#lanes = LANES.map((lane) => ({ lane: lane.id, available: false, reason: message }));
      this.#setStatus({ ...previous, state: previous.state === "connected" || previous.state === "reconnecting" ? "reconnecting" : "unavailable", message });
      this.#schedule(++this.#attempt);
    }
  }

  /** The deployment's models (names and multipliers), read once per connection. */
  async #readModels(client: CopilotClient | undefined): Promise<Map<string, ModelInfo>> {
    if (!client) return new Map();
    try {
      const models = await deadline(client.listModels(), 15_000, "Listing models");
      return new Map(models.map((model) => [model.id, model]));
    } catch (error) {
      log.warn("Couldn't list models; showing model IDs", { error: (error as Error).message });
      return new Map();
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
    if (this.#stopped) return;
    // Lanes waiting on the deployment (sandboxes still starting, say) are looked at again between races.
    const waiting = this.#lanes.some((lane) => lane.reason === NOT_READY || lane.reason === NOT_RUNNING);
    if (waiting && !this.#isBusy()) return void this.#connect();
    try {
      await Promise.all([...this.#clients.values()].map((client) => deadline(client.ping(), 8_000, "Managed Copilot")));
      this.#schedule(0);
    } catch (error) {
      if (this.#stopped) return;
      log.warn("Lost the connection to Managed Copilot; reconnecting", { error: (error as Error).message });
      this.#setStatus({ ...this.#status, state: "reconnecting", message: "Reconnecting to Managed Copilot…" });
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
