import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ActivityItem, WorkOrder } from "../shared/types.js";

/** A published artifact version captured from the platform, with its content when the factory keeps it. */
export interface StoredArtifact {
  readonly workOrderId: string;
  readonly stationId: string;
  /** Path relative to `/workspace/outputs`. */
  readonly path: string;
  readonly version: number;
  readonly round: number;
  readonly size: number;
  readonly digest: string;
  readonly contentType: string;
  readonly publishedAt: string;
  /** Text content; undefined for binary or oversized files. */
  readonly content?: string;
}

export type StoredArtifactMeta = Omit<StoredArtifact, "content"> & { readonly hasContent: boolean };

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS factory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS factory_work_orders (
     id TEXT PRIMARY KEY,
     number INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     data TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS factory_activity (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     work_order_id TEXT NOT NULL,
     id TEXT NOT NULL,
     station_id TEXT NOT NULL,
     data TEXT NOT NULL,
     UNIQUE (work_order_id, id)
   );
   CREATE INDEX IF NOT EXISTS factory_activity_by_order ON factory_activity (work_order_id, seq);
   CREATE TABLE IF NOT EXISTS factory_artifacts (
     work_order_id TEXT NOT NULL,
     station_id TEXT NOT NULL,
     path TEXT NOT NULL,
     version INTEGER NOT NULL,
     round INTEGER NOT NULL,
     size INTEGER NOT NULL,
     digest TEXT NOT NULL,
     content_type TEXT NOT NULL,
     published_at TEXT NOT NULL,
     content TEXT,
     PRIMARY KEY (work_order_id, station_id, path, version)
   );`,
];

/** The factory's own records (work orders, activity, captured artifacts). Sessions themselves live in the platform. */
export class FactoryStore {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#db.exec("CREATE TABLE IF NOT EXISTS factory_schema (version INTEGER NOT NULL)");
    const row = this.#db.prepare("SELECT MAX(version) AS version FROM factory_schema").get() as { version: number | null } | undefined;
    const applied = row?.version ?? 0;
    MIGRATIONS.slice(applied).forEach((sql, index) => {
      this.#db.exec(sql);
      this.#db.prepare("INSERT INTO factory_schema (version) VALUES (?)").run(applied + index + 1);
    });
  }

  close(): void {
    this.#db.close();
  }

  nextWorkOrderNumber(): number {
    const row = this.#db.prepare("SELECT value FROM factory_meta WHERE key = 'work_order_number'").get() as { value: string } | undefined;
    const next = (row ? Number(row.value) : 0) + 1;
    this.#db.prepare("INSERT INTO factory_meta (key, value) VALUES ('work_order_number', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(next));
    return next;
  }

  saveWorkOrder(workOrder: WorkOrder): void {
    this.#db
      .prepare(
        "INSERT INTO factory_work_orders (id, number, created_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      )
      .run(workOrder.id, workOrder.number, workOrder.createdAt, JSON.stringify(workOrder));
  }

  getWorkOrder(id: string): WorkOrder | undefined {
    const row = this.#db.prepare("SELECT data FROM factory_work_orders WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as WorkOrder) : undefined;
  }

  /** Newest first. */
  listWorkOrders(): WorkOrder[] {
    const rows = this.#db.prepare("SELECT data FROM factory_work_orders ORDER BY number DESC").all() as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as WorkOrder);
  }

  deleteWorkOrder(id: string): void {
    this.#db.prepare("DELETE FROM factory_activity WHERE work_order_id = ?").run(id);
    this.#db.prepare("DELETE FROM factory_artifacts WHERE work_order_id = ?").run(id);
    this.#db.prepare("DELETE FROM factory_work_orders WHERE id = ?").run(id);
  }

  /** Forgets a station's captured artifacts (its sandbox was replaced, so platform versions restart). */
  deleteStationArtifacts(workOrderId: string, stationId: string): void {
    this.#db.prepare("DELETE FROM factory_artifacts WHERE work_order_id = ? AND station_id = ?").run(workOrderId, stationId);
  }

  /** Inserts or replaces an activity item; a replaced item keeps its original position. */
  upsertActivity(item: ActivityItem): void {
    this.#db
      .prepare(
        "INSERT INTO factory_activity (work_order_id, id, station_id, data) VALUES (?, ?, ?, ?) ON CONFLICT(work_order_id, id) DO UPDATE SET data = excluded.data",
      )
      .run(item.workOrderId, item.id, item.stationId, JSON.stringify(item));
  }

  listActivity(workOrderId: string, stationId?: string): ActivityItem[] {
    const rows = (
      stationId
        ? this.#db.prepare("SELECT data FROM factory_activity WHERE work_order_id = ? AND station_id = ? ORDER BY seq").all(workOrderId, stationId)
        : this.#db.prepare("SELECT data FROM factory_activity WHERE work_order_id = ? ORDER BY seq").all(workOrderId)
    ) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as ActivityItem);
  }

  hasArtifact(workOrderId: string, stationId: string, path: string, version: number): boolean {
    return (
      this.#db
        .prepare("SELECT 1 AS found FROM factory_artifacts WHERE work_order_id = ? AND station_id = ? AND path = ? AND version = ?")
        .get(workOrderId, stationId, path, version) !== undefined
    );
  }

  putArtifact(artifact: StoredArtifact): void {
    this.#db
      .prepare(
        `INSERT INTO factory_artifacts (work_order_id, station_id, path, version, round, size, digest, content_type, published_at, content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(work_order_id, station_id, path, version) DO UPDATE SET content = excluded.content`,
      )
      .run(
        artifact.workOrderId,
        artifact.stationId,
        artifact.path,
        artifact.version,
        artifact.round,
        artifact.size,
        artifact.digest,
        artifact.contentType,
        artifact.publishedAt,
        artifact.content ?? null,
      );
  }

  listArtifacts(workOrderId: string): StoredArtifactMeta[] {
    const rows = this.#db
      .prepare(
        `SELECT station_id, path, version, round, size, digest, content_type, published_at, content IS NOT NULL AS has_content
         FROM factory_artifacts WHERE work_order_id = ? ORDER BY station_id, path, version DESC`,
      )
      .all(workOrderId) as {
      station_id: string;
      path: string;
      version: number;
      round: number;
      size: number;
      digest: string;
      content_type: string;
      published_at: string;
      has_content: number;
    }[];
    return rows.map((row) => ({
      workOrderId,
      stationId: row.station_id,
      path: row.path,
      version: row.version,
      round: row.round,
      size: row.size,
      digest: row.digest,
      contentType: row.content_type,
      publishedAt: row.published_at,
      hasContent: row.has_content === 1,
    }));
  }

  /** The requested version, or the newest when `version` is omitted. */
  getArtifact(workOrderId: string, stationId: string, path: string, version?: number): StoredArtifact | undefined {
    const row = (
      version === undefined
        ? this.#db
            .prepare("SELECT * FROM factory_artifacts WHERE work_order_id = ? AND station_id = ? AND path = ? ORDER BY version DESC LIMIT 1")
            .get(workOrderId, stationId, path)
        : this.#db
            .prepare("SELECT * FROM factory_artifacts WHERE work_order_id = ? AND station_id = ? AND path = ? AND version = ?")
            .get(workOrderId, stationId, path, version)
    ) as
      | {
          station_id: string;
          path: string;
          version: number;
          round: number;
          size: number;
          digest: string;
          content_type: string;
          published_at: string;
          content: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      workOrderId,
      stationId: row.station_id,
      path: row.path,
      version: row.version,
      round: row.round,
      size: row.size,
      digest: row.digest,
      contentType: row.content_type,
      publishedAt: row.published_at,
      ...(row.content !== null ? { content: row.content } : {}),
    };
  }

  /** Newest version of every file a station published, with content. */
  latestArtifacts(workOrderId: string, stationId: string): StoredArtifact[] {
    const metas = this.listArtifacts(workOrderId).filter((meta) => meta.stationId === stationId);
    const seen = new Set<string>();
    const result: StoredArtifact[] = [];
    for (const meta of metas) {
      if (seen.has(meta.path)) continue;
      seen.add(meta.path);
      const artifact = this.getArtifact(workOrderId, stationId, meta.path, meta.version);
      if (artifact) result.push(artifact);
    }
    return result;
  }
}
