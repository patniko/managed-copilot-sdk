// The coordinator's platform tools (spec section 17): names, descriptions, and argument schemas the model sees.
import { PLATFORM_TOOLS } from "@managed-copilot/protocol";

/** Default and longest `wait_for_workers` wait, in seconds. */
export const WAIT_DEFAULT_SECONDS = 900;
export const WAIT_MAX_SECONDS = 3600;

const WORKER_REF = { type: "string", description: "The worker's name or ID." } as const;

export interface WorkerToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  /** Only starting a worker asks for the session's permission: approving it approves the worker's work. */
  readonly skipPermission: boolean;
}

export const WORKER_TOOLS: readonly WorkerToolDefinition[] = [
  {
    name: PLATFORM_TOOLS.startWorker,
    description: [
      "Starts a worker: a separate agent in its own Linux sandbox with a shell, files, and a /workspace directory, which works on the task you give it.",
      "Returns right away while the worker's sandbox starts; call wait_for_workers to get its report.",
      "Give it a complete, self-contained task: it can't see this conversation or the other workers.",
      "Starting a worker needs the user's approval, which also covers what the worker does in its sandbox.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: 'Short, unique label such as "tests" or "docs-review": letters, digits, "-" and "_".' },
        task: { type: "string", description: "Complete instructions for the worker: the goal, the inputs and context it needs, and what to report back." },
        environment: { type: "string", description: "Worker environment to start it in. Defaults to the first one in your instructions." },
        agent: { type: "string", description: "Optional custom agent of that environment to run the worker as (list_workers shows them)." },
        model: { type: "string", description: "Optional model for the worker. Defaults to this session's model when the environment allows it." },
      },
      required: ["name", "task"],
      additionalProperties: false,
    },
    skipPermission: false,
  },
  {
    name: PLATFORM_TOOLS.messageWorker,
    description:
      "Sends a follow-up message, such as a correction or more work, to a worker that finished (or failed) its current work; a working worker is waited for first. Call wait_for_workers for its reply.",
    parameters: {
      type: "object",
      properties: { worker: WORKER_REF, message: { type: "string", description: "What to tell the worker." } },
      required: ["worker", "message"],
      additionalProperties: false,
    },
    skipPermission: true,
  },
  {
    name: PLATFORM_TOOLS.waitForWorkers,
    description: [
      "Waits until workers finish their current work, then returns each one's state and final report. Waiting costs no model time.",
      `Waits for the named workers, or every worker that is still starting or working. Returns after timeoutSeconds (default ${WAIT_DEFAULT_SECONDS}, at most ${WAIT_MAX_SECONDS}) even if some are still working; call it again to keep waiting.`,
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        workers: { type: "array", items: WORKER_REF, description: "Workers to wait for. Defaults to every worker that is still starting or working." },
        timeoutSeconds: { type: "number", description: `Longest wait in seconds (default ${WAIT_DEFAULT_SECONDS}, at most ${WAIT_MAX_SECONDS}).` },
      },
      additionalProperties: false,
    },
    skipPermission: true,
  },
  {
    name: PLATFORM_TOOLS.listWorkers,
    description: "Lists this session's workers with their state and latest report, and the worker environments and agents you can start workers in.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    skipPermission: true,
  },
  {
    name: PLATFORM_TOOLS.readWorkerFile,
    description: "Reads a text file from a worker's /workspace, or lists a directory. Paths are relative to /workspace, for example outputs/report.md. Long files are truncated.",
    parameters: {
      type: "object",
      properties: { worker: WORKER_REF, path: { type: "string", description: 'Path relative to /workspace, for example "outputs/report.md" or "." for the top level.' } },
      required: ["worker", "path"],
      additionalProperties: false,
    },
    skipPermission: true,
  },
  {
    name: PLATFORM_TOOLS.copyWorkerFiles,
    description:
      "Copies files or whole directories from one worker's /workspace to another's, at the same paths or under a destination directory. Use it to hand one worker's results to another without reading them yourself.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "The worker to copy from (name or ID)." },
        to: { type: "string", description: "The worker to copy to (name or ID)." },
        paths: { type: "array", items: { type: "string" }, description: 'Files or directories relative to /workspace, for example ["src", "outputs/report.md"].' },
        destination: { type: "string", description: "Optional directory in the receiving worker's /workspace to copy into. Defaults to the same paths." },
      },
      required: ["from", "to", "paths"],
      additionalProperties: false,
    },
    skipPermission: true,
  },
  {
    name: PLATFORM_TOOLS.stopWorker,
    description: "Stops a worker you no longer need: cancels its work and deletes its sandbox and files. Read or copy anything you need from it first.",
    parameters: { type: "object", properties: { worker: WORKER_REF }, required: ["worker"], additionalProperties: false },
    skipPermission: true,
  },
];

/** Appended to every worker's system prompt. */
export const WORKER_INSTRUCTIONS = [
  "You are a worker started by a coordinating agent in a Managed Copilot orchestrator session. Its messages are your task and its follow-ups.",
  "Nobody can answer questions while you work, so make reasonable assumptions and state them.",
  "Work in your sandbox until the task is done, then reply with a complete, concise report of what you did, what you found, and anything left open: that final reply is what the coordinator receives.",
  "Save files meant for the coordinator, other workers, or the user under /workspace/outputs, and list their paths in your report.",
].join(" ");
