// The orchestrator ledger (`orchestrator_*` tables): each orchestrator session's workers, and the coordinator's
// messages to them keyed by tool call, so a replayed tool call never starts a worker or delivers a message twice.
import { ManagedCopilotError, type WorkerInfo, type WorkerState } from "@managed-copilot/protocol";
import { migrate, transaction, type Database } from "../../db.js";

const MIGRATIONS = [
  `CREATE TABLE orchestrator_workers (
     id TEXT PRIMARY KEY,
     coordinator_id TEXT NOT NULL,
     coordinator_incarnation TEXT NOT NULL,
     owner_id INTEGER NOT NULL,
     incarnation TEXT,
     name TEXT NOT NULL,
     environment TEXT NOT NULL,
     model TEXT,
     agent TEXT,
     task TEXT NOT NULL,
     state TEXT NOT NULL,
     result TEXT,
     error TEXT,
     messages INTEGER NOT NULL DEFAULT 0,
     start_key TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX orchestrator_workers_coordinator ON orchestrator_workers (coordinator_id, coordinator_incarnation, created_at);
   CREATE TABLE orchestrator_messages (
     key TEXT PRIMARY KEY,
     worker_id TEXT NOT NULL,
     message_id TEXT,
     created_at TEXT NOT NULL
   );`,
];

/** States in which a worker is busy: a wait for it continues. */
export const BUSY_STATES: readonly WorkerState[] = ["starting", "working"];

/**
 * Whether a worker holds one of its coordinator's `maxWorkers` slots (and its name): until it is stopped, unless it
 * failed before it had a session (nothing to message or stop).
 */
export function occupiesSlot(record: WorkerRecord): boolean {
  if (record.state === "stopped") return false;
  return record.state !== "failed" || record.incarnation !== undefined;
}

interface Row {
  id: string;
  coordinator_id: string;
  coordinator_incarnation: string;
  owner_id: number;
  incarnation: string | null;
  name: string;
  environment: string;
  model: string | null;
  agent: string | null;
  task: string;
  state: string;
  result: string | null;
  error: string | null;
  messages: number;
  start_key: string;
  created_at: string;
  updated_at: string;
}

export interface WorkerRecord {
  readonly id: string;
  readonly coordinatorId: string;
  readonly coordinatorIncarnation: string;
  readonly ownerId: number;
  /** The worker session's incarnation, once its session exists. */
  readonly incarnation?: string;
  readonly name: string;
  readonly environment: string;
  readonly model?: string;
  readonly agent?: string;
  readonly task: string;
  readonly state: WorkerState;
  readonly result?: string;
  readonly error?: string;
  readonly messages: number;
  /** The `start_worker` tool call that started it. */
  readonly startKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewWorker {
  readonly id: string;
  readonly coordinatorId: string;
  readonly coordinatorIncarnation: string;
  readonly ownerId: number;
  readonly name: string;
  readonly environment: string;
  readonly model?: string;
  readonly agent?: string;
  readonly task: string;
  readonly startKey: string;
}

export type WorkerUpdate = Partial<{ state: WorkerState; incarnation: string; result: string | null; error: string | null; messages: number }>;

export class WorkerStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
    migrate(db, "orchestrator", MIGRATIONS);
  }

  /**
   * Admits a worker in one transaction: the same tool call returns the worker it already started; otherwise the
   * coordinator incarnation must have fewer than `maxWorkers` active workers and no active worker with the same name.
   */
  admit(worker: NewWorker, maxWorkers: number): { readonly record: WorkerRecord; readonly created: boolean } {
    return transaction(this.#db, () => {
      const existing = this.byStartKey(worker.startKey);
      if (existing) return { record: existing, created: false };
      const active = this.forCoordinator(worker.coordinatorId, worker.coordinatorIncarnation).filter(occupiesSlot);
      if (active.some((record) => record.name === worker.name)) {
        throw new ManagedCopilotError("conflict", `A worker named "${worker.name}" already exists in this session. Pick another name, or use message_worker to give it more work.`);
      }
      if (active.length >= maxWorkers) {
        throw new ManagedCopilotError(
          "policy_violation",
          `This session already has ${active.length} workers, the most it can have at once (${maxWorkers}). Stop a worker you no longer need with stop_worker, then start this one.`,
          { maxWorkers },
        );
      }
      const now = new Date().toISOString();
      this.#db
        .prepare(
          `INSERT INTO orchestrator_workers (id, coordinator_id, coordinator_incarnation, owner_id, name, environment, model, agent, task, state, messages, start_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', 0, ?, ?, ?)`,
        )
        .run(worker.id, worker.coordinatorId, worker.coordinatorIncarnation, worker.ownerId, worker.name, worker.environment, worker.model ?? null, worker.agent ?? null, worker.task, worker.startKey, now, now);
      return { record: this.get(worker.id)!, created: true };
    });
  }

  get(id: string): WorkerRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM orchestrator_workers WHERE id = ?").get(id) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  byStartKey(key: string): WorkerRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM orchestrator_workers WHERE start_key = ?").get(key) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** A coordinator incarnation's workers, oldest first. */
  forCoordinator(coordinatorId: string, coordinatorIncarnation: string): WorkerRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM orchestrator_workers WHERE coordinator_id = ? AND coordinator_incarnation = ? ORDER BY created_at, rowid")
      .all(coordinatorId, coordinatorIncarnation) as unknown as Row[];
    return rows.map(toRecord);
  }

  /** Every worker of a coordinator session ID, whatever its incarnation (cleanup after the coordinator is deleted). */
  forCoordinatorId(coordinatorId: string): WorkerRecord[] {
    const rows = this.#db.prepare("SELECT * FROM orchestrator_workers WHERE coordinator_id = ? ORDER BY created_at, rowid").all(coordinatorId) as unknown as Row[];
    return rows.map(toRecord);
  }

  /** Workers that are not stopped (startup recovery). */
  unstopped(): WorkerRecord[] {
    const rows = this.#db.prepare("SELECT * FROM orchestrator_workers WHERE state <> 'stopped' ORDER BY created_at, rowid").all() as unknown as Row[];
    return rows.map(toRecord);
  }

  /**
   * Applies `fields` when the worker is in one of `from` (any state when omitted). Returns the updated record, or
   * undefined when the worker is gone or in another state.
   */
  update(id: string, fields: WorkerUpdate, from?: readonly WorkerState[]): WorkerRecord | undefined {
    const sets: string[] = ["updated_at = ?"];
    const args: (string | number | null)[] = [new Date().toISOString()];
    for (const [key, value] of Object.entries(fields) as [keyof WorkerUpdate, WorkerUpdate[keyof WorkerUpdate]][]) {
      if (value === undefined) continue;
      sets.push(`${COLUMNS[key]} = ?`);
      args.push(value);
    }
    let where = "id = ?";
    args.push(id);
    if (from) {
      where += ` AND state IN (${from.map(() => "?").join(", ")})`;
      args.push(...from);
    }
    const result = this.#db.prepare(`UPDATE orchestrator_workers SET ${sets.join(", ")} WHERE ${where}`).run(...args);
    return Number(result.changes) > 0 ? this.get(id) : undefined;
  }

  /** Counts one more coordinator message and marks the worker working, when it is in one of `from`. */
  messaged(id: string, from: readonly WorkerState[]): WorkerRecord | undefined {
    const result = this.#db
      .prepare(`UPDATE orchestrator_workers SET state = 'working', error = NULL, messages = messages + 1, updated_at = ? WHERE id = ? AND state IN (${from.map(() => "?").join(", ")})`)
      .run(new Date().toISOString(), id, ...from);
    return Number(result.changes) > 0 ? this.get(id) : undefined;
  }

  /**
   * Records a coordinator message to a worker before it is sent. `existing` is set when this tool call already
   * recorded one: its `messageId` when the runtime accepted it, no `messageId` when that is unknown (a restart in
   * between).
   */
  beginMessage(key: string, workerId: string): { readonly existing?: { readonly messageId?: string } } {
    const row = this.#db.prepare("SELECT message_id FROM orchestrator_messages WHERE key = ?").get(key) as { message_id: string | null } | undefined;
    if (row) return { existing: row.message_id ? { messageId: row.message_id } : {} };
    this.#db.prepare("INSERT INTO orchestrator_messages (key, worker_id, created_at) VALUES (?, ?, ?)").run(key, workerId, new Date().toISOString());
    return {};
  }

  completeMessage(key: string, messageId: string): void {
    this.#db.prepare("UPDATE orchestrator_messages SET message_id = ? WHERE key = ?").run(messageId, key);
  }

  /** Forgets a message the runtime refused, so the coordinator's retry of the same call can send it. */
  abandonMessage(key: string): void {
    this.#db.prepare("DELETE FROM orchestrator_messages WHERE key = ? AND message_id IS NULL").run(key);
  }
}

const COLUMNS: Readonly<Record<keyof WorkerUpdate, string>> = {
  state: "state",
  incarnation: "incarnation",
  result: "result",
  error: "error",
  messages: "messages",
};

function toRecord(row: Row): WorkerRecord {
  return {
    id: row.id,
    coordinatorId: row.coordinator_id,
    coordinatorIncarnation: row.coordinator_incarnation,
    ownerId: Number(row.owner_id),
    ...(row.incarnation ? { incarnation: row.incarnation } : {}),
    name: row.name,
    environment: row.environment,
    ...(row.model ? { model: row.model } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    task: row.task,
    state: row.state as WorkerState,
    ...(row.result !== null ? { result: row.result } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    messages: Number(row.messages),
    startKey: row.start_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The REST shape. */
export function toWorkerInfo(record: WorkerRecord): WorkerInfo {
  return {
    id: record.id,
    name: record.name,
    coordinatorId: record.coordinatorId,
    environment: record.environment,
    state: record.state,
    ...(record.model ? { model: record.model } : {}),
    ...(record.agent ? { agent: record.agent } : {}),
    task: record.task,
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    messages: record.messages,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
