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
}
