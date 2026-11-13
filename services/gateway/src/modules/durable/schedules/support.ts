// Durable schedules: options, dependencies, request validation, and pure helpers.
import { createHash } from "node:crypto";
import {
  ManagedCopilotError,
  ToolDeclarationSchema,
  type ManagedCopilotConfig,
  type PlatformEvent,
  type ScheduleInfo,
} from "@managed-copilot/protocol";
import { z } from "zod";
import type { Database } from "../../../db.js";
import type { Logger } from "../../../log.js";
import type { ActionChange } from "../actions/service.js";
import type {
  ActionsService,
  CredentialsService,
  DurableSessionView,
  DurableSessionsPort,
  PlatformEventMeta,
} from "../contract.js";
import { isGone } from "../ids.js";
import { toScheduleRun, type RunRow, type RunTrigger, type ScheduleRow } from "./store.js";

/** A schedule as the operator console shows it, with its owner (the prompt only for AppHost schedules). */
export type ScheduleOperatorRecord = Omit<ScheduleInfo, "prompt"> & { readonly prompt?: string; readonly ownerId: number; readonly ownerLogin: string };

/** How the reason of an operator's pause starts (spec section 16). */
export const OPERATOR_PAUSE = "Paused: an operator (@";

/** How it ends when it took over the owner's own pause, which lifting the operator's pause restores. */
export const OWNER_PAUSED_TOO = " Its owner had paused it too.";

export interface SchedulesOptions {
  readonly tickIntervalMs: number;
  /** An occurrence later than this is skipped with a recorded outcome (no backfill). */
  readonly missedGraceMs: { readonly cron: number; readonly once: number };
  /** Occurrences allowed to wait behind a schedule's active run; more are skipped. */
  readonly maxQueuedPerSchedule: number;
  readonly maxActiveRunsPerOwner: number;
  readonly maxRunLifetimeMs: number;
  readonly dispatchRetryBaseMs: number;
  readonly maxDispatchAttempts: number;
  readonly maxHorizonMs: number;
  readonly agent: {
    readonly maxActivePerSession: number;
    readonly minCronIntervalMinutes: number;
    readonly minDelayMs: number;
  };
}

export const DEFAULT_SCHEDULES_OPTIONS: SchedulesOptions = {
  tickIntervalMs: 1_000,
  missedGraceMs: { cron: 5 * 60_000, once: 60 * 60_000 },
  maxQueuedPerSchedule: 1,
  maxActiveRunsPerOwner: 5,
  maxRunLifetimeMs: 6 * 60 * 60_000,
  dispatchRetryBaseMs: 2_000,
  maxDispatchAttempts: 8,
  maxHorizonMs: 366 * 24 * 60 * 60_000,
  agent: { maxActivePerSession: 10, minCronIntervalMinutes: 5, minDelayMs: 10_000 },
};

export interface SchedulesDeps {
  readonly db: Database;
  readonly log: Logger;
  readonly deployment: ManagedCopilotConfig;
  readonly sessions: () => DurableSessionsPort | undefined;
  readonly credentials: () => CredentialsService;
  readonly actions: () => (ActionsService & { onChange?(listener: (change: ActionChange) => void): () => void }) | undefined;
  readonly publish: (event: PlatformEvent, meta: PlatformEventMeta) => void;
  readonly now?: () => number;
  readonly options?: Partial<SchedulesOptions>;
}

export interface CreateOptions {
  readonly createdBy?: "user" | "agent";
  /** The session an agent created the schedule from. */
  readonly originSessionId?: string;
  /** Deduplicates retried agent tool calls. */
  readonly originKey?: string;
}

const NAME = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(100, "name must be at most 100 characters")
  .regex(/^[^\u0000-\u001f]+$/, "name cannot contain control characters");

export const CreateScheduleSchema = z
  .object({
    name: NAME,
    cron: z.string().min(1).max(200).optional(),
    runAt: z.string().min(1).optional(),
    timeZone: z.string().min(1).max(100).optional(),
    environment: z.string().min(1).optional(),
    target: z.object({ sessionId: z.string().min(1) }).strict().optional(),
    session: z
      .object({
        agent: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        tools: z.array(ToolDeclarationSchema).max(128).optional(),
      })
      .strict()
      .optional(),
    webhook: z.string().min(1).optional(),
    prompt: z.string().trim().min(1, "prompt is required").max(20_000, "prompt must be at most 20,000 characters"),
  })
  .strict();

export const RUN_EVENT_DATA = (run: RunRow, schedule: Pick<ScheduleRow, "id" | "name">) => {
  const view = toScheduleRun(run);
  return {
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    runId: run.id,
    occurrenceId: run.occurrence_id,
    status: run.status,
    ...(view.sessionId ? { sessionId: view.sessionId } : {}),
    scheduledFor: view.scheduledFor,
    ...(run.message_id ? { messageId: run.message_id } : {}),
    ...(run.reason ? { reason: run.reason } : {}),
  };
};

export const TRANSIENT_CODES = new Set(["capability_unavailable", "timeout", "internal", "session_busy", "inference_unavailable"]);

export const LEDGER_CHECK_INTERVAL_MS = 30_000;

/** Tolerated clock difference between the gateway and a runtime when matching a prompt in history. */
export const INPUT_CLOCK_SKEW_MS = 5_000;

/** How often a run whose prompt may still be queued in the runtime checks again (it never sends a second copy). */
export const ACCEPTANCE_RECHECK_MS = { max: 60_000 };

export const QUEUE_READ_TIMEOUT_MS = 15_000;

export const TARGET_GONE = "The session this schedule continues was deleted, so it cannot run again. Delete the schedule, or create a new one for another session.";

export const TARGET_DELETED = "Paused: the session this schedule continues was deleted";

export const RUN_SESSION_DELETED = "The run's session was deleted while the run was in progress";

export const NOT_THIS_RUNS_SESSION =
  "Could not start the run: a session this schedule did not create now uses the run's session ID (the run's own session may have been deleted), so nothing was sent to it";

/** Binding of a schedule recorded before incarnations whose session could not be proven to be the same one. */
export const RETIRED = "retired";

/** Why a queued run may not start now. A person's pause still lets them run it now; a platform pause blocks every run. */
export function pausedReason(schedule: ScheduleRow, run: RunRow): string | undefined {
  if (schedule.state === "active" || (run.trigger === "manual" && !schedule.paused_reason)) return undefined;
  return `The schedule was paused before this run started${schedule.paused_reason ? ` (${schedule.paused_reason})` : ""}`;
}

/**
 * Whether a session is provably the one a row from before incarnations meant: alive, the same owner's, and created
 * within the row's window. Anything less is not proof, and the row is retired instead.
 */
export function provenSession(view: DurableSessionView | undefined, ownerId: number, notBefore: number, notAfter: number): view is DurableSessionView {
  if (isGone(view) || view!.ownerId !== ownerId) return false;
  const createdAt = view!.createdAt ? Date.parse(view!.createdAt) : Number.NaN;
  return Number.isFinite(createdAt) && createdAt >= notBefore && createdAt <= notAfter;
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ManagedCopilotError("timeout", `The runtime did not answer within ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function occurrenceIdFor(scheduleId: string, trigger: RunTrigger, key: string | number): string {
  return `occ_${createHash("sha256").update(`${scheduleId}:${trigger}:${key}`).digest("base64url").slice(0, 32)}`;
}

export function describeError(error: unknown): string {
  return error instanceof ManagedCopilotError ? error.message : "an unexpected error occurred";
}
