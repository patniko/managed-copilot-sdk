/**
 * SQLite schema for the durable module. Append new migrations; never edit one that has shipped in a release.
 * Times are epoch milliseconds.
 */
import type { Database } from "../../db.js";

const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

/** Brings data directories from pre-release branch builds (which predate `notified_at`) up to the shipped schema. */
export function upgradeDurableSchema(db: Database): void {
  const columns = db.prepare("PRAGMA table_info(durable_actions)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "notified_at")) db.exec("ALTER TABLE durable_actions ADD COLUMN notified_at INTEGER");
}

export const DURABLE_MIGRATIONS: readonly string[] = [
  // 1: durable action ledger (spec section 12, "One owner for each action").
  `CREATE TABLE durable_actions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    kind TEXT NOT NULL,
    request_id TEXT NOT NULL,
    tool_call_id TEXT,
    turn_id TEXT,
    tool TEXT,
    provider_id TEXT,
    agent_id TEXT,
    arguments TEXT,
    event TEXT NOT NULL,
    generation INTEGER NOT NULL,
    state TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    claim_seq INTEGER NOT NULL DEFAULT 0,
    claim_token_hash TEXT,
    claimed_by TEXT,
    responder_type TEXT,
    live_connection TEXT,
    lease_expires_at INTEGER,
    deadline_at INTEGER NOT NULL,
    result TEXT,
    error TEXT,
    result_hash TEXT,
    reason TEXT,
    forwarded INTEGER NOT NULL DEFAULT 0,
    forward_attempts INTEGER NOT NULL DEFAULT 0,
    next_forward_at INTEGER,
    notified_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    UNIQUE (session_id, kind, request_id)
  );
  CREATE INDEX durable_actions_session ON durable_actions (session_id, state);
  CREATE INDEX durable_actions_state ON durable_actions (state, lease_expires_at);
  CREATE INDEX durable_actions_live ON durable_actions (live_connection);`,

  // 2: webhook outbox (spec section 12, "Handle a webhook").
  `CREATE TABLE durable_webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    session_id TEXT,
    environment TEXT,
    owner_id INTEGER,
    event TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_status INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    delivered_at INTEGER,
    UNIQUE (webhook, event_id)
  );
  CREATE INDEX durable_webhook_deliveries_due ON durable_webhook_deliveries (state, next_attempt_at);`,

  // 3: schedules and their runs (spec section 13).
  `CREATE TABLE durable_schedules (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    owner_login TEXT NOT NULL,
    name TEXT NOT NULL,
    cron TEXT,
    run_at INTEGER,
    time_zone TEXT NOT NULL,
    environment TEXT NOT NULL,
    prompt TEXT NOT NULL,
    state TEXT NOT NULL,
    paused_reason TEXT,
    created_by TEXT NOT NULL,
    target_session_id TEXT,
    origin_session_id TEXT,
    session_config TEXT,
    webhook TEXT,
    next_run_at INTEGER,
    definition_hash TEXT NOT NULL,
    apphost_key TEXT,
    origin_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE UNIQUE INDEX durable_schedules_owner_name ON durable_schedules (owner_id, name) WHERE deleted_at IS NULL;
  CREATE UNIQUE INDEX durable_schedules_origin ON durable_schedules (owner_id, origin_key) WHERE origin_key IS NOT NULL;
  CREATE INDEX durable_schedules_due ON durable_schedules (state, next_run_at);
  CREATE TABLE durable_schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    occurrence_id TEXT NOT NULL UNIQUE,
    trigger TEXT NOT NULL,
    scheduled_for INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    session_mode TEXT NOT NULL,
    session_id TEXT,
    session_created INTEGER NOT NULL DEFAULT 0,
    input_state TEXT NOT NULL DEFAULT 'none',
    input_started_at INTEGER,
    message_id TEXT,
    consumed INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX durable_schedule_runs_schedule ON durable_schedule_runs (schedule_id, scheduled_for);
  CREATE INDEX durable_schedule_runs_status ON durable_schedule_runs (status);`,

  // 4: background credentials (spec section 2, "Work that continues without you").
  `CREATE TABLE durable_credentials (
    account_id INTEGER PRIMARY KEY,
    login TEXT NOT NULL,
    name TEXT,
    avatar_url TEXT,
    sealed_token TEXT,
    state TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_verified_at INTEGER
  );`,

  // 5: a runtime message belongs to at most one run (schedule input reconciliation claims it atomically). Ledgers
  // written before this rule may hold duplicates: every run after the first loses the assignment (named in its
  // reason, for audit), and one still in progress ends as needs_reconciliation rather than ever running again.
  // (The repair step joined this migration before any release; wherever the index alone applied, it was a no-op.)
  `UPDATE durable_schedule_runs
      SET reason = 'Runtime message ' || message_id || ' was also attributed to an earlier run of this session' || COALESCE('; ' || reason, ''),
          status = CASE WHEN status IN ('queued', 'running', 'waiting') THEN 'needs_reconciliation' ELSE status END,
          completed_at = CASE WHEN status IN ('queued', 'running', 'waiting') THEN ${NOW_MS} ELSE completed_at END,
          updated_at = ${NOW_MS},
          message_id = NULL
    WHERE message_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM durable_schedule_runs AS earlier
         WHERE earlier.session_id = durable_schedule_runs.session_id
           AND earlier.message_id = durable_schedule_runs.message_id
           AND earlier.rowid < durable_schedule_runs.rowid);
  CREATE UNIQUE INDEX durable_schedule_runs_message ON durable_schedule_runs (session_id, message_id) WHERE message_id IS NOT NULL;`,
];
