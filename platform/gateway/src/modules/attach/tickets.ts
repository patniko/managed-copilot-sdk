import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ATTACH_TICKET_PREFIX } from "@managed-copilot/protocol";
import { migrate, transaction, type Database } from "../../db.js";
import type { Principal } from "../../http.js";

/** Recognizable prefix so attach tickets are easy to spot and redact. */
export const TICKET_PREFIX = ATTACH_TICKET_PREFIX;

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
  /**
   * The verified principal that requested the ticket, kept in memory only until the ticket is redeemed (absent after
   * a gateway restart). The attached CLI serves as the session's connected credential with it.
   */
  readonly principal?: Principal;
  /** The session incarnation the ticket was minted for (a reused session ID names another incarnation). */
  readonly incarnation?: string;
}

interface TicketRow {
  id: string;
  session_id: string;
  account_id: number;
  expires_at: string;
  used_at: string | null;
}

interface Grant {
  readonly principal?: Principal;
  readonly incarnation?: string;
  readonly expiresAt: number;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Short-lived, single-use, owner- and session-bound attach tickets. Only a SHA-256 hash is stored; the token
 * exists in plaintext only in the `POST /attach` response, and the requester's credential only in memory.
 */
export class AttachTickets {
  readonly #db: Database;
  readonly #now: () => number;
  readonly #grants = new Map<string, Grant>();

  constructor(db: Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    migrate(db, "attach", MIGRATIONS);
  }

  mint(owner: number | Principal, sessionId: string, ttlMs: number, options: { readonly incarnation?: string } = {}): { token: string; expiresAt: string } {
    const now = this.#now();
    const accountId = typeof owner === "number" ? owner : owner.accountId;
    // Tickets are useless once expired; keep a short tail for diagnostics only.
    this.#db.prepare("DELETE FROM attach_tickets WHERE expires_at < ?").run(new Date(now - 60 * 60_000).toISOString());
    for (const [id, grant] of this.#grants) if (grant.expiresAt <= now) this.#grants.delete(id);
    const id = randomUUID();
    const token = `${TICKET_PREFIX}${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(now + ttlMs).toISOString();
    this.#db
      .prepare("INSERT INTO attach_tickets (id, token_hash, session_id, account_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, hash(token), sessionId, accountId, new Date(now).toISOString(), expiresAt);
    this.#grants.set(id, { ...(typeof owner === "number" ? {} : { principal: owner }), ...(options.incarnation ? { incarnation: options.incarnation } : {}), expiresAt: now + ttlMs });
    return { token, expiresAt };
  }

  /** Consumes a ticket for `sessionId` exactly once. Unknown, expired, reused, or mismatched tickets return undefined. */
  redeem(token: string, sessionId: string): AttachTicket | undefined {
    if (!token.startsWith(TICKET_PREFIX)) return undefined;
    const now = new Date(this.#now()).toISOString();
    const ticket = transaction(this.#db, () => {
      const row = this.#db.prepare("SELECT id, session_id, account_id, expires_at, used_at FROM attach_tickets WHERE token_hash = ?").get(hash(token)) as
        | TicketRow
        | undefined;
      if (!row || row.used_at !== null || row.session_id !== sessionId || row.expires_at <= now) return undefined;
      this.#db.prepare("UPDATE attach_tickets SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now, row.id);
      return { id: row.id, sessionId: row.session_id, accountId: row.account_id, expiresAt: row.expires_at };
    });
    if (!ticket) return undefined;
    const grant = this.#grants.get(ticket.id);
    this.#grants.delete(ticket.id);
    return { ...ticket, ...(grant?.principal ? { principal: grant.principal } : {}), ...(grant?.incarnation ? { incarnation: grant.incarnation } : {}) };
  }
}
