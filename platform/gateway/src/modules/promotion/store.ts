// The promotion ledger (`promotion_operations`): one row per attempt. At most one attempt per session is open at a
// time (a partial unique index makes admission atomic), and recovery after a restart reconciles open rows against
// core's ledger, whose commit moves placement and generation in one transaction.
import { ManagedCopilotError, type PromotionTrigger } from "@managed-copilot/protocol";
import { migrate, type Database } from "../../db.js";
import type { OperationState, PromotionOperation } from "./contract.js";

const MIGRATIONS = [
  `CREATE TABLE promotion_operations (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     owner_id INTEGER NOT NULL,
     from_generation INTEGER NOT NULL,
     to_generation INTEGER,
     trigger TEXT NOT NULL,
     tool_call_id TEXT,
     request_id TEXT,
     target TEXT NOT NULL,
     state TEXT NOT NULL,
     sandbox_id TEXT,
     error_code TEXT,
     error TEXT,
     source_cleaned INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     committed_at TEXT
   );
   CREATE INDEX promotion_operations_session ON promotion_operations (session_id, created_at);
   CREATE UNIQUE INDEX promotion_operations_open ON promotion_operations (session_id) WHERE state NOT IN ('committed', 'failed');`,
];

interface Row {
  id: string;
  session_id: string;
  owner_id: number;
  from_generation: number;
  to_generation: number | null;
  trigger: string;
  tool_call_id: string | null;
  request_id: string | null;
  target: string;
  state: string;
  sandbox_id: string | null;
  error_code: string | null;
  error: string | null;
  source_cleaned: number;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
}

function toOperation(row: Row): PromotionOperation {
  return {
    id: row.id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    fromGeneration: row.from_generation,
    ...(row.to_generation !== null ? { toGeneration: row.to_generation } : {}),
    trigger: row.trigger as PromotionTrigger,
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    ...(row.request_id ? { requestId: row.request_id } : {}),
    target: row.target,
    state: row.state as OperationState,
    ...(row.sandbox_id ? { sandboxId: row.sandbox_id } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error ? { error: row.error } : {}),
    sourceCleaned: row.source_cleaned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.committed_at ? { committedAt: row.committed_at } : {}),
  };
}

export interface NewOperation {
  readonly id: string;
  readonly sessionId: string;
  readonly ownerId: number;
  readonly fromGeneration: number;
  readonly trigger: PromotionTrigger;
  readonly toolCallId?: string;
  readonly target: string;
}

export type OperationUpdate = Partial<{
  state: OperationState;
  toGeneration: number;
  requestId: string;
  sandboxId: string;
  errorCode: string;
  error: string;
  sourceCleaned: boolean;
  committedAt: string;
}>;

const COLUMNS: Record<keyof OperationUpdate, string> = {
  state: "state",
  toGeneration: "to_generation",
  requestId: "request_id",
  sandboxId: "sandbox_id",
  errorCode: "error_code",
  error: "error",
  sourceCleaned: "source_cleaned",
  committedAt: "committed_at",
};

export class PromotionStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
    migrate(db, "promotion", MIGRATIONS);
  }

  /** Admits an attempt; fails with `promotion_busy` when another attempt for the session is still open. */
  insert(operation: NewOperation): PromotionOperation {
    const now = new Date().toISOString();
    try {
      this.#db
        .prepare(
          `INSERT INTO promotion_operations (id, session_id, owner_id, from_generation, trigger, tool_call_id, target, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'admitted', ?, ?)`,
        )
        .run(operation.id, operation.sessionId, operation.ownerId, operation.fromGeneration, operation.trigger, operation.toolCallId ?? null, operation.target, now, now);
    } catch (error) {
      if (/UNIQUE constraint failed/i.test((error as Error).message)) {
        throw new ManagedCopilotError("promotion_busy", `Session ${operation.sessionId} is already being promoted; try again when that finishes`, { sessionId: operation.sessionId });
      }
      throw error;
    }
    return this.get(operation.id)!;
  }

  update(id: string, fields: OperationUpdate): PromotionOperation {
    const sets = ["updated_at = ?"];
    const args: (string | number | null)[] = [new Date().toISOString()];
    for (const [key, value] of Object.entries(fields) as [keyof OperationUpdate, unknown][]) {
      const column = COLUMNS[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      args.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as string | number));
    }
    args.push(id);
    this.#db.prepare(`UPDATE promotion_operations SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    return this.get(id)!;
  }

  get(id: string): PromotionOperation | undefined {
    const row = this.#db.prepare("SELECT * FROM promotion_operations WHERE id = ?").get(id) as Row | undefined;
    return row ? toOperation(row) : undefined;
  }

  latest(sessionId: string): PromotionOperation | undefined {
    const row = this.#db.prepare("SELECT * FROM promotion_operations WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(sessionId) as Row | undefined;
    return row ? toOperation(row) : undefined;
  }

  open(sessionId: string): PromotionOperation | undefined {
    const row = this.#db.prepare("SELECT * FROM promotion_operations WHERE session_id = ? AND state NOT IN ('committed', 'failed')").get(sessionId) as Row | undefined;
    return row ? toOperation(row) : undefined;
  }

  committed(sessionId: string): PromotionOperation | undefined {
    const row = this.#db.prepare("SELECT * FROM promotion_operations WHERE session_id = ? AND state = 'committed' ORDER BY created_at DESC LIMIT 1").get(sessionId) as Row | undefined;
    return row ? toOperation(row) : undefined;
  }

  /** Attempts that never reached a terminal state (interrupted by a restart). */
  unfinished(): PromotionOperation[] {
    return (this.#db.prepare("SELECT * FROM promotion_operations WHERE state NOT IN ('committed', 'failed')").all() as unknown as Row[]).map(toOperation);
  }

  /** Committed attempts whose source copy of the session state still has to be removed. */
  uncleaned(): PromotionOperation[] {
    return (this.#db.prepare("SELECT * FROM promotion_operations WHERE state = 'committed' AND source_cleaned = 0").all() as unknown as Row[]).map(toOperation);
  }
}
