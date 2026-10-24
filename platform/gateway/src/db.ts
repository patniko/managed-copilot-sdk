import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Database = DatabaseSync;

/** Opens the gateway ledger. Each module owns its own tables and registers them with `migrate`. */
export function openDatabase(file: string): Database {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (module TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (module, version))",
  );
  return db;
}

/**
 * Applies a module's ordered migrations once. Never edit a shipped migration; append a new one.
 * Prefix table names with the module name (e.g. `sandbox_allocations`) to avoid collisions.
 */
export function migrate(db: Database, module: string, migrations: readonly string[]): void {
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations WHERE module = ?").all(module) as { version: number }[]).map((row) => row.version),
  );
  migrations.forEach((sql, index) => {
    const version = index + 1;
    if (applied.has(version)) return;
    transaction(db, () => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (module, version, applied_at) VALUES (?, ?, ?)").run(module, version, new Date().toISOString());
    });
  });
}

export function transaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
