// Durable schedules: state and the helpers every part uses (ownership, pausing, run endings, and events).
import {
  ManagedCopilotError,
  type PlatformEvent,
  type ScheduleInfo,
  type ScheduleRunStatus,
} from "@managed-copilot/protocol";
import type { Logger } from "../../../log.js";
import type { DurableSessionsPort } from "../contract.js";
import { incarnationOf, isGone, newId, parseJson, sameIncarnation } from "../ids.js";
import { ScheduleStore, toScheduleInfo, type RunRow, type ScheduleRow, type SessionConfig } from "./store.js";
import {
  OPERATOR_PAUSE,
  type SchedulesOptions,
  DEFAULT_SCHEDULES_OPTIONS,
  type SchedulesDeps,
  RUN_EVENT_DATA,
  TARGET_DELETED,
  RUN_SESSION_DELETED,
} from "./support.js";

export abstract class ScheduleInternals {
  protected readonly deps: SchedulesDeps;
  protected readonly scheduleStore: ScheduleStore;
  protected readonly log: Logger;
  protected readonly options: SchedulesOptions;
  protected readonly now: () => number;
  protected readonly inFlight = new Set<string>();
  protected readonly inFlightSchedules = new Set<string>();
  protected readonly inFlightSessions = new Set<string>();
  protected readonly inFlightOwners = new Map<number, number>();
  /** Recent `user.message` IDs per session: a prompt's event can arrive before `send` returns its ID. */
  protected readonly recentMessages = new Map<string, string[]>();
  protected readonly disposers: (() => void)[] = [];
  protected timer: NodeJS.Timeout | undefined;
  protected ticking: Promise<void> | undefined;
  protected lastLedgerCheck = 0;
  protected targetsRepaired = false;
  /** The latest scheduler pass and its failure, if it failed (operator console). */
  protected lastTickAt: number | undefined;
  protected lastTickError: string | undefined;

  constructor(deps: SchedulesDeps) {
    this.deps = deps;
    this.scheduleStore = new ScheduleStore(deps.db);
    this.log = deps.log;
    this.options = { ...DEFAULT_SCHEDULES_OPTIONS, ...deps.options };
    this.now = deps.now ?? Date.now;
  }

  /** The session a schedule continues was deleted (or its ID now names a different session). */
  protected targetGone(schedule: ScheduleRow): boolean {
    if (!schedule.target_session_id) return false;
    const view = this.deps.sessions()?.get(schedule.target_session_id);
    if (isGone(view) || view!.ownerId !== schedule.owner_id) return true;
    return schedule.target_incarnation !== null && !sameIncarnation(schedule.target_incarnation, view);
  }

  /** The incarnation a run continues, while it is still the session's current one (undefined once it is gone). */
  protected runIncarnation(sessions: DurableSessionsPort, run: RunRow): string | undefined {
    if (!run.session_id || run.session_incarnation === null) return undefined;
    const view = sessions.get(run.session_id);
    return sameIncarnation(run.session_incarnation, view) ? incarnationOf(view!) : undefined;
  }

  /** The run's session was deleted (or its ID names another session now): the run ends, and a target schedule pauses. */
  protected sessionGone(run: RunRow, schedule: ScheduleRow): void {
    if (run.session_mode === "target") this.pauseFor(schedule, TARGET_DELETED);
    if (run.status === "queued") return this.finishRun(run, "skipped", "The session was deleted before this run started", schedule);
    return this.finishRun(run, "failed", RUN_SESSION_DELETED, schedule);
  }

  /** `#sessionGone` for a run found while tracking, whose schedule may since have been deleted. */
  protected endGoneRun(run: RunRow): void {
    const schedule = this.scheduleStore.schedule(run.schedule_id);
    if (schedule) this.sessionGone(run, schedule);
    else this.finishRun(run, run.status === "queued" ? "skipped" : "failed", run.status === "queued" ? "The session was deleted before this run started" : RUN_SESSION_DELETED);
  }

  protected finishRun(run: RunRow, status: "completed" | "failed" | "skipped" | "needs_reconciliation", reason: string, schedule?: ScheduleRow): void {
    const now = this.now();
    const from: ScheduleRunStatus[] = status === "skipped" ? ["queued"] : ["queued", "running", "waiting"];
    if (!this.scheduleStore.updateRun(run.id, from, { status, reason, completed_at: now }, now)) return;
    const finished = this.scheduleStore.run(run.id)!;
    const owner = schedule ?? this.scheduleStore.schedule(run.schedule_id) ?? this.deletedSchedule(run.schedule_id);
    this.log.info("Schedule run finished", { runId: run.id, status, reason });
    if (owner) this.publishRun("schedule.run_completed", finished, owner);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------------------

  protected policyProblem(schedule: ScheduleRow): ManagedCopilotError | undefined {
    const environment = this.deps.deployment.environments[schedule.environment];
    if (!environment) return new ManagedCopilotError("environment_not_found", `Environment "${schedule.environment}" is no longer declared in this deployment`);
    if (schedule.created_by === "agent" && environment.scheduling !== true) {
      return new ManagedCopilotError("policy_violation", `Scheduling is no longer enabled for environment "${schedule.environment}"`);
    }
    const config = parseJson<SessionConfig>(schedule.session_config);
    try {
      this.validateWebhook(schedule.webhook ?? undefined, schedule.environment, (config?.tools?.length ?? 0) > 0, config?.tools?.[0]?.name);
    } catch (error) {
      if (error instanceof ManagedCopilotError) return new ManagedCopilotError("background_callback_unsupported", error.message);
      throw error;
    }
    return undefined;
  }

  protected validateWebhook(name: string | undefined, environment: string, hasTools: boolean, firstTool: string | undefined): void {
    if (name === undefined) {
      if (hasTools) {
        throw new ManagedCopilotError(
          "background_callback_unsupported",
          `A scheduled session runs while your app may be offline, so its tools (such as ${firstTool}) need a webhook that answers them. Declare one in the AppHost and pass webhook.`,
        );
      }
      return;
    }
    const declaration = this.deps.deployment.webhooks?.[name];
    if (!declaration) throw new ManagedCopilotError("invalid_request", `Unknown webhook "${name}"; declare it in the AppHost`);
    if (!declaration.environments.includes(environment)) throw new ManagedCopilotError("policy_violation", `Webhook "${name}" is not authorized for environment "${environment}"`);
    if (hasTools && !declaration.events.includes("session.action_required") && !declaration.events.includes("*")) {
      throw new ManagedCopilotError("invalid_request", `Webhook "${name}" must subscribe to session.action_required to answer tool calls`);
    }
  }

  /**
   * A platform pause (safety, revoked sign-in, policy) blocks every run, so it also takes over a person's pause, whose
   * null reason would still let manual runs through, and an operator's, which an operator could lift without the
   * owner. An existing platform reason is kept.
   */
  protected pauseFor(schedule: ScheduleRow, reason: string): void {
    this.deps.db
      .prepare(
        "UPDATE durable_schedules SET state = 'paused', paused_reason = ?, updated_at = ? WHERE id = ? AND (state = 'active' OR paused_reason IS NULL OR instr(paused_reason, ?) = 1) AND deleted_at IS NULL",
      )
      .run(reason, this.now(), schedule.id, OPERATOR_PAUSE);
  }

  protected owned(ownerId: number, scheduleId: string): ScheduleRow {
    const row = this.scheduleStore.schedule(scheduleId);
    if (!row || row.owner_id !== ownerId) throw new ManagedCopilotError("not_found", `Schedule ${scheduleId} was not found`);
    return row;
  }

  protected deletedSchedule(scheduleId: string): ScheduleRow | undefined {
    return this.deps.db.prepare("SELECT * FROM durable_schedules WHERE id = ?").get(scheduleId) as ScheduleRow | undefined;
  }

  protected info(row: ScheduleRow): ScheduleInfo {
    return toScheduleInfo(row, this.scheduleStore.lastRun(row.id));
  }

  protected publishRun(type: "schedule.run_started" | "schedule.run_completed", run: RunRow, schedule: ScheduleRow): void {
    const data = RUN_EVENT_DATA(run, schedule);
    const event: PlatformEvent = {
      id: newId("evt"),
      type,
      createdAt: new Date(this.now()).toISOString(),
      ...(data.sessionId ? { sessionId: data.sessionId } : {}),
      environment: schedule.environment,
      data,
    };
    try {
      this.deps.publish(event, { ownerId: schedule.owner_id });
    } catch (error) {
      this.log.error("Publishing a schedule event failed", { type, runId: run.id, error: (error as Error).message });
    }
  }
}
