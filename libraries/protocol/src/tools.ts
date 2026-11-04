/**
 * Platform tools the gateway injects into sessions and executes itself (never forwarded to the customer).
 * Each is enabled only where the environment's operator policy allows it.
 */
export const PLATFORM_TOOLS = {
  /** Spec section 13; requires `scheduling: true` on the environment. */
  scheduleTask: "schedule_task",
  listSchedules: "list_schedules",
  cancelSchedule: "cancel_schedule",
  /** Spec section 9; promotable environments only. Requests one-way promotion into a sandbox. */
  requestSandbox: "request_sandbox",
  /** Spec section 17; orchestrator environments only. The coordinator's tools for its workers. */
  startWorker: "start_worker",
  messageWorker: "message_worker",
  waitForWorkers: "wait_for_workers",
  listWorkers: "list_workers",
  readWorkerFile: "read_worker_file",
  copyWorkerFiles: "copy_worker_files",
  stopWorker: "stop_worker",
} as const;
export type PlatformToolName = (typeof PLATFORM_TOOLS)[keyof typeof PLATFORM_TOOLS];

/** Logical workspace inside a sandbox, and the folder whose files are published as artifacts. */
export const WORKSPACE_DIR = "/workspace";
export const OUTPUTS_DIR = "/workspace/outputs";
/** Execution identity reserved by the base sandbox image. */
export const SANDBOX_UID = 10001;
