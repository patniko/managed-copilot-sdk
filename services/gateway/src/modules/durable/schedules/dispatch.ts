// Durable schedules: occurrences, dispatching runs into sessions, and tracking runs to their end.
import { isManagedCopilotError, ManagedCopilotError, type ScheduleRunStatus } from "@managed-copilot/protocol";
import { transaction } from "../../../db.js";
import type { Principal } from "../../../http.js";
import type { ActionChange } from "../actions/service.js";
import type { DurableSessionsPort, RuntimeSessionEvent } from "../contract.js";
import { deterministicUuid, incarnationOf, isGone, newId, parseJson } from "../ids.js";
import { nextOccurrence, occurrencesBetween, parseCron } from "./cron.js";
import { ACTIVE_RUN_STATUSES, type RunRow, type RunTrigger, type ScheduleRow, type SessionConfig } from "./store.js";
import {
  TRANSIENT_CODES,
  INPUT_CLOCK_SKEW_MS,
  ACCEPTANCE_RECHECK_MS,
  QUEUE_READ_TIMEOUT_MS,
  TARGET_DELETED,
  NOT_THIS_RUNS_SESSION,
  pausedReason,
  withTimeout,
  occurrenceIdFor,
  describeError,
} from "./support.js";
import { ScheduleInternals } from "./internals.js";

export abstract class ScheduleDispatch extends ScheduleInternals {
  // Implemented by later layers of DurableSchedules.
  abstract repairTargets(): boolean;

  // ---------------------------------------------------------------------------------------------------------
  // Occurrences
  // ---------------------------------------------------------------------------------------------------------

  /** Records due occurrences and advances the schedule, atomically. Late occurrences are skipped, never backfilled. */
  protected materialize(scheduleId: string, now: number): void {
    const published: (() => void)[] = [];
    transaction(this.deps.db, () => {
      const schedule = this.scheduleStore.schedule(scheduleId);
      if (!schedule || schedule.state !== "active" || schedule.next_run_at === null || schedule.next_run_at > now) return;
      if (schedule.cron) {
        const cron = parseCron(schedule.cron);
        const due = occurrencesBetween(cron, schedule.time_zone, new Date(schedule.next_run_at - 1), new Date(now), 21).map((date) => date.getTime());
        if (due.length === 0) due.push(schedule.next_run_at);
        const truncated = due.length > 20;
        for (const [index, at] of due.slice(0, 20).entries()) {
          const missed = now - at > this.options.missedGraceMs.cron;
          const reason = missed
            ? `Missed: the platform was not running at the scheduled time${truncated && index === 19 ? "; later missed occurrences were not recorded individually" : ""}`
            : undefined;
          this.addOccurrence(schedule, at, "cron", occurrenceIdFor(schedule.id, "cron", at), now, reason, published);
        }
        const last = due[due.length - 1]!;
        const next = nextOccurrence(cron, schedule.time_zone, new Date(Math.max(now, last)));
        this.scheduleStore.updateSchedule(schedule.id, { next_run_at: next?.getTime() ?? null }, now);
      } else {
        const at = schedule.next_run_at;
        const missed = now - at > this.options.missedGraceMs.once;
        this.addOccurrence(schedule, at, "once", occurrenceIdFor(schedule.id, "once", schedule.run_at ?? at), now, missed ? "Missed: the platform was not running at the scheduled time" : undefined, published);
        this.scheduleStore.updateSchedule(schedule.id, { next_run_at: null }, now);
      }
    });
    for (const publish of published) publish();
  }

  /** Inserts one occurrence (idempotent by occurrence ID). Must run inside a transaction. */
  protected addOccurrence(schedule: ScheduleRow, at: number, trigger: RunTrigger, occurrenceId: string, now: number, skipReason: string | undefined, published: (() => void)[]): void {
    const sessionMode = schedule.target_session_id ? "target" : "new";
    // A new session's ID is derived from the occurrence, so a retried creation can never make a second session.
    const sessionId = schedule.target_session_id ?? deterministicUuid("managed-copilot/schedule-run", occurrenceId);
    let status: ScheduleRunStatus = "queued";
    let reason = skipReason;
    if (reason) status = "skipped";
    else if (this.scheduleStore.countRuns(schedule.id, ["queued"]) >= this.options.maxQueuedPerSchedule) {
      status = "skipped";
      reason = "Skipped: an earlier run of this schedule was still waiting to start (runs of one schedule never overlap)";
    }
    const inserted = this.scheduleStore.insertRun({
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
      const run = this.scheduleStore.runByOccurrence(occurrenceId)!;
      this.log.info("Schedule occurrence skipped", { scheduleId: schedule.id, scheduledFor: new Date(at).toISOString(), reason });
      published.push(() => this.publishRun("schedule.run_completed", run, schedule));
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------------------------------------

  protected dispatchQueued(now: number): void {
    // Nothing starts before schedule targets and older runs are bound to their sessions' incarnations.
    if (!this.targetsRepaired && !this.repairTargets()) return;
    for (const run of this.scheduleStore.runsByStatus(["queued"])) {
      if (this.inFlight.has(run.id) || this.inFlightSchedules.has(run.schedule_id)) continue;
      // One dispatch per session at a time, so input reconciliation for a shared session is never concurrent.
      if (run.session_id && this.inFlightSessions.has(run.session_id)) continue;
      if (run.next_attempt_at !== null && run.next_attempt_at > now) continue;
      if (this.scheduleStore.countRuns(run.schedule_id, ACTIVE_RUN_STATUSES) > 0) continue;
      // Dispatches still creating sessions or sending count against the owner's capacity too.
      const active = this.scheduleStore.countOwnerRuns(run.owner_id, ACTIVE_RUN_STATUSES) + (this.inFlightOwners.get(run.owner_id) ?? 0);
      if (active >= this.options.maxActiveRunsPerOwner) continue;
      this.inFlight.add(run.id);
      this.inFlightSchedules.add(run.schedule_id);
      if (run.session_id) this.inFlightSessions.add(run.session_id);
      this.inFlightOwners.set(run.owner_id, (this.inFlightOwners.get(run.owner_id) ?? 0) + 1);
      void this.#dispatch(run.id)
        .catch((error: unknown) => this.log.error("Schedule dispatch failed unexpectedly", { runId: run.id, error: (error as Error)?.stack ?? String(error) }))
        .finally(() => {
          this.inFlight.delete(run.id);
          this.inFlightSchedules.delete(run.schedule_id);
          if (run.session_id) this.inFlightSessions.delete(run.session_id);
          const remaining = (this.inFlightOwners.get(run.owner_id) ?? 1) - 1;
          if (remaining > 0) this.inFlightOwners.set(run.owner_id, remaining);
          else this.inFlightOwners.delete(run.owner_id);
        });
    }
  }

  async #dispatch(runId: string): Promise<void> {
    let run = this.scheduleStore.run(runId);
    if (!run || run.status !== "queued") return;
    const schedule = this.scheduleStore.schedule(run.schedule_id);
    if (!schedule) return this.finishRun(run, "skipped", "The schedule was deleted before this run started");
    const paused = pausedReason(schedule, run);
    if (paused) return this.finishRun(run, "skipped", paused, schedule);

    // Recheck delegation, policy, and handler routes at execution time.
    const problem = this.policyProblem(schedule);
    if (problem) {
      this.pauseFor(schedule, problem.message);
      return this.finishRun(run, "failed", problem.message, schedule);
    }
    let principal: Principal;
    try {
      principal = await this.deps.credentials().principalFor(schedule.owner_id);
    } catch (error) {
      if (isManagedCopilotError(error, "authentication_required")) {
        this.pauseFor(schedule, `Paused: ${error.message}`);
        return this.finishRun(run, "failed", error.message, schedule);
      }
      return this.#retryLater(run, schedule, error);
    }
    const sessions = this.deps.sessions();
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
          return this.finishRun(run, "failed", NOT_THIS_RUNS_SESSION, schedule);
        }
        const incarnation = created.incarnation ?? (isGone(view) ? null : incarnationOf(view!));
        this.scheduleStore.updateRun(run.id, ["queued"], { session_created: 1, session_incarnation: incarnation }, this.now());
      } else if (run.session_mode === "target" && this.targetGone(schedule)) {
        const message = "The session this schedule continues no longer exists";
        this.pauseFor(schedule, `Paused: ${message}`);
        return this.finishRun(run, "failed", message, schedule);
      }

      run = this.scheduleStore.run(run.id)!;
      if (run.status !== "queued") return;
      if (this.runIncarnation(sessions, run) === undefined) return this.sessionGone(run, schedule);
      if (run.input_state === "submitting") {
        // A previous attempt may have reached the runtime. Its history decides, and while the runtime might still hold
        // the prompt unrecorded (queued behind a turn, or its turn just starting), it is never sent a second time.
        const recovering = run;
        const unconfirmed = (what: string) =>
          this.runIncarnation(sessions, recovering) === undefined
            ? this.sessionGone(recovering, schedule)
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
      const sending = this.scheduleStore.run(run.id);
      if (!sending || sending.status !== "queued") return;
      const current = this.scheduleStore.schedule(sending.schedule_id);
      if (!current) return this.finishRun(sending, "skipped", "The schedule was deleted before this run started");
      const pausedNow = pausedReason(current, sending);
      if (pausedNow) return this.finishRun(sending, "skipped", pausedNow, current);
      const incarnation = this.runIncarnation(sessions, sending);
      if (incarnation === undefined) return this.sessionGone(sending, current);
      const startedAt = this.now();
      this.scheduleStore.updateRun(sending.id, ["queued"], { input_state: "submitting", input_started_at: startedAt }, startedAt);
      const { messageId } = await sessions.send(principal, sending.session_id!, { prompt: current.prompt, source: "system" }, { incarnation });
      this.#markStarted(this.scheduleStore.run(sending.id)!, current, messageId);
    } catch (error) {
      const latest = this.scheduleStore.run(run.id) ?? run;
      if (isManagedCopilotError(error, "needs_reconciliation")) {
        return this.finishRun(latest, "needs_reconciliation", `${error.message}. Check the session before running it again.`, schedule);
      }
      if (error instanceof ManagedCopilotError && !TRANSIENT_CODES.has(error.code)) {
        if (latest.input_state === "submitting") {
          // The runtime refused the prompt: nothing was accepted, so the failure is certain.
          this.scheduleStore.updateRun(latest.id, ["queued"], { input_state: "none" }, this.now());
        }
        // The session needs a handler that is not connected (for example its SDK hooks): every run would fail the same
        // way until it is, so the schedule pauses with the reason instead of failing on each occurrence.
        if (error.code === "background_callback_unsupported") this.pauseFor(schedule, `Paused: ${error.message}`);
        // The session was deleted (or its ID reused) as the prompt was sent: core refused it, and it cannot run again.
        if (latest.session_mode === "target" && this.targetGone(schedule)) this.pauseFor(schedule, TARGET_DELETED);
        return this.finishRun(this.scheduleStore.run(run.id) ?? latest, "failed", `Could not start the run: ${error.message}`, schedule);
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
    const incarnation = this.runIncarnation(sessions, run);
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
    const now = this.now();
    const since = run.input_started_at ?? run.created_at;
    if (now - since >= this.options.maxRunLifetimeMs) {
      return this.finishRun(
        run,
        "needs_reconciliation",
        "The session still had queued or running work, so it is unknown whether it accepted this run's prompt; it was not sent again. Check the session before running it again.",
        schedule,
      );
    }
    const delay = Math.min(ACCEPTANCE_RECHECK_MS.max, Math.max(this.options.dispatchRetryBaseMs, Math.round((now - since) / 4)));
    this.scheduleStore.updateRun(run.id, ["queued"], { next_attempt_at: now + delay, reason: "Waiting: confirming that the session accepted this run's prompt (it has queued or running work)" }, now);
    this.log.info("Schedule run is confirming its prompt was accepted", { runId: run.id, sessionId: run.session_id, recheckInMs: delay });
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
    const incarnation = this.runIncarnation(sessions, run);
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
      (this.deps.db.prepare("SELECT message_id FROM durable_schedule_runs WHERE session_id = ? AND message_id IS NOT NULL AND id != ?").all(run.session_id, run.id) as { message_id: string }[]).map(
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
    const now = this.now();
    // The runtime may emit the prompt's user.message before `send` returns, or (after a crash) long before.
    const consumed = alreadyInSession || (messageId !== "" && (this.recentMessages.get(run.session_id!) ?? []).includes(messageId));
    let updated: boolean;
    try {
      updated = this.scheduleStore.updateRun(
        run.id,
        ["queued"],
        { status: "running", input_state: "submitted", message_id: messageId || null, consumed: consumed ? 1 : 0, started_at: now, attempts: 0, next_attempt_at: null, reason: null },
        now,
      );
    } catch (error) {
      // Another run already owns that message (unique per session): never let two occurrences share one prompt.
      if (/UNIQUE/i.test((error as Error).message)) {
        return this.finishRun(run, "needs_reconciliation", "The session's history cannot show which message is this run's prompt, so it was not sent again. Check the session before running it again.", schedule);
      }
      throw error;
    }
    if (!updated) return;
    const started = this.scheduleStore.run(run.id)!;
    this.log.info("Schedule run started", { scheduleId: schedule.id, runId: run.id, sessionId: run.session_id });
    this.publishRun("schedule.run_started", started, schedule);
  }

  #retryLater(run: RunRow, schedule: ScheduleRow, error: unknown): void {
    const now = this.now();
    const attempts = run.attempts + 1;
    if (attempts >= this.options.maxDispatchAttempts) {
      if (run.input_state === "submitting") {
        return this.finishRun(run, "needs_reconciliation", "It is unknown whether the runtime accepted this run's prompt, so it was not sent again. Check the session before running it again.", schedule);
      }
      return this.finishRun(run, "failed", `Could not start the run: ${describeError(error)}`, schedule);
    }
    const delay = Math.min(5 * 60_000, this.options.dispatchRetryBaseMs * 2 ** (attempts - 1));
    this.scheduleStore.updateRun(run.id, ["queued"], { attempts, next_attempt_at: now + delay, reason: `Retrying: ${describeError(error)}` }, now);
    this.log.warn("Schedule run will be retried", { runId: run.id, attempt: attempts, retryInMs: delay, error: describeError(error) });
  }

  /**
   * Bounds run lifetime without breaking no-overlap or touching other work: only a turn proven to be this run's
   * (its prompt was consumed and it is the session's current turn) is stopped. Otherwise (the prompt may still be
   * queued behind someone else's turn, or the stop fails) the schedule pauses with a visible reason instead.
   */
  protected async expireLongRuns(now: number): Promise<void> {
    const hours = Math.round(this.options.maxRunLifetimeMs / 3_600_000);
    for (const run of this.scheduleStore.runsByStatus(ACTIVE_RUN_STATUSES)) {
      if (run.started_at === null || now - run.started_at <= this.options.maxRunLifetimeMs) continue;
      const sessions = this.deps.sessions();
      // A run whose session is gone has no turn to stop, and nothing here may stop a turn of a session that reuses its ID.
      const incarnation = sessions ? this.runIncarnation(sessions, run) : undefined;
      if (sessions && incarnation === undefined) {
        this.endGoneRun(run);
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
          this.log.warn("Could not stop an overdue scheduled run", { runId: run.id, sessionId: run.session_id, error: (error as Error).message });
        }
      }
      if (stopped) {
        this.finishRun(run, "failed", `The run did not finish within ${hours} hours, so its turn was stopped`);
        continue;
      }
      const schedule = this.scheduleStore.schedule(run.schedule_id);
      const why = run.consumed ? "could not be stopped" : "never started (its prompt may still be queued in the session)";
      if (schedule) this.pauseFor(schedule, `Paused: a run ${why} after ${hours} hours; check session ${run.session_id} before resuming`);
      this.finishRun(run, "failed", `The run did not finish within ${hours} hours and ${why}`, schedule);
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
      const recent = this.recentMessages.get(sessionId) ?? [];
      recent.push(event.data.messageId);
      if (recent.length > 20) recent.shift();
      this.recentMessages.set(sessionId, recent);
      if (this.recentMessages.size > 500) this.recentMessages.delete(this.recentMessages.keys().next().value!);
    }
    if (!["user.message", "session.idle", "session.error", "abort"].includes(event.type)) return;
    const sessions = this.deps.sessions();
    // Events come from the session as it is now: runs of an earlier session that had this ID are not affected.
    const runs = (
      this.deps.db.prepare("SELECT * FROM durable_schedule_runs WHERE session_id = ? AND status IN ('running', 'waiting')").all(sessionId) as unknown as RunRow[]
    ).filter((run) => sessions !== undefined && this.runIncarnation(sessions, run) !== undefined);
    const now = this.now();
    for (const run of runs) {
      switch (event.type) {
        case "user.message":
          if (run.message_id && event.data.messageId === run.message_id) this.scheduleStore.updateRun(run.id, ACTIVE_RUN_STATUSES, { consumed: 1 }, now);
          break;
        case "session.error":
          if (run.consumed || (run.message_id && event.data.originatingMessageId === run.message_id)) {
            this.finishRun(run, "failed", `The run's turn failed: ${String(event.data.message ?? "unknown error")}`);
          }
          break;
        case "abort":
          if (run.consumed) this.finishRun(run, "failed", "The run's turn was cancelled");
          break;
        case "session.idle":
          if (!run.consumed) break;
          if (event.data.aborted === true) this.finishRun(run, "failed", "The run's turn was cancelled");
          else this.finishRun(run, "completed", "The agent finished the run's turn");
          break;
      }
    }
  }

  /**
   * Settles a run from core's session ledger, which records each root turn's outcome keyed by the prompt's message
   * ID (`lastTurn`). Used after a restart, when the turn may have ended while no event could be observed.
   */
  async #settleFromLedger(sessions: DurableSessionsPort, runId: string): Promise<void> {
    const run = this.scheduleStore.run(runId);
    if (!run || !ACTIVE_RUN_STATUSES.includes(run.status) || !run.session_id) return;
    // Its session is gone: no turn of a session that reuses the ID says anything about this run.
    if (this.runIncarnation(sessions, run) === undefined) return this.endGoneRun(run);
    const turn = sessions.get(run.session_id)?.lastTurn;
    // Only the run's own turn proves its outcome: another turn's result (or timing) says nothing about it.
    if (!turn || turn.status === "running" || turn.turnId === undefined || turn.turnId !== run.message_id) return;
    if (turn.status === "completed") this.finishRun(run, "completed", "The agent finished the run's turn");
    else if (turn.status === "cancelled") this.finishRun(run, "failed", "The run's turn was cancelled");
    else this.finishRun(run, "failed", "The run's turn failed");
  }

  protected onActionChange(change: ActionChange): void {
    const sessions = this.deps.sessions();
    if (!sessions) return;
    // The ledger's actions are the session's current incarnation's; only runs in that incarnation follow them.
    const runs = (
      this.deps.db.prepare("SELECT * FROM durable_schedule_runs WHERE session_id = ? AND status IN ('running', 'waiting')").all(change.sessionId) as unknown as RunRow[]
    ).filter((run) => this.runIncarnation(sessions, run) !== undefined);
    if (runs.length === 0) return;
    const incarnation = this.runIncarnation(sessions, runs[0]!)!;
    const open = this.deps.actions()?.list(change.sessionId, { open: true, incarnation }) ?? [];
    const waiting = open.some((action) => action.state === "pending" || action.state === "needs_reconciliation");
    const now = this.now();
    for (const run of runs) {
      if (waiting && run.status === "running") this.scheduleStore.updateRun(run.id, ["running"], { status: "waiting", reason: "Waiting for a tool or approval to be answered" }, now);
      if (!waiting && run.status === "waiting") this.scheduleStore.updateRun(run.id, ["waiting"], { status: "running", reason: null }, now);
    }
  }

  /** After a restart (and periodically), settles runs whose turn ended, or whose session went away, unobserved. */
  protected async recoverActiveRuns(): Promise<void> {
    const sessions = this.deps.sessions();
    if (!sessions) return;
    for (const run of this.scheduleStore.runsByStatus(ACTIVE_RUN_STATUSES)) {
      if (!run.consumed && this.runIncarnation(sessions, run) !== undefined) continue;
      try {
        await this.#settleFromLedger(sessions, run.id);
      } catch (error) {
        this.log.debug("Could not check a run's session", { runId: run.id, error: (error as Error).message });
      }
    }
  }
}
