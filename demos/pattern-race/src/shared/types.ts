import type { JobId } from "./jobs.js";
import type { BrainPlace, LaneId } from "./lanes.js";

export interface AccountSummary {
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
}

export interface PlatformStatus {
  readonly state: "connecting" | "connected" | "reconnecting" | "unavailable";
  readonly message?: string;
  readonly url?: string;
  readonly mode?: "local" | "azure";
  readonly deployment?: string;
  readonly account?: AccountSummary;
}

/** Whether this deployment can race a lane: its environment is declared as the pattern needs, and works now. */
export interface LaneAvailability {
  readonly lane: LaneId;
  readonly available: boolean;
  readonly reason?: string;
  /** The environment its sandboxes come from: its own (isolated), its `promoteTo` (promotable), or its first worker environment. */
  readonly sandboxEnvironment?: string;
  /** The models its environment allows; every model the deployment offers when absent. */
  readonly models?: readonly string[];
}

/** A model a race can use. */
export interface ModelChoice {
  readonly id: string;
  readonly name: string;
}

/**
 * - `ready`: not started.
 * - `starting`: its session (and, for an isolated lane, its sandbox) is being created.
 * - `thinking`: its model is working.
 * - `working`: a tool is running: a command, a move into a sandbox, workers, or a sub-agent.
 * - `done`: it answered. `failed`: it couldn't. `stopped`: the race was stopped.
 * - `skipped`: this deployment can't race it (see its availability).
 */
export type LaneStatus = "ready" | "starting" | "thinking" | "working" | "done" | "failed" | "stopped" | "skipped";

/**
 * - `own`: the lane session's own sandbox (isolated from the start, or promotable after its move).
 * - `hands`: a sandbox a direct or mixed coordinator and its sub-agents act in, with no agent inside.
 * - `worker`: a worker agent's sandbox, with that agent inside.
 */
export type SandboxKind = "own" | "hands" | "worker";
export type SandboxState = "starting" | "working" | "idle" | "failed" | "stopped";

/** What a sandbox used, read from its own cgroup with `managed.exec`: the last reading before it was deleted. */
export interface SandboxUsage {
  /** CPU time every process in it used since it started (setup, its runtime, the agent's commands), in milliseconds. */
  readonly cpuMs: number;
  /** The most memory it held at once, in bytes. */
  readonly peakMemoryBytes: number;
  /** The memory it held at the latest reading, in bytes. */
  readonly memoryBytes?: number;
}

/**
 * What a lane was doing from `at` until its next phase (or its end):
 * - `starting`: its session (or sandbox) is being created. `thinking`: its model is working.
 * - `command`: a shell command or file tool. `sandbox`: moving into a sandbox. `workers`: starting, messaging, or
 *   waiting for workers. `subagents`: a sub-agent's work. `tool`: any other tool.
 */
export type PhaseKind = "starting" | "thinking" | "command" | "sandbox" | "workers" | "subagents" | "tool";

export interface Phase {
  readonly at: number;
  readonly kind: PhaseKind;
  readonly label: string;
}

/** A lane's sandboxes at `at`: the CPU time they used so far, and the memory they held then. */
export interface UsageSample {
  readonly at: number;
  readonly cpuMs: number;
  readonly memoryBytes: number;
}

export interface SandboxToken {
  readonly id: string;
  readonly kind: SandboxKind;
  readonly name: string;
  readonly state: SandboxState;
  readonly environment: string;
  /** What it was given: its environment's size. */
  readonly cpus?: number;
  readonly memoryBytes?: number;
  /** Epoch milliseconds when it appeared (asked for), was ready (no longer starting), and was deleted. */
  readonly appearedAt?: number;
  readonly readyAt?: number;
  readonly endedAt?: number;
  readonly usage?: SandboxUsage;
}

/** Tokens a session's model calls used. */
export interface Tokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface Premium {
  /** What the lane's own session reported (`session.rpc.usage.getMetrics()`). */
  readonly session: number;
  /** Its workers: one per message each received (its task included), at its model's multiplier. */
  readonly workers: number;
}

/**
 * - `correct`: every expected value is in the answer. `partial`: some are. `missed`: none are.
 * - `failed`: no answer (an error, or the race stopped).
 */
export type Verdict = "correct" | "partial" | "missed" | "failed";

export interface LaneRun {
  readonly lane: LaneId;
  readonly status: LaneStatus;
  /** What it's doing now, in a few words. */
  readonly activity?: string;
  readonly sessionId?: string;
  /** Epoch milliseconds when it ended (done, failed, or stopped). */
  readonly finishedAt?: number;
  /** Where its own brain runs now. */
  readonly brain: BrainPlace;
  /** Sub-agents it started in its own runtime (direct and mixed). */
  readonly subagents: number;
  /** Every sandbox it had, in the order they appeared. */
  readonly sandboxes: readonly SandboxToken[];
  readonly premium: Premium;
  /** Model calls its own session made (sub-agents included; workers are sessions of their own). */
  readonly modelCalls: number;
  /** Tokens its own session's model calls used (sub-agents included; workers are sessions of their own). */
  readonly tokens?: Tokens;
  /** Time its own session spent in model calls (sub-agents included), in milliseconds. */
  readonly modelMs?: number;
  /** Tool calls in its own session (sub-agents included). */
  readonly toolCalls?: number;
  /** What it was doing over time, oldest first. */
  readonly timeline?: readonly Phase[];
  /** Its sandboxes' usage over time, one sample per reading. */
  readonly samples?: readonly UsageSample[];
  /** Permission requests answered automatically. */
  readonly approvals: number;
  readonly answer?: string;
  readonly verdict?: Verdict;
  /** Whether the answer contains each of the job's expected values, in order. */
  readonly checks?: readonly boolean[];
  readonly error?: string;
  /** Finishing position among the lanes that answered (1 is first). */
  readonly place?: number;
}

export interface RaceSnapshot {
  readonly id: string;
  readonly job: JobId;
  readonly model: string;
  /** The job's expected values, computed by the server, in the order of its checks. */
  readonly expected: readonly string[];
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly state: "running" | "finished" | "stopped";
  readonly lanes: readonly LaneRun[];
}

export interface AppState {
  readonly platform: PlatformStatus;
  readonly lanes: readonly LaneAvailability[];
  /** The model a race uses unless the person picks another (`PATTERN_RACE_MODEL`). */
  readonly model: ModelChoice;
  /** The models the deployment offers that at least one lane can race with. */
  readonly models: readonly ModelChoice[];
  readonly race?: RaceSnapshot;
  /** The server's clock when this state was sent, so the page can time lanes without clock skew. */
  readonly serverNow: number;
}

export interface StartRaceRequest {
  readonly job: JobId;
  /** The model every lane uses; the default model when absent. */
  readonly model?: string;
}

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}
