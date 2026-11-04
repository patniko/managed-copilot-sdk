import type { ScheduleInfo, ScheduleRun, ScheduleRunStatus, ScheduleState, ToolDeclaration } from "@managed-copilot/protocol";
import type { Database } from "../../../db.js";
import { parseJson, toIso } from "../ids.js";

export type ScheduleCreator = "user" | "agent" | "apphost";
export type RunTrigger = "cron" | "once" | "manual";
export type InputState = "none" | "submitting" | "submitted";

export interface ScheduleRow {
  readonly id: string;
  readonly owner_id: number;
  readonly owner_login: string;
  readonly name: string;
  readonly cron: string | null;
  readonly run_at: number | null;
  readonly time_zone: string;
  readonly environment: string;
  readonly prompt: string;
  readonly state: ScheduleState;
  readonly paused_reason: string | null;
  readonly created_by: ScheduleCreator;
  readonly target_session_id: string | null;
  /** The incarnation of the target session the schedule continues (session IDs are reusable after deletion). */
  readonly target_incarnation: string | null;
  readonly origin_session_id: string | null;
  readonly session_config: string | null;
  readonly webhook: string | null;
  readonly next_run_at: number | null;
  readonly definition_hash: string;
  readonly apphost_key: string | null;
  readonly origin_key: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly deleted_at: number | null;
}

export interface RunRow {
  readonly id: string;
  readonly schedule_id: string;
  readonly owner_id: number;
  readonly occurrence_id: string;
  readonly trigger: RunTrigger;
  readonly scheduled_for: number;
  readonly status: ScheduleRunStatus;
  readonly reason: string | null;
  readonly session_mode: "new" | "target";
  readonly session_id: string | null;
  /** The incarnation of the session the run continues: bound when the run is queued (target) or creates it (new). */
  readonly session_incarnation: string | null;
  readonly session_created: number;
  readonly input_state: InputState;
  readonly input_started_at: number | null;
  readonly message_id: string | null;
  readonly consumed: number;
  readonly attempts: number;
  readonly next_attempt_at: number | null;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface SessionConfig {
  readonly agent?: string;
  readonly model?: string;
  readonly tools?: readonly ToolDeclaration[];
}

export const ACTIVE_RUN_STATUSES: readonly ScheduleRunStatus[] = ["running", "waiting"];
export const TERMINAL_RUN_STATUSES: readonly ScheduleRunStatus[] = ["completed", "failed", "skipped", "needs_reconciliation"];

type Bindable = string | number | null;

/** Synchronous access to schedules and runs. Callers keep async work outside transactions. */
export class ScheduleStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  get db(): Database {
    return this.#db;
  }

  insertSchedule(row: Omit<ScheduleRow, "deleted_at">): void {
    this.#db
      .prepare(
        `INSERT INTO durable_schedules (id, owner_id, owner_login, name, cron, run_at, time_zone, environment, prompt, state, paused_reason, created_by,
           target_session_id, target_incarnation, origin_session_id, session_config, webhook, next_run_at, definition_hash, apphost_key, origin_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.owner_id,
        row.owner_login,
        row.name,
        row.cron,
        row.run_at,
        row.time_zone,
        row.environment,
        row.prompt,
        row.state,
        row.paused_reason,
        row.created_by,
        row.target_session_id,
        row.target_incarnation,
        row.origin_session_id,
        row.session_config,
        row.webhook,
        row.next_run_at,
        row.definition_hash,
        row.apphost_key,
        row.origin_key,
        row.created_at,
        row.updated_at,
      );
  }

  schedule(id: string): ScheduleRow | undefined {
    return this.#db.prepare("SELECT * FROM durable_schedules WHERE id = ? AND deleted_at IS NULL").get(id) as ScheduleRow | undefined;
  }

  byName(ownerId: number, name: string): ScheduleRow | undefined {
    return this.#db.prepare("SELECT * FROM durable_schedules WHERE owner_id = ? AND name = ? AND deleted_at IS NULL").get(ownerId, name) as ScheduleRow | undefined;
  }

  byOriginKey(ownerId: number, originKey: string): ScheduleRow | undefined {
    return this.#db.prepare("SELECT * FROM durable_schedules WHERE owner_id = ? AND origin_key = ?").get(ownerId, originKey) as ScheduleRow | undefined;
  }

  listByOwner(ownerId: number): ScheduleRow[] {
    return this.#db.prepare("SELECT * FROM durable_schedules WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid").all(ownerId) as unknown as ScheduleRow[];
  }

  /** Every schedule that was not deleted, of every owner (operator console). */
  listAll(): ScheduleRow[] {
    return this.#db.prepare("SELECT * FROM durable_schedules WHERE deleted_at IS NULL ORDER BY created_at, rowid").all() as unknown as ScheduleRow[];
  }

  listByTarget(sessionId: string): ScheduleRow[] {
    return this.#db
      .prepare("SELECT * FROM durable_schedules WHERE target_session_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid")
      .all(sessionId) as unknown as ScheduleRow[];
  }

  /** Every schedule that continues an existing session. */
  listTargeted(): ScheduleRow[] {
    return this.#db.prepare("SELECT * FROM durable_schedules WHERE target_session_id IS NOT NULL AND deleted_at IS NULL ORDER BY created_at, rowid").all() as unknown as ScheduleRow[];
  }

  /** Unfinished runs recorded before runs were bound to a session incarnation. */
  unboundRuns(): RunRow[] {
    return this.#db
      .prepare("SELECT * FROM durable_schedule_runs WHERE session_incarnation IS NULL AND status IN ('queued', 'running', 'waiting') ORDER BY created_at, rowid")
      .all() as unknown as RunRow[];
  }

  countActiveByOrigin(sessionId: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM durable_schedules WHERE origin_session_id = ? AND created_by = 'agent' AND deleted_at IS NULL AND state = 'active'")
      .get(sessionId) as { n: number };
    return Number(row.n);
  }

  listDue(now: number): ScheduleRow[] {
    return this.#db
      .prepare("SELECT * FROM durable_schedules WHERE state = 'active' AND deleted_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, rowid")
      .all(now) as unknown as ScheduleRow[];
  }

  nextDueAt(): number | undefined {
    const row = this.#db
      .prepare("SELECT MIN(next_run_at) AS at FROM durable_schedules WHERE state = 'active' AND deleted_at IS NULL AND next_run_at IS NOT NULL")
      .get() as { at: number | null };
    return row.at ?? undefined;
  }

  updateSchedule(id: string, fields: Partial<Pick<ScheduleRow, "state" | "paused_reason" | "next_run_at" | "deleted_at" | "target_incarnation">>, now: number): void {
    const sets: string[] = ["updated_at = ?"];
    const params: Bindable[] = [now];
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = ?`);
      params.push((value as Bindable | undefined) ?? null);
    }
    params.push(id);
    this.#db.prepare(`UPDATE durable_schedules SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  /** Replaces an AppHost schedule's definition (the operator changed its declaration). */
  replaceDefinition(
    id: string,
    fields: Pick<ScheduleRow, "cron" | "time_zone" | "environment" | "prompt" | "session_config" | "webhook" | "definition_hash" | "state" | "paused_reason" | "next_run_at">,
    now: number,
  ): void {
    this.#db
      .prepare(
        `UPDATE durable_schedules SET cron = ?, time_zone = ?, environment = ?, prompt = ?, session_config = ?, webhook = ?, definition_hash = ?, state = ?,
           paused_reason = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(fields.cron, fields.time_zone, fields.environment, fields.prompt, fields.session_config, fields.webhook, fields.definition_hash, fields.state, fields.paused_reason, fields.next_run_at, now, id);
  }

  listAppHost(ownerId: number): ScheduleRow[] {
    return this.#db
      .prepare("SELECT * FROM durable_schedules WHERE owner_id = ? AND apphost_key IS NOT NULL AND deleted_at IS NULL ORDER BY created_at, rowid")
      .all(ownerId) as unknown as ScheduleRow[];
  }

  insertRun(
    row: Omit<
      RunRow,
      "reason" | "session_incarnation" | "session_created" | "input_state" | "input_started_at" | "message_id" | "consumed" | "attempts" | "next_attempt_at" | "started_at" | "completed_at"
    > & {
      readonly reason?: string | null;
      readonly session_incarnation?: string | null;
      readonly completed_at?: number | null;
    },
  ): boolean {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO durable_schedule_runs (id, schedule_id, owner_id, occurrence_id, trigger, scheduled_for, status, reason, session_mode, session_id,
           session_incarnation, completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.schedule_id,
        row.owner_id,
        row.occurrence_id,
        row.trigger,
        row.scheduled_for,
        row.status,
        row.reason ?? null,
        row.session_mode,
        row.session_id,
        row.session_incarnation ?? null,
        row.completed_at ?? null,
        row.created_at,
        row.updated_at,
      );
    return Number(result.changes) === 1;
  }

  run(id: string): RunRow | undefined {
    return this.#db.prepare("SELECT * FROM durable_schedule_runs WHERE id = ?").get(id) as RunRow | undefined;
  }

  runByOccurrence(occurrenceId: string): RunRow | undefined {
    return this.#db.prepare("SELECT * FROM durable_schedule_runs WHERE occurrence_id = ?").get(occurrenceId) as RunRow | undefined;
  }

  runsBySchedule(scheduleId: string, limit = 100): RunRow[] {
    return this.#db
      .prepare("SELECT * FROM durable_schedule_runs WHERE schedule_id = ? ORDER BY scheduled_for DESC, rowid DESC LIMIT ?")
      .all(scheduleId, limit) as unknown as RunRow[];
  }

  lastRun(scheduleId: string): RunRow | undefined {
    return this.#db.prepare("SELECT * FROM durable_schedule_runs WHERE schedule_id = ? ORDER BY scheduled_for DESC, rowid DESC LIMIT 1").get(scheduleId) as
      | RunRow
      | undefined;
  }

  runsByStatus(statuses: readonly ScheduleRunStatus[]): RunRow[] {
    return this.#db
      .prepare(`SELECT * FROM durable_schedule_runs WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY scheduled_for, rowid`)
      .all(...statuses) as unknown as RunRow[];
  }

  countRuns(scheduleId: string, statuses: readonly ScheduleRunStatus[]): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM durable_schedule_runs WHERE schedule_id = ? AND status IN (${statuses.map(() => "?").join(", ")})`)
      .get(scheduleId, ...statuses) as { n: number };
    return Number(row.n);
  }

  countOwnerRuns(ownerId: number, statuses: readonly ScheduleRunStatus[]): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM durable_schedule_runs WHERE owner_id = ? AND status IN (${statuses.map(() => "?").join(", ")})`)
      .get(ownerId, ...statuses) as { n: number };
    return Number(row.n);
  }

  /** Updates a run only while it is still in one of `from` (compare-and-set). */
  updateRun(id: string, from: readonly ScheduleRunStatus[], fields: Partial<Omit<RunRow, "id" | "schedule_id" | "owner_id" | "occurrence_id">>, now: number): boolean {
    const sets: string[] = ["updated_at = ?"];
    const params: Bindable[] = [now];
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = ?`);
      params.push((value as Bindable | undefined) ?? null);
    }
    params.push(id, ...from);
    const result = this.#db.prepare(`UPDATE durable_schedule_runs SET ${sets.join(", ")} WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`).run(...params);
    return Number(result.changes) === 1;
  }
}

export function toScheduleRun(row: RunRow): ScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    occurrenceId: row.occurrence_id,
    scheduledFor: toIso(row.scheduled_for)!,
    ...(row.started_at !== null ? { startedAt: toIso(row.started_at)! } : {}),
    ...(row.completed_at !== null ? { completedAt: toIso(row.completed_at)! } : {}),
    status: row.status,
    ...(row.session_id && (row.session_created === 1 || row.session_mode === "target") ? { sessionId: row.session_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    trigger: row.trigger,
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

export function toScheduleInfo(row: ScheduleRow, lastRun: RunRow | undefined): ScheduleInfo {
  const session = parseJson<SessionConfig>(row.session_config);
  return {
    id: row.id,
    name: row.name,
    ...(row.cron ? { cron: row.cron } : {}),
    ...(row.run_at !== null ? { runAt: toIso(row.run_at)! } : {}),
    timeZone: row.time_zone,
    environment: row.environment,
    prompt: row.prompt,
    state: row.state,
    ...(row.paused_reason ? { pausedReason: row.paused_reason } : {}),
    createdBy: row.created_by,
    ...(row.target_session_id ? { target: { sessionId: row.target_session_id } } : {}),
    ...(session && Object.keys(session).length > 0 ? { session } : {}),
    ...(row.webhook ? { webhook: row.webhook } : {}),
    ...(row.next_run_at !== null && row.state === "active" ? { nextRunAt: toIso(row.next_run_at)! } : {}),
    ...(lastRun ? { lastRun: toScheduleRun(lastRun) } : {}),
    createdAt: toIso(row.created_at)!,
  };
}
