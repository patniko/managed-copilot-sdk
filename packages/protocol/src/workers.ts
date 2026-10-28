/**
 * Orchestrator environments (spec section 17): a coordinator session on shared placement starts workers, and each
 * worker is an ordinary session of a declared isolated environment, in its own sandbox. The coordinator manages them
 * with platform tools (`WORKER_TOOLS`); owners list them with `GET ROUTES.workers(id)` (`managed.workers(session)`),
 * and `worker.*` platform events report their progress.
 */

/** Workers one orchestrator session can have at once when its environment sets no `maxWorkers`. */
export const DEFAULT_MAX_WORKERS = 4;
/** The highest `maxWorkers` an environment can set. */
export const MAX_WORKERS_LIMIT = 16;

/**
 * How an orchestrator gets work done (`EnvironmentConfig.execution`):
 * - `delegate` (default): worker agents do the hands-on work, each in its own sandbox.
 * - `direct`: the coordinator and its stock sub-agents run commands and edit files themselves, in a hands sandbox of
 *   its only worker environment (no agent runs in it).
 * - `mixed`: both; its hands sandbox is in the first worker environment, and it can start workers in any.
 */
export const EXECUTION_STYLES = ["delegate", "direct", "mixed"] as const;
export type ExecutionStyle = (typeof EXECUTION_STYLES)[number];

/** Direct and mixed: one hands sandbox per coordinator session (`shared`, default) or one per sub-agent (`own`). */
export const SUBAGENT_SANDBOXES = ["shared", "own"] as const;
export type SubagentSandboxes = (typeof SUBAGENT_SANDBOXES)[number];

/** The tools a direct or mixed coordinator acts in its sandbox with (the stock shell and file tools' names and shapes). */
export const HANDS_TOOLS = {
  bash: "bash",
  readBash: "read_bash",
  writeBash: "write_bash",
  stopBash: "stop_bash",
  listBash: "list_bash",
  view: "view",
  create: "create",
  edit: "edit",
  glob: "glob",
  grep: "grep",
} as const;
export type HandsToolName = (typeof HANDS_TOOLS)[keyof typeof HANDS_TOOLS];

/** `worker`: an agent the coordinator started. `hands`: a sandbox a direct or mixed coordinator (or one of its sub-agents) acts in. */
export type WorkerRole = "worker" | "hands";

/**
 * - `starting`: admitted; its sandbox is being prepared.
 * - `working`: running a turn (its task, or a later message).
 * - `idle`: finished its latest turn; `result` holds its reply. It keeps its sandbox and accepts more messages.
 * - `failed`: its sandbox could not be prepared, or its latest turn ended in an error (`error`). A failed turn leaves
 *   the worker usable: another message starts a new turn.
 * - `stopped`: stopped by the coordinator or with its coordinator session; its session and sandbox are deleted.
 */
export type WorkerState = "starting" | "working" | "idle" | "failed" | "stopped";

export interface WorkerInfo {
  /** The worker's own session ID: use it with `managed.files`, `managed.artifacts`, and `managed-copilot attach`. */
  readonly id: string;
  /**
   * `worker` (an agent with its task) or `hands`: a workspace-only sandbox a direct or mixed coordinator acts in
   * itself (no agent runs in it, so it has no task or report; attach and messages don't apply).
   */
  readonly role?: WorkerRole;
  /** Hands sandboxes with `subagents: "own"`: the sub-agent (`agentId`) it belongs to; absent for the root agent's. */
  readonly agentId?: string;
  /** Short label the coordinator gave it, unique within the coordinator session. */
  readonly name: string;
  /** The orchestrator session that started it. */
  readonly coordinatorId: string;
  /** The isolated environment it runs in. */
  readonly environment: string;
  readonly state: WorkerState;
  readonly model?: string;
  readonly agent?: string;
  /** The task it was started with. */
  readonly task: string;
  /** Its reply when its latest turn finished: its report to the coordinator. */
  readonly result?: string;
  /** Why its latest turn or its start failed, or why it stopped. */
  readonly error?: string;
  /** Messages it has received, its task included. */
  readonly messages: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * `data` of the `worker.started`, `worker.idle`, `worker.failed`, and `worker.stopped` platform events. The event's
 * top-level `sessionId` and `environment` are the coordinator's; `workerId` is the worker's own session ID.
 */
export interface WorkerEventData {
  readonly workerId: string;
  readonly name: string;
  /** The worker's isolated environment. */
  readonly environment: string;
  readonly state: WorkerState;
  readonly error?: string;
  /** `hands` for a direct or mixed coordinator's own sandbox (absent for workers). */
  readonly role?: WorkerRole;
  /** Hands sandboxes of a sub-agent (`subagents: "own"`). */
  readonly agentId?: string;
}
