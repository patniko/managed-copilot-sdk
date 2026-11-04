/** SQLite tables owned by the network module (all prefixed `network_`). */
import { migrate, type Database } from "../../db.js";

export const NETWORK_MIGRATIONS: readonly string[] = [
  `CREATE TABLE network_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE network_vaults (
     id TEXT PRIMARY KEY,
     owner_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     credentials TEXT NOT NULL,
     sealed TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (owner_id, name)
   );
   CREATE TABLE network_sessions (
     session_id TEXT PRIMARY KEY,
     owner_id INTEGER NOT NULL,
     environment TEXT,
     type TEXT NOT NULL,
     requested TEXT,
     policy TEXT NOT NULL,
     vaults TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE network_credentials (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     vault_id TEXT NOT NULL,
     credential_key TEXT NOT NULL,
     placeholder TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL,
     UNIQUE (session_id, vault_id, credential_key)
   );
   CREATE INDEX network_credentials_vault ON network_credentials (vault_id);
   CREATE TABLE network_sandboxes (
     sandbox_id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     credential_hash TEXT NOT NULL,
     address TEXT,
     revision INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX network_sandboxes_session ON network_sandboxes (session_id);
   CREATE TABLE network_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT,
     sandbox_id TEXT,
     at TEXT NOT NULL,
     reason TEXT NOT NULL,
     host TEXT,
     port INTEGER,
     method TEXT,
     path TEXT,
     message TEXT NOT NULL
   );
   CREATE INDEX network_events_session ON network_events (session_id, id);
   CREATE TABLE network_mcp_routes (
     route_id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     name TEXT NOT NULL,
     url TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (session_id, name, url)
   );`,
  // The binding before an uncommitted promotion, so a pre-commit rollback can restore it (spec 9.5).
  `ALTER TABLE network_sessions ADD COLUMN promoted_from TEXT;`,
  // The isolated environment a session was promoted into. The source environment keeps owning the session's grants.
  `ALTER TABLE network_sessions ADD COLUMN promoted_to TEXT;`,
];

export function migrateNetwork(db: Database): void {
  migrate(db, "network", NETWORK_MIGRATIONS);
}

export function getState(db: Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM network_state WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setState(db: Database, key: string, value: string): void {
  db.prepare("INSERT INTO network_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(
    key,
    value,
    new Date().toISOString(),
  );
}
