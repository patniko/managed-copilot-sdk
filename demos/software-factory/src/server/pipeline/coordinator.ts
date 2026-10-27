import { createHash } from "node:crypto";
import type { SessionEvent } from "@github/copilot-sdk";
import { z } from "zod";
import { FACTORY_ENVIRONMENTS } from "../../shared/environments.js";
import { formatWorkOrderNumber, type DecisionView, type PlanTask, type StationRole, type WorkOrder } from "../../shared/types.js";
import { planMarkdown } from "./seed.js";

/** Workers finish this first turn before the factory writes their inputs. */
export const WORKER_READY_TASK =
  "The factory is preparing your workspace. Do not read, write, or run anything yet. Reply READY now and end this turn. Your complete task will arrive in the next message.";

export const TaskWorkerSchema = z.object({
  taskId: z.string().describe("The task ID in the accepted plan."),
  worker: z.string().describe("The builder worker's name or ID, returned by start_worker."),
}).strict();
export const TaskSchema = z.object({ taskId: z.string().describe("The task ID in the accepted plan.") }).strict();
export const ReleaseWorkerSchema = z.object({ worker: z.string().describe("The release worker's name or ID.") }).strict();
export const NoArgsSchema = z.object({}).strict();

export function builderName(taskId: string): string {
  const name = `builder-${taskId}`;
  if (name.length <= 40) return name;
  return `${name.slice(0, 31)}-${createHash("sha256").update(taskId).digest("hex").slice(0, 8)}`;
}

export function coordinatorPrompt(workOrder: WorkOrder, models: Readonly<Record<StationRole, string>>, resuming: boolean): string {
  return `${resuming ? "Continue" : "Run"} this agent-led work order: ${formatWorkOrderNumber(workOrder.number)} ${workOrder.title}.

${resuming ? "The factory resumed your SAME coordinator session and reconciled your existing workers. Your previous coordinator turn was stopped, not your workers. Call factory_status and list_workers first. Never send duplicate work to a busy worker: wait for it, then check its output. Reuse an existing builder; don't create another just because the factory restarted." : "The factory accepted the plan below. You decide when to create workers and when to send more work to the same worker."}

${planMarkdown(workOrder.plan!)}

Worker names and models:
${workOrder.plan!.tasks.map((task) => `- Task ${task.id}: name "${builderName(task.id)}", environment "${FACTORY_ENVIRONMENTS.builder}", agent "builder", model "${models.builder}".`).join("\n")}
- Release: name "release", environment "${FACTORY_ENVIRONMENTS.release}", agent "release", model "${models.release}".

Use EXACTLY this initial task for EVERY start_worker call (the factory seeds the sandbox only after this turn finishes):
${JSON.stringify(WORKER_READY_TASK)}

For each ready task: start_worker, prepare_workspace({taskId, worker}), then message_worker with the returned message.
Start independent builders together. Wait for them with wait_for_workers (no model time), then check_build({taskId})
and request_review({taskId}). Reviews run in the shared factory-reviewer environment on ${models.reviewer}, not in a worker.
The factory allows at most ${workOrder.maxReviewRounds} review rounds. For changes, message the SAME builder with the
returned findings; then wait, check, and review again. A repeated check or review cannot advance a round.

Once every task is accepted, start the release worker. Call prepare_release({worker:"release"}). It returns
copy_worker_files operations that copy each builder's published outputs into the release sandbox. Do those copies,
then call prepare_release AGAIN: the factory verifies the copied bytes and assembles the inputs. Only when it returns
ready:true should you message the release worker with its returned message. Wait and call check_release.
Do not stop builders before the release is accepted: the release needs their files.

The factory's tools are authoritative. Never claim a release is done without check_release accepting it. On a
failed check, send its returned message to the SAME worker and wait. If a tool reports a fatal error, end your turn
and report it. After acceptance you may stop workers you no longer need; the factory retains the deliverable.
Do not stop early or merely describe next steps: keep working until the release is accepted or the factory fails.`;
}

export function coordinatorReminder(): string {
  return "The release has not been accepted yet. Call factory_status to read the checkpoints, then keep coordinating your existing workers through the remaining factory gates. Do not end until check_release accepts the release or a factory tool reports a fatal failure.";
}

export function taskStart(task: PlanTask, model: string) {
  return { name: builderName(task.id), environment: FACTORY_ENVIRONMENTS.builder, agent: "builder", model, task: WORKER_READY_TASK };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export interface CoordinatorDecision {
  readonly text: string;
  readonly decision: DecisionView;
}

/** Names come from SDK tool arguments; results are displayed as text, never treated as instructions. */
export function toolDecision(name: string, args: unknown, status: DecisionView["status"], firstMessage = false): CoordinatorDecision | undefined {
  const input = record(args);
  const worker = text(input.worker);
  const workers = Array.isArray(input.workers) ? input.workers.filter((item): item is string => typeof item === "string") : [];
  const task = text(input.taskId);
  const done = status === "done";
  const make = (action: DecisionView["action"], description: string, names: string[] = [], tag?: DecisionView["tag"]): CoordinatorDecision => ({
    text: description,
    decision: { action, status, ...(names.length ? { workers: names } : {}), ...(tag ? { tag } : {}) },
  });
  switch (name) {
    case "start_worker":
      return make("create", `${done ? "Created" : "Creating"} **${text(input.name)}** in ${text(input.environment)}, agent ${text(input.agent)}`, [text(input.name)], "new");
    case "message_worker":
      return firstMessage
        ? make("message", `${done ? "Sent the task" : "Sending the task"} to **${worker}**`, [worker])
        : make("message", `${done ? "Sent follow-up work" : "Sending follow-up work"} to the same **${worker}** sandbox`, [worker], "reused");
    case "wait_for_workers":
      return make("wait", `${done ? "Finished waiting for" : "Waiting for"} ${workers.length ? workers.map((item) => `**${item}**`).join(", ") : "the workers"}${done ? "" : " · no model time"}`, workers);
    case "copy_worker_files":
      return make("copy", `${done ? "Copied" : "Copying"} files from **${text(input.from)}** to **${text(input.to)}**`, [text(input.from), text(input.to)]);
    case "stop_worker":
      return make("stop", `${done ? "Stopped" : "Stopping"} **${worker}**`, [worker]);
    case "prepare_workspace":
      return make("prepare", `${done ? "Prepared" : "Preparing"} **${worker}** for task ${task}`, [worker]);
    case "prepare_release":
      return make("prepare", `${done ? "Prepared" : "Preparing"} the release inputs`, [worker]);
    case "check_build":
      return make("check", `Asked the factory to check **${builderName(task)}**`, [builderName(task)]);
    case "request_review":
      return make("review", `Requested a factory review of **${builderName(task)}** on a second model`, [builderName(task)]);
    case "check_release":
      return make("check", "Asked the factory to accept the **release**", ["release"]);
    default:
      return undefined;
  }
}

export type ToolStart = Extract<SessionEvent, { type: "tool.execution_start" }>;
