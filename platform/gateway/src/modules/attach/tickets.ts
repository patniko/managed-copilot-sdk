import { createHash, randomBytes, randomUUID } from "node:crypto";
import { migrate, transaction, type Database } from "../../db.js";

/** Recognizable prefix so attach tickets are easy to spot and redact. */
export const TICKET_PREFIX = "mcat_";

const MIGRATIONS = [
  `CREATE TABLE attach_tickets (
     id TEXT PRIMARY KEY,
     token_hash TEXT NOT NULL UNIQUE,
     session_id TEXT NOT NULL,
     account_id INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     used_at TEXT
   )`,
];

export interface AttachTicket {
  readonly id: string;
  readonly sessionId: string;
  readonly accountId: number;
  readonly expiresAt: string;
}

interface TicketRow {
  id: string;
  session_id: string;
  account_id: number;
  expires_at: string;
  used_at: string | null;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Short-lived, single-use, owner- and session-bound attach tickets. Only a SHA-256 hash is stored; the token
 * exists in plaintext only in the `POST /attach` response.
 */
export class AttachTickets {
  readonly #db: Database;
  readonly #now: () => number;

  constructor(db: Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    migrate(db, "attach", MIGRATIONS);
  }

  mint(accountId: number, sessionId: string, ttlMs: number): { token: string; expiresAt: string } {
    const now = this.#now();
    // Tickets are useless once expired; keep a short tail for diagnostics only.
    this.#db.prepare("DELETE FROM attach_tickets WHERE expires_at < ?").run(new Date(now - 60 * 60_000).toISOString());
    const token = `${TICKET_PREFIX}${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(now + ttlMs).toISOString();
    this.#db
      .prepare("INSERT INTO attach_tickets (id, token_hash, session_id, account_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), hash(token), sessionId, accountId, new Date(now).toISOString(), expiresAt);
    return { token, expiresAt };
  }

  /** Consumes a ticket for `sessionId` exactly once. Unknown, expired, reused, or mismatched tickets return undefined. */
  redeem(token: string, sessionId: string): AttachTicket | undefined {
    if (!token.startsWith(TICKET_PREFIX)) return undefined;
    const now = new Date(this.#now()).toISOString();
    return transaction(this.#db, () => {
      const row = this.#db.prepare("SELECT id, session_id, account_id, expires_at, used_at FROM attach_tickets WHERE token_hash = ?").get(hash(token)) as
        | TicketRow
        | undefined;
      if (!row || row.used_at !== null || row.session_id !== sessionId || row.expires_at <= now) return undefined;
      this.#db.prepare("UPDATE attach_tickets SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now, row.id);
      return { id: row.id, sessionId: row.session_id, accountId: row.account_id, expiresAt: row.expires_at };
    });
  }
}
