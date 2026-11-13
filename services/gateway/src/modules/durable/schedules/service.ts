import { createHash } from "node:crypto";
import {
  isManagedCopilotError,
  ManagedCopilotError,
  type CreateScheduleRequest,
  type ScheduleInfo,
  type ScheduleRun,
} from "@managed-copilot/protocol";
import { transaction } from "../../../db.js";
import { isGitHubPrincipal, type Principal } from "../../../http.js";
import { redactText } from "../../../redaction.js";
import type { DurableSessionView, SchedulesService } from "../contract.js";
import { canonicalJson, incarnationOf, isGone, newId, sameIncarnation } from "../ids.js";
import { LOGIN_HINT } from "../credentials/service.js";
import { assertTimeZone, minimumIntervalMinutes, nextOccurrence, parseCron } from "./cron.js";
import {
  ACTIVE_RUN_STATUSES,
  ScheduleStore,
  toScheduleRun,
  type RunRow,
  type ScheduleCreator,
  type ScheduleRow,
  type SessionConfig,
} from "./store.js";
import {
  type ScheduleOperatorRecord,
  OPERATOR_PAUSE,
  OWNER_PAUSED_TOO,
  type CreateOptions,
  CreateScheduleSchema,
  LEDGER_CHECK_INTERVAL_MS,
  INPUT_CLOCK_SKEW_MS,
  TARGET_GONE,
  TARGET_DELETED,
  RUN_SESSION_DELETED,
  RETIRED,
  provenSession,
  occurrenceIdFor,
  describeError,
} from "./support.js";
import { ScheduleDispatch } from "./dispatch.js";

/**
 * Cron and one-shot schedules (spec section 13). Each occurrence is persisted with a stable ID before anything
 * happens upstream; dispatch then moves through recorded phases (session created → input submitting → submitted) so a
 * restart at any point neither creates a second session nor sends the prompt twice.
 */
export class DurableSchedules extends ScheduleDispatch implements SchedulesService {
  get store(): ScheduleStore {
    return this.scheduleStore;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------------------

  start(): void {
    this.repairTargets();
    const sessions = this.deps.sessions();
    if (sessions) this.disposers.push(sessions.subscribe((sessionId, event) => this.onSessionEvent(sessionId, event)));
    const actions = this.deps.actions();
    if (actions?.onChange) this.disposers.push(actions.onChange((change) => this.onActionChange(change)));
    this.syncAppHostForKnownAccounts();
    void this.recoverActiveRuns();
    if (this.options.tickIntervalMs > 0) {
      this.timer = setInterval(() => void this.tick(), this.options.tickIntervalMs);
      this.timer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const dispose of this.disposers.splice(0)) dispose();
    await this.ticking;
    // In-flight dispatches write to the ledger; let them settle before the database closes.
    await this.idle(10_000);
  }

  /** One scheduler pass: materialize due occurrences, enforce run lifetimes, and dispatch queued runs. */
  tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = this.#tickOnce()
        .then(
          () => {
            this.lastTickAt = this.now();
            this.lastTickError = undefined;
          },
          (error: unknown) => {
            this.lastTickAt = this.now();
            this.lastTickError = describeError(error);
            throw error;
          },
        )
        .finally(() => {
          this.ticking = undefined;
        });
    }
    return this.ticking;
  }

  /** Resolves when every dispatch started so far has settled (tests and graceful shutdown), or after `timeoutMs`. */
  async idle(timeoutMs = Number.POSITIVE_INFINITY): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  async #tickOnce(): Promise<void> {
    const now = this.now();
    for (const schedule of this.scheduleStore.listDue(now)) {
      try {
        this.materialize(schedule.id, now);
      } catch (error) {
        this.log.error("Could not materialize a schedule occurrence", { scheduleId: schedule.id, error: (error as Error)?.stack ?? String(error) });
      }
    }
    await this.expireLongRuns(now);
    // Safety net for turn outcomes that produced no observable event (missed while reconnecting, ephemeral idle).
    if (now - this.lastLedgerCheck >= LEDGER_CHECK_INTERVAL_MS) {
      this.lastLedgerCheck = now;
      await this.recoverActiveRuns();
    }
    this.dispatchQueued(now);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Service API
  // ---------------------------------------------------------------------------------------------------------

  async create(principal: Principal, request: CreateScheduleRequest, options: CreateOptions = {}): Promise<ScheduleInfo> {
    // Runs happen with the owner's background sign-in, a GitHub credential stored from the CLI.
    if (!isGitHubPrincipal(principal)) {
      throw new ManagedCopilotError("capability_unavailable", "Schedules run with their owner's background GitHub sign-in, and an app's own users have none.");
    }
    if (principal.app) {
      throw new ManagedCopilotError("capability_unavailable", `Schedules run with their owner's background sign-in (\`npx managed-copilot login\`), which is never made through an app; create it outside the "${principal.app}" app.`);
    }
    const createdBy: ScheduleCreator = options.createdBy ?? "user";
    const parsed = CreateScheduleSchema.parse(request);
    const now = this.now();
    if (options.originKey) {
      const existing = this.scheduleStore.byOriginKey(principal.accountId, options.originKey);
      if (existing) return this.info(existing);
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
      const view = this.deps.sessions()?.get(parsed.target.sessionId);
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
    const environmentConfig = this.deps.deployment.environments[environment];
    if (!environmentConfig) throw new ManagedCopilotError("environment_not_found", `Environment "${environment}" is not declared in this deployment`);

    const tools = parsed.session?.tools ?? [];
    const names = new Set<string>();
    for (const tool of tools) {
      if (names.has(tool.name)) throw new ManagedCopilotError("invalid_request", `Tool ${tool.name} is declared twice`);
      names.add(tool.name);
    }
    this.validateWebhook(parsed.webhook, environment, tools.length > 0, tools[0]?.name);

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
    if (nextRunAt - now > this.options.maxHorizonMs) throw new ManagedCopilotError("policy_violation", "Schedules can start at most a year ahead");

    if (createdBy === "agent") {
      if (environmentConfig.scheduling !== true) throw new ManagedCopilotError("policy_violation", `Scheduling is not enabled for environment "${environment}"`);
      const limits = this.options.agent;
      if (options.originSessionId && this.scheduleStore.countActiveByOrigin(options.originSessionId) >= limits.maxActivePerSession) {
        throw new ManagedCopilotError("policy_violation", `This session already has ${limits.maxActivePerSession} active scheduled tasks; cancel one first`);
      }
      if (cronSchedule && minimumIntervalMinutes(cronSchedule, timeZone, new Date(now)) < limits.minCronIntervalMinutes) {
        throw new ManagedCopilotError("policy_violation", `Recurring tasks may run at most every ${limits.minCronIntervalMinutes} minutes`);
      }
      if (runAt !== undefined && runAt - now < limits.minDelayMs - 1_000) {
        throw new ManagedCopilotError("policy_violation", `One-time tasks must be at least ${Math.round(limits.minDelayMs / 1000)} seconds in the future`);
      }
    }
    if (!this.deps.credentials().has(principal.accountId)) {
      throw new ManagedCopilotError("authentication_required", `Schedules run as you while you're away. ${LOGIN_HINT}`);
    }

    const session: SessionConfig | undefined = parsed.session
      ? { ...(parsed.session.agent ? { agent: parsed.session.agent } : {}), ...(parsed.session.model ? { model: parsed.session.model } : {}), ...(tools.length ? { tools } : {}) }
      : undefined;
    const definition = { cron: parsed.cron, runAt: parsed.runAt, timeZone, environment, target: parsed.target, session, webhook: parsed.webhook, prompt: parsed.prompt };
    const definitionHash = createHash("sha256").update(canonicalJson(definition)).digest("hex");
    let name = parsed.name;
    const existing = this.scheduleStore.byName(principal.accountId, name);
    if (existing) {
      // The same definition for the same session (not an earlier one that had its ID) is a retry.
      const sameTarget = existing.target_incarnation === null || sameIncarnation(existing.target_incarnation, targetView);
      if (existing.definition_hash === definitionHash && existing.created_by === createdBy && sameTarget) return this.info(existing);
      if (createdBy !== "agent") throw new ManagedCopilotError("conflict", `A schedule named "${name}" already exists; delete it or choose another name`);
      name = `${name.slice(0, 90)}-${newId("x", 3).slice(2)}`;
    }

    const id = newId("sch");
    this.scheduleStore.insertSchedule({
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
    this.log.info("Schedule created", { scheduleId: id, owner: principal.login, createdBy, environment, nextRunAt: new Date(nextRunAt).toISOString() });
    return this.info(this.scheduleStore.schedule(id)!);
  }

  list(ownerId: number): ScheduleInfo[] {
    return this.scheduleStore.listByOwner(ownerId).map((row) => this.info(row));
  }

  // ---------------------------------------------------------------------------------------------------------
  // Operator views and actions (the operator module authorizes callers)
  // ---------------------------------------------------------------------------------------------------------

  /** Schedules of every owner (deleted ones left out). A person's or an agent's prompt is never included. */
  operatorSchedules(query: { readonly ownerId?: number; readonly state?: ScheduleInfo["state"]; readonly targetSessionId?: string } = {}): ScheduleOperatorRecord[] {
    return this.scheduleStore
      .listAll()
      .filter((row) => query.ownerId === undefined || row.owner_id === query.ownerId)
      .filter((row) => query.state === undefined || row.state === query.state)
      .filter((row) => query.targetSessionId === undefined || row.target_session_id === query.targetSessionId)
      .map((row) => this.#operatorRecord(row));
  }

  operatorRuns(scheduleId: string): { readonly schedule: ScheduleOperatorRecord; readonly runs: ScheduleRun[] } {
    const row = this.scheduleStore.schedule(scheduleId);
    if (!row) throw new ManagedCopilotError("not_found", `Schedule ${scheduleId} was not found`);
    const runs = this.scheduleStore.runsBySchedule(scheduleId).map(toScheduleRun);
    return { schedule: this.#operatorRecord(row), runs: runs.map((run) => (run.reason ? { ...run, reason: redactText(run.reason) } : run)) };
  }

  /**
   * An operator's pause, with a reason its owner sees. Like a platform pause, it blocks every run (manual ones too)
   * until the schedule is resumed, and it takes over the owner's own pause (whose missing reason lets manual runs
   * through), remembering it: lifting the operator's pause then leaves the owner's in place. A platform pause is kept.
   */
  operatorPause(scheduleId: string, operator: string, reason?: string): ScheduleOperatorRecord {
    const row = this.scheduleStore.schedule(scheduleId);
    if (!row) throw new ManagedCopilotError("not_found", `Schedule ${scheduleId} was not found`);
    if (row.state === "paused" && row.paused_reason) {
      throw new ManagedCopilotError("conflict", `Schedule "${row.name}" is already paused (${row.paused_reason.replace(/^Paused: /, "")}).`);
    }
    const detail = reason?.trim() ? ` (${reason.trim().slice(0, 200)})` : "";
    const text = `${OPERATOR_PAUSE}${operator}) paused this schedule${detail}.${row.state === "paused" ? OWNER_PAUSED_TOO : ""}`;
    const updated = this.deps.db
      .prepare("UPDATE durable_schedules SET state = 'paused', paused_reason = ?, updated_at = ? WHERE id = ? AND state = ? AND (state = 'active' OR paused_reason IS NULL) AND deleted_at IS NULL")
      .run(text, this.now(), row.id, row.state);
    if (Number(updated.changes) !== 1) throw new ManagedCopilotError("conflict", `Schedule "${row.name}" changed while it was being paused; refresh and try again.`);
    this.log.info("Schedule paused by an operator", { scheduleId, operator, ownerPaused: row.state === "paused" });
    return this.#operatorRecord(this.scheduleStore.schedule(scheduleId)!);
  }

  /**
   * Lifts an operator's pause, and only that: a pause by the owner or by the platform (a revoked sign-in, a definition
   * the owner has not approved) is the owner's to lift. Resuming makes the owner's checks (background sign-in, target
   * session, policy); an owner's pause the operator's took over stays.
   */
  operatorResume(scheduleId: string): ScheduleOperatorRecord {
    const row = this.scheduleStore.schedule(scheduleId);
    if (!row) throw new ManagedCopilotError("not_found", `Schedule ${scheduleId} was not found`);
    if (row.state === "active") throw new ManagedCopilotError("conflict", `Schedule "${row.name}" is not paused.`);
    if (!row.paused_reason?.startsWith(OPERATOR_PAUSE)) {
      const by = row.paused_reason ? `the platform (${row.paused_reason.replace(/^Paused: /, "")})` : `its owner, @${row.owner_login}`;
      throw new ManagedCopilotError("conflict", `Schedule "${row.name}" was paused by ${by}; only its owner can resume it.`);
    }
    if (row.paused_reason.endsWith(OWNER_PAUSED_TOO)) {
      const lifted = this.deps.db
        .prepare("UPDATE durable_schedules SET paused_reason = NULL, updated_at = ? WHERE id = ? AND state = 'paused' AND paused_reason = ? AND deleted_at IS NULL")
        .run(this.now(), row.id, row.paused_reason);
      if (Number(lifted.changes) !== 1) throw new ManagedCopilotError("conflict", `Schedule "${row.name}" changed while it was being resumed; refresh and try again.`);
      this.log.info("Operator pause lifted; the owner's pause stays", { scheduleId });
      return this.#operatorRecord(this.scheduleStore.schedule(scheduleId)!);
    }
    try {
      this.resume(row.owner_id, scheduleId);
    } catch (error) {
      if (isManagedCopilotError(error, "authentication_required")) {
        throw new ManagedCopilotError("conflict", `@${row.owner_login} has no active background sign-in, so this schedule cannot run. They need to run \`npx managed-copilot login\` first.`);
      }
      throw error;
    }
    return this.#operatorRecord(this.scheduleStore.schedule(scheduleId)!);
  }

  schedulerStatus(): { running: boolean; tickIntervalMs: number; lastTickAt?: string; lastTickError?: string; nextDueAt?: string; queuedRuns: number; activeRuns: number } {
    const next = this.scheduleStore.nextDueAt();
    return {
      running: this.timer !== undefined,
      tickIntervalMs: this.options.tickIntervalMs,
      ...(this.lastTickAt !== undefined ? { lastTickAt: new Date(this.lastTickAt).toISOString() } : {}),
      ...(this.lastTickError ? { lastTickError: this.lastTickError } : {}),
      ...(next !== undefined ? { nextDueAt: new Date(next).toISOString() } : {}),
      queuedRuns: this.scheduleStore.runsByStatus(["queued"]).length,
      activeRuns: this.scheduleStore.runsByStatus(ACTIVE_RUN_STATUSES).length,
    };
  }

  #operatorRecord(row: ScheduleRow): ScheduleOperatorRecord {
    const { prompt, ...info } = this.info(row);
    // Reasons can carry what a failed run printed (sandbox setup output): operators see them redacted.
    return {
      ...info,
      ...(info.pausedReason ? { pausedReason: redactText(info.pausedReason) } : {}),
      ...(info.lastRun?.reason ? { lastRun: { ...info.lastRun, reason: redactText(info.lastRun.reason) } } : {}),
      ...(row.created_by === "apphost" && typeof prompt === "string" ? { prompt: redactText(prompt) } : {}),
      ownerId: row.owner_id,
      ownerLogin: row.owner_login,
    };
  }

  listForSession(ownerId: number, sessionId: string): ScheduleInfo[] {
    // Only schedules that continue this session, not an earlier deleted session that had the same ID.
    const view = this.deps.sessions()?.get(sessionId);
    return this.scheduleStore
      .listByTarget(sessionId)
      .filter((row) => row.owner_id === ownerId && (row.target_incarnation === null ? !isGone(view) : sameIncarnation(row.target_incarnation, view)))
      .map((row) => this.info(row));
  }

  get(ownerId: number, scheduleId: string): ScheduleInfo {
    return this.info(this.owned(ownerId, scheduleId));
  }

  runs(ownerId: number, scheduleId: string): ScheduleRun[] {
    this.owned(ownerId, scheduleId);
    return this.scheduleStore.runsBySchedule(scheduleId).map(toScheduleRun);
  }

  pause(ownerId: number, scheduleId: string, reason?: string): ScheduleInfo {
    const row = this.owned(ownerId, scheduleId);
    // Pausing again never clears a platform pause's reason: that reason blocks every run until the owner resumes.
    if (row.state !== "paused") this.scheduleStore.updateSchedule(row.id, { state: "paused", paused_reason: reason ?? null }, this.now());
    // Under an operator's pause the owner's own pause is remembered, so lifting the operator's pause leaves it in place.
    else if (row.paused_reason?.startsWith(OPERATOR_PAUSE) && !row.paused_reason.endsWith(OWNER_PAUSED_TOO)) {
      this.scheduleStore.updateSchedule(row.id, { paused_reason: reason ?? `${row.paused_reason}${OWNER_PAUSED_TOO}` }, this.now());
    }
    this.log.info("Schedule paused", { scheduleId, reason });
    return this.info(this.scheduleStore.schedule(row.id)!);
  }

  resume(ownerId: number, scheduleId: string): ScheduleInfo {
    const row = this.owned(ownerId, scheduleId);
    if (!this.deps.credentials().has(ownerId)) throw new ManagedCopilotError("authentication_required", `Schedules run as you while you're away. ${LOGIN_HINT}`);
    if (this.targetGone(row)) throw new ManagedCopilotError("conflict", TARGET_GONE);
    const problem = this.policyProblem(row);
    if (problem) throw problem;
    const now = this.now();
    let next: number | null = null;
    if (row.cron) {
      // No backfill: the next run is the first occurrence after resuming.
      next = nextOccurrence(parseCron(row.cron), row.time_zone, new Date(now))?.getTime() ?? null;
    } else if (row.run_at !== null && !this.scheduleStore.lastRun(row.id)) {
      next = row.run_at;
    }
    this.scheduleStore.updateSchedule(row.id, { state: "active", paused_reason: null, next_run_at: next }, now);
    this.log.info("Schedule resumed", { scheduleId });
    return this.info(this.scheduleStore.schedule(row.id)!);
  }

  delete(ownerId: number, scheduleId: string): void {
    const row = this.owned(ownerId, scheduleId);
    const now = this.now();
    this.scheduleStore.updateSchedule(row.id, { state: "paused", deleted_at: now, next_run_at: null }, now);
    for (const run of this.scheduleStore.runsBySchedule(row.id).filter((candidate) => candidate.status === "queued" && !this.inFlight.has(candidate.id))) {
      this.finishRun(run, "skipped", "The schedule was deleted before this run started", row);
    }
    this.log.info("Schedule deleted", { scheduleId });
  }

  async runNow(ownerId: number, scheduleId: string, invocationId?: string): Promise<ScheduleRun> {
    const row = this.owned(ownerId, scheduleId);
    if (!this.deps.credentials().has(ownerId)) throw new ManagedCopilotError("authentication_required", `Schedules run as you while you're away. ${LOGIN_HINT}`);
    if (row.state !== "active" && row.paused_reason) {
      throw new ManagedCopilotError("conflict", `This schedule was paused by the platform: ${row.paused_reason.replace(/^Paused: /, "")} Resume it first.`);
    }
    if (this.targetGone(row)) throw new ManagedCopilotError("conflict", TARGET_GONE);
    const key = invocationId?.trim() || newId("inv");
    if (key.length > 200) throw new ManagedCopilotError("invalid_request", "invocationId must be at most 200 characters");
    const occurrenceId = occurrenceIdFor(row.id, "manual", key);
    const now = this.now();
    const existing = this.scheduleStore.runByOccurrence(occurrenceId);
    if (existing) {
      if (existing.schedule_id !== row.id) throw new ManagedCopilotError("conflict", "That invocationId was already used for another schedule");
      return toScheduleRun(existing);
    }
    const published: (() => void)[] = [];
    transaction(this.deps.db, () => this.addOccurrence(row, now, "manual", occurrenceId, now, undefined, published));
    for (const publish of published) publish();
    this.dispatchQueued(now);
    return toScheduleRun(this.scheduleStore.runByOccurrence(occurrenceId)!);
  }

  /**
   * Platform pauses also take over a person's pause (its null reason would let manual runs through) and an operator's
   * (which an operator could otherwise lift): only the owner can lift them.
   */
  pauseAllForOwner(ownerId: number, reason: string): number {
    const result = this.deps.db
      .prepare(
        "UPDATE durable_schedules SET state = 'paused', paused_reason = ?, updated_at = ? WHERE owner_id = ? AND (state = 'active' OR paused_reason IS NULL OR instr(paused_reason, ?) = 1) AND deleted_at IS NULL",
      )
      .run(reason, this.now(), ownerId, OPERATOR_PAUSE);
    return Number(result.changes);
  }

  /**
   * A deleted session can no longer be continued: schedules that continue it pause, its queued runs are skipped, and
   * runs in progress in it fail. Only what is bound to a session that is no longer current is affected: a later
   * session reusing the ID is a different session, with its own schedules and runs.
   */
  onSessionDeleted(sessionId: string, incarnation?: string): void {
    const view = this.deps.sessions()?.get(sessionId);
    // The ledger may still show the deleted incarnation while its deletion is announced.
    const current = isGone(view) || (incarnation !== undefined && incarnationOf(view!) === incarnation) ? undefined : view;
    for (const schedule of this.scheduleStore.listByTarget(sessionId)) {
      const bound = schedule.target_incarnation;
      const affected = bound === null ? current === undefined : !sameIncarnation(bound, current);
      if (affected) this.pauseFor(schedule, TARGET_DELETED);
    }
    const runs = this.deps.db
      .prepare("SELECT * FROM durable_schedule_runs WHERE session_id = ? AND status IN ('queued', 'running', 'waiting')")
      .all(sessionId) as unknown as RunRow[];
    for (const run of runs) {
      // A dispatch in progress rechecks the session itself before it sends anything.
      if (this.inFlight.has(run.id)) continue;
      if (run.session_incarnation === null) {
        // Unbound: whatever was deleted may be the run's own session (a create whose reply was lost), so the run ends
        // unless the ID names a live session again (a dispatch then adopts it only if this schedule created it).
        if (current !== undefined) continue;
      } else if (sameIncarnation(run.session_incarnation, current)) {
        continue;
      }
      if (run.status === "queued") this.finishRun(run, "skipped", "The session was deleted before this run started");
      else this.finishRun(run, "failed", RUN_SESSION_DELETED);
    }
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
    const sessions = this.deps.sessions();
    if (!sessions) return false;
    const now = this.now();
    for (const schedule of this.scheduleStore.listTargeted()) {
      const view = sessions.get(schedule.target_session_id!);
      const bound = schedule.target_incarnation;
      if (bound === null) {
        if (provenSession(view, schedule.owner_id, Number.NEGATIVE_INFINITY, schedule.created_at)) {
          this.scheduleStore.updateSchedule(schedule.id, { target_incarnation: incarnationOf(view) }, now);
        } else {
          this.scheduleStore.updateSchedule(schedule.id, { target_incarnation: RETIRED }, now);
          this.pauseFor(schedule, TARGET_DELETED);
          this.log.warn("A schedule from before session incarnations no longer provably continues its session; paused", { scheduleId: schedule.id });
        }
      } else if (sameIncarnation(bound, view)) {
        if (bound !== incarnationOf(view!)) this.scheduleStore.updateSchedule(schedule.id, { target_incarnation: incarnationOf(view!) }, now);
      } else if (schedule.state === "active") {
        this.pauseFor(schedule, TARGET_DELETED);
      }
    }
    for (const run of this.scheduleStore.unboundRuns()) {
      if (this.inFlight.has(run.id) || !run.session_id) continue;
      // A new session's run that has not created it yet binds when it does.
      if (run.session_mode === "new" && run.session_created === 0) continue;
      const view = sessions.get(run.session_id);
      let bound: string | null | undefined;
      if (run.session_mode === "target") {
        const schedule = this.scheduleStore.schedule(run.schedule_id) ?? this.deletedSchedule(run.schedule_id);
        bound = schedule?.target_incarnation ?? (schedule && provenSession(view, schedule.owner_id, Number.NEGATIVE_INFINITY, schedule.created_at) ? incarnationOf(view) : undefined);
      } else {
        // The run's own session (its ID derives from the occurrence, and this schedule created it): created after the
        // run and before its prompt.
        const notAfter = (run.input_started_at ?? now) + INPUT_CLOCK_SKEW_MS;
        bound =
          provenSession(view, run.owner_id, run.created_at - INPUT_CLOCK_SKEW_MS, notAfter) && view.scheduleId === run.schedule_id ? incarnationOf(view) : undefined;
      }
      if (bound && sameIncarnation(bound, view)) {
        this.scheduleStore.updateRun(run.id, ["queued", "running", "waiting"], { session_incarnation: incarnationOf(view!) }, now);
      } else if (run.status === "queued") {
        this.finishRun(run, "skipped", "The session was deleted before this run started");
      } else {
        this.finishRun(run, "failed", RUN_SESSION_DELETED);
      }
    }
    this.targetsRepaired = true;
    return true;
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
    const now = this.now();
    const existing = new Map(this.scheduleStore.listAppHost(account.accountId).map((row) => [row.apphost_key!, row]));
    for (const [key, declaration] of Object.entries(this.deps.deployment.schedules ?? {})) {
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
        if (!this.deps.deployment.environments[declaration.environment]) throw new ManagedCopilotError("environment_not_found", `Unknown environment "${declaration.environment}"`);
        this.validateWebhook(declaration.webhook, declaration.environment, (session?.tools?.length ?? 0) > 0, session?.tools?.[0]?.name);
        nextRunAt = nextOccurrence(parseCron(declaration.cron), declaration.timeZone, new Date(now))?.getTime() ?? null;
      } catch (error) {
        this.log.error("AppHost schedule is invalid and will not run", { schedule: key, error: describeError(error) });
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
        const name = this.scheduleStore.byName(account.accountId, key) ? `${key}-apphost` : key;
        this.scheduleStore.insertSchedule({
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
        this.log.info("AppHost schedule is waiting for its account's approval", { schedule: key, runAs: account.login });
      } else if (row.definition_hash !== definitionHash) {
        this.scheduleStore.replaceDefinition(row.id, { ...fields, state: "paused", paused_reason: "The AppHost changed this schedule. Resume it to approve the new definition." }, now);
        this.log.info("AppHost schedule changed; paused for re-approval", { schedule: key, runAs: account.login });
      }
    }
    for (const row of existing.values()) {
      this.delete(account.accountId, row.id);
      this.log.info("AppHost schedule removed from the declaration", { schedule: row.apphost_key });
    }
  }

  /** Materializes (or removes) AppHost schedules for every account that signed in or already owns one. */
  syncAppHostForKnownAccounts(): void {
    const accounts = this.deps.db
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
}

export { DEFAULT_SCHEDULES_OPTIONS } from "./support.js";
export type { CreateOptions, ScheduleOperatorRecord, SchedulesDeps, SchedulesOptions } from "./support.js";
