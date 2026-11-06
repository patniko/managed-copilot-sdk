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

export interface SandboxToken {
  readonly id: string;
  readonly kind: SandboxKind;
  readonly name: string;
  readonly state: SandboxState;
  readonly environment: string;
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
  /** The model every lane uses, and its display name. */
  readonly model: { readonly id: string; readonly name: string };
  readonly race?: RaceSnapshot;
  /** The server's clock when this state was sent, so the page can time lanes without clock skew. */
  readonly serverNow: number;
}

export interface StartRaceRequest {
  readonly job: JobId;
}

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}
