import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The assistant server's local state (SQLite). It holds pointers and secrets the platform must not: which session is
 * each person's conversation, sealed Google tokens, the demo inbox and calendar, side-effect records, and webhook
 * deduplication. The conversation itself lives on the platform.
 */

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE users (
     account_id INTEGER PRIMARY KEY,
     login TEXT NOT NULL,
     name TEXT,
     session_id TEXT,
     time_zone TEXT,
     last_read_at TEXT,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE google_connections (
     account_id INTEGER PRIMARY KEY,
     email TEXT,
     scopes TEXT NOT NULL,
     refresh_token TEXT NOT NULL,
     access_token TEXT,
     access_expires_at TEXT,
     status TEXT NOT NULL,
     connected_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE oauth_states (
     state TEXT PRIMARY KEY,
     account_id INTEGER NOT NULL,
     verifier TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE effects (
     key TEXT PRIMARY KEY,
     tool TEXT NOT NULL,
     state TEXT NOT NULL,
     result TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE webhook_events (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL,
     received_at TEXT NOT NULL
   );
   CREATE TABLE offline_calls (
     tool_call_id TEXT PRIMARY KEY,
     tool TEXT NOT NULL,
     via TEXT NOT NULL,
     handled_at TEXT NOT NULL
   );
   CREATE TABLE demo_meta (
     account_id INTEGER PRIMARY KEY,
     seeded_at TEXT NOT NULL,
     time_zone TEXT NOT NULL
   );
   CREATE TABLE demo_mail (
     id TEXT PRIMARY KEY,
     account_id INTEGER NOT NULL,
     thread_id TEXT NOT NULL,
     folder TEXT NOT NULL,
     from_name TEXT,
     from_email TEXT NOT NULL,
     to_json TEXT NOT NULL,
     cc_json TEXT NOT NULL,
     subject TEXT NOT NULL,
     body TEXT NOT NULL,
     date TEXT NOT NULL,
     unread INTEGER NOT NULL,
     important INTEGER NOT NULL,
     labels_json TEXT NOT NULL
   );
   CREATE INDEX demo_mail_account ON demo_mail (account_id, folder, date);
   CREATE TABLE demo_events (
     id TEXT PRIMARY KEY,
     account_id INTEGER NOT NULL,
     title TEXT NOT NULL,
     start TEXT NOT NULL,
     end TEXT NOT NULL,
     all_day INTEGER NOT NULL,
     location TEXT,
     description TEXT,
     attendees_json TEXT NOT NULL,
     organizer TEXT,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX demo_events_account ON demo_events (account_id, start);`,
];

export interface UserRecord {
  readonly accountId: number;
  readonly login: string;
  readonly name?: string;
  readonly sessionId?: string;
  readonly timeZone?: string;
  readonly lastReadAt?: string;
}

export interface GoogleConnectionRecord {
  readonly accountId: number;
  readonly email?: string;
  readonly scopes: readonly string[];
  /** Sealed. */
  readonly refreshToken: string;
  /** Sealed. */
  readonly accessToken?: string;
  readonly accessExpiresAt?: string;
  readonly status: "ok" | "needs_reconnect";
  readonly connectedAt: string;
}

export interface EffectRecord {
  readonly key: string;
  readonly tool: string;
  readonly state: "started" | "completed";
  readonly result?: string;
}

type Row = Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const row = this.db.prepare("SELECT version FROM schema_version").get() as Row | undefined;
    let version = typeof row?.version === "number" ? row.version : 0;
    if (!row) this.db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
    while (version < MIGRATIONS.length) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version]!);
        this.db.prepare("UPDATE schema_version SET version = ?").run(version + 1);
      });
      version++;
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- users -------------------------------------------------------------------------------------------------------

  getUser(accountId: number): UserRecord | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE account_id = ?").get(accountId) as Row | undefined;
    if (!row) return undefined;
    return {
      accountId,
      login: String(row.login),
      name: str(row.name),
      sessionId: str(row.session_id),
      timeZone: str(row.time_zone),
      lastReadAt: str(row.last_read_at),
    };
  }

  upsertUser(account: { id: number; login: string; name?: string }): UserRecord {
    this.db
      .prepare(
        `INSERT INTO users (account_id, login, name, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET login = excluded.login, name = excluded.name, updated_at = excluded.updated_at`,
      )
      .run(account.id, account.login, account.name ?? null, new Date().toISOString());
    return this.getUser(account.id)!;
  }

  setSessionId(accountId: number, sessionId: string | undefined): void {
    this.db.prepare("UPDATE users SET session_id = ?, updated_at = ? WHERE account_id = ?").run(sessionId ?? null, new Date().toISOString(), accountId);
  }

  setTimeZone(accountId: number, timeZone: string): void {
    this.db.prepare("UPDATE users SET time_zone = ?, updated_at = ? WHERE account_id = ?").run(timeZone, new Date().toISOString(), accountId);
  }

  setLastReadAt(accountId: number, at: string): void {
    this.db.prepare("UPDATE users SET last_read_at = ?, updated_at = ? WHERE account_id = ?").run(at, new Date().toISOString(), accountId);
  }

  // ---- Google ------------------------------------------------------------------------------------------------------

  getGoogle(accountId: number): GoogleConnectionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM google_connections WHERE account_id = ?").get(accountId) as Row | undefined;
    if (!row) return undefined;
    return {
      accountId,
      email: str(row.email),
      scopes: String(row.scopes).split(" ").filter(Boolean),
      refreshToken: String(row.refresh_token),
      accessToken: str(row.access_token),
      accessExpiresAt: str(row.access_expires_at),
      status: row.status === "needs_reconnect" ? "needs_reconnect" : "ok",
      connectedAt: String(row.connected_at),
    };
  }

  saveGoogle(record: GoogleConnectionRecord): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO google_connections (account_id, email, scopes, refresh_token, access_token, access_expires_at, status, connected_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET email = excluded.email, scopes = excluded.scopes, refresh_token = excluded.refresh_token,
           access_token = excluded.access_token, access_expires_at = excluded.access_expires_at, status = excluded.status,
           connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
      )
      .run(
        record.accountId,
        record.email ?? null,
        record.scopes.join(" "),
        record.refreshToken,
        record.accessToken ?? null,
        record.accessExpiresAt ?? null,
        record.status,
        record.connectedAt,
        now,
      );
  }

  updateGoogleAccess(accountId: number, sealedAccessToken: string, expiresAt: string, scopes?: readonly string[]): void {
    const now = new Date().toISOString();
    if (scopes) {
      this.db
        .prepare("UPDATE google_connections SET access_token = ?, access_expires_at = ?, scopes = ?, status = 'ok', updated_at = ? WHERE account_id = ?")
        .run(sealedAccessToken, expiresAt, scopes.join(" "), now, accountId);
    } else {
      this.db
        .prepare("UPDATE google_connections SET access_token = ?, access_expires_at = ?, status = 'ok', updated_at = ? WHERE account_id = ?")
        .run(sealedAccessToken, expiresAt, now, accountId);
    }
  }

  setGoogleStatus(accountId: number, status: "ok" | "needs_reconnect"): void {
    this.db.prepare("UPDATE google_connections SET status = ?, updated_at = ? WHERE account_id = ?").run(status, new Date().toISOString(), accountId);
  }

  deleteGoogle(accountId: number): void {
    this.db.prepare("DELETE FROM google_connections WHERE account_id = ?").run(accountId);
  }

  saveOAuthState(state: string, accountId: number, sealedVerifier: string): void {
    const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
    this.db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(cutoff);
    this.db.prepare("INSERT INTO oauth_states (state, account_id, verifier, created_at) VALUES (?, ?, ?, ?)").run(state, accountId, sealedVerifier, new Date().toISOString());
  }

  /** Returns and deletes a pending OAuth state (single use). */
  takeOAuthState(state: string): { accountId: number; verifier: string; createdAt: string } | undefined {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM oauth_states WHERE state = ?").get(state) as Row | undefined;
      if (!row) return undefined;
      this.db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
      return { accountId: Number(row.account_id), verifier: String(row.verifier), createdAt: String(row.created_at) };
    });
  }

  // ---- side effects ------------------------------------------------------------------------------------------------

  getEffect(key: string): EffectRecord | undefined {
    const row = this.db.prepare("SELECT * FROM effects WHERE key = ?").get(key) as Row | undefined;
    if (!row) return undefined;
    return { key, tool: String(row.tool), state: row.state === "completed" ? "completed" : "started", result: str(row.result) };
  }

  /** Records that a side effect is about to run. Returns false if one with this key already exists. */
  startEffect(key: string, tool: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("INSERT INTO effects (key, tool, state, created_at, updated_at) VALUES (?, ?, 'started', ?, ?) ON CONFLICT (key) DO NOTHING")
      .run(key, tool, now, now);
    return Number(result.changes) === 1;
  }

  completeEffect(key: string, result: string): void {
    this.db.prepare("UPDATE effects SET state = 'completed', result = ?, updated_at = ? WHERE key = ?").run(result, new Date().toISOString(), key);
  }

  clearEffect(key: string): void {
    this.db.prepare("DELETE FROM effects WHERE key = ?").run(key);
  }

  // ---- webhooks and offline work -----------------------------------------------------------------------------------

  /** Records a webhook event ID; returns false if it was already processed (at-least-once delivery). */
  recordWebhookEvent(id: string, type: string): boolean {
    const cutoff = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    this.db.prepare("DELETE FROM webhook_events WHERE received_at < ?").run(cutoff);
    const result = this.db.prepare("INSERT INTO webhook_events (id, type, received_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING").run(id, type, new Date().toISOString());
    return Number(result.changes) === 1;
  }

  hasWebhookEvent(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM webhook_events WHERE id = ?").get(id) !== undefined;
  }

  lastWebhookAt(): string | undefined {
    const row = this.db.prepare("SELECT MAX(received_at) AS at FROM webhook_events").get() as Row | undefined;
    return str(row?.at);
  }

  recordOfflineCall(toolCallId: string, tool: string, via: "webhook" | "poll"): void {
    this.db
      .prepare("INSERT INTO offline_calls (tool_call_id, tool, via, handled_at) VALUES (?, ?, ?, ?) ON CONFLICT (tool_call_id) DO NOTHING")
      .run(toolCallId, tool, via, new Date().toISOString());
  }

  offlineCallIds(): Set<string> {
    const rows = this.db.prepare("SELECT tool_call_id FROM offline_calls").all() as Row[];
    return new Set(rows.map((row) => String(row.tool_call_id)));
  }
}
