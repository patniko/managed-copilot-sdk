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
import type { ActionsService, CredentialsService, DurableSessionsPort, PlatformEventMeta, RuntimeSessionEvent, SchedulesService } from "../contract.js";
import { canonicalJson, deterministicUuid, newId, parseJson } from "../ids.js";
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
  /** Recent `user.message` IDs per session: a prompt's event can arrive before `send` returns its ID. */
  readonly #recentMessages = new Map<string, string[]>();
  readonly #disposers: (() => void)[] = [];
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<void> | undefined;

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

  /** Resolves when every dispatch started so far has settled (tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) await new Promise((resolve) => setTimeout(resolve, 5));
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
    this.#expireLongRuns(now);
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
    if (parsed.target) {
      if (parsed.session) throw new ManagedCopilotError("invalid_request", "A schedule that continues an existing session uses that session's configuration; remove session");
      const view = await this.#deps.sessions()?.get(parsed.target.sessionId);
      if (!view || view.ownerId !== principal.accountId) throw new ManagedCopilotError("not_found", `Session ${parsed.target.sessionId} was not found`);
      if (parsed.environment && parsed.environment !== view.environment) {
        throw new ManagedCopilotError("invalid_request", `Session ${parsed.target.sessionId} runs in environment "${view.environment}", not "${parsed.environment}"`);
      }
      environment = view.environment;
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
      if (existing.definition_hash === definitionHash && existing.created_by === createdBy) return this.#info(existing);
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
    return this.#store
      .listByTarget(sessionId)
      .filter((row) => row.owner_id === ownerId)
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
    this.#store.updateSchedule(row.id, { state: "paused", paused_reason: reason ?? null }, this.#now());
    this.#log.info("Schedule paused", { scheduleId, reason });
    return this.#info(this.#store.schedule(row.id)!);
  }

  resume(ownerId: number, scheduleId: string): ScheduleInfo {
    const row = this.#owned(ownerId, scheduleId);
    if (!this.#deps.credentials().has(ownerId)) throw new ManagedCopilotError("authentication_required", `Schedules run as you while you're away. ${LOGIN_HINT}`);
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

  pauseAllForOwner(ownerId: number, reason: string): number {
    const result = this.#deps.db
      .prepare("UPDATE durable_schedules SET state = 'paused', paused_reason = ?, updated_at = ? WHERE owner_id = ? AND state = 'active' AND deleted_at IS NULL")
      .run(reason, this.#now(), ownerId);
    return Number(result.changes);
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

  /** Materializes AppHost schedules for every account that has signed in for background work. */
  syncAppHostForKnownAccounts(): void {
    if (!this.#deps.deployment.schedules) return;
    const accounts = this.#deps.db.prepare("SELECT account_id, login FROM durable_credentials").all() as { account_id: number; login: string }[];
    for (const account of accounts) this.syncAppHost({ accountId: account.account_id, login: account.login });
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
    const activeByOwner = new Map<number, number>();
    for (const run of this.#store.runsByStatus(["queued"])) {
      if (this.#inFlight.has(run.id) || this.#inFlightSchedules.has(run.schedule_id)) continue;
      if (run.next_attempt_at !== null && run.next_attempt_at > now) continue;
      if (this.#store.countRuns(run.schedule_id, ACTIVE_RUN_STATUSES) > 0) continue;
      const active = activeByOwner.get(run.owner_id) ?? this.#store.countOwnerRuns(run.owner_id, ACTIVE_RUN_STATUSES);
      if (active >= this.#options.maxActiveRunsPerOwner) continue;
      activeByOwner.set(run.owner_id, active + 1);
      this.#inFlight.add(run.id);
      this.#inFlightSchedules.add(run.schedule_id);
      void this.#dispatch(run.id)
        .catch((error: unknown) => this.#log.error("Schedule dispatch failed unexpectedly", { runId: run.id, error: (error as Error)?.stack ?? String(error) }))
        .finally(() => {
          this.#inFlight.delete(run.id);
          this.#inFlightSchedules.delete(run.schedule_id);
        });
    }
  }

  async #dispatch(runId: string): Promise<void> {
    let run = this.#store.run(runId);
    if (!run || run.status !== "queued") return;
    const schedule = this.#store.schedule(run.schedule_id);
    if (!schedule) return this.#finishRun(run, "skipped", "The schedule was deleted before this run started");
    if (schedule.state !== "active" && run.trigger !== "manual") {
      return this.#finishRun(run, "skipped", `The schedule was paused before this run started${schedule.paused_reason ? ` (${schedule.paused_reason})` : ""}`, schedule);
    }

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
        await sessions.create(principal, {
          sessionId: run.session_id!,
          environment: schedule.environment,
          ...(config.model ? { model: config.model } : {}),
          ...(config.agent ? { agent: config.agent } : {}),
          ...(config.tools?.length ? { tools: config.tools } : {}),
          ...(schedule.webhook ? { webhook: schedule.webhook } : {}),
          scheduleId: schedule.id,
        });
        this.#store.updateRun(run.id, ["queued"], { session_created: 1 }, this.#now());
      } else if (run.session_mode === "target") {
        const view = await sessions.get(run.session_id!);
        if (!view || view.ownerId !== schedule.owner_id) {
          const message = "The session this schedule continues no longer exists";
          this.#pauseFor(schedule, `Paused: ${message}`);
          return this.#finishRun(run, "failed", message, schedule);
        }
      }

      run = this.#store.run(run.id)!;
      if (run.status !== "queued") return;
      if (run.input_state === "submitting") {
        // A previous attempt may have reached the runtime: its history decides, never a blind resend.
        const found = await this.#findSubmittedInput(sessions, run, schedule);
        if (found === undefined) return this.#retryLater(run, schedule, new ManagedCopilotError("capability_unavailable", "Could not read the session's history to confirm the prompt"));
        if (found) return this.#markStarted(run, schedule, found);
      }
      const startedAt = this.#now();
      this.#store.updateRun(run.id, ["queued"], { input_state: "submitting", input_started_at: startedAt }, startedAt);
      const { messageId } = await sessions.send(principal, run.session_id!, { prompt: schedule.prompt, source: "system" });
      this.#markStarted(this.#store.run(run.id)!, schedule, messageId);
    } catch (error) {
      const latest = this.#store.run(run.id) ?? run;
      if (error instanceof ManagedCopilotError && !TRANSIENT_CODES.has(error.code)) {
        if (latest.input_state === "submitting") {
          // The runtime refused the prompt: nothing was accepted, so the failure is certain.
          this.#store.updateRun(latest.id, ["queued"], { input_state: "none" }, this.#now());
        }
        return this.#finishRun(this.#store.run(run.id) ?? latest, "failed", `Could not start the run: ${error.message}`, schedule);
      }
      return this.#retryLater(latest, schedule, error);
    }
  }

  /** `null`: the history shows the prompt was not accepted. `undefined`: the history could not be read. */
  async #findSubmittedInput(sessions: DurableSessionsPort, run: RunRow, schedule: ScheduleRow): Promise<string | null | undefined> {
    let events: RuntimeSessionEvent[] | undefined;
    try {
      events = (await sessions.request<{ events?: RuntimeSessionEvent[] }>(run.session_id!, "session.getMessages", { sessionId: run.session_id })).events;
    } catch {
      return undefined;
    }
    if (!Array.isArray(events)) return undefined;
    const since = (run.input_started_at ?? run.created_at) - 60_000;
    const match = events.find(
      (event) =>
        event.type === "user.message" &&
        Date.parse(event.timestamp) >= since &&
        // A schedule's own session only ever receives its prompt; a shared session must match the prompt text.
        (run.session_mode === "new" || String(event.data.content ?? "").trim() === schedule.prompt.trim()),
    );
    if (!match) return null;
    return typeof match.data.messageId === "string" ? match.data.messageId : "";
  }

  #markStarted(run: RunRow, schedule: ScheduleRow, messageId: string): void {
    const now = this.#now();
    const consumed = messageId !== "" && (this.#recentMessages.get(run.session_id!) ?? []).includes(messageId);
    const updated = this.#store.updateRun(
      run.id,
      ["queued"],
      { status: "running", input_state: "submitted", message_id: messageId || null, consumed: consumed ? 1 : 0, started_at: now, attempts: 0, next_attempt_at: null, reason: null },
      now,
    );
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

  #expireLongRuns(now: number): void {
    for (const run of this.#store.runsByStatus(ACTIVE_RUN_STATUSES)) {
      if (run.started_at !== null && now - run.started_at > this.#options.maxRunLifetimeMs) {
        this.#finishRun(run, "failed", `The run did not finish within ${Math.round(this.#options.maxRunLifetimeMs / 3_600_000)} hours`);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Run tracking
  // ---------------------------------------------------------------------------------------------------------

  /** Follows runtime events to move runs to `completed`/`failed` (the turn's recorded outcome, not mere idleness). */
  onSessionEvent(sessionId: string, event: RuntimeSessionEvent): void {
    if (event.type === "user.message" && typeof event.data.messageId === "string") {
      const recent = this.#recentMessages.get(sessionId) ?? [];
      recent.push(event.data.messageId);
      if (recent.length > 20) recent.shift();
      this.#recentMessages.set(sessionId, recent);
      if (this.#recentMessages.size > 500) this.#recentMessages.delete(this.#recentMessages.keys().next().value!);
    }
    if (!["user.message", "session.idle", "session.error", "abort"].includes(event.type)) return;
    const runs = this.#deps.db
      .prepare("SELECT * FROM durable_schedule_runs WHERE session_id = ? AND status IN ('running', 'waiting')")
      .all(sessionId) as unknown as RunRow[];
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
          if (run.consumed) this.#finishRun(run, "completed", "The agent finished the run's turn");
          break;
      }
    }
  }

  #onActionChange(change: ActionChange): void {
    const runs = this.#deps.db
      .prepare("SELECT * FROM durable_schedule_runs WHERE session_id = ? AND status IN ('running', 'waiting')")
      .all(change.sessionId) as unknown as RunRow[];
    if (runs.length === 0) return;
    const open = this.#deps.actions()?.list(change.sessionId, { open: true }) ?? [];
    const waiting = open.some((action) => action.state === "pending" || action.state === "needs_reconciliation");
    const now = this.#now();
    for (const run of runs) {
      if (waiting && run.status === "running") this.#store.updateRun(run.id, ["running"], { status: "waiting", reason: "Waiting for a tool or approval to be answered" }, now);
      if (!waiting && run.status === "waiting") this.#store.updateRun(run.id, ["waiting"], { status: "running", reason: null }, now);
    }
  }

  /** After a restart, settles runs whose turn finished while the gateway was down; the rest keep following events. */
  async #recoverActiveRuns(): Promise<void> {
    const sessions = this.#deps.sessions();
    if (!sessions) return;
    for (const run of this.#store.runsByStatus(ACTIVE_RUN_STATUSES)) {
      try {
        const view = await sessions.get(run.session_id!);
        if (!view) continue;
        if (view.state === "failed" || view.lastTurn?.status === "failed") this.#finishRun(run, "failed", "The run's turn failed while the platform was restarting");
        else if (run.consumed && view.state === "idle" && view.lastTurn?.status === "completed") this.#finishRun(run, "completed", "The agent finished the run's turn");
      } catch (error) {
        this.#log.debug("Could not check a run after restart", { runId: run.id, error: (error as Error).message });
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

  #pauseFor(schedule: ScheduleRow, reason: string): void {
    if (schedule.state === "active") this.#store.updateSchedule(schedule.id, { state: "paused", paused_reason: reason }, this.#now());
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
