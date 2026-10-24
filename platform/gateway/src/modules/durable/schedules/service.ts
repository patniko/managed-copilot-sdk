import { createHash } from "node:crypto";
import {
  isManagedCopilotError,
  ManagedCopilotError,
  ToolDeclarationSchema,
  type CreateScheduleRequest,
  type ManagedCopilotConfig,
  type PlatformEvent,
  type ScheduleInfo,
  type ScheduleRun,
  type ScheduleRunStatus,
} from "@managed-copilot/protocol";
import { z } from "zod";
import { transaction, type Database } from "../../../db.js";
import type { Principal } from "../../../http.js";
import type { Logger } from "../../../log.js";
import type { ActionChange } from "../actions/service.js";
import type { ActionsService, CredentialsService, DurableSessionView, DurableSessionsPort, PlatformEventMeta, RuntimeSessionEvent, SchedulesService } from "../contract.js";
import { canonicalJson, deterministicUuid, incarnationOf, isGone, newId, parseJson, sameIncarnation } from "../ids.js";
import { LOGIN_HINT } from "../credentials/service.js";
import { assertTimeZone, minimumIntervalMinutes, nextOccurrence, occurrencesBetween, parseCron } from "./cron.js";
import {
  ACTIVE_RUN_STATUSES,
  ScheduleStore,
  toScheduleInfo,
  toScheduleRun,
  type RunRow,
  type RunTrigger,
  type ScheduleCreator,
  type ScheduleRow,
  type SessionConfig,
} from "./store.js";

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

const CreateScheduleSchema = z
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

const RUN_EVENT_DATA = (run: RunRow, schedule: Pick<ScheduleRow, "id" | "name">) => {
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

const TRANSIENT_CODES = new Set(["capability_unavailable", "timeout", "internal", "session_busy", "inference_unavailable"]);
const LEDGER_CHECK_INTERVAL_MS = 30_000;
/** Tolerated clock difference between the gateway and a runtime when matching a prompt in history. */
const INPUT_CLOCK_SKEW_MS = 5_000;
/** How often a run whose prompt may still be queued in the runtime checks again (it never sends a second copy). */
const ACCEPTANCE_RECHECK_MS = { max: 60_000 };
const QUEUE_READ_TIMEOUT_MS = 15_000;
const TARGET_GONE = "The session this schedule continues was deleted, so it cannot run again. Delete the schedule, or create a new one for another session.";
const TARGET_DELETED = "Paused: the session this schedule continues was deleted";
const RUN_SESSION_DELETED = "The run's session was deleted while the run was in progress";
const NOT_THIS_RUNS_SESSION =
  "Could not start the run: a session this schedule did not create now uses the run's session ID (the run's own session may have been deleted), so nothing was sent to it";
/** Binding of a schedule recorded before incarnations whose session could not be proven to be the same one. */
const RETIRED = "retired";

/** Why a queued run may not start now. A person's pause still lets them run it now; a platform pause blocks every run. */
function pausedReason(schedule: ScheduleRow, run: RunRow): string | undefined {
  if (schedule.state === "active" || (run.trigger === "manual" && !schedule.paused_reason)) return undefined;
  return `The schedule was paused before this run started${schedule.paused_reason ? ` (${schedule.paused_reason})` : ""}`;
}

/**
 * Whether a session is provably the one a row from before incarnations meant: alive, the same owner's, and created
 * within the row's window. Anything less is not proof, and the row is retired instead.
 */
function provenSession(view: DurableSessionView | undefined, ownerId: number, notBefore: number, notAfter: number): view is DurableSessionView {
  if (isGone(view) || view!.ownerId !== ownerId) return false;
  const createdAt = view!.createdAt ? Date.parse(view!.createdAt) : Number.NaN;
  return Number.isFinite(createdAt) && createdAt >= notBefore && createdAt <= notAfter;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ManagedCopilotError("timeout", `The runtime did not answer within ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function occurrenceIdFor(scheduleId: string, trigger: RunTrigger, key: string | number): string {
  return `occ_${createHash("sha256").update(`${scheduleId}:${trigger}:${key}`).digest("base64url").slice(0, 32)}`;
}

function describeError(error: unknown): string {
  return error instanceof ManagedCopilotError ? error.message : "an unexpected error occurred";
}

/**
 * Cron and one-shot schedules (spec section 13). Each occurrence is persisted with a stable ID before anything
 * happens upstream; dispatch then moves through recorded phases (session created → input submitting → submitted) so a
 * restart at any point neither creates a second session nor sends the prompt twice.
 */
export class DurableSchedules implements SchedulesService {
  readonly #deps: SchedulesDeps;
  readonly #store: ScheduleStore;
  readonly #log: Logger;
  readonly #options: SchedulesOptions;
  readonly #now: () => number;
  readonly #inFlight = new Set<string>();
  readonly #inFlightSchedules = new Set<string>();
  readonly #inFlightSessions = new Set<string>();
  readonly #inFlightOwners = new Map<number, number>();
  /** Recent `user.message` IDs per session: a prompt's event can arrive before `send` returns its ID. */
  readonly #recentMessages = new Map<string, string[]>();
  readonly #disposers: (() => void)[] = [];
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<void> | undefined;
  #lastLedgerCheck = 0;
  #targetsRepaired = false;

  constructor(deps: SchedulesDeps) {
    this.#deps = deps;
    this.#store = new ScheduleStore(deps.db);
    this.#log = deps.log;
    this.#options = { ...DEFAULT_SCHEDULES_OPTIONS, ...deps.options };
    this.#now = deps.now ?? Date.now;
  }

  get store(): ScheduleStore {
    return this.#store;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------------------

  start(): void {
    this.repairTargets();
    const sessions = this.#deps.sessions();
    if (sessions) this.#disposers.push(sessions.subscribe((sessionId, event) => this.onSessionEvent(sessionId, event)));
    const actions = this.#deps.actions();
    if (actions?.onChange) this.#disposers.push(actions.onChange((change) => this.#onActionChange(change)));
    this.syncAppHostForKnownAccounts();
    void this.#recoverActiveRuns();
    if (this.#options.tickIntervalMs > 0) {
      this.#timer = setInterval(() => void this.tick(), this.#options.tickIntervalMs);
      this.#timer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    for (const dispose of this.#disposers.splice(0)) dispose();
    await this.#ticking;
    // In-flight dispatches write to the ledger; let them settle before the database closes.
    await this.idle(10_000);
  }

  /** One scheduler pass: materialize due occurrences, enforce run lifetimes, and dispatch queued runs. */
  tick(): Promise<void> {
    if (!this.#ticking) {
      this.#ticking = this.#tickOnce().finally(() => {
        this.#ticking = undefined;
      });
    }
    return this.#ticking;
  }

  /** Resolves when every dispatch started so far has settled (tests and graceful shutdown), or after `timeoutMs`. */
  async idle(timeoutMs = Number.POSITIVE_INFINITY): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.#inFlight.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  async #tickOnce(): Promise<void> {
    const now = this.#now();
    for (const schedule of this.#store.listDue(now)) {
      try {
        this.#materialize(schedule.id, now);
      } catch (error) {
        this.#log.error("Could not materialize a schedule occurrence", { scheduleId: schedule.id, error: (error as Error)?.stack ?? String(error) });
      }
    }
    await this.#expireLongRuns(now);
    // Safety net for turn outcomes that produced no observable event (missed while reconnecting, ephemeral idle).
    if (now - this.#lastLedgerCheck >= LEDGER_CHECK_INTERVAL_MS) {
      this.#lastLedgerCheck = now;
      await this.#recoverActiveRuns();
    }
    this.#dispatchQueued(now);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Service API
  // ---------------------------------------------------------------------------------------------------------

  async create(principal: Principal, request: CreateScheduleRequest, options: CreateOptions = {}): Promise<ScheduleInfo> {
    const createdBy: ScheduleCreator = options.createdBy ?? "user";
    const parsed = CreateScheduleSchema.parse(request);
    const now = this.#now();
    if (options.originKey) {
      const existing = this.#store.byOriginKey(principal.accountId, options.originKey);
      if (existing) return this.#info(existing);
    }
    if ((parsed.cron === undefined) === (parsed.runAt === undefined)) {
      throw new ManagedCopilotError("invalid_request", "Set exactly one of cron (recurring) or runAt (one time)");
    }
    const timeZone = parsed.timeZone ?? "UTC";
    assertTimeZone(timeZone);

    let environment: string;
    let targetIncarnation: string | null = null;
    let targetView: DurableSessionView | undefined;
    if (parsed.target) {
      if (parsed.session) throw new ManagedCopilotError("invalid_request", "A schedule that continues an existing session uses that session's configuration; remove session");
      const view = this.#deps.sessions()?.get(parsed.target.sessionId);
      if (isGone(view) || view!.ownerId !== principal.accountId) throw new ManagedCopilotError("not_found", `Session ${parsed.target.sessionId} was not found`);
      if (parsed.environment && parsed.environment !== view!.environment) {
        throw new ManagedCopilotError("invalid_request", `Session ${parsed.target.sessionId} runs in environment "${view!.environment}", not "${parsed.environment}"`);
      }
      environment = view!.environment;
      // The schedule continues this session, not a later one that reuses its ID.
      targetIncarnation = incarnationOf(view!);
      targetView = view;
    } else {
      if (!parsed.environment) throw new ManagedCopilotError("invalid_request", "environment is required unless the schedule targets an existing session");
      environment = parsed.environment;
    }
    const environmentConfig = this.#deps.deployment.environments[environment];
    if (!environmentConfig) throw new ManagedCopilotError("environment_not_found", `Environment "${environment}" is not declared in this deployment`);

    const tools = parsed.session?.tools ?? [];
    const names = new Set<string>();
    for (const tool of tools) {
      if (names.has(tool.name)) throw new ManagedCopilotError("invalid_request", `Tool ${tool.name} is declared twice`);
      names.add(tool.name);
    }
    this.#validateWebhook(parsed.webhook, environment, tools.length > 0, tools[0]?.name);

    let cronSchedule: ReturnType<typeof parseCron> | undefined;
    let runAt: number | undefined;
    let nextRunAt: number;
    if (parsed.cron !== undefined) {
      cronSchedule = parseCron(parsed.cron);
      const next = nextOccurrence(cronSchedule, timeZone, new Date(now));
      if (!next) throw new ManagedCopilotError("invalid_request", `Cron expression "${parsed.cron}" never runs`);
      nextRunAt = next.getTime();
    } else {
      runAt = Date.parse(parsed.runAt!);
      if (!Number.isFinite(runAt) || !/(Z|[+-]\d{2}:?\d{2})$/i.test(parsed.runAt!.trim())) {
        throw new ManagedCopilotError("invalid_request", 'runAt must be an ISO 8601 date-time with a UTC offset, e.g. "2026-10-24T09:00:00-07:00"');
      }
      if (runAt < now - 60_000) throw new ManagedCopilotError("invalid_request", `runAt ${parsed.runAt} is in the past`);
      nextRunAt = Math.max(runAt, now);
    }
    if (nextRunAt - now > this.#options.maxHorizonMs) throw new ManagedCopilotError("policy_violation", "Schedules can start at most a year ahead");

    if (createdBy === "agent") {
      if (environmentConfig.scheduling !== true) throw new ManagedCopilotError("policy_violation", `Scheduling is not enabled for environment "${environment}"`);
      const limits = this.#options.agent;
      if (options.originSessionId && this.#store.countActiveByOrigin(options.originSessionId) >= limits.maxActivePerSession) {
        throw new ManagedCopilotError("policy_violation", `This session already has ${limits.maxActivePerSession} active scheduled tasks; cancel one first`);
      }
      if (cronSchedule && minimumIntervalMinutes(cronSchedule, timeZone, new Date(now)) < limits.minCronIntervalMinutes) {
        throw new ManagedCopilotError("policy_violation", `Recurring tasks may run at most every ${limits.minCronIntervalMinutes} minutes`);
      }
      if (runAt !== undefined && runAt - now < limits.minDelayMs - 1_000) {
        throw new ManagedCopilotError("policy_violation", `One-time tasks must be at least ${Math.round(limits.minDelayMs / 1000)} seconds in the future`);
      }
    }
    if (!this.#deps.credentials().has(principal.accountId)) {
      throw new ManagedCopilotError("authentication_required", `Schedules run as you while you're away. ${LOGIN_HINT}`);
    }

    const session: SessionConfig | undefined = parsed.session
      ? { ...(parsed.session.agent ? { agent: parsed.session.agent } : {}), ...(parsed.session.model ? { model: parsed.session.model } : {}), ...(tools.length ? { tools } : {}) }
      : undefined;
    const definition = { cron: parsed.cron, runAt: parsed.runAt, timeZone, environment, target: parsed.target, session, webhook: parsed.webhook, prompt: parsed.prompt };
    const definitionHash = createHash("sha256").update(canonicalJson(definition)).digest("hex");
    let name = parsed.name;
    const existing = this.#store.byName(principal.accountId, name);
    if (existing) {
      // The same definition for the same session (not an earlier one that had its ID) is a retry.
      const sameTarget = existing.target_incarnation === null || sameIncarnation(existing.target_incarnation, targetView);
      if (existing.definition_hash === definitionHash && existing.created_by === createdBy && sameTarget) return this.#info(existing);
      if (createdBy !== "agent") throw new ManagedCopilotError("conflict", `A schedule named "${name}" already exists; delete it or choose another name`);
      name = `${name.slice(0, 90)}-${newId("x", 3).slice(2)}`;
    }

    const id = newId("sch");
    this.#store.insertSchedule({
      id,
      owner_id: principal.accountId,
      owner_login: principal.login,
      name,
      cron: parsed.cron ?? null,
      run_at: runAt ?? null,
      time_zone: timeZone,
      environment,
      prompt: parsed.prompt,
      state: "active",
      paused_reason: null,
      created_by: createdBy,
      target_session_id: parsed.target?.sessionId ?? null,
      target_incarnation: targetIncarnation,
      origin_session_id: options.originSessionId ?? null,
      session_config: session ? JSON.stringify(session) : null,
      webhook: parsed.webhook ?? null,
      next_run_at: nextRunAt,
      definition_hash: definitionHash,
      apphost_key: null,
      origin_key: options.originKey ?? null,
      created_at: now,
      updated_at: now,
    });
    this.#log.info("Schedule created", { scheduleId: id, owner: principal.login, createdBy, environment, nextRunAt: new Date(nextRunAt).toISOString() });
    return this.#info(this.#store.schedule(id)!);
  }

  list(ownerId: number): ScheduleInfo[] {
    return this.#store.listByOwner(ownerId).map((row) => this.#info(row));
  }

  listForSession(ownerId: number, sessionId: string): ScheduleInfo[] {
    // Only schedules that continue this session, not an earlier deleted session that had the same ID.
    const view = this.#deps.sessions()?.get(sessionId);
    return this.#store
      .listByTarget(sessionId)
      .filter((row) => row.owner_id === ownerId && (row.target_incarnation === null ? !isGone(view) : sameIncarnation(row.target_incarnation, view)))
      .map((row) => this.#info(row));
  }

  get(ownerId: number, scheduleId: string): ScheduleInfo {
    return this.#info(this.#owned(ownerId, scheduleId));
  }

  runs(ownerId: number, scheduleId: string): ScheduleRun[] {
    this.#owned(ownerId, scheduleId);
    return this.#store.runsBySchedule(scheduleId).map(toScheduleRun);
  }

  pause(ownerId: number, scheduleId: string, reason?: string): ScheduleInfo {
    const row = this.#owned(ownerId, scheduleId);
    // Pausing again never clears a platform pause's reason: that reason blocks every run until the owner resumes.
    if (row.state !== "paused") this.#store.updateSchedule(row.id, { state: "paused", paused_reason: reason ?? null }, this.#now());
    this.#log.info("Schedule paused", { scheduleId, reason });
    return this.#info(this.#store.schedule(row.id)!);
  }

  resume(ownerId: number, scheduleId: string): ScheduleInfo {
    const row = this.#owned(ownerId, scheduleId);
    if (!this.#deps.credentials().has(ownerId)) throw new ManagedCopilotError("authentication_required", `Schedules run as you while you're away. ${LOGIN_HINT}`);
    if (this.#targetGone(row)) throw new ManagedCopilotError("conflict", TARGET_GONE);
    const problem = this.#policyProblem(row);
    if (problem) throw problem;
    const now = this.#now();
    let next: number | null = null;
    if (row.cron) {
      // No backfill: the next run is the first occurrence after resuming.
      next = nextOccurrence(parseCron(row.cron), row.time_zone, new Date(now))?.getTime() ?? null;
    } else if (row.run_at !== null && !this.#store.lastRun(row.id)) {
      next = row.run_at;
    }
    this.#store.updateSchedule(row.id, { state: "active", paused_reason: null, next_run_at: next }, now);
    this.#log.info("Schedule resumed", { scheduleId });
    return this.#info(this.#store.schedule(row.id)!);
  }

  delete(ownerId: number, scheduleId: string): void {
    const row = this.#owned(ownerId, scheduleId);
    const now = this.#now();
    this.#store.updateSchedule(row.id, { state: "paused", deleted_at: now, next_run_at: null }, now);
    for (const run of this.#store.runsBySchedule(row.id).filter((candidate) => candidate.status === "queued" && !this.#inFlight.has(candidate.id))) {
      this.#finishRun(run, "skipped", "The schedule was deleted before this run started", row);
    }
    this.#log.info("Schedule deleted", { scheduleId });
  }

  async runNow(ownerId: number, scheduleId: string, invocationId?: string): Promise<ScheduleRun> {
    const row = this.#owned(ownerId, scheduleId);
    if (!this.#deps.credentials().has(ownerId)) throw new ManagedCopilotError("authentication_required", `Schedules run as you while you're away. ${LOGIN_HINT}`);
    if (row.state !== "active" && row.paused_reason) {
      throw new ManagedCopilotError("conflict", `This schedule was paused by the platform: ${row.paused_reason.replace(/^Paused: /, "")} Resume it first.`);
    }
    if (this.#targetGone(row)) throw new ManagedCopilotError("conflict", TARGET_GONE);
    const key = invocationId?.trim() || newId("inv");
    if (key.length > 200) throw new ManagedCopilotError("invalid_request", "invocationId must be at most 200 characters");
    const occurrenceId = occurrenceIdFor(row.id, "manual", key);
    const now = this.#now();
    const existing = this.#store.runByOccurrence(occurrenceId);
    if (existing) {
      if (existing.schedule_id !== row.id) throw new ManagedCopilotError("conflict", "That invocationId was already used for another schedule");
      return toScheduleRun(existing);
    }
    const published: (() => void)[] = [];
    transaction(this.#deps.db, () => this.#addOccurrence(row, now, "manual", occurrenceId, now, undefined, published));
    for (const publish of published) publish();
    this.#dispatchQueued(now);
    return toScheduleRun(this.#store.runByOccurrence(occurrenceId)!);
  }

  /** Platform pauses also take over a person's pause (its null reason would let manual runs through). */
  pauseAllForOwner(ownerId: number, reason: string): number {
    const result = this.#deps.db
      .prepare(
        "UPDATE durable_schedules SET state = 'paused', paused_reason = ?, updated_at = ? WHERE owner_id = ? AND (state = 'active' OR paused_reason IS NULL) AND deleted_at IS NULL",
      )
      .run(reason, this.#now(), ownerId);
    return Number(result.changes);
  }

  /**
   * A deleted session can no longer be continued: schedules that continue it pause, its queued runs are skipped, and
   * runs in progress in it fail. Only what is bound to a session that is no longer current is affected: a later
   * session reusing the ID is a different session, with its own schedules and runs.
   */
  onSessionDeleted(sessionId: string, incarnation?: string): void {
    const view = this.#deps.sessions()?.get(sessionId);
    // The ledger may still show the deleted incarnation while its deletion is announced.
    const current = isGone(view) || (incarnation !== undefined && incarnationOf(view!) === incarnation) ? undefined : view;
    for (const schedule of this.#store.listByTarget(sessionId)) {
      const bound = schedule.target_incarnation;
      const affected = bound === null ? current === undefined : !sameIncarnation(bound, current);
      if (affected) this.#pauseFor(schedule, TARGET_DELETED);
    }
    const runs = this.#deps.db
      .prepare("SELECT * FROM durable_schedule_runs WHERE session_id = ? AND status IN ('queued', 'running', 'waiting')")
      .all(sessionId) as unknown as RunRow[];
    for (const run of runs) {
      // A dispatch in progress rechecks the session itself before it sends anything.
      if (this.#inFlight.has(run.id)) continue;
      if (run.session_incarnation === null) {
        // Unbound: whatever was deleted may be the run's own session (a create whose reply was lost), so the run ends
        // unless the ID names a live session again (a dispatch then adopts it only if this schedule created it).
        if (current !== undefined) continue;
      } else if (sameIncarnation(run.session_incarnation, current)) {
        continue;
      }
      if (run.status === "queued") this.#finishRun(run, "skipped", "The session was deleted before this run started");
      else this.#finishRun(run, "failed", RUN_SESSION_DELETED);
    }
  }

  /** The session a schedule continues was deleted (or its ID now names a different session). */
  #targetGone(schedule: ScheduleRow): boolean {
    if (!schedule.target_session_id) return false;
    const view = this.#deps.sessions()?.get(schedule.target_session_id);
    if (isGone(view) || view!.ownerId !== schedule.owner_id) return true;
    return schedule.target_incarnation !== null && !sameIncarnation(schedule.target_incarnation, view);
  }

  /**
   * Startup repair of what schedules continue (session IDs are reusable after deletion). A target recorded before
   * incarnations existed is bound only when provably the same session (alive, the owner's, and created no later than
   * the schedule); otherwise it is retired and the schedule pauses. A provisional binding (the session's creation
   * time, recorded while core reported no incarnations) is re-keyed to the incarnation core reports now, and an
   * active schedule whose session is gone pauses. Unfinished runs from before incarnations are bound the same way, or
   * end. Returns false (and dispatch waits) while core's sessions are unavailable.
   */
  repairTargets(): boolean {
    const sessions = this.#deps.sessions();
    if (!sessions) return false;
    const now = this.#now();
    for (const schedule of this.#store.listTargeted()) {
      const view = sessions.get(schedule.target_session_id!);
      const bound = schedule.target_incarnation;
      if (bound === null) {
        if (provenSession(view, schedule.owner_id, Number.NEGATIVE_INFINITY, schedule.created_at)) {
          this.#store.updateSchedule(schedule.id, { target_incarnation: incarnationOf(view) }, now);
        } else {
          this.#store.updateSchedule(schedule.id, { target_incarnation: RETIRED }, now);
          this.#pauseFor(schedule, TARGET_DELETED);
          this.#log.warn("A schedule from before session incarnations no longer provably continues its session; paused", { scheduleId: schedule.id });
        }
      } else if (sameIncarnation(bound, view)) {
        if (bound !== incarnationOf(view!)) this.#store.updateSchedule(schedule.id, { target_incarnation: incarnationOf(view!) }, now);
      } else if (schedule.state === "active") {
        this.#pauseFor(schedule, TARGET_DELETED);
      }
    }
    for (const run of this.#store.unboundRuns()) {
      if (this.#inFlight.has(run.id) || !run.session_id) continue;
      // A new session's run that has not created it yet binds when it does.
      if (run.session_mode === "new" && run.session_created === 0) continue;
      const view = sessions.get(run.session_id);
      let bound: string | null | undefined;
      if (run.session_mode === "target") {
        const schedule = this.#store.schedule(run.schedule_id) ?? this.#deletedSchedule(run.schedule_id);
        bound = schedule?.target_incarnation ?? (schedule && provenSession(view, schedule.owner_id, Number.NEGATIVE_INFINITY, schedule.created_at) ? incarnationOf(view) : undefined);
      } else {
        // The run's own session (its ID derives from the occurrence, and this schedule created it): created after the
        // run and before its prompt.
        const notAfter = (run.input_started_at ?? now) + INPUT_CLOCK_SKEW_MS;
        bound =
          provenSession(view, run.owner_id, run.created_at - INPUT_CLOCK_SKEW_MS, notAfter) && view.scheduleId === run.schedule_id ? incarnationOf(view) : undefined;
      }
      if (bound && sameIncarnation(bound, view)) {
        this.#store.updateRun(run.id, ["queued", "running", "waiting"], { session_incarnation: incarnationOf(view!) }, now);
      } else if (run.status === "queued") {
        this.#finishRun(run, "skipped", "The session was deleted before this run started");
      } else {
        this.#finishRun(run, "failed", RUN_SESSION_DELETED);
      }
    }
    this.#targetsRepaired = true;
    return true;
  }

  /** The incarnation a run continues, while it is still the session's current one (undefined once it is gone). */
  #runIncarnation(sessions: DurableSessionsPort, run: RunRow): string | undefined {
    if (!run.session_id || run.session_incarnation === null) return undefined;
    const view = sessions.get(run.session_id);
    return sameIncarnation(run.session_incarnation, view) ? incarnationOf(view!) : undefined;
  }

  /** The run's session was deleted (or its ID names another session now): the run ends, and a target schedule pauses. */
  #sessionGone(run: RunRow, schedule: ScheduleRow): void {
    if (run.session_mode === "target") this.#pauseFor(schedule, TARGET_DELETED);
    if (run.status === "queued") return this.#finishRun(run, "skipped", "The session was deleted before this run started", schedule);
    return this.#finishRun(run, "failed", RUN_SESSION_DELETED, schedule);
  }

  /** `#sessionGone` for a run found while tracking, whose schedule may since have been deleted. */
  #endGoneRun(run: RunRow): void {
    const schedule = this.#store.schedule(run.schedule_id);
    if (schedule) this.#sessionGone(run, schedule);
    else this.#finishRun(run, run.status === "queued" ? "skipped" : "failed", run.status === "queued" ? "The session was deleted before this run started" : RUN_SESSION_DELETED);
  }

  // ---------------------------------------------------------------------------------------------------------
  // AppHost-declared schedules
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Materializes the AppHost's schedule declarations whose `runAs` names this account (spec section 13). Naming an
   * account is not a grant: each declaration appears paused until that account resumes it, which is its explicit
   * grant for this deployment, environment, and schedule. A changed declaration pauses again for re-approval, and a
   * removed one is deleted.
   */
  syncAppHost(account: { readonly accountId: number; readonly login: string }): void {
    const now = this.#now();
    const existing = new Map(this.#store.listAppHost(account.accountId).map((row) => [row.apphost_key!, row]));
    for (const [key, declaration] of Object.entries(this.#deps.deployment.schedules ?? {})) {
      if (!declaration.runAs || declaration.runAs.toLowerCase() !== account.login.toLowerCase()) continue;
      const session: SessionConfig | undefined = declaration.session
        ? {
            ...(declaration.session.agent ? { agent: declaration.session.agent } : {}),
            ...(declaration.session.model ? { model: declaration.session.model } : {}),
            ...(declaration.session.tools?.length ? { tools: declaration.session.tools } : {}),
          }
        : undefined;
      let nextRunAt: number | null;
      try {
        assertTimeZone(declaration.timeZone);
        if (!this.#deps.deployment.environments[declaration.environment]) throw new ManagedCopilotError("environment_not_found", `Unknown environment "${declaration.environment}"`);
        this.#validateWebhook(declaration.webhook, declaration.environment, (session?.tools?.length ?? 0) > 0, session?.tools?.[0]?.name);
        nextRunAt = nextOccurrence(parseCron(declaration.cron), declaration.timeZone, new Date(now))?.getTime() ?? null;
      } catch (error) {
        this.#log.error("AppHost schedule is invalid and will not run", { schedule: key, error: describeError(error) });
        continue;
      }
      const definition = { cron: declaration.cron, timeZone: declaration.timeZone, environment: declaration.environment, session, webhook: declaration.webhook, prompt: declaration.prompt, runAs: declaration.runAs };
      const definitionHash = createHash("sha256").update(canonicalJson(definition)).digest("hex");
      const fields = {
        cron: declaration.cron,
        time_zone: declaration.timeZone,
        environment: declaration.environment,
        prompt: declaration.prompt,
        session_config: session ? JSON.stringify(session) : null,
        webhook: declaration.webhook ?? null,
        definition_hash: definitionHash,
        next_run_at: nextRunAt,
      };
      const row = existing.get(key);
      existing.delete(key);
      if (!row) {
        const name = this.#store.byName(account.accountId, key) ? `${key}-apphost` : key;
        this.#store.insertSchedule({
          id: newId("sch"),
          owner_id: account.accountId,
          owner_login: account.login,
          name,
          run_at: null,
          state: "paused",
          paused_reason: `Declared by this deployment's AppHost to run as ${account.login}. Resume it to allow it to run as you.`,
          created_by: "apphost",
          target_session_id: null,
          target_incarnation: null,
          origin_session_id: null,
          apphost_key: key,
          origin_key: null,
          created_at: now,
          updated_at: now,
          ...fields,
        });
        this.#log.info("AppHost schedule is waiting for its account's approval", { schedule: key, runAs: account.login });
      } else if (row.definition_hash !== definitionHash) {
        this.#store.replaceDefinition(row.id, { ...fields, state: "paused", paused_reason: "The AppHost changed this schedule. Resume it to approve the new definition." }, now);
        this.#log.info("AppHost schedule changed; paused for re-approval", { schedule: key, runAs: account.login });
      }
    }
    for (const row of existing.values()) {
      this.delete(account.accountId, row.id);
      this.#log.info("AppHost schedule removed from the declaration", { schedule: row.apphost_key });
    }
  }

  /** Materializes (or removes) AppHost schedules for every account that signed in or already owns one. */
  syncAppHostForKnownAccounts(): void {
    const accounts = this.#deps.db
      .prepare(
        `SELECT account_id, login FROM durable_credentials
         UNION SELECT owner_id AS account_id, owner_login AS login FROM durable_schedules WHERE apphost_key IS NOT NULL AND deleted_at IS NULL`,
      )
      .all() as { account_id: number; login: string }[];
    const seen = new Set<number>();
    for (const account of accounts) {
      if (seen.has(account.account_id)) continue;
      seen.add(account.account_id);
      this.syncAppHost({ accountId: account.account_id, login: account.login });
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Occurrences
  // ---------------------------------------------------------------------------------------------------------

  /** Records due occurrences and advances the schedule, atomically. Late occurrences are skipped, never backfilled. */
  #materialize(scheduleId: string, now: number): void {
    const published: (() => void)[] = [];
    transaction(this.#deps.db, () => {
      const schedule = this.#store.schedule(scheduleId);
      if (!schedule || schedule.state !== "active" || schedule.next_run_at === null || schedule.next_run_at > now) return;
      if (schedule.cron) {
        const cron = parseCron(schedule.cron);
        const due = occurrencesBetween(cron, schedule.time_zone, new Date(schedule.next_run_at - 1), new Date(now), 21).map((date) => date.getTime());
        if (due.length === 0) due.push(schedule.next_run_at);
        const truncated = due.length > 20;
        for (const [index, at] of due.slice(0, 20).entries()) {
          const missed = now - at > this.#options.missedGraceMs.cron;
          const reason = missed
            ? `Missed: the platform was not running at the scheduled time${truncated && index === 19 ? "; later missed occurrences were not recorded individually" : ""}`
            : undefined;
          this.#addOccurrence(schedule, at, "cron", occurrenceIdFor(schedule.id, "cron", at), now, reason, published);
        }
        const last = due[due.length - 1]!;
        const next = nextOccurrence(cron, schedule.time_zone, new Date(Math.max(now, last)));
        this.#store.updateSchedule(schedule.id, { next_run_at: next?.getTime() ?? null }, now);
      } else {
        const at = schedule.next_run_at;
        const missed = now - at > this.#options.missedGraceMs.once;
        this.#addOccurrence(schedule, at, "once", occurrenceIdFor(schedule.id, "once", schedule.run_at ?? at), now, missed ? "Missed: the platform was not running at the scheduled time" : undefined, published);
        this.#store.updateSchedule(schedule.id, { next_run_at: null }, now);
      }
    });
    for (const publish of published) publish();
  }

  /** Inserts one occurrence (idempotent by occurrence ID). Must run inside a transaction. */
  #addOccurrence(schedule: ScheduleRow, at: number, trigger: RunTrigger, occurrenceId: string, now: number, skipReason: string | undefined, published: (() => void)[]): void {
    const sessionMode = schedule.target_session_id ? "target" : "new";
    // A new session's ID is derived from the occurrence, so a retried creation can never make a second session.
    const sessionId = schedule.target_session_id ?? deterministicUuid("managed-copilot/schedule-run", occurrenceId);
    let status: ScheduleRunStatus = "queued";
    let reason = skipReason;
    if (reason) status = "skipped";
    else if (this.#store.countRuns(schedule.id, ["queued"]) >= this.#options.maxQueuedPerSchedule) {
      status = "skipped";
      reason = "Skipped: an earlier run of this schedule was still waiting to start (runs of one schedule never overlap)";
    }
    const inserted = this.#store.insertRun({
      id: newId("run"),
      schedule_id: schedule.id,
      owner_id: schedule.owner_id,
      occurrence_id: occurrenceId,
      trigger,
      scheduled_for: at,
      status,
      reason: reason ?? null,
      session_mode: sessionMode,
      session_id: sessionId,
      // A run continues the session its schedule is bound to; a new session's run binds when it creates it.
      session_incarnation: sessionMode === "target" ? schedule.target_incarnation : null,
      completed_at: status === "skipped" ? now : null,
      created_at: now,
      updated_at: now,
    });
    if (inserted && status === "skipped") {
      const run = this.#store.runByOccurrence(occurrenceId)!;
      this.#log.info("Schedule occurrence skipped", { scheduleId: schedule.id, scheduledFor: new Date(at).toISOString(), reason });
      published.push(() => this.#publishRun("schedule.run_completed", run, schedule));
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------------------------------------

  #dispatchQueued(now: number): void {
    // Nothing starts before schedule targets and older runs are bound to their sessions' incarnations.
    if (!this.#targetsRepaired && !this.repairTargets()) return;
    for (const run of this.#store.runsByStatus(["queued"])) {
      if (this.#inFlight.has(run.id) || this.#inFlightSchedules.has(run.schedule_id)) continue;
      // One dispatch per session at a time, so input reconciliation for a shared session is never concurrent.
      if (run.session_id && this.#inFlightSessions.has(run.session_id)) continue;
      if (run.next_attempt_at !== null && run.next_attempt_at > now) continue;
      if (this.#store.countRuns(run.schedule_id, ACTIVE_RUN_STATUSES) > 0) continue;
      // Dispatches still creating sessions or sending count against the owner's capacity too.
      const active = this.#store.countOwnerRuns(run.owner_id, ACTIVE_RUN_STATUSES) + (this.#inFlightOwners.get(run.owner_id) ?? 0);
      if (active >= this.#options.maxActiveRunsPerOwner) continue;
      this.#inFlight.add(run.id);
      this.#inFlightSchedules.add(run.schedule_id);
      if (run.session_id) this.#inFlightSessions.add(run.session_id);
      this.#inFlightOwners.set(run.owner_id, (this.#inFlightOwners.get(run.owner_id) ?? 0) + 1);
      void this.#dispatch(run.id)
        .catch((error: unknown) => this.#log.error("Schedule dispatch failed unexpectedly", { runId: run.id, error: (error as Error)?.stack ?? String(error) }))
        .finally(() => {
          this.#inFlight.delete(run.id);
          this.#inFlightSchedules.delete(run.schedule_id);
          if (run.session_id) this.#inFlightSessions.delete(run.session_id);
          const remaining = (this.#inFlightOwners.get(run.owner_id) ?? 1) - 1;
          if (remaining > 0) this.#inFlightOwners.set(run.owner_id, remaining);
          else this.#inFlightOwners.delete(run.owner_id);
        });
    }
  }

  async #dispatch(runId: string): Promise<void> {
    let run = this.#store.run(runId);
    if (!run || run.status !== "queued") return;
    const schedule = this.#store.schedule(run.schedule_id);
    if (!schedule) return this.#finishRun(run, "skipped", "The schedule was deleted before this run started");
    const paused = pausedReason(schedule, run);
    if (paused) return this.#finishRun(run, "skipped", paused, schedule);

    // Recheck delegation, policy, and handler routes at execution time.
    const problem = this.#policyProblem(schedule);
    if (problem) {
      this.#pauseFor(schedule, problem.message);
      return this.#finishRun(run, "failed", problem.message, schedule);
    }
    let principal: Principal;
    try {
      principal = await this.#deps.credentials().principalFor(schedule.owner_id);
    } catch (error) {
      if (isManagedCopilotError(error, "authentication_required")) {
        this.#pauseFor(schedule, `Paused: ${error.message}`);
        return this.#finishRun(run, "failed", error.message, schedule);
      }
      return this.#retryLater(run, schedule, error);
    }
    const sessions = this.#deps.sessions();
    if (!sessions) return this.#retryLater(run, schedule, new ManagedCopilotError("capability_unavailable", "Sessions are not available on this gateway yet"));

    try {
      if (run.session_mode === "new" && run.session_created === 0) {
        const config = parseJson<SessionConfig>(schedule.session_config) ?? {};
        const created = await sessions.create(principal, {
          sessionId: run.session_id!,
          environment: schedule.environment,
          ...(config.model ? { model: config.model } : {}),
          ...(config.agent ? { agent: config.agent } : {}),
          ...(config.tools?.length ? { tools: config.tools } : {}),
          ...(schedule.webhook ? { webhook: schedule.webhook } : {}),
          scheduleId: schedule.id,
        });
        // The run continues the session it created (or found, when retried), never a later one that reuses its ID.
        const view = sessions.get(run.session_id!);
        // An existing session is this run's only if this schedule created it (an earlier attempt whose reply was
        // lost). Otherwise the run's own session may have been deleted and its ID reused: never adopt that one.
        if (!created.created && !isGone(view) && view!.scheduleId !== schedule.id) {
          return this.#finishRun(run, "failed", NOT_THIS_RUNS_SESSION, schedule);
        }
        const incarnation = created.incarnation ?? (isGone(view) ? null : incarnationOf(view!));
        this.#store.updateRun(run.id, ["queued"], { session_created: 1, session_incarnation: incarnation }, this.#now());
      } else if (run.session_mode === "target" && this.#targetGone(schedule)) {
        const message = "The session this schedule continues no longer exists";
        this.#pauseFor(schedule, `Paused: ${message}`);
        return this.#finishRun(run, "failed", message, schedule);
      }

      run = this.#store.run(run.id)!;
      if (run.status !== "queued") return;
      if (this.#runIncarnation(sessions, run) === undefined) return this.#sessionGone(run, schedule);
      if (run.input_state === "submitting") {
        // A previous attempt may have reached the runtime. Its history decides, and while the runtime might still hold
        // the prompt unrecorded (queued behind a turn, or its turn just starting), it is never sent a second time.
        const recovering = run;
        const unconfirmed = (what: string) =>
          this.#runIncarnation(sessions, recovering) === undefined
            ? this.#sessionGone(recovering, schedule)
            : this.#retryLater(recovering, schedule, new ManagedCopilotError("capability_unavailable", what));
        const found = await this.#findSubmittedInput(sessions, recovering, schedule);
        if (found === undefined) return unconfirmed("Could not read the session's history to confirm the prompt");
        if (found !== null) return this.#adoptSubmitted(sessions, recovering, schedule, found);
        const held = await this.#runtimeMayHold(sessions, recovering);
        if (held === undefined) return unconfirmed("Could not read the session's queue to confirm the prompt was not accepted");
        if (held) return this.#awaitAcceptance(recovering, schedule);
        // Nothing queued or running now. A prompt accepted meanwhile has left the queue for the history, so the
        // history, read again after the queue, is conclusive.
        const settled = await this.#findSubmittedInput(sessions, recovering, schedule);
        if (settled === undefined) return unconfirmed("Could not read the session's history to confirm the prompt");
        if (settled !== null) return this.#adoptSubmitted(sessions, recovering, schedule, settled);
      }

      // Everything from here to the send is synchronous: the run, its schedule, and its session are checked as of
      // sending (they may have changed while this dispatch waited), and core refuses the send unless the session is
      // still this incarnation when it writes the prompt.
      const sending = this.#store.run(run.id);
      if (!sending || sending.status !== "queued") return;
      const current = this.#store.schedule(sending.schedule_id);
      if (!current) return this.#finishRun(sending, "skipped", "The schedule was deleted before this run started");
      const pausedNow = pausedReason(current, sending);
      if (pausedNow) return this.#finishRun(sending, "skipped", pausedNow, current);
      const incarnation = this.#runIncarnation(sessions, sending);
      if (incarnation === undefined) return this.#sessionGone(sending, current);
      const startedAt = this.#now();
      this.#store.updateRun(sending.id, ["queued"], { input_state: "submitting", input_started_at: startedAt }, startedAt);
      const { messageId } = await sessions.send(principal, sending.session_id!, { prompt: current.prompt, source: "system" }, { incarnation });
      this.#markStarted(this.#store.run(sending.id)!, current, messageId);
    } catch (error) {
      const latest = this.#store.run(run.id) ?? run;
      if (isManagedCopilotError(error, "needs_reconciliation")) {
        return this.#finishRun(latest, "needs_reconciliation", `${error.message}. Check the session before running it again.`, schedule);
      }
      if (error instanceof ManagedCopilotError && !TRANSIENT_CODES.has(error.code)) {
        if (latest.input_state === "submitting") {
          // The runtime refused the prompt: nothing was accepted, so the failure is certain.
          this.#store.updateRun(latest.id, ["queued"], { input_state: "none" }, this.#now());
        }
        // The session needs a handler that is not connected (for example its SDK hooks): every run would fail the same
        // way until it is, so the schedule pauses with the reason instead of failing on each occurrence.
        if (error.code === "background_callback_unsupported") this.#pauseFor(schedule, `Paused: ${error.message}`);
        // The session was deleted (or its ID reused) as the prompt was sent: core refused it, and it cannot run again.
        if (latest.session_mode === "target" && this.#targetGone(schedule)) this.#pauseFor(schedule, TARGET_DELETED);
        return this.#finishRun(this.#store.run(run.id) ?? latest, "failed", `Could not start the run: ${error.message}`, schedule);
      }
      return this.#retryLater(latest, schedule, error);
    }
  }

  /**
   * Whether the runtime might hold an accepted prompt that its history does not show yet: a prompt waits in the queue
   * until its turn starts (prompts sent as `system` are not listed individually, so any queued work counts), and a
   * turn that just started records its message a moment later. `false` only when nothing is queued or running;
   * `undefined` when the runtime cannot say.
   */
  async #runtimeMayHold(sessions: DurableSessionsPort, run: RunRow): Promise<boolean | undefined> {
    const sessionId = run.session_id!;
    const view = sessions.get(sessionId);
    // Only the run's own session can hold its prompt; once that is gone the caller ends the run.
    const incarnation = this.#runIncarnation(sessions, run);
    if (incarnation === undefined) return undefined;
    if (view!.state === "running" || view!.state === "waiting" || view!.lastTurn?.status === "running") return true;
    try {
      const fence = { incarnation };
      const [pending, queue] = await withTimeout(
        Promise.all([
          sessions.request<{ hasPending?: unknown }>(sessionId, "session.queue.hasPending", { sessionId }, fence),
          sessions.request<{ items?: unknown; steeringMessages?: unknown; withdrawableTurnMessageId?: unknown }>(sessionId, "session.queue.pendingItems", { sessionId }, fence),
        ]),
        QUEUE_READ_TIMEOUT_MS,
      );
      if (typeof pending?.hasPending !== "boolean" || !Array.isArray(queue?.items)) return undefined;
      const steering = Array.isArray(queue.steeringMessages) ? queue.steeringMessages.length : 0;
      return pending.hasPending || queue.items.length > 0 || steering > 0 || typeof queue.withdrawableTurnMessageId === "string";
    } catch {
      return undefined;
    }
  }

  /**
   * The prompt may still be queued in the runtime: check again later, never send it again. A run that cannot
   * confirm it within the run lifetime ends `needs_reconciliation`.
   */
  #awaitAcceptance(run: RunRow, schedule: ScheduleRow): void {
    const now = this.#now();
    const since = run.input_started_at ?? run.created_at;
    if (now - since >= this.#options.maxRunLifetimeMs) {
      return this.#finishRun(
        run,
        "needs_reconciliation",
        "The session still had queued or running work, so it is unknown whether it accepted this run's prompt; it was not sent again. Check the session before running it again.",
        schedule,
      );
    }
    const delay = Math.min(ACCEPTANCE_RECHECK_MS.max, Math.max(this.#options.dispatchRetryBaseMs, Math.round((now - since) / 4)));
    this.#store.updateRun(run.id, ["queued"], { next_attempt_at: now + delay, reason: "Waiting: confirming that the session accepted this run's prompt (it has queued or running work)" }, now);
    this.#log.info("Schedule run is confirming its prompt was accepted", { runId: run.id, sessionId: run.session_id, recheckInMs: delay });
  }

  /** The history shows the run's prompt: its turn may still run, or may have ended while no event was observed. */
  async #adoptSubmitted(sessions: DurableSessionsPort, run: RunRow, schedule: ScheduleRow, messageId: string): Promise<void> {
    this.#markStarted(run, schedule, messageId, true);
    await this.#settleFromLedger(sessions, run.id);
  }

  /**
   * `null`: the history shows the prompt was not consumed. `undefined`: the history could not be read.
   * Throws `needs_reconciliation` when the history cannot attribute a message to this occurrence unambiguously.
   */
  async #findSubmittedInput(sessions: DurableSessionsPort, run: RunRow, schedule: ScheduleRow): Promise<string | null | undefined> {
    // Only the run's own session's history counts: a session that reuses the ID never received this prompt.
    const incarnation = this.#runIncarnation(sessions, run);
    if (incarnation === undefined) return undefined;
    let events: RuntimeSessionEvent[] | undefined;
    try {
      events = (await sessions.request<{ events?: RuntimeSessionEvent[] }>(run.session_id!, "session.getMessages", { sessionId: run.session_id }, { incarnation })).events;
    } catch {
      return undefined;
    }
    if (!Array.isArray(events)) return undefined;
    // Only messages that arrived after this occurrence's send began (with a little clock skew), and that no other
    // run already owns, can be this occurrence's prompt.
    const since = (run.input_started_at ?? run.created_at) - INPUT_CLOCK_SKEW_MS;
    const owned = new Set(
      (this.#deps.db.prepare("SELECT message_id FROM durable_schedule_runs WHERE session_id = ? AND message_id IS NOT NULL AND id != ?").all(run.session_id, run.id) as { message_id: string }[]).map(
        (row) => row.message_id,
      ),
    );
    const candidates = events.filter(
      (event) =>
        event.type === "user.message" &&
        !event.agentId &&
        Date.parse(event.timestamp) >= since &&
        !(typeof event.data.messageId === "string" && owned.has(event.data.messageId)) &&
        // A schedule's own session only ever receives its prompt; a shared session must match the prompt text.
        (run.session_mode === "new" || String(event.data.content ?? "").trim() === schedule.prompt.trim()),
    );
    if (candidates.length === 0) return null;
    if (candidates.length > 1 || typeof candidates[0]!.data.messageId !== "string" || candidates[0]!.data.messageId === "") {
      throw new ManagedCopilotError("needs_reconciliation", "The session's history cannot show which message is this run's prompt, so it was not sent again");
    }
    return candidates[0]!.data.messageId;
  }

  #markStarted(run: RunRow, schedule: ScheduleRow, messageId: string, alreadyInSession = false): void {
    const now = this.#now();
    // The runtime may emit the prompt's user.message before `send` returns, or (after a crash) long before.
    const consumed = alreadyInSession || (messageId !== "" && (this.#recentMessages.get(run.session_id!) ?? []).includes(messageId));
    let updated: boolean;
    try {
      updated = this.#store.updateRun(
        run.id,
        ["queued"],
        { status: "running", input_state: "submitted", message_id: messageId || null, consumed: consumed ? 1 : 0, started_at: now, attempts: 0, next_attempt_at: null, reason: null },
        now,
      );
    } catch (error) {
      // Another run already owns that message (unique per session): never let two occurrences share one prompt.
      if (/UNIQUE/i.test((error as Error).message)) {
        return this.#finishRun(run, "needs_reconciliation", "The session's history cannot show which message is this run's prompt, so it was not sent again. Check the session before running it again.", schedule);
      }
      throw error;
    }
    if (!updated) return;
    const started = this.#store.run(run.id)!;
    this.#log.info("Schedule run started", { scheduleId: schedule.id, runId: run.id, sessionId: run.session_id });
    this.#publishRun("schedule.run_started", started, schedule);
  }

  #retryLater(run: RunRow, schedule: ScheduleRow, error: unknown): void {
    const now = this.#now();
    const attempts = run.attempts + 1;
    if (attempts >= this.#options.maxDispatchAttempts) {
      if (run.input_state === "submitting") {
        return this.#finishRun(run, "needs_reconciliation", "It is unknown whether the runtime accepted this run's prompt, so it was not sent again. Check the session before running it again.", schedule);
      }
      return this.#finishRun(run, "failed", `Could not start the run: ${describeError(error)}`, schedule);
    }
    const delay = Math.min(5 * 60_000, this.#options.dispatchRetryBaseMs * 2 ** (attempts - 1));
    this.#store.updateRun(run.id, ["queued"], { attempts, next_attempt_at: now + delay, reason: `Retrying: ${describeError(error)}` }, now);
    this.#log.warn("Schedule run will be retried", { runId: run.id, attempt: attempts, retryInMs: delay, error: describeError(error) });
  }

  #finishRun(run: RunRow, status: "completed" | "failed" | "skipped" | "needs_reconciliation", reason: string, schedule?: ScheduleRow): void {
    const now = this.#now();
    const from: ScheduleRunStatus[] = status === "skipped" ? ["queued"] : ["queued", "running", "waiting"];
    if (!this.#store.updateRun(run.id, from, { status, reason, completed_at: now }, now)) return;
    const finished = this.#store.run(run.id)!;
    const owner = schedule ?? this.#store.schedule(run.schedule_id) ?? this.#deletedSchedule(run.schedule_id);
    this.#log.info("Schedule run finished", { runId: run.id, status, reason });
    if (owner) this.#publishRun("schedule.run_completed", finished, owner);
  }

  /**
   * Bounds run lifetime without breaking no-overlap or touching other work: only a turn proven to be this run's
   * (its prompt was consumed and it is the session's current turn) is stopped. Otherwise (the prompt may still be
   * queued behind someone else's turn, or the stop fails) the schedule pauses with a visible reason instead.
   */
  async #expireLongRuns(now: number): Promise<void> {
    const hours = Math.round(this.#options.maxRunLifetimeMs / 3_600_000);
    for (const run of this.#store.runsByStatus(ACTIVE_RUN_STATUSES)) {
      if (run.started_at === null || now - run.started_at <= this.#options.maxRunLifetimeMs) continue;
      const sessions = this.#deps.sessions();
      // A run whose session is gone has no turn to stop, and nothing here may stop a turn of a session that reuses its ID.
      const incarnation = sessions ? this.#runIncarnation(sessions, run) : undefined;
      if (sessions && incarnation === undefined) {
        this.#endGoneRun(run);
        continue;
      }
      let stopped = false;
      if (sessions && run.session_id && run.consumed && run.message_id) {
        try {
          const turn = sessions.get(run.session_id)?.lastTurn;
          if (turn?.turnId === run.message_id && turn.status === "running") {
            await sessions.request(run.session_id, "session.abort", { sessionId: run.session_id }, { incarnation });
            stopped = true;
          }
        } catch (error) {
          this.#log.warn("Could not stop an overdue scheduled run", { runId: run.id, sessionId: run.session_id, error: (error as Error).message });
        }
      }
      if (stopped) {
        this.#finishRun(run, "failed", `The run did not finish within ${hours} hours, so its turn was stopped`);
        continue;
      }
      const schedule = this.#store.schedule(run.schedule_id);
      const why = run.consumed ? "could not be stopped" : "never started (its prompt may still be queued in the session)";
      if (schedule) this.#pauseFor(schedule, `Paused: a run ${why} after ${hours} hours; check session ${run.session_id} before resuming`);
      this.#finishRun(run, "failed", `The run did not finish within ${hours} hours and ${why}`, schedule);
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Run tracking
  // ---------------------------------------------------------------------------------------------------------

  /** Follows runtime events to move runs to `completed`/`failed` (the turn's recorded outcome, not mere idleness). */
  onSessionEvent(sessionId: string, event: RuntimeSessionEvent): void {
    // Sub-agents emit their own idle/error events; only the root agent's turn decides a run's outcome.
    if (event.agentId) return;
    if (event.type === "user.message" && typeof event.data.messageId === "string") {
      const recent = this.#recentMessages.get(sessionId) ?? [];
      recent.push(event.data.messageId);
      if (recent.length > 20) recent.shift();
      this.#recentMessages.set(sessionId, recent);
      if (this.#recentMessages.size > 500) this.#recentMessages.delete(this.#recentMessages.keys().next().value!);
    }
    if (!["user.message", "session.idle", "session.error", "abort"].includes(event.type)) return;
    const sessions = this.#deps.sessions();
    // Events come from the session as it is now: runs of an earlier session that had this ID are not affected.
    const runs = (
      this.#deps.db.prepare("SELECT * FROM durable_schedule_runs WHERE session_id = ? AND status IN ('running', 'waiting')").all(sessionId) as unknown as RunRow[]
    ).filter((run) => sessions !== undefined && this.#runIncarnation(sessions, run) !== undefined);
    const now = this.#now();
    for (const run of runs) {
      switch (event.type) {
        case "user.message":
          if (run.message_id && event.data.messageId === run.message_id) this.#store.updateRun(run.id, ACTIVE_RUN_STATUSES, { consumed: 1 }, now);
          break;
        case "session.error":
          if (run.consumed || (run.message_id && event.data.originatingMessageId === run.message_id)) {
            this.#finishRun(run, "failed", `The run's turn failed: ${String(event.data.message ?? "unknown error")}`);
          }
          break;
        case "abort":
          if (run.consumed) this.#finishRun(run, "failed", "The run's turn was cancelled");
          break;
        case "session.idle":
          if (!run.consumed) break;
          if (event.data.aborted === true) this.#finishRun(run, "failed", "The run's turn was cancelled");
          else this.#finishRun(run, "completed", "The agent finished the run's turn");
          break;
      }
    }
  }

  /**
   * Settles a run from core's session ledger, which records each root turn's outcome keyed by the prompt's message
   * ID (`lastTurn`). Used after a restart, when the turn may have ended while no event could be observed.
   */
  async #settleFromLedger(sessions: DurableSessionsPort, runId: string): Promise<void> {
    const run = this.#store.run(runId);
    if (!run || !ACTIVE_RUN_STATUSES.includes(run.status) || !run.session_id) return;
    // Its session is gone: no turn of a session that reuses the ID says anything about this run.
    if (this.#runIncarnation(sessions, run) === undefined) return this.#endGoneRun(run);
    const turn = sessions.get(run.session_id)?.lastTurn;
    // Only the run's own turn proves its outcome: another turn's result (or timing) says nothing about it.
    if (!turn || turn.status === "running" || turn.turnId === undefined || turn.turnId !== run.message_id) return;
    if (turn.status === "completed") this.#finishRun(run, "completed", "The agent finished the run's turn");
    else if (turn.status === "cancelled") this.#finishRun(run, "failed", "The run's turn was cancelled");
    else this.#finishRun(run, "failed", "The run's turn failed");
  }

  #onActionChange(change: ActionChange): void {
    const sessions = this.#deps.sessions();
    if (!sessions) return;
    // The ledger's actions are the session's current incarnation's; only runs in that incarnation follow them.
    const runs = (
      this.#deps.db.prepare("SELECT * FROM durable_schedule_runs WHERE session_id = ? AND status IN ('running', 'waiting')").all(change.sessionId) as unknown as RunRow[]
    ).filter((run) => this.#runIncarnation(sessions, run) !== undefined);
    if (runs.length === 0) return;
    const incarnation = this.#runIncarnation(sessions, runs[0]!)!;
    const open = this.#deps.actions()?.list(change.sessionId, { open: true, incarnation }) ?? [];
    const waiting = open.some((action) => action.state === "pending" || action.state === "needs_reconciliation");
    const now = this.#now();
    for (const run of runs) {
      if (waiting && run.status === "running") this.#store.updateRun(run.id, ["running"], { status: "waiting", reason: "Waiting for a tool or approval to be answered" }, now);
      if (!waiting && run.status === "waiting") this.#store.updateRun(run.id, ["waiting"], { status: "running", reason: null }, now);
    }
  }

  /** After a restart (and periodically), settles runs whose turn ended, or whose session went away, unobserved. */
  async #recoverActiveRuns(): Promise<void> {
    const sessions = this.#deps.sessions();
    if (!sessions) return;
    for (const run of this.#store.runsByStatus(ACTIVE_RUN_STATUSES)) {
      if (!run.consumed && this.#runIncarnation(sessions, run) !== undefined) continue;
      try {
        await this.#settleFromLedger(sessions, run.id);
      } catch (error) {
        this.#log.debug("Could not check a run's session", { runId: run.id, error: (error as Error).message });
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------------------

  #policyProblem(schedule: ScheduleRow): ManagedCopilotError | undefined {
    const environment = this.#deps.deployment.environments[schedule.environment];
    if (!environment) return new ManagedCopilotError("environment_not_found", `Environment "${schedule.environment}" is no longer declared in this deployment`);
    if (schedule.created_by === "agent" && environment.scheduling !== true) {
      return new ManagedCopilotError("policy_violation", `Scheduling is no longer enabled for environment "${schedule.environment}"`);
    }
    const config = parseJson<SessionConfig>(schedule.session_config);
    try {
      this.#validateWebhook(schedule.webhook ?? undefined, schedule.environment, (config?.tools?.length ?? 0) > 0, config?.tools?.[0]?.name);
    } catch (error) {
      if (error instanceof ManagedCopilotError) return new ManagedCopilotError("background_callback_unsupported", error.message);
      throw error;
    }
    return undefined;
  }

  #validateWebhook(name: string | undefined, environment: string, hasTools: boolean, firstTool: string | undefined): void {
    if (name === undefined) {
      if (hasTools) {
        throw new ManagedCopilotError(
          "background_callback_unsupported",
          `A scheduled session runs while your app may be offline, so its tools (such as ${firstTool}) need a webhook that answers them. Declare one in the AppHost and pass webhook.`,
        );
      }
      return;
    }
    const declaration = this.#deps.deployment.webhooks?.[name];
    if (!declaration) throw new ManagedCopilotError("invalid_request", `Unknown webhook "${name}"; declare it in the AppHost`);
    if (!declaration.environments.includes(environment)) throw new ManagedCopilotError("policy_violation", `Webhook "${name}" is not authorized for environment "${environment}"`);
    if (hasTools && !declaration.events.includes("session.action_required") && !declaration.events.includes("*")) {
      throw new ManagedCopilotError("invalid_request", `Webhook "${name}" must subscribe to session.action_required to answer tool calls`);
    }
  }

  /**
   * A platform pause (safety, revoked sign-in, policy) blocks every run, so it also takes over a person's pause, whose
   * null reason would still let manual runs through. An existing platform reason is kept.
   */
  #pauseFor(schedule: ScheduleRow, reason: string): void {
    this.#deps.db
      .prepare("UPDATE durable_schedules SET state = 'paused', paused_reason = ?, updated_at = ? WHERE id = ? AND (state = 'active' OR paused_reason IS NULL) AND deleted_at IS NULL")
      .run(reason, this.#now(), schedule.id);
  }

  #owned(ownerId: number, scheduleId: string): ScheduleRow {
    const row = this.#store.schedule(scheduleId);
    if (!row || row.owner_id !== ownerId) throw new ManagedCopilotError("not_found", `Schedule ${scheduleId} was not found`);
    return row;
  }

  #deletedSchedule(scheduleId: string): ScheduleRow | undefined {
    return this.#deps.db.prepare("SELECT * FROM durable_schedules WHERE id = ?").get(scheduleId) as ScheduleRow | undefined;
  }

  #info(row: ScheduleRow): ScheduleInfo {
    return toScheduleInfo(row, this.#store.lastRun(row.id));
  }

  #publishRun(type: "schedule.run_started" | "schedule.run_completed", run: RunRow, schedule: ScheduleRow): void {
    const data = RUN_EVENT_DATA(run, schedule);
    const event: PlatformEvent = {
      id: newId("evt"),
      type,
      createdAt: new Date(this.#now()).toISOString(),
      ...(data.sessionId ? { sessionId: data.sessionId } : {}),
      environment: schedule.environment,
      data,
    };
    try {
      this.#deps.publish(event, { ownerId: schedule.owner_id });
    } catch (error) {
      this.#log.error("Publishing a schedule event failed", { type, runId: run.id, error: (error as Error).message });
    }
  }
}
