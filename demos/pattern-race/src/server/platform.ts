// The connection to Managed Copilot: one stock CopilotClient per lane's environment, kept healthy, plus the REST helpers
// the race reads sessions and workers with. Everything here is the public SDK.
import type { AssistantMessageEvent, CopilotClient, MessageOptions, ModelInfo, SessionConfig, SessionEvent, UsageGetMetricsResult } from "@github/copilot-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isManagedCopilotError, ManagedCopilot, ManagedCopilotError, type DeploymentInfo, type PlatformEvent, type SessionInfo, type WorkerInfo } from "@managed-copilot/sdk";
import { OPERATOR_ROUTES, SANDBOX_SIZES, TOKEN_ENVS, type OperatorInfrastructure } from "@managed-copilot/protocol";
import { LANES, laneById, withModel, type LaneId } from "../shared/lanes.js";
import type { LaneAvailability, ModelChoice, PlatformStatus, SandboxUsage } from "../shared/types.js";
import type { RaceConfig } from "./config.js";
import { RaceError } from "./errors.js";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);

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
  /** The model a race uses unless the person picks another, and its display name. */
  readonly model: ModelChoice;
  /** The models the deployment offers that at least one available lane allows. */
  readonly models: readonly ModelChoice[];
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
  /** What a sandbox of `environment` is given (its size), as the deployment declares it. */
  sandboxSize(environment: string): SandboxSize | undefined;
  /** Whether `managed.exec` works in `environment`'s sandboxes, so their usage can be read. */
  measurable(environment: string): boolean;
  /** What a session's sandbox used so far, from its own cgroup; undefined when its counters aren't readable. */
  sandboxUsage(sessionId: string): Promise<SandboxUsage | undefined>;
  /** The shared runtime's process usage (every shared session's); fails in plain words where this account can't see it. */
  runtimeUsage(): Promise<RuntimeReading>;
  /** Deletes the account's sessions in the lanes' environments whose IDs start with `prefix` (a race cut short). */
  deleteLeftovers(prefix: string): Promise<number>;
}

/** One reading of the shared runtime process: CPU time since it started, its memory, and its open shared sessions. */
export interface RuntimeReading {
  readonly cpuMs: number;
  readonly memoryBytes: number;
  readonly peakMemoryBytes?: number;
  readonly sessions: number;
  /** Increments with every new runtime process (its CPU counter starts again). */
  readonly generation: number;
}

/** What the operator API's infrastructure view says about the shared runtime, as far as a race needs. */
export function runtimeReading(infrastructure: Pick<OperatorInfrastructure, "runtime">): RuntimeReading {
  const runtime = infrastructure.runtime;
  if (runtime.state === "disabled") throw new RaceError("runtime_unavailable", "This deployment has no shared runtime.");
  if (!runtime.usage) {
    throw new RaceError(
      "runtime_unavailable",
      runtime.external ? "The shared runtime runs outside the gateway here, so the gateway can't read its usage." : "The gateway doesn't report the shared runtime's usage right now.",
    );
  }
  const { cpuMs, memoryBytes, peakMemoryBytes } = runtime.usage;
  return { cpuMs, memoryBytes, ...(peakMemoryBytes !== undefined ? { peakMemoryBytes } : {}), sessions: runtime.sessions, generation: runtime.generation };
}

async function ghAuthToken(): Promise<string | undefined> {
  const { stdout } = await execFileAsync("gh", ["auth", "token"], { windowsHide: true, timeout: 10_000 });
  return stdout.trim() || undefined;
}

/**
 * This server's GitHub token, found the way `ManagedCopilot.connect()` finds one. It's passed to `connect`, so the one
 * operator route the race reads (the shared runtime's usage) acts as exactly the account the connection does.
 */
export async function resolveGitHubToken(env: Readonly<Record<string, string | undefined>> = process.env, gh: () => Promise<string | undefined> = ghAuthToken): Promise<string> {
  for (const name of TOKEN_ENVS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  const fromGh = await gh().catch(() => undefined);
  if (fromGh) return fromGh;
  throw new ManagedCopilotError("authentication_required", `Sign in with GitHub first: set ${TOKEN_ENVS[0]}, or run \`gh auth login\`.`);
}

const EVENTS = ["session.promoted", "worker.started", "worker.idle", "worker.failed", "worker.stopped"] as const;

/** What a sandbox is given: its vCPUs and memory. */
export interface SandboxSize {
  readonly cpus: number;
  readonly memoryBytes: number;
}

/**
 * Prints a sandbox's own cgroup counters (cgroup v2, else v1): CPU time since it started and its peak and current
 * memory. Every process in the sandbox counts (setup, its runtime, the agent's commands); this read costs a few ms.
 */
const USAGE_PROBE = [
  "c=/sys/fs/cgroup",
  'if [ -r "$c/cpu.stat" ]; then while read -r k v; do [ "$k" = usage_usec ] && echo "cpu_us $v"; done < "$c/cpu.stat"; echo "peak $(cat "$c/memory.peak" 2>/dev/null)"; echo "now $(cat "$c/memory.current" 2>/dev/null)"',
  'else echo "cpu_ns $(cat "$c/cpuacct/cpuacct.usage" 2>/dev/null)"; echo "peak $(cat "$c/memory/memory.max_usage_in_bytes" 2>/dev/null)"; echo "now $(cat "$c/memory/memory.usage_in_bytes" 2>/dev/null)"; fi',
].join("; ");

/** Reads `USAGE_PROBE`'s output; undefined without a CPU reading. */
export function parseUsage(output: string): SandboxUsage | undefined {
  const values = new Map<string, number>();
  for (const line of output.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    const number = Number(value);
    if (key && value && Number.isFinite(number) && number >= 0) values.set(key, number);
  }
  const cpuMs = values.has("cpu_us") ? values.get("cpu_us")! / 1000 : values.has("cpu_ns") ? values.get("cpu_ns")! / 1e6 : undefined;
  if (cpuMs === undefined) return undefined;
  const now = values.get("now");
  return { cpuMs, peakMemoryBytes: Math.max(values.get("peak") ?? 0, now ?? 0), ...(now !== undefined ? { memoryBytes: now } : {}) };
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

/** Which lanes this deployment can race: each lane's environment declared as its pattern needs, and working now (with the models it allows). */
export function describeLanes(info: DeploymentInfo): LaneAvailability[] {
  const capabilities = new Set(info.capabilities);
  return LANES.map((lane): LaneAvailability => {
    const unavailable = (reason: string): LaneAvailability => ({ lane: lane.id, available: false, reason });
    const declared = info.environments.find((environment) => environment.name === lane.environment);
    if (!declared) return unavailable(`This deployment has no "${lane.environment}" environment.`);
    if (declared.type !== lane.type) return unavailable(`"${lane.environment}" is a ${declared.type} environment, not ${lane.type}.`);
    const execution = declared.execution ?? "delegate";
    if (lane.execution && execution !== lane.execution) return unavailable(`"${lane.environment}" works ${execution}, not ${lane.execution}.`);
    const missing = CAPABILITIES[lane.type].filter((capability) => !capabilities.has(capability));
    if (missing.includes("shared")) return unavailable(NOT_RUNNING);
    if (missing.length) return unavailable(NOT_READY);
    const sandboxEnvironment = lane.type === "isolated" ? lane.environment : lane.type === "promotable" ? declared.promoteTo : declared.workers?.[0];
    return { lane: lane.id, available: true, ...(sandboxEnvironment ? { sandboxEnvironment } : {}), ...(declared.models?.length ? { models: [...declared.models] } : {}) };
  });
}

export class Platform implements RacePlatform {
  readonly #config: RaceConfig;
  readonly #isBusy: () => boolean;
  #managed: ManagedCopilot | undefined;
  /** The GitHub token `#managed` connected with; it never leaves this process except to the deployment. */
  #token: string | undefined;
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

  get model(): ModelChoice {
    const id = this.#config.model;
    return { id, name: this.#models.get(id)?.name ?? id };
  }

  get models(): readonly ModelChoice[] {
    // `auto` picks a model per session: lanes on it wouldn't be racing the same model.
    const offered = [...this.#models.values()].filter((model) => model.policy?.state !== "disabled" && model.id !== "auto").map((model) => ({ id: model.id, name: model.name }));
    if (!offered.some((model) => model.id === this.#config.model)) offered.unshift(this.model);
    return offered.filter((model) => this.#lanes.some((lane) => withModel(lane, model).available));
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

  sandboxSize(environment: string): SandboxSize | undefined {
    const declared = this.#managed?.info.environments.find((candidate) => candidate.name === environment);
    const size = declared?.size ? SANDBOX_SIZES[declared.size] : undefined;
    return size ? { cpus: size.cpus, memoryBytes: size.memoryMiB * 1024 ** 2 } : undefined;
  }

  measurable(environment: string): boolean {
    const declared = this.#managed?.info.environments.find((candidate) => candidate.name === environment);
    return declared !== undefined && declared.exec !== false;
  }

  async runtimeUsage(): Promise<RuntimeReading> {
    const managed = this.#requireManaged();
    let response: Response;
    try {
      response = await fetch(new URL(OPERATOR_ROUTES.infrastructure, managed.url), {
        headers: { authorization: `Bearer ${this.#token}`, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new RaceError("runtime_unavailable", `Couldn't ask for the shared runtime's usage: ${(error as Error).message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new RaceError("runtime_unavailable", `Only operators of this deployment can see the shared runtime's usage, and @${managed.account.login} isn't one.`);
    }
    if (!response.ok) throw new RaceError("runtime_unavailable", `The gateway answered ${response.status} when asked for the shared runtime's usage.`);
    return runtimeReading((await response.json()) as OperatorInfrastructure);
  }

  async sandboxUsage(sessionId: string): Promise<SandboxUsage | undefined> {
    const result = await this.#requireManaged().exec(sessionId, USAGE_PROBE, { timeoutMs: 15_000 });
    return result.exitCode === 0 ? parseUsage(result.output) : undefined;
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
      const token = await resolveGitHubToken();
      const connecting = ManagedCopilot.connect({ clientName: "pattern-race", gitHubToken: token });
      try {
        managed = await deadline(connecting, 20_000, "Managed Copilot");
      } catch (error) {
        // A connection that completes after the deadline is closed, not leaked.
        void connecting.then((late) => late.close()).catch(() => undefined);
        throw error;
      }
      const lanes = describeLanes(managed.info);
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
      const models = await this.#readModels([...clients.values()]);
      if (this.#stopped) throw new Error("stopped");
      for (const type of EVENTS) managed.on(type, (event) => this.#event(event));
      this.#managed = managed;
      this.#token = token;
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

  /** The deployment's models (names and multipliers), read once per connection through every lane's client: each lists the models its environment allows. */
  async #readModels(clients: readonly CopilotClient[]): Promise<Map<string, ModelInfo>> {
    const models = new Map<string, ModelInfo>();
    const lists = await Promise.allSettled(clients.map((client) => deadline(client.listModels(), 15_000, "Listing models")));
    for (const list of lists) {
      if (list.status === "fulfilled") for (const model of list.value) if (!models.has(model.id)) models.set(model.id, model);
    }
    const failed = lists.find((list): list is PromiseRejectedResult => list.status === "rejected");
    if (failed && models.size === 0) log.warn("Couldn't list models; showing model IDs", { error: (failed.reason as Error).message });
    return models;
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
