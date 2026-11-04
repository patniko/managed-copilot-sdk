// Runs one job in every lane at once: a real session per lane in its pattern's environment, observed through its own
// events, its usage, the platform's events, and its workers. Each lane's code differs only in the environment name.
import { approveAll, type PermissionHandler, type SessionEvent, type UsageGetMetricsResult } from "@github/copilot-sdk";
import { isManagedCopilotError, type PlatformEvent, type WorkerEventData, type WorkerInfo } from "@managed-copilot/sdk";
import { jobById, type Check, type JobId } from "../shared/jobs.js";
import { LANES, type Lane, type LaneId } from "../shared/lanes.js";
import type { LaneRun, RaceSnapshot, SandboxState, SandboxToken } from "../shared/types.js";
import { expectedValue, judge } from "./checks.js";
import type { RaceConfig } from "./config.js";
import { errorText, RaceError } from "./errors.js";
import { log } from "./log.js";
import type { LaneSession, RacePlatform } from "./platform.js";
import type { RaceStore } from "./store.js";

/** Every lane session's ID starts with this, so sessions a crash left behind are found and deleted. */
export const SESSION_PREFIX = "pattern-race-";

const ANSWER_LIMIT = 8_000;
const ACTIVITY_LIMIT = 120;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface RaceManagerOptions {
  readonly platform: RacePlatform;
  readonly config: Pick<RaceConfig, "laneTimeoutMs" | "pollIntervalMs">;
  readonly store?: RaceStore;
  readonly now?: () => number;
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function argument(args: unknown, key: string): string {
  const value = args && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : "";
}

/** What a tool call is doing, in a few words. */
export function describeTool(name: string, args: unknown): string {
  switch (name) {
    case "bash":
      return `$ ${argument(args, "command").split("\n")[0]}`;
    case "read_bash":
    case "write_bash":
      return "Following a command";
    case "create":
      return `Writing ${argument(args, "path")}`;
    case "edit":
      return `Editing ${argument(args, "path")}`;
    case "view":
      return `Reading ${argument(args, "path")}`;
    case "request_sandbox":
      return "Moving into a sandbox";
    case "start_worker":
      return `Starting worker ${argument(args, "name")}`;
    case "message_worker":
      return `Messaging ${argument(args, "worker")}`;
    case "wait_for_workers":
      return "Waiting for workers";
    case "read_worker_file":
    case "copy_worker_files":
      return "Reading a worker's files";
    case "stop_worker":
      return `Stopping ${argument(args, "worker")}`;
    case "task":
      return "Starting a sub-agent";
    case "read_agent":
      return "Reading a sub-agent's result";
    case "web_fetch":
      return `Fetching ${argument(args, "url")}`;
    default:
      return name.replace(/_/g, " ");
  }
}

/** A failure in plain words, one line. */
function describeFailure(error: unknown, timeoutMs: number): string {
  if (isManagedCopilotError(error)) return clip(error.message, 240);
  const message = errorText(error);
  if (/timeout after|timed out/i.test(message)) return `It didn't finish within ${Math.round(timeoutMs / 60_000)} minutes.`;
  return clip(message, 240);
}

const WORKER_STATES: Readonly<Record<string, SandboxState>> = { starting: "starting", working: "working", idle: "idle", failed: "failed", stopped: "stopped" };

type Usage = Pick<UsageGetMetricsResult, "totalPremiumRequestCost" | "totalUserRequests" | "modelMetrics">;

/** One lane of one race: its session, what it does, and what it uses. */
class LaneRunner {
  readonly lane: Lane;
  /** The environment its own sandbox comes from (isolated: its own; promotable: its `promoteTo`). */
  readonly #sandboxEnvironment: string;
  readonly #run: Mutable<LaneRun>;
  readonly #changed: () => void;
  session: LaneSession | undefined;
  stopping = false;
  /** A read of its usage and workers in flight. */
  observation: Promise<void> | undefined;
  /** Its `request_sandbox` call while a promotable lane moves into its own sandbox. */
  #moving: string | undefined;
  /** Tool calls in progress, oldest first: the newest is what the lane is doing. */
  readonly #tools = new Map<string, string>();
  readonly #subagents = new Set<string>();
  readonly #workers = new Map<string, WorkerInfo>();
  /** Premium requests per user request its session measured: the multiplier of a model the deployment didn't describe. */
  #measuredRate: number | undefined;

  constructor(lane: Lane, sandboxEnvironment: string | undefined, changed: () => void) {
    this.lane = lane;
    this.#sandboxEnvironment = sandboxEnvironment ?? lane.environment;
    this.#changed = changed;
    this.#run = { lane: lane.id, status: "ready", brain: lane.brain, subagents: 0, sandboxes: [], premium: { session: 0, workers: 0 }, modelCalls: 0, approvals: 0 };
  }

  get run(): LaneRun {
    return { ...this.#run, premium: { ...this.#run.premium } };
  }

  get running(): boolean {
    return this.#run.status === "starting" || this.#run.status === "thinking" || this.#run.status === "working";
  }

  update(patch: Partial<LaneRun>): void {
    Object.assign(this.#run, patch);
    this.#changed();
  }

  /** Approves what the lane asks for: every request acts only in its own sandboxes, within its environment's rules. */
  readonly approve: PermissionHandler = async (request, invocation) => {
    const result = await approveAll(request, invocation);
    const decision = result.kind === "attributed" ? result.result : result;
    if (decision.kind.startsWith("approve")) this.update({ approvals: this.#run.approvals + 1 });
    return result;
  };

  #upsertSandbox(token: SandboxToken): void {
    const index = this.#run.sandboxes.findIndex((candidate) => candidate.id === token.id);
    this.update({ sandboxes: index === -1 ? [...this.#run.sandboxes, token] : this.#run.sandboxes.map((candidate, i) => (i === index ? token : candidate)) });
  }

  /** The lane's own sandbox: isolated from the start (`pending` while it's created), promotable once it moved. */
  ownSandbox(id: string, state: SandboxState): void {
    this.#run.sandboxes = this.#run.sandboxes.filter((candidate) => candidate.kind !== "own" || candidate.id === id);
    this.#upsertSandbox({ id, kind: "own", name: "Its own sandbox", state, environment: this.#sandboxEnvironment });
  }

  onEvent(event: SessionEvent): void {
    switch (event.type) {
      case "assistant.turn_start":
        if (!event.agentId && this.#tools.size === 0) this.#activity("thinking", "Thinking");
        break;
      case "tool.execution_start": {
        const { toolName, toolCallId } = event.data;
        if (toolName === "report_intent") {
          const intent = argument(event.data.arguments, "intent");
          if (intent && this.#tools.size === 0) this.#activity("thinking", intent);
          break;
        }
        const activity = describeTool(toolName, event.data.arguments);
        this.#tools.set(toolCallId, activity);
        this.#activity("working", activity);
        // The sandbox it asked for appears at once, starting; the platform's `session.promoted` replaces it.
        if (toolName === "request_sandbox" && this.#run.brain === "runtime") {
          this.#moving = toolCallId;
          this.ownSandbox("pending", "starting");
        }
        break;
      }
      case "tool.execution_complete": {
        if (event.data.toolCallId === this.#moving) {
          this.#moving = undefined;
          if (!event.data.success && this.#run.brain === "runtime") this.update({ sandboxes: this.#run.sandboxes.filter((token) => token.id !== "pending") });
        }
        if (!this.#tools.delete(event.data.toolCallId)) break;
        const latest = [...this.#tools.values()].at(-1);
        this.#activity(latest ? "working" : "thinking", latest ?? "Thinking");
        break;
      }
      case "subagent.started":
        if (event.agentId && !this.#subagents.has(event.agentId)) {
          this.#subagents.add(event.agentId);
          this.update({ subagents: this.#subagents.size });
        }
        break;
    }
  }

  #activity(status: "thinking" | "working", activity: string): void {
    if (!this.running || this.stopping) return;
    this.update({ status, activity: clip(activity, ACTIVITY_LIMIT) });
  }

  /** A promotable lane moved into its own sandbox (`session.promoted`, or its placement when that event was missed). */
  moved(sandboxId: string): void {
    if (this.#run.brain === "sandbox") return;
    this.update({ brain: "sandbox" });
    this.ownSandbox(sandboxId, "working");
  }

  /** A `worker.*` platform event of this lane's coordinator. */
  workerEvent(data: WorkerEventData): void {
    this.#upsertSandbox({ id: data.workerId, kind: data.role === "hands" ? "hands" : "worker", name: data.name, state: WORKER_STATES[data.state] ?? "working", environment: data.environment });
  }

  /** The coordinator's workers and hands sandboxes, as the platform lists them. */
  workers(list: readonly WorkerInfo[]): void {
    for (const worker of list) {
      this.#workers.set(worker.id, worker);
      this.#upsertSandbox({ id: worker.id, kind: worker.role === "hands" ? "hands" : "worker", name: worker.name, state: WORKER_STATES[worker.state] ?? "working", environment: worker.environment });
    }
  }

  /** What the lane's own session reported: premium requests, and model calls (its sub-agents' included). */
  usage(metrics: Usage): void {
    const modelCalls = Object.values(metrics.modelMetrics).reduce((sum, model) => sum + (model?.requests.count ?? 0), 0);
    if (metrics.totalUserRequests > 0) this.#measuredRate = metrics.totalPremiumRequestCost / metrics.totalUserRequests;
    this.update({ premium: { ...this.#run.premium, session: metrics.totalPremiumRequestCost }, modelCalls });
  }

  /** Workers are sessions of their own: one premium request per message each received, at its model's multiplier. */
  workerPremium(multiplier: (model: string) => number | undefined, laneModel: string): void {
    let total = 0;
    for (const worker of this.#workers.values()) {
      if (worker.role === "hands") continue;
      const model = worker.model ?? laneModel;
      const rate = multiplier(model) ?? (model === laneModel ? this.#measuredRate : undefined);
      if (rate === undefined) log.warn("No premium request multiplier for a worker's model; counting it at 1", { model });
      total += worker.messages * (rate ?? 1);
    }
    if (total !== this.#run.premium.workers) this.update({ premium: { ...this.#run.premium, workers: total } });
  }

  /** Ends the lane at `at`, when its answer arrived, it failed, or the race stopped. */
  finish(patch: Partial<LaneRun>, at: number): void {
    this.#tools.clear();
    delete this.#run.activity;
    this.update({ ...patch, finishedAt: at });
  }

  /** Its session was deleted, and its sandboxes, hands sandboxes, and workers with it. */
  sandboxesDeleted(): void {
    this.update({ sandboxes: this.#run.sandboxes.map((token) => ({ ...token, state: "stopped" })) });
  }
}

interface ActiveRace {
  readonly id: string;
  readonly job: JobId;
  readonly model: string;
  readonly expected: readonly string[];
  readonly startedAt: number;
  finishedAt?: number;
  state: RaceSnapshot["state"];
  readonly runners: readonly LaneRunner[];
  readonly skipped: ReadonlyMap<LaneId, string>;
  readonly done: Promise<void>;
}

export class RaceManager {
  readonly #platform: RacePlatform;
  readonly #config: RaceManagerOptions["config"];
  readonly #store: RaceStore | undefined;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: () => void;
  #active: ActiveRace | undefined;
  #last: RaceSnapshot | undefined;

  constructor(options: RaceManagerOptions) {
    this.#platform = options.platform;
    this.#config = options.config;
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#last = this.#store?.load();
    this.#unsubscribe = this.#platform.onEvent((event) => this.#platformEvent(event));
  }

  get running(): boolean {
    return this.#active?.state === "running";
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The race running now, or the last one. */
  snapshot(): RaceSnapshot | undefined {
    const race = this.#active;
    if (!race) return this.#last;
    return {
      id: race.id,
      job: race.job,
      model: race.model,
      expected: race.expected,
      startedAt: race.startedAt,
      ...(race.finishedAt !== undefined ? { finishedAt: race.finishedAt } : {}),
      state: race.state,
      lanes: LANES.map((lane): LaneRun => {
        const runner = race.runners.find((candidate) => candidate.lane.id === lane.id);
        if (runner) return runner.run;
        return {
          lane: lane.id,
          status: "skipped",
          brain: lane.brain,
          subagents: 0,
          sandboxes: [],
          premium: { session: 0, workers: 0 },
          modelCalls: 0,
          approvals: 0,
          error: race.skipped.get(lane.id) ?? "Not available on this deployment.",
        };
      }),
    };
  }

  /** Starts a race of `job` in every lane this deployment can race. */
  start(jobId: JobId): RaceSnapshot {
    if (this.running) throw new RaceError("race_running", "A race is already running. Stop it or wait for it to finish.", 409);
    if (this.#platform.status.state !== "connected") throw new RaceError("platform_unavailable", this.#platform.status.message ?? "Managed Copilot isn't connected yet.", 503);
    const available = new Set(this.#platform.lanes.filter((lane) => lane.available).map((lane) => lane.lane));
    if (available.size === 0) throw new RaceError("lanes_unavailable", "This deployment can't race any lane right now.", 503);
    const job = jobById(jobId);
    const changed = () => this.#changed();
    const lanes = new Map(this.#platform.lanes.map((lane) => [lane.lane, lane] as const));
    const runners = LANES.filter((lane) => available.has(lane.id)).map((lane) => new LaneRunner(lane, lanes.get(lane.id)?.sandboxEnvironment, changed));
    const skipped = new Map(this.#platform.lanes.filter((lane) => !lane.available).map((lane) => [lane.lane, lane.reason ?? "Not available on this deployment."] as const));
    let settle!: () => void;
    const race: ActiveRace = {
      id: `${this.#now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      job: jobId,
      model: this.#platform.model.id,
      expected: job.checks.map((check) => expectedValue(check.expect)),
      startedAt: this.#now(),
      state: "running",
      runners,
      skipped,
      done: new Promise<void>((resolve) => (settle = resolve)),
    };
    this.#active = race;
    log.info("Race started", { race: race.id, job: jobId, lanes: runners.map((runner) => runner.lane.id).join(",") });
    void Promise.all(runners.map((runner) => this.#runLane(race, runner, job.prompt, job.checks))).then(() => {
      race.finishedAt = this.#now();
      if (race.state === "running") race.state = "finished";
      const snapshot = this.snapshot()!;
      this.#last = snapshot;
      this.#store?.save(snapshot);
      log.info("Race finished", { race: race.id, state: race.state, places: snapshot.lanes.filter((lane) => lane.place).map((lane) => `${lane.place}.${lane.lane}`).join(" ") });
      this.#changed();
      settle();
    });
    this.#changed();
    return this.snapshot()!;
  }

  /** Stops the running race: every lane's turn is cancelled, then its session deleted in the background. */
  stop(): void {
    const race = this.#active;
    if (!race || race.state !== "running") throw new RaceError("not_running", "No race is running.", 409);
    race.state = "stopped";
    for (const runner of race.runners) {
      if (!runner.running) continue;
      runner.stopping = true;
      runner.finish({ status: "stopped", verdict: "failed" }, this.#now());
      void runner.session?.abort().catch(() => undefined);
    }
    log.info("Race stopped", { race: race.id });
    this.#changed();
  }

  /** Server shutdown: stops a running race and waits until its sessions are deleted. */
  async close(): Promise<void> {
    this.#unsubscribe();
    const race = this.#active;
    if (!race) return;
    if (race.state === "running") this.stop();
    await race.done;
  }

  /** Deletes sessions a race left behind when the server stopped mid-race. */
  async deleteLeftovers(): Promise<void> {
    if (this.running) return;
    try {
      const deleted = await this.#platform.deleteLeftovers(SESSION_PREFIX);
      if (deleted > 0) log.info("Deleted sessions an interrupted race left behind", { sessions: deleted });
    } catch (error) {
      log.warn("Couldn't check for sessions an interrupted race left behind", { error: errorText(error) });
    }
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  async #runLane(race: ActiveRace, runner: LaneRunner, prompt: string, checks: readonly Check[]): Promise<void> {
    const { lane } = runner;
    const platform = this.#platform;
    runner.update({ status: "starting", activity: lane.type === "isolated" ? "Starting its sandbox" : "Starting its session" });
    if (lane.type === "isolated") runner.ownSandbox("pending", "starting");
    let poll: NodeJS.Timeout | undefined;
    try {
      const session = await platform.createSession(lane.id, { sessionId: `${SESSION_PREFIX}${race.id}-${lane.id}`, model: race.model, onPermissionRequest: runner.approve });
      runner.session = session;
      if (runner.stopping) return;
      runner.update({ sessionId: session.sessionId });
      session.on((event) => runner.onEvent(event));
      if (lane.type === "isolated") {
        const info = await platform.sessionInfo(session.sessionId);
        runner.ownSandbox(info.sandbox?.id ?? session.sessionId, "working");
      }
      runner.update({ status: "thinking", activity: "Thinking" });
      poll = setInterval(() => void this.#observe(runner), this.#config.pollIntervalMs);
      const reply = await session.sendAndWait({ prompt }, this.#config.laneTimeoutMs);
      const answeredAt = this.#now();
      clearInterval(poll);
      if (runner.stopping) return;
      const answer = reply?.data.content?.trim();
      const judged = judge(answer, checks);
      runner.finish({ status: "done", ...(answer ? { answer: answer.slice(0, ANSWER_LIMIT) } : {}), verdict: judged.verdict, checks: judged.checks }, answeredAt);
      this.#rank(race);
      await this.#observe(runner, { final: true });
    } catch (error) {
      if (runner.stopping) return;
      log.warn("A lane failed", { race: race.id, lane: lane.id, error: errorText(error) });
      runner.finish({ status: "failed", verdict: "failed", error: describeFailure(error, this.#config.laneTimeoutMs) }, this.#now());
      await runner.session?.abort().catch(() => undefined);
    } finally {
      clearInterval(poll);
      await this.#cleanUp(race, runner);
    }
  }

  /** Places go to the lanes with a correct answer, in the order their answers arrived. */
  #rank(race: ActiveRace): void {
    const correct = race.runners.filter((runner) => runner.run.verdict === "correct").sort((a, b) => (a.run.finishedAt ?? 0) - (b.run.finishedAt ?? 0));
    correct.forEach((runner, index) => {
      if (runner.run.place !== index + 1) runner.update({ place: index + 1 });
    });
  }

  /** Reads a lane's usage and, for a coordinator, its workers and hands sandboxes; `final` waits for a read in flight, then reads once more. */
  async #observe(runner: LaneRunner, options: { readonly final?: boolean } = {}): Promise<void> {
    if (runner.observation) {
      await runner.observation;
      if (!options.final) return;
    }
    runner.observation = this.#read(runner).finally(() => (runner.observation = undefined));
    await runner.observation;
  }

  async #read(runner: LaneRunner): Promise<void> {
    const session = runner.session;
    if (!session) return;
    const reads: Promise<void>[] = [
      session.rpc.usage.getMetrics().then(
        (metrics) => runner.usage(metrics),
        (error: unknown) => log.debug("Couldn't read a lane's usage", { lane: runner.lane.id, error: errorText(error) }),
      ),
    ];
    if (runner.lane.type === "orchestrator") {
      reads.push(
        this.#platform.workers(session.sessionId).then(
          (workers) => runner.workers(workers),
          (error: unknown) => log.debug("Couldn't list a lane's workers", { lane: runner.lane.id, error: errorText(error) }),
        ),
      );
    }
    if (runner.lane.type === "promotable") {
      reads.push(
        this.#platform.sessionInfo(session.sessionId).then(
          (info) => {
            if (info.placement === "sandbox") runner.moved(info.sandbox?.id ?? session.sessionId);
          },
          (error: unknown) => log.debug("Couldn't read a lane's placement", { lane: runner.lane.id, error: errorText(error) }),
        ),
      );
    }
    await Promise.all(reads);
    runner.workerPremium((model) => this.#platform.multiplier(model), this.#active?.model ?? this.#platform.model.id);
  }

  /** Deletes the lane's session: its sandboxes, hands sandboxes, and workers go with it. */
  async #cleanUp(race: ActiveRace, runner: LaneRunner): Promise<void> {
    const sessionId = runner.session?.sessionId;
    if (!sessionId) return;
    try {
      await this.#platform.deleteSession(runner.lane.id, sessionId);
      runner.sandboxesDeleted();
    } catch (error) {
      log.warn("Couldn't delete a lane's session", { race: race.id, lane: runner.lane.id, session: sessionId, error: errorText(error) });
    }
  }

  #platformEvent(event: PlatformEvent): void {
    const race = this.#active;
    if (!race || !event.sessionId) return;
    const runner = race.runners.find((candidate) => candidate.session?.sessionId === event.sessionId);
    if (!runner?.running) return;
    if (event.type === "session.promoted") {
      runner.moved(event.sandboxId ?? event.sessionId);
    } else if (event.type.startsWith("worker.")) {
      runner.workerEvent(event.data as unknown as WorkerEventData);
    }
  }
}
