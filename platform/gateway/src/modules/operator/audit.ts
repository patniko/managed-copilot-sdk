// The operator audit log (`operator_audit`): every guarded operator action and console sign-in, with who did it,
// what it acted on, and how it went. Bounded to the most recent entries.
import type { AccountInfo, OperatorAuditAction, OperatorAuditEntry } from "@managed-copilot/protocol";
import { migrate, type Database } from "../../db.js";
import type { Logger } from "../../log.js";
import { redactText } from "../../redaction.js";

const MIGRATIONS = [
  `CREATE TABLE operator_audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     actor_id INTEGER NOT NULL,
     actor_login TEXT NOT NULL,
     action TEXT NOT NULL,
     target TEXT,
     outcome TEXT NOT NULL,
     detail TEXT
   );`,
];

const KEEP = 5_000;

interface AuditRow {
  id: number;
  at: string;
  actor_id: number;
  actor_login: string;
  action: OperatorAuditAction;
  target: string | null;
  outcome: "succeeded" | "failed";
  detail: string | null;
}

export class OperatorAudit {
  readonly #db: Database;
  readonly #log: Logger;
  #writes = 0;

  constructor(db: Database, log: Logger) {
    this.#db = db;
    this.#log = log;
    migrate(db, "operator", MIGRATIONS);
  }

  record(entry: { readonly actor: AccountInfo; readonly action: OperatorAuditAction; readonly target?: string; readonly outcome: "succeeded" | "failed"; readonly detail?: string }): OperatorAuditEntry {
    const at = new Date().toISOString();
    const detail = entry.detail ? redactText(entry.detail).slice(0, 1000) : undefined;
    const result = this.#db
      .prepare("INSERT INTO operator_audit (at, actor_id, actor_login, action, target, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(at, entry.actor.id, entry.actor.login, entry.action, entry.target ?? null, entry.outcome, detail ?? null);
    if (++this.#writes % 100 === 0) this.#db.prepare("DELETE FROM operator_audit WHERE id <= (SELECT MAX(id) FROM operator_audit) - ?").run(KEEP);
    this.#log.info("Operator action", { actor: entry.actor.login, action: entry.action, ...(entry.target ? { target: entry.target } : {}), outcome: entry.outcome, ...(detail ? { detail } : {}) });
    return {
      id: Number(result.lastInsertRowid),
      at,
      actor: entry.actor,
      action: entry.action,
      ...(entry.target ? { target: entry.target } : {}),
      outcome: entry.outcome,
      ...(detail ? { detail } : {}),
    };
  }

  /** Newest first. `account` fills in names and avatars of the actors it knows. */
  list(limit: number, account: (id: number) => AccountInfo): OperatorAuditEntry[] {
    const rows = this.#db.prepare("SELECT * FROM operator_audit ORDER BY id DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 1000)) as unknown as AuditRow[];
    return rows.map((row) => {
      const known = account(Number(row.actor_id));
      return {
        id: Number(row.id),
        at: row.at,
        actor: known.login === String(row.actor_id) ? { id: Number(row.actor_id), login: row.actor_login } : known,
        action: row.action,
        ...(row.target ? { target: row.target } : {}),
        outcome: row.outcome,
        ...(row.detail ? { detail: row.detail } : {}),
      };
    });
  }
}
