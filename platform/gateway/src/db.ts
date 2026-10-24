import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Database = DatabaseSync;

const depth = new WeakMap<Database, number>();

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

/**
 * Runs `fn` atomically. Nested calls use savepoints. `fn` must be synchronous: SQLite transactions cannot span
 * `await`, so a returned promise is rejected (and rolled back) rather than committed early.
 */
export function transaction<T>(db: Database, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const savepoint = `sp_${level}`;
  db.exec(level === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
  depth.set(db, level + 1);
  let result: T;
  try {
    result = fn();
    if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
      throw new TypeError("transaction() callbacks must be synchronous; do not return a promise");
    }
  } catch (error) {
    depth.set(db, level);
    try {
      db.exec(level === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    } catch {
      // Keep the original error; a failed rollback must not mask it.
    }
    throw error;
  }
  depth.set(db, level);
  if (level === 0) {
    try {
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The commit error is the one that matters.
      }
      throw error;
    }
  } else {
    db.exec(`RELEASE ${savepoint}`);
  }
  return result;
}
