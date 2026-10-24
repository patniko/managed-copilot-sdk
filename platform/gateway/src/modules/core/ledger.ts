// The core session ledger (`core_*` tables): ownership, placement, environment, admitted configuration, and the
// owner-scoped platform event log used for SSE replay.
import type { AccountInfo, EnvironmentRequest, EnvironmentType, NetworkPolicy, Placement, PlatformEvent, SessionState } from "@managed-copilot/protocol";
import { migrate, type Database } from "../../db.js";
import type { SessionRecord } from "./contracts.js";

const MIGRATIONS = [
  `CREATE TABLE core_accounts (
     id INTEGER PRIMARY KEY,
     login TEXT NOT NULL,
     name TEXT,
     avatar_url TEXT,
     last_seen_at TEXT NOT NULL
   );
   CREATE TABLE core_sessions (
     id TEXT PRIMARY KEY,
     owner_id INTEGER NOT NULL,
     environment TEXT NOT NULL,
     env_type TEXT NOT NULL,
     placement TEXT NOT NULL,
     state TEXT NOT NULL,
     generation INTEGER NOT NULL DEFAULT 0,
     title TEXT,
     model TEXT,
     agent TEXT,
     client_name TEXT,
     schedule_id TEXT,
     webhook TEXT,
     network TEXT NOT NULL,
     environment_request TEXT NOT NULL,
     admitted TEXT NOT NULL,
     last_turn TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX core_sessions_owner ON core_sessions (owner_id, updated_at);
   CREATE TABLE core_events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     owner_id INTEGER NOT NULL,
     type TEXT NOT NULL,
     session_id TEXT,
     body TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX core_events_owner ON core_events (owner_id, seq);`,
  // Runtime events a placement cutover hid (the source's handoff after the seal): never shown in history reads.
  `CREATE TABLE core_hidden_events (
     session_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     PRIMARY KEY (session_id, event_id)
   );`,
];

interface SessionRow {
  id: string;
  owner_id: number;
  environment: string;
  env_type: string;
  placement: string;
  state: string;
  generation: number;
  title: string | null;
  model: string | null;
  agent: string | null;
  client_name: string | null;
  schedule_id: string | null;
  webhook: string | null;
  network: string;
  environment_request: string;
  admitted: string;
  last_turn: string | null;
  created_at: string;
  updated_at: string;
  login: string | null;
  name: string | null;
  avatar_url: string | null;
}

/** The admitted, credential-free configuration a session is resumed with (no handlers, no tokens). */
export interface AdmittedConfig {
  /** Admitted `session.create` params minus per-connection fields (tools, request flags, tokens). */
  readonly params: Record<string, unknown>;
  /** Server-side tool declarations for sessions created without a client (schedules). */
  readonly tools?: readonly Record<string, unknown>[];
  readonly optionsPatch: Record<string, unknown>;
  /**
   * The caller's requested configuration before admission (no credentials, no per-connection fields), so a placement
   * change can admit it again for the new placement.
   */
  readonly requested?: Record<string, unknown>;
  /** The caller's `session.options.update` patches as requested (merged), re-admitted after a placement change. */
  readonly requestedOptions?: Record<string, unknown>;
}

export interface NewSession {
  readonly id: string;
  readonly owner: AccountInfo;
  readonly environment: string;
  readonly type: EnvironmentType;
  readonly placement: Placement;
  readonly network: NetworkPolicy;
  readonly environmentRequest: EnvironmentRequest;
  readonly admitted: AdmittedConfig;
  readonly model?: string;
  readonly agent?: string;
  readonly clientName?: string;
  readonly scheduleId?: string;
  readonly webhook?: string;
}

const SELECT = `SELECT s.*, a.login, a.name, a.avatar_url FROM core_sessions s LEFT JOIN core_accounts a ON a.id = s.owner_id`;

export class SessionLedger {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
    migrate(db, "core", MIGRATIONS);
    // A create that was in flight when the gateway stopped never completed. A placement cutover that was open did not
    // commit (a commit moves placement and generation in one transaction): the source placement stays the owner, and
    // the promotion module reconciles its own operation rows against generation/placement.
    const now = new Date().toISOString();
    db.prepare("UPDATE core_sessions SET state = 'failed', updated_at = ? WHERE state = 'creating'").run(now);
    db.prepare("UPDATE core_sessions SET state = 'idle', updated_at = ? WHERE state = 'promoting'").run(now);
  }

  upsertAccount(account: AccountInfo): void {
    this.#db
      .prepare(
        `INSERT INTO core_accounts (id, login, name, avatar_url, last_seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url, last_seen_at = excluded.last_seen_at`,
      )
      .run(account.id, account.login, account.name ?? null, account.avatarUrl ?? null, new Date().toISOString());
  }

  insert(session: NewSession): SessionRecord {
    const now = new Date().toISOString();
    this.upsertAccount(session.owner);
    this.#db
      .prepare(
        `INSERT INTO core_sessions (id, owner_id, environment, env_type, placement, state, generation, model, agent, client_name, schedule_id, webhook, network, environment_request, admitted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'creating', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.owner.id,
        session.environment,
        session.type,
        session.placement,
        session.model ?? null,
        session.agent ?? null,
        session.clientName ?? null,
        session.scheduleId ?? null,
        session.webhook ?? null,
        JSON.stringify(session.network),
        JSON.stringify(session.environmentRequest),
        JSON.stringify(session.admitted),
        now,
        now,
      );
    return this.get(session.id)!;
  }

  get(id: string): SessionRecord | undefined {
    const row = this.#db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as SessionRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  admitted(id: string): AdmittedConfig | undefined {
    const row = this.#db.prepare("SELECT admitted FROM core_sessions WHERE id = ?").get(id) as { admitted: string } | undefined;
    return row ? (JSON.parse(row.admitted) as AdmittedConfig) : undefined;
  }

  list(ownerId: number, query: { environment?: string; state?: SessionState; limit?: number } = {}): SessionRecord[] {
    const clauses = ["s.owner_id = ?", "s.state NOT IN ('deleted')"];
    const args: (string | number)[] = [ownerId];
    if (query.environment) {
      clauses.push("s.environment = ?");
      args.push(query.environment);
    }
    if (query.state) {
      clauses.push("s.state = ?");
      args.push(query.state);
    }
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
    const rows = this.#db.prepare(`${SELECT} WHERE ${clauses.join(" AND ")} ORDER BY s.updated_at DESC LIMIT ${limit}`).all(...args) as unknown as SessionRow[];
    return rows.map(toRecord);
  }

  update(id: string, fields: Partial<{ state: SessionState; title: string; model: string; agent: string; network: NetworkPolicy; admitted: AdmittedConfig; generation: number; placement: Placement; lastTurn: SessionRecord["lastTurn"] }>): void {
    const sets: string[] = ["updated_at = ?"];
    const args: (string | number | null)[] = [new Date().toISOString()];
    const map: Record<string, [string, (value: unknown) => string | number | null]> = {
      state: ["state", (value) => value as string],
      title: ["title", (value) => value as string],
      model: ["model", (value) => value as string],
      agent: ["agent", (value) => value as string],
      network: ["network", (value) => JSON.stringify(value)],
      admitted: ["admitted", (value) => JSON.stringify(value)],
      generation: ["generation", (value) => value as number],
      placement: ["placement", (value) => value as string],
      lastTurn: ["last_turn", (value) => (value === undefined ? null : JSON.stringify(value))],
    };
    for (const [key, value] of Object.entries(fields)) {
      const column = map[key];
      if (!column) continue;
      sets.push(`${column[0]} = ?`);
      args.push(column[1](value));
    }
    args.push(id);
    this.#db.prepare(`UPDATE core_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }

  remove(id: string): void {
    this.#db.prepare("DELETE FROM core_sessions WHERE id = ?").run(id);
    this.#db.prepare("DELETE FROM core_hidden_events WHERE session_id = ?").run(id);
  }

  /** Records runtime events of a session that history reads must not return. */
  hideEvents(sessionId: string, eventIds: readonly string[]): void {
    if (eventIds.length === 0) return;
    const insert = this.#db.prepare("INSERT OR IGNORE INTO core_hidden_events (session_id, event_id) VALUES (?, ?)");
    for (const eventId of eventIds) insert.run(sessionId, eventId);
  }

  hiddenEvents(sessionId: string): Set<string> {
    const rows = this.#db.prepare("SELECT event_id FROM core_hidden_events WHERE session_id = ?").all(sessionId) as { event_id: string }[];
    return new Set(rows.map((row) => row.event_id));
  }

  /** Sessions that were active when the gateway stopped; they are resumed lazily. */
  activeSessions(): SessionRecord[] {
    const rows = this.#db.prepare(`${SELECT} WHERE s.state IN ('ready', 'running', 'waiting', 'idle')`).all() as unknown as SessionRow[];
    return rows.map(toRecord);
  }

  /**
   * Stores a platform event. Storing an ID again is a no-op for the same owner (a publisher retrying with a stable ID)
   * and an error for another owner.
   */
  appendEvent(event: PlatformEvent, ownerId: number): void {
    const result = this.#db
      .prepare("INSERT INTO core_events (id, owner_id, type, session_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
      .run(event.id, ownerId, event.type, event.sessionId ?? null, JSON.stringify(event), event.createdAt);
    if (Number(result.changes) > 0) return;
    const existing = this.#db.prepare("SELECT owner_id FROM core_events WHERE id = ?").get(event.id) as { owner_id: number } | undefined;
    if (existing?.owner_id !== ownerId) throw new Error(`Platform event ${event.id} already exists for another owner`);
  }

  /** Events for an owner after `afterId` (the SSE `Last-Event-ID`), oldest first. */
  eventsAfter(ownerId: number, afterId: string, limit = 500): { seq: number; event: PlatformEvent }[] {
    const anchor = this.#db.prepare("SELECT seq FROM core_events WHERE id = ? AND owner_id = ?").get(afterId, ownerId) as { seq: number } | undefined;
    if (!anchor) return [];
    const rows = this.#db.prepare("SELECT seq, body FROM core_events WHERE owner_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(ownerId, anchor.seq, limit) as { seq: number; body: string }[];
    return rows.map((row) => ({ seq: row.seq, event: JSON.parse(row.body) as PlatformEvent }));
  }

  /** Keeps the most recent events per deployment bounded. */
  pruneEvents(keep = 10_000): void {
    this.#db.prepare("DELETE FROM core_events WHERE seq <= (SELECT MAX(seq) FROM core_events) - ?").run(keep);
  }
}

function toRecord(row: SessionRow): SessionRecord {
  const owner: AccountInfo = {
    id: row.owner_id,
    login: row.login ?? String(row.owner_id),
    ...(row.name ? { name: row.name } : {}),
    ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
  };
  return {
    id: row.id,
    ownerId: row.owner_id,
    owner,
    environment: row.environment,
    type: row.env_type as EnvironmentType,
    placement: row.placement as Placement,
    state: row.state as SessionState,
    generation: row.generation,
    ...(row.title ? { title: row.title } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    ...(row.client_name ? { clientName: row.client_name } : {}),
    ...(row.schedule_id ? { scheduleId: row.schedule_id } : {}),
    ...(row.webhook ? { webhook: row.webhook } : {}),
    network: JSON.parse(row.network) as NetworkPolicy,
    environmentRequest: JSON.parse(row.environment_request) as EnvironmentRequest,
    ...(row.last_turn ? { lastTurn: JSON.parse(row.last_turn) as NonNullable<SessionRecord["lastTurn"]> } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
