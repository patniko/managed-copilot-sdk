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
  // The browser's time zone, remembered so scheduled runs with no tab open use the same zone.
  `ALTER TABLE users ADD COLUMN detected_time_zone TEXT;`,
  // Sandboxes (orchestrator workers): their published outputs, with a copy of each image so charts stay in the chat
  // after a sandbox is deleted, and when each start or follow-up card's work ran.
  `CREATE TABLE sandbox_outputs (
     artifact_id TEXT PRIMARY KEY,
     coordinator_id TEXT NOT NULL,
     worker_id TEXT NOT NULL,
     path TEXT NOT NULL,
     version INTEGER NOT NULL,
     size INTEGER NOT NULL,
     content_type TEXT,
     published_at TEXT,
     bytes BLOB
   );
   CREATE INDEX sandbox_outputs_worker ON sandbox_outputs (coordinator_id, worker_id);
   CREATE TABLE sandbox_runs (
     card_id TEXT PRIMARY KEY,
     coordinator_id TEXT NOT NULL,
     worker_name TEXT NOT NULL,
     worker_id TEXT,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     outcome TEXT
   );
   CREATE INDEX sandbox_runs_worker ON sandbox_runs (worker_id, finished_at);`,
];

export interface UserRecord {
  readonly accountId: number;
  readonly login: string;
  readonly name?: string;
  readonly sessionId?: string;
  /** Chosen in Settings. */
  readonly timeZone?: string;
  /** Reported by the person's browser. */
  readonly detectedTimeZone?: string;
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

/** A published sandbox output this server knows about (and, for images, keeps a copy of). */
export interface SandboxOutputRecord {
  readonly artifactId: string;
  readonly coordinatorId: string;
  readonly workerId: string;
  readonly path: string;
  readonly version: number;
  readonly size: number;
  readonly contentType?: string;
  readonly publishedAt?: string;
  readonly cached: boolean;
}

/** When one start or follow-up card's work ran. */
export interface SandboxRunRecord {
  readonly cardId: string;
  readonly workerName: string;
  readonly workerId?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly outcome?: "idle" | "failed" | "stopped";
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
      detectedTimeZone: str(row.detected_time_zone),
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

  setDetectedTimeZone(accountId: number, timeZone: string): void {
    this.db.prepare("UPDATE users SET detected_time_zone = ?, updated_at = ? WHERE account_id = ?").run(timeZone, new Date().toISOString(), accountId);
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

  /**
   * Stores a refreshed access token, but only for the connection it was refreshed for: if Google was disconnected or
   * reconnected (possibly as another Google account) meanwhile, nothing is written and this returns false.
   */
  updateGoogleAccess(accountId: number, sealedRefreshToken: string, sealedAccessToken: string, expiresAt: string, scopes?: readonly string[]): boolean {
    const now = new Date().toISOString();
    const result = scopes
      ? this.db
          .prepare("UPDATE google_connections SET access_token = ?, access_expires_at = ?, scopes = ?, status = 'ok', updated_at = ? WHERE account_id = ? AND refresh_token = ?")
          .run(sealedAccessToken, expiresAt, scopes.join(" "), now, accountId, sealedRefreshToken)
      : this.db
          .prepare("UPDATE google_connections SET access_token = ?, access_expires_at = ?, status = 'ok', updated_at = ? WHERE account_id = ? AND refresh_token = ?")
          .run(sealedAccessToken, expiresAt, now, accountId, sealedRefreshToken);
    return Number(result.changes) === 1;
  }

  /** Marks a connection's status; with `sealedRefreshToken`, only if it is still that connection. */
  setGoogleStatus(accountId: number, status: "ok" | "needs_reconnect", sealedRefreshToken?: string): void {
    const now = new Date().toISOString();
    if (sealedRefreshToken === undefined) {
      this.db.prepare("UPDATE google_connections SET status = ?, updated_at = ? WHERE account_id = ?").run(status, now, accountId);
    } else {
      this.db.prepare("UPDATE google_connections SET status = ?, updated_at = ? WHERE account_id = ? AND refresh_token = ?").run(status, now, accountId, sealedRefreshToken);
    }
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

  clearOfflineCalls(): void {
    this.db.prepare("DELETE FROM offline_calls").run();
  }

  // ---- sandboxes ---------------------------------------------------------------------------------------------------

  #outputRecord(row: Row): SandboxOutputRecord {
    return {
      artifactId: String(row.artifact_id),
      coordinatorId: String(row.coordinator_id),
      workerId: String(row.worker_id),
      path: String(row.path),
      version: Number(row.version),
      size: Number(row.size),
      contentType: str(row.content_type),
      publishedAt: str(row.published_at),
      cached: Number(row.cached) === 1,
    };
  }

  /** Records published outputs (new ones only: a published version never changes). */
  recordOutputs(outputs: readonly Omit<SandboxOutputRecord, "cached">[]): void {
    const insert = this.db.prepare(
      `INSERT INTO sandbox_outputs (artifact_id, coordinator_id, worker_id, path, version, size, content_type, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (artifact_id) DO NOTHING`,
    );
    for (const output of outputs) {
      insert.run(output.artifactId, output.coordinatorId, output.workerId, output.path, output.version, output.size, output.contentType ?? null, output.publishedAt ?? null);
    }
  }

  outputs(coordinatorId: string): SandboxOutputRecord[] {
    const rows = this.db
      .prepare("SELECT artifact_id, coordinator_id, worker_id, path, version, size, content_type, published_at, bytes IS NOT NULL AS cached FROM sandbox_outputs WHERE coordinator_id = ? ORDER BY published_at, path, version")
      .all(coordinatorId) as Row[];
    return rows.map((row) => this.#outputRecord(row));
  }

  output(artifactId: string): SandboxOutputRecord | undefined {
    const row = this.db
      .prepare("SELECT artifact_id, coordinator_id, worker_id, path, version, size, content_type, published_at, bytes IS NOT NULL AS cached FROM sandbox_outputs WHERE artifact_id = ?")
      .get(artifactId) as Row | undefined;
    return row ? this.#outputRecord(row) : undefined;
  }

  outputBytes(artifactId: string): Uint8Array | undefined {
    const row = this.db.prepare("SELECT bytes FROM sandbox_outputs WHERE artifact_id = ?").get(artifactId) as Row | undefined;
    return row?.bytes instanceof Uint8Array ? row.bytes : undefined;
  }

  cacheOutput(artifactId: string, bytes: Uint8Array): void {
    this.db.prepare("UPDATE sandbox_outputs SET bytes = ? WHERE artifact_id = ?").run(bytes, artifactId);
  }

  /** Starts timing a card's work, once; later calls only fill in the sandbox's ID when it was unknown. */
  startRun(run: { cardId: string; coordinatorId: string; workerName: string; workerId?: string; startedAt: string }): void {
    this.db
      .prepare(
        `INSERT INTO sandbox_runs (card_id, coordinator_id, worker_name, worker_id, started_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (card_id) DO UPDATE SET worker_id = COALESCE(sandbox_runs.worker_id, excluded.worker_id)`,
      )
      .run(run.cardId, run.coordinatorId, run.workerName, run.workerId ?? null, run.startedAt);
  }

  /** Ends a sandbox's open runs that started by `at`: it finished (or stopped) then. */
  finishRuns(workerId: string, at: string, outcome: "idle" | "failed" | "stopped"): number {
    const result = this.db
      .prepare("UPDATE sandbox_runs SET finished_at = ?, outcome = ? WHERE worker_id = ? AND finished_at IS NULL AND started_at <= ?")
      .run(at, outcome, workerId, at);
    return Number(result.changes);
  }

  /** Ends every open run of a sandbox at `at` (never before a run's own start): it finished all it was sent. */
  finishOpenRuns(workerId: string, at: string, outcome: "idle" | "failed" | "stopped"): number {
    const result = this.db
      .prepare("UPDATE sandbox_runs SET finished_at = MAX(started_at, ?), outcome = ? WHERE worker_id = ? AND finished_at IS NULL")
      .run(at, outcome, workerId);
    return Number(result.changes);
  }

  /** Ends one card's run if it is still open (and started by `at`). */
  finishRun(cardId: string, at: string, outcome: "idle" | "failed" | "stopped"): void {
    this.db.prepare("UPDATE sandbox_runs SET finished_at = ?, outcome = ? WHERE card_id = ? AND finished_at IS NULL AND started_at <= ?").run(at, outcome, cardId, at);
  }

  runs(coordinatorId: string): SandboxRunRecord[] {
    const rows = this.db.prepare("SELECT * FROM sandbox_runs WHERE coordinator_id = ? ORDER BY started_at").all(coordinatorId) as Row[];
    return rows.map((row) => ({
      cardId: String(row.card_id),
      workerName: String(row.worker_name),
      workerId: str(row.worker_id),
      startedAt: String(row.started_at),
      finishedAt: str(row.finished_at),
      outcome: row.outcome === "idle" || row.outcome === "failed" || row.outcome === "stopped" ? row.outcome : undefined,
    }));
  }

  /** Forgets a conversation's sandboxes (it was replaced by a new one, and the platform deleted them with it). */
  clearSandboxes(coordinatorId: string): void {
    this.db.prepare("DELETE FROM sandbox_outputs WHERE coordinator_id = ?").run(coordinatorId);
    this.db.prepare("DELETE FROM sandbox_runs WHERE coordinator_id = ?").run(coordinatorId);
  }
}
