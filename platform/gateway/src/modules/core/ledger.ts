// The core session ledger (`core_*` tables): ownership, placement, environment, admitted configuration, and the
// owner-scoped platform event log used for SSE replay.
import { randomBytes } from "node:crypto";
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
  // A session ID can be reused after deletion; the incarnation tells two sessions with the same ID apart.
  `ALTER TABLE core_sessions ADD COLUMN incarnation TEXT;
   UPDATE core_sessions SET incarnation = 'inc_' || lower(hex(randomblob(16))) WHERE incarnation IS NULL;`,
  // The session that started this one (an orchestrator's coordinator, for a worker), pinned to its incarnation.
  `ALTER TABLE core_sessions ADD COLUMN parent_session_id TEXT;
   ALTER TABLE core_sessions ADD COLUMN parent_incarnation TEXT;
   CREATE INDEX core_sessions_parent ON core_sessions (parent_session_id);`,
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
  incarnation: string | null;
  parent_session_id: string | null;
  parent_incarnation: string | null;
  created_at: string;
  updated_at: string;
  login: string | null;
  name: string | null;
  avatar_url: string | null;
}

/** The SSE cursor of a stream that began before the owner had any events: replay starts from its first. */
export const EVENTS_START = "start";

/** The admitted, credential-free configuration a session is resumed with (no handlers, no tokens). */
export interface AdmittedConfig {
  /** Admitted `session.create` params minus per-connection fields (tools, request flags, tokens). */
  readonly params: Record<string, unknown>;
  /** Server-side tool declarations for sessions created without a client (schedules). */
  readonly tools?: readonly Record<string, unknown>[];
  /**
   * What clients registered for the session: tool declarations and handler flags (`requestPermission`, `hooks`, ...).
   * A disconnect never removes them; only the connection that registered something can withdraw it.
   */
  readonly callbacks?: CallbackInventory;
  readonly optionsPatch: Record<string, unknown>;
  /**
   * The caller's requested configuration before admission (no credentials, no per-connection fields), so a placement
   * change can admit it again for the new placement.
   */
  readonly requested?: Record<string, unknown>;
  /** The caller's `session.options.update` patches as requested (merged), re-admitted after a placement change. */
  readonly requestedOptions?: Record<string, unknown>;
}

export interface CallbackInventory {
  readonly tools: readonly Record<string, unknown>[];
  readonly flags: Readonly<Record<string, true>>;
  /**
   * The registration revision of each tool and flag: a client's withdrawal applies only to the registration it made,
   * never to one another client made since.
   */
  readonly revisions?: { readonly tools: Readonly<Record<string, number>>; readonly flags: Readonly<Record<string, number>> };
  readonly revision?: number;
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
  readonly parentSessionId?: string;
  readonly parentIncarnation?: string;
}

const SELECT = `SELECT s.*, a.login, a.name, a.avatar_url FROM core_sessions s LEFT JOIN core_accounts a ON a.id = s.owner_id`;

export class SessionLedger {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
    migrate(db, "core", MIGRATIONS);
    // A placement cutover that was open when the gateway stopped did not commit (a commit moves placement and
    // generation in one transaction): the source placement stays the owner, and the promotion module reconciles its
    // own operation rows against generation/placement. Interrupted creates and deletions are finished by
    // `SessionManager.recover()`.
    const now = new Date().toISOString();
    db.prepare("UPDATE core_sessions SET state = 'idle', updated_at = ? WHERE state = 'promoting'").run(now);
  }

  /** Sessions in one state (startup recovery). */
  byState(state: SessionState): SessionRecord[] {
    const rows = this.#db.prepare(`${SELECT} WHERE s.state = ?`).all(state) as unknown as SessionRow[];
    return rows.map(toRecord);
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
        `INSERT INTO core_sessions (id, owner_id, environment, env_type, placement, state, generation, model, agent, client_name, schedule_id, webhook, network, environment_request, admitted, incarnation, parent_session_id, parent_incarnation, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'creating', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        `inc_${randomBytes(16).toString("hex")}`,
        session.parentSessionId ?? null,
        session.parentIncarnation ?? null,
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

  /** Events for an owner after `afterId` (the SSE `Last-Event-ID`), oldest first; none for an ID it does not know. */
  eventsAfter(ownerId: number, afterId: string, limit = 500): { seq: number; event: PlatformEvent }[] {
    const position = this.eventPosition(ownerId, afterId);
    return position === undefined ? [] : this.eventsAfterPosition(ownerId, position, limit);
  }

  /**
   * Where an SSE cursor points in the owner's events: its stored event, or before all of them for `EVENTS_START`
   * (a stream that began when the owner had none). Undefined for an ID the owner does not have (pruned, or not its).
   */
  eventPosition(ownerId: number, id: string): number | undefined {
    const anchor = this.#db.prepare("SELECT seq FROM core_events WHERE id = ? AND owner_id = ?").get(id, ownerId) as { seq: number } | undefined;
    if (anchor) return anchor.seq;
    return id === EVENTS_START ? 0 : undefined;
  }

  eventsAfterPosition(ownerId: number, position: number, limit = 500): { seq: number; event: PlatformEvent }[] {
    const rows = this.#db.prepare("SELECT seq, body FROM core_events WHERE owner_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(ownerId, position, limit) as { seq: number; body: string }[];
    return rows.map((row) => ({ seq: row.seq, event: JSON.parse(row.body) as PlatformEvent }));
  }

  /** The ID of the owner's newest stored event. */
  latestEventId(ownerId: number): string | undefined {
    const row = this.#db.prepare("SELECT id FROM core_events WHERE owner_id = ? ORDER BY seq DESC LIMIT 1").get(ownerId) as { id: string } | undefined;
    return row?.id;
  }

  /** Keeps the most recent events per deployment bounded. */
  pruneEvents(keep = 10_000): void {
    this.#db.prepare("DELETE FROM core_events WHERE seq <= (SELECT MAX(seq) FROM core_events) - ?").run(keep);
  }

  // --- Operator views (every owner; the operator module decides who may read them) ---------------------------

  /** Sessions of every owner, newest first. Deleted sessions are left out. */
  listAll(query: { ownerId?: number; environment?: string; state?: SessionState; placement?: Placement; idPrefix?: string; limit?: number } = {}): SessionRecord[] {
    const clauses = ["s.state NOT IN ('deleted')"];
    const args: (string | number)[] = [];
    if (query.ownerId !== undefined) {
      clauses.push("s.owner_id = ?");
      args.push(query.ownerId);
    }
    if (query.environment) {
      clauses.push("s.environment = ?");
      args.push(query.environment);
    }
    if (query.state) {
      clauses.push("s.state = ?");
      args.push(query.state);
    }
    if (query.placement) {
      clauses.push("s.placement = ?");
      args.push(query.placement);
    }
    if (query.idPrefix) {
      clauses.push("substr(s.id, 1, ?) = ?");
      args.push(query.idPrefix.length, query.idPrefix);
    }
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
    const rows = this.#db.prepare(`${SELECT} WHERE ${clauses.join(" AND ")} ORDER BY s.updated_at DESC LIMIT ${limit}`).all(...args) as unknown as SessionRow[];
    return rows.map(toRecord);
  }

  /** Session counts by state, placement, environment, and owner (deleted sessions left out). */
  sessionCounts(): { byState: Record<string, number>; byPlacement: Record<string, number>; byEnvironment: Record<string, number>; byOwner: Record<number, number>; total: number } {
    const rows = this.#db
      .prepare("SELECT state, placement, environment, owner_id, COUNT(*) AS n FROM core_sessions WHERE state <> 'deleted' GROUP BY state, placement, environment, owner_id")
      .all() as { state: string; placement: string; environment: string; owner_id: number; n: number }[];
    const counts = { byState: {} as Record<string, number>, byPlacement: {} as Record<string, number>, byEnvironment: {} as Record<string, number>, byOwner: {} as Record<number, number>, total: 0 };
    for (const row of rows) {
      const n = Number(row.n);
      counts.byState[row.state] = (counts.byState[row.state] ?? 0) + n;
      counts.byPlacement[row.placement] = (counts.byPlacement[row.placement] ?? 0) + n;
      counts.byEnvironment[row.environment] = (counts.byEnvironment[row.environment] ?? 0) + n;
      counts.byOwner[row.owner_id] = (counts.byOwner[row.owner_id] ?? 0) + n;
      counts.total += n;
    }
    return counts;
  }

  /** Every GitHub account the gateway has seen, most recently seen first. */
  accounts(): (AccountInfo & { readonly lastSeenAt: string })[] {
    const rows = this.#db.prepare("SELECT * FROM core_accounts ORDER BY last_seen_at DESC").all() as { id: number; login: string; name: string | null; avatar_url: string | null; last_seen_at: string }[];
    return rows.map((row) => ({
      id: Number(row.id),
      login: row.login,
      ...(row.name ? { name: row.name } : {}),
      ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
      lastSeenAt: row.last_seen_at,
    }));
  }

  /** Recent platform events of every owner, newest first. */
  recentEvents(query: { limit?: number; type?: string } = {}): { seq: number; ownerId: number; event: PlatformEvent }[] {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
    const rows = (
      query.type
        ? this.#db.prepare("SELECT seq, owner_id, body FROM core_events WHERE type = ? ORDER BY seq DESC LIMIT ?").all(query.type, limit)
        : this.#db.prepare("SELECT seq, owner_id, body FROM core_events ORDER BY seq DESC LIMIT ?").all(limit)
    ) as { seq: number; owner_id: number; body: string }[];
    return rows.map((row) => ({ seq: Number(row.seq), ownerId: Number(row.owner_id), event: JSON.parse(row.body) as PlatformEvent }));
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
    incarnation: row.incarnation ?? `inc_legacy_${row.id}_${row.created_at}`,
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    ...(row.parent_incarnation ? { parentIncarnation: row.parent_incarnation } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
