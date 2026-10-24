import { isManagedCopilotError, ManagedCopilotError, PLATFORM_TOOLS, type ManagedCopilotConfig, type ScheduleInfo } from "@managed-copilot/protocol";
import { ZodError } from "zod";
import type { CredentialsService, DurablePlatformToolsPort, PlatformToolContext, PlatformToolDefinition, PlatformToolResult } from "../contract.js";
import type { DurableSchedules } from "./service.js";

export interface ScheduleToolsDeps {
  readonly deployment: ManagedCopilotConfig;
  readonly schedules: DurableSchedules;
  readonly credentials: () => CredentialsService;
  readonly now?: () => number;
}

interface ScheduleTaskArgs {
  readonly prompt?: unknown;
  readonly name?: unknown;
  readonly runAt?: unknown;
  readonly delaySeconds?: unknown;
  readonly cron?: unknown;
  readonly timeZone?: unknown;
}

const failure = (message: string): PlatformToolResult => ({ textResultForLlm: message, resultType: "failure", error: message });

function explain(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ");
  if (isManagedCopilotError(error, "authentication_required")) {
    return "The user has not enabled background work for this deployment, so nothing can run while they are away. Ask them to run `npx managed-copilot login` once, then try again.";
  }
  if (error instanceof ManagedCopilotError) return error.message;
  return "Scheduling failed unexpectedly";
}

function describeWhen(schedule: ScheduleInfo): string {
  if (!schedule.nextRunAt) return schedule.cron ? `recurring (${schedule.cron}, ${schedule.timeZone})` : "no upcoming run";
  const local = new Intl.DateTimeFormat("en-US", { timeZone: schedule.timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(schedule.nextRunAt));
  return `${schedule.cron ? `recurring (${schedule.cron}); next run` : "runs once"} at ${schedule.nextRunAt} (${local} ${schedule.timeZone})`;
}

/**
 * Agent scheduling tools (spec section 13), injected only into environments with operator-approved
 * `scheduling: true`. An agent may schedule follow-ups only for its own session, as the session's owner, within the
 * module's count and frequency limits; it can see and cancel only schedules that target its own session.
 */
export function scheduleToolDefinitions(deps: ScheduleToolsDeps): PlatformToolDefinition[] {
  const enabledFor = (environment: string) => deps.deployment.environments[environment]?.scheduling === true;
  const now = deps.now ?? Date.now;

  const scheduleTask: PlatformToolDefinition = {
    name: PLATFORM_TOOLS.scheduleTask,
    description:
      "Schedule a follow-up for this conversation: at the chosen time, the prompt is delivered back to this session so you can continue the task (for example, a reminder or a periodic check). Use delaySeconds for relative times, runAt for an exact time, or cron for a recurring task. Runs happen even when the user is away.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The instruction to deliver back to you when the task runs, written so it makes sense on its own later." },
        name: { type: "string", description: "A short name for the task, e.g. 'standup-reminder'." },
        delaySeconds: { type: "integer", minimum: 10, description: "Run once after this many seconds." },
        runAt: { type: "string", description: "Run once at this ISO 8601 date-time, including a UTC offset, e.g. 2026-10-24T09:00:00-07:00." },
        cron: { type: "string", description: "Run repeatedly on this 5-field cron schedule, e.g. '0 9 * * 1-5' for 9:00 on weekdays." },
        timeZone: { type: "string", description: "IANA time zone for cron and for displaying times, e.g. America/Los_Angeles. Defaults to UTC." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    enabledFor,
    handler: async (raw: unknown, context: PlatformToolContext) => {
      const args = (raw ?? {}) as ScheduleTaskArgs;
      if (typeof args.prompt !== "string" || args.prompt.trim() === "") return failure("prompt is required: say what should happen when the task runs");
      const whenCount = [args.delaySeconds, args.runAt, args.cron].filter((value) => value !== undefined && value !== null).length;
      if (whenCount !== 1) return failure("Provide exactly one of delaySeconds, runAt, or cron");
      let runAt: string | undefined;
      if (args.delaySeconds !== undefined && args.delaySeconds !== null) {
        const seconds = Number(args.delaySeconds);
        if (!Number.isFinite(seconds) || seconds <= 0) return failure("delaySeconds must be a positive number of seconds");
        runAt = new Date(now() + Math.round(seconds) * 1000).toISOString();
      } else if (args.runAt !== undefined && args.runAt !== null) {
        runAt = String(args.runAt);
      }
      const name = typeof args.name === "string" && args.name.trim() ? args.name.trim().slice(0, 80) : `task-${context.toolCallId.slice(-6).replace(/[^a-zA-Z0-9]/g, "x")}`;
      try {
        const principal = await deps.credentials().principalFor(context.ownerId);
        const schedule = await deps.schedules.create(
          principal,
          {
            name,
            prompt: args.prompt.trim(),
            ...(runAt !== undefined ? { runAt } : { cron: String(args.cron) }),
            ...(typeof args.timeZone === "string" && args.timeZone ? { timeZone: args.timeZone } : {}),
            target: { sessionId: context.sessionId },
          },
          { createdBy: "agent", originSessionId: context.sessionId, originKey: context.idempotencyKey },
        );
        return `Scheduled "${schedule.name}" (id ${schedule.id}): ${describeWhen(schedule)}. When it runs, the prompt comes back to this conversation.`;
      } catch (error) {
        return failure(`Could not schedule the task: ${explain(error)}`);
      }
    },
  };

  const listSchedules: PlatformToolDefinition = {
    name: PLATFORM_TOOLS.listSchedules,
    description: "List the scheduled tasks that deliver prompts to this conversation, with their next run and last outcome.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    enabledFor,
    handler: async (_raw: unknown, context: PlatformToolContext) => {
      const schedules = deps.schedules.listForSession(context.ownerId, context.sessionId);
      if (schedules.length === 0) return "No scheduled tasks target this conversation.";
      return JSON.stringify(
        schedules.map((schedule) => ({
          id: schedule.id,
          name: schedule.name,
          state: schedule.state,
          ...(schedule.pausedReason ? { pausedReason: schedule.pausedReason } : {}),
          ...(schedule.cron ? { cron: schedule.cron } : { runAt: schedule.runAt }),
          timeZone: schedule.timeZone,
          nextRunAt: schedule.nextRunAt ?? null,
          lastRun: schedule.lastRun ? { status: schedule.lastRun.status, scheduledFor: schedule.lastRun.scheduledFor } : null,
          prompt: schedule.prompt,
        })),
        null,
        2,
      );
    },
  };

  const cancelSchedule: PlatformToolDefinition = {
    name: PLATFORM_TOOLS.cancelSchedule,
    description: "Cancel a scheduled task that targets this conversation, by its id from list_schedules.",
    parameters: {
      type: "object",
      properties: { scheduleId: { type: "string", description: "The id of the scheduled task, e.g. sch_..." } },
      required: ["scheduleId"],
      additionalProperties: false,
    },
    enabledFor,
    handler: async (raw: unknown, context: PlatformToolContext) => {
      const scheduleId = typeof (raw as { scheduleId?: unknown })?.scheduleId === "string" ? (raw as { scheduleId: string }).scheduleId : "";
      const owned = deps.schedules.listForSession(context.ownerId, context.sessionId).find((schedule) => schedule.id === scheduleId);
      // Only schedules that target this conversation are visible here, so others read as not found.
      if (!owned) return failure(`No scheduled task ${scheduleId || "(missing id)"} targets this conversation; use list_schedules to see them`);
      deps.schedules.delete(context.ownerId, scheduleId);
      return `Cancelled "${owned.name}" (${owned.id}).`;
    },
  };

  return [scheduleTask, listSchedules, cancelSchedule];
}

export function registerScheduleTools(registry: DurablePlatformToolsPort, deps: ScheduleToolsDeps): void {
  for (const definition of scheduleToolDefinitions(deps)) registry.register(definition);
}
