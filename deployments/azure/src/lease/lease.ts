// Single-writer lease for a gateway data directory shared through network storage.
//
// Container Apps can briefly run two gateway replicas against one volume: Single revision mode keeps the old revision
// until the new one is ready, and platform maintenance pre-warms replacement replicas even at maxReplicas 1. The
// lease is an exclusive SQLite lock (a POSIX byte-range lock on the lease file) held for the life of the holder's
// connection, so exactly one supervisor runs a gateway at a time. It needs a filesystem whose byte-range locks work
// across hosts (local disk, Azure Files NFS). Azure Files SMB rejects the lock upgrade, which surfaces as a
// LeaseStorageError instead of a silent second writer.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** SQLite result codes that mean "another connection holds the lock". */
const BUSY_CODES = new Set([5 /* SQLITE_BUSY */, 6 /* SQLITE_LOCKED */]);

export interface LeaseIdentity {
  /** Who holds the lease, for logs (revision and replica name). */
  readonly holder: string;
  /** Deployment stamp: a newer stamp may ask the holder to hand over (see the supervisor). */
  readonly stamp: string;
}

/** The lease file could not be locked or written for a reason other than another holder. */
export class LeaseStorageError extends Error {
  override readonly name = "LeaseStorageError";
  constructor(file: string, cause: unknown) {
    super(
      `Cannot take the gateway's single-writer lease on ${file}: ${describe(cause)}. The data directory must be on storage ` +
        "with working POSIX byte-range locks (a local disk or Azure Files NFS, not Azure Files SMB).",
      { cause },
    );
  }
}

/** The lease was lost while held: the lock or the lease row no longer belongs to this holder. */
export class LeaseLostError extends Error {
  override readonly name = "LeaseLostError";
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isBusy(error: unknown): boolean {
  const candidate = error as { errcode?: unknown; message?: unknown } | undefined;
  if (typeof candidate?.errcode === "number" && BUSY_CODES.has(candidate.errcode & 0xff)) return true;
  return typeof candidate?.message === "string" && /database is locked|database table is locked/i.test(candidate.message);
}

export class Lease {
  readonly file: string;
  readonly generation: number;
  readonly identity: LeaseIdentity;
  #db: DatabaseSync | undefined;

  private constructor(file: string, db: DatabaseSync, generation: number, identity: LeaseIdentity) {
    this.file = file;
    this.#db = db;
    this.generation = generation;
    this.identity = identity;
  }

  /**
   * Takes the lease if nobody holds it. Returns undefined when another process holds it; throws LeaseStorageError
   * when the storage cannot provide the lock at all.
   */
  static tryAcquire(file: string, identity: LeaseIdentity, now: Date = new Date()): Lease | undefined {
    mkdirSync(dirname(file), { recursive: true });
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file);
    } catch (error) {
      throw new LeaseStorageError(file, error);
    }
    try {
      // Rollback journal (the default) and an exclusive locking mode: the lock is taken once and kept until close,
      // so there is no per-transaction lock upgrade over the network.
      db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE;");
      db.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      db.close();
      if (isBusy(error)) return undefined;
      throw new LeaseStorageError(file, error);
    }
    try {
      db.exec(
        "CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, holder TEXT NOT NULL, " +
          "stamp TEXT NOT NULL, acquired_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL)",
      );
      const row = db.prepare("SELECT generation FROM lease WHERE id = 1").get() as { generation: number } | undefined;
      const generation = (row?.generation ?? 0) + 1;
      const at = now.toISOString();
      db.prepare(
        "INSERT INTO lease (id, generation, holder, stamp, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, holder = excluded.holder, stamp = excluded.stamp, " +
          "acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at",
      ).run(generation, identity.holder, identity.stamp, at, at);
      db.exec("COMMIT");
      return new Lease(file, db, generation, identity);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The original error matters.
      }
      db.close();
      throw new LeaseStorageError(file, error);
    }
  }

  get held(): boolean {
    return this.#db !== undefined;
  }

  /**
   * Proves the lease is still ours with a write through the held lock. A lock the NFS client lost turns into an I/O
   * error, and a row rewritten by another holder matches no row; both throw LeaseLostError.
   */
  heartbeat(now: Date = new Date()): void {
    const db = this.#db;
    if (!db) throw new LeaseLostError("The lease was already released.");
    let changes: number | bigint;
    try {
      ({ changes } = db.prepare("UPDATE lease SET heartbeat_at = ? WHERE id = 1 AND generation = ?").run(now.toISOString(), this.generation));
    } catch (error) {
      throw new LeaseLostError(`The lease could not be renewed: ${describe(error)}`, { cause: error });
    }
    if (Number(changes) !== 1) throw new LeaseLostError(`Another holder replaced lease generation ${this.generation}.`);
  }

  /** Releases the lock. Safe to repeat. */
  release(): void {
    const db = this.#db;
    this.#db = undefined;
    try {
      db?.close();
    } catch {
      // Closing releases the lock even when the final write-back fails; nothing else to do.
    }
  }
}
