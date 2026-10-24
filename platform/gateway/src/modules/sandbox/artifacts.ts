// Turn-scoped artifact publication (spec section 6). At each completed turn the gateway snapshots the bounded regular
// files under /workspace/outputs into immutable, content-addressed storage under the data directory and records a
// manifest. Unchanged files keep their version; changed files get a new one. Interrupted or failing publications are
// recorded as `failed`, never as an empty success.
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, promises as fs } from "node:fs";
import { extname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ManagedCopilotError, type ArtifactInfo, type PublicationResult } from "@managed-copilot/protocol";
import { transaction, type Database } from "../../db.js";
import type { Logger } from "../../log.js";
import type { SandboxAgentClient } from "./agent-client.js";
import type { ArtifactsService, SandboxEventsPort } from "./contract.js";

const CONTENT_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "application/jsonl",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/plain",
  ".py": "text/x-python",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".diff": "text/x-diff",
  ".patch": "text/x-diff",
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

const DELETED = "The session was deleted before its outputs were published.";

type TurnOutcome = "completed" | "cancelled" | "failed";

interface ArtifactRow {
  id: string;
  session_id: string;
  path: string;
  version: number;
  turn_id: string;
  size: number;
  digest: string;
  content_type: string | null;
  state: string;
  published_at: string | null;
}

interface PublicationRow {
  session_id: string;
  turn_id: string;
  state: "pending" | "published" | "failed";
  error: string | null;
  artifact_ids: string | null;
}

interface TurnRow {
  turn_id: string;
  seq: number;
  state: "running" | TurnOutcome;
}

function toInfo(row: ArtifactRow): ArtifactInfo {
  return {
    id: row.id,
    path: row.path,
    size: row.size,
    digest: `sha256:${row.digest}`,
    ...(row.content_type ? { contentType: row.content_type } : {}),
    turnId: row.turn_id,
    version: row.version,
    state: row.state as ArtifactInfo["state"],
    ...(row.published_at ? { publishedAt: row.published_at } : {}),
  };
}

export interface ArtifactServiceOptions {
  readonly db: Database;
  readonly dataDir: string;
  readonly log: Logger;
  /** The session's sandbox agent (ensures it is running). */
  agentFor(sessionId: string): Promise<SandboxAgentClient>;
  /** Marks the session busy while publication runs, so idle stop waits for it. */
  track<T>(sessionId: string, work: Promise<T>): Promise<T>;
  ownerOf(sessionId: string): number | undefined;
  /** True when the session's sandbox is being deleted or is gone (publication then records that, not a transport error). */
  sessionGone?(sessionId: string): boolean;
  events(): SandboxEventsPort | undefined;
}

export class ArtifactService implements ArtifactsService {
  readonly #options: ArtifactServiceOptions;
  readonly #waiters = new Map<string, Set<() => void>>();
  /** Publications run one at a time per session, in turn order, so versions and blob cleanup never race. */
  readonly #chains = new Map<string, Promise<void>>();

  constructor(options: ArtifactServiceOptions) {
    this.#options = options;
  }

  #dir(sessionId: string): string {
    return join(this.#options.dataDir, "artifacts", sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
  }

  #notify(sessionId: string, turnId: string): void {
    const key = `${sessionId}\0${turnId}`;
    const waiters = this.#waiters.get(key);
    if (!waiters) return;
    this.#waiters.delete(key);
    for (const wake of waiters) wake();
  }

  // Turn tracking ------------------------------------------------------------------------------------------------

  /** Records a root-agent user turn (the turn ID is the user message's `messageId`). */
  turnStarted(sessionId: string, turnId: string): void {
    const db = this.#options.db;
    const exists = db.prepare("SELECT 1 FROM sandbox_turns WHERE session_id = ? AND turn_id = ?").get(sessionId, turnId);
    if (exists) return;
    const next = (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM sandbox_turns WHERE session_id = ?").get(sessionId) as { seq: number }).seq;
    db.prepare("INSERT INTO sandbox_turns (session_id, turn_id, seq, state, started_at) VALUES (?, ?, ?, 'running', ?)").run(sessionId, turnId, next, new Date().toISOString());
  }

  /** Completes every running turn of the session and returns their IDs (oldest first). */
  turnsCompleted(sessionId: string, outcome: TurnOutcome): string[] {
    const db = this.#options.db;
    const running = (db.prepare("SELECT turn_id FROM sandbox_turns WHERE session_id = ? AND state = 'running' ORDER BY seq").all(sessionId) as { turn_id: string }[]).map((row) => row.turn_id);
    if (running.length === 0) return [];
    const now = new Date().toISOString();
    transaction(db, () => {
      for (const turnId of running) {
        db.prepare("UPDATE sandbox_turns SET state = ?, completed_at = ? WHERE session_id = ? AND turn_id = ?").run(outcome, now, sessionId, turnId);
        db.prepare("INSERT OR IGNORE INTO sandbox_publications (session_id, turn_id, state, created_at) VALUES (?, ?, 'pending', ?)").run(sessionId, turnId, now);
      }
    });
    return running;
  }

  /** Publishes the outputs of completed turns (or records why they were not published). */
  publish(sessionId: string, turnIds: readonly string[], outcome: TurnOutcome): Promise<void> {
    const previous = this.#chains.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.#publish(sessionId, turnIds, outcome));
    this.#chains.set(sessionId, next);
    const cleanup = () => {
      if (this.#chains.get(sessionId) === next) this.#chains.delete(sessionId);
    };
    next.then(cleanup, cleanup);
    return this.#options.track(sessionId, next);
  }

  /**
   * Turns still running when the gateway (re)starts lost their completion event with the old connection; their
   * outputs are not labeled successful. Marks them failed so waiters get an explicit answer.
   */
  failInterruptedTurns(): number {
    const db = this.#options.db;
    const rows = db.prepare("SELECT session_id, turn_id FROM sandbox_turns WHERE state = 'running'").all() as { session_id: string; turn_id: string }[];
    const pending = db.prepare("SELECT session_id, turn_id FROM sandbox_publications WHERE state = 'pending'").all() as { session_id: string; turn_id: string }[];
    if (rows.length === 0 && pending.length === 0) return 0;
    const now = new Date().toISOString();
    transaction(db, () => {
      for (const row of rows) {
        db.prepare("UPDATE sandbox_turns SET state = 'failed', completed_at = ? WHERE session_id = ? AND turn_id = ?").run(now, row.session_id, row.turn_id);
        db.prepare(
          "INSERT INTO sandbox_publications (session_id, turn_id, state, error, created_at, completed_at) VALUES (?, ?, 'failed', ?, ?, ?) ON CONFLICT (session_id, turn_id) DO UPDATE SET state = 'failed', error = excluded.error, completed_at = excluded.completed_at",
        ).run(row.session_id, row.turn_id, "The gateway restarted while this turn was running, so its outputs were not published.", now, now);
      }
      // A publication in flight when the gateway stopped had no immutable checkpoint to resume from.
      for (const row of pending) {
        db.prepare("UPDATE sandbox_publications SET state = 'failed', error = ?, completed_at = ? WHERE session_id = ? AND turn_id = ? AND state = 'pending'").run(
          "The gateway restarted while this turn's outputs were being published, so they were not published. Run another turn to publish the current outputs.",
          now,
          row.session_id,
          row.turn_id,
        );
      }
    });
    return rows.length + pending.length;
  }

  async #publish(sessionId: string, turnIds: readonly string[], outcome: TurnOutcome): Promise<void> {
    const db = this.#options.db;
    const finish = (state: "published" | "failed", error: string | null, artifactIds: readonly string[]) => {
      const now = new Date().toISOString();
      for (const turnId of turnIds) {
        db.prepare("UPDATE sandbox_publications SET state = ?, error = ?, artifact_ids = ?, completed_at = ? WHERE session_id = ? AND turn_id = ?").run(state, error, JSON.stringify(artifactIds), now, sessionId, turnId);
      }
    };
    if (outcome !== "completed") {
      finish("failed", outcome === "cancelled" ? "The turn was cancelled before it completed, so its outputs were not published." : "The turn ended with an error, so its outputs were not published.", []);
      for (const turnId of turnIds) this.#notify(sessionId, turnId);
      return;
    }
    const turnId = turnIds[turnIds.length - 1]!;
    if (this.#options.sessionGone?.(sessionId)) {
      finish("failed", DELETED, []);
      for (const id of turnIds) this.#notify(sessionId, id);
      return;
    }
    const lastSeq = (db.prepare("SELECT seq FROM sandbox_turns WHERE session_id = ? AND turn_id = ?").get(sessionId, turnId) as { seq: number } | undefined)?.seq ?? 0;
    const dir = this.#dir(sessionId);
    const created: string[] = [];
    try {
      const agent = await this.#options.agentFor(sessionId);
      const manifest = await agent.outputsManifest();
      // The manifest fixes the bytes (downloads are verified against it). If a later turn had already started, it may
      // have changed outputs/ first, so those bytes cannot be attributed to this turn.
      if (db.prepare("SELECT 1 FROM sandbox_turns WHERE session_id = ? AND seq > ? LIMIT 1").get(sessionId, lastSeq)) {
        throw new ManagedCopilotError(
          "publication_failed",
          "Another turn started before this turn's outputs were captured, so they cannot be attributed to this turn. The current outputs are published when the later turn completes.",
        );
      }
      if (manifest.rejected.length > 0) {
        const listed = manifest.rejected.slice(0, 5).map((entry) => `outputs/${entry.path} (${entry.reason})`).join(", ");
        throw new ManagedCopilotError("publication_failed", `${manifest.rejected.length} output file${manifest.rejected.length === 1 ? "" : "s"} could not be published: ${listed}${manifest.rejected.length > 5 ? ", …" : ""}. Remove or fix them and run another turn.`);
      }
      await fs.mkdir(dir, { recursive: true });
      const planned: { path: string; size: number; digest: string; reuse?: ArtifactRow; version: number }[] = [];
      for (const file of manifest.files) {
        const latest = db.prepare("SELECT * FROM sandbox_artifacts WHERE session_id = ? AND path = ? ORDER BY version DESC LIMIT 1").get(sessionId, file.path) as ArtifactRow | undefined;
        if (latest && latest.digest === file.sha256 && latest.state === "published") {
          planned.push({ path: file.path, size: file.size, digest: file.sha256, reuse: latest, version: latest.version });
          continue;
        }
        const blob = join(dir, file.sha256);
        if (!existsSync(blob)) {
          const temp = join(dir, `.incoming-${randomBytes(8).toString("hex")}`);
          const hash = createHash("sha256");
          let size = 0;
          const body = await agent.readOutput(file.path);
          body.on("data", (chunk: Buffer) => {
            hash.update(chunk);
            size += chunk.length;
          });
          try {
            await pipeline(body, createWriteStream(temp, { flags: "wx" }));
          } catch (error) {
            await fs.rm(temp, { force: true });
            throw error;
          }
          const digest = hash.digest("hex");
          if (digest !== file.sha256 || size !== file.size) {
            await fs.rm(temp, { force: true });
            throw new ManagedCopilotError("publication_failed", `outputs/${file.path} changed while it was being published. Wait for writers to finish, then run another turn.`);
          }
          await fs.rename(temp, blob);
          created.push(blob);
        }
        planned.push({ path: file.path, size: file.size, digest: file.sha256, version: (latest?.version ?? 0) + 1 });
      }
      const now = new Date().toISOString();
      const artifactIds: string[] = [];
      const published: ArtifactInfo[] = [];
      const fresh: ArtifactInfo[] = [];
      transaction(db, () => {
        // A session deleted while its outputs were being downloaded must not regain rows.
        if (!db.prepare("SELECT 1 FROM sandbox_publications WHERE session_id = ? AND turn_id = ?").get(sessionId, turnId)) {
          throw new ManagedCopilotError("not_found", "The session was deleted while its outputs were being published.");
        }
        for (const item of planned) {
          if (item.reuse) {
            artifactIds.push(item.reuse.id);
            published.push(toInfo(item.reuse));
            continue;
          }
          const row: ArtifactRow = {
            id: `art_${randomBytes(12).toString("hex")}`,
            session_id: sessionId,
            path: item.path,
            version: item.version,
            turn_id: turnId,
            size: item.size,
            digest: item.digest,
            content_type: contentTypeFor(item.path),
            state: "published",
            published_at: now,
          };
          db.prepare(
            "INSERT INTO sandbox_artifacts (id, session_id, path, version, turn_id, size, digest, content_type, state, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(row.id, row.session_id, row.path, row.version, row.turn_id, row.size, row.digest, row.content_type, row.state, row.published_at, now);
          artifactIds.push(row.id);
          published.push(toInfo(row));
          fresh.push(toInfo(row));
        }
        finish("published", null, artifactIds);
      });
      created.length = 0;
      this.#options.log.info("Published turn outputs", { sessionId, turnId, artifacts: published.length, newVersions: fresh.length });
      const ownerId = this.#options.ownerOf(sessionId);
      // The event announces new versions only; a turn that changed nothing under outputs/ stays quiet.
      if (ownerId !== undefined && fresh.length > 0) {
        try {
          this.#options.events()?.publish(
            {
              id: `evt_${randomBytes(12).toString("hex")}`,
              type: "artifact.published",
              createdAt: now,
              sessionId,
              data: { turnId, artifacts: fresh.map((artifact) => ({ id: artifact.id, path: artifact.path, version: artifact.version, size: artifact.size, digest: artifact.digest })) },
            },
            { ownerId },
          );
        } catch (error) {
          this.#options.log.warn("Could not publish the artifact.published event", { sessionId, error: (error as Error).message });
        }
      }
    } catch (error) {
      // Remove only blobs this attempt stored that no committed version references.
      for (const blob of created) {
        const digest = blob.slice(blob.length - 64);
        const referenced = db.prepare("SELECT 1 FROM sandbox_artifacts WHERE session_id = ? AND digest = ? LIMIT 1").get(sessionId, digest);
        if (!referenced) await fs.rm(blob, { force: true }).catch(() => undefined);
      }
      const message =
        this.#options.sessionGone?.(sessionId) === true
          ? DELETED
          : error instanceof ManagedCopilotError
            ? error.message
            : `Publishing the turn's outputs failed: ${(error as Error).message}`;
      if (message === DELETED) this.#options.log.info("Skipped publishing outputs of a session that is being deleted", { sessionId, turnId });
      else this.#options.log.warn("Publication failed", { sessionId, turnId, error: message });
      finish("failed", message, []);
    } finally {
      for (const id of turnIds) this.#notify(sessionId, id);
    }
  }

  // Reads --------------------------------------------------------------------------------------------------------

  list(sessionId: string, options: { readonly versions?: "latest" | "all" } = {}): ArtifactInfo[] {
    const db = this.#options.db;
    const rows =
      options.versions === "all"
        ? (db.prepare("SELECT * FROM sandbox_artifacts WHERE session_id = ? AND state = 'published' ORDER BY path, version").all(sessionId) as unknown as ArtifactRow[])
        : (db
            .prepare(
              "SELECT a.* FROM sandbox_artifacts a JOIN (SELECT path, MAX(version) AS version FROM sandbox_artifacts WHERE session_id = ? AND state = 'published' GROUP BY path) latest ON a.path = latest.path AND a.version = latest.version WHERE a.session_id = ? ORDER BY a.path",
            )
            .all(sessionId, sessionId) as unknown as ArtifactRow[]);
    return rows.map(toInfo);
  }

  #turn(sessionId: string, turnId: string | undefined): TurnRow {
    const db = this.#options.db;
    if (turnId) {
      const row = db.prepare("SELECT turn_id, seq, state FROM sandbox_turns WHERE session_id = ? AND turn_id = ?").get(sessionId, turnId) as TurnRow | undefined;
      if (!row) throw new ManagedCopilotError("not_found", `Turn ${turnId} was not found in this session.`, { turnId });
      return row;
    }
    const completed = db.prepare("SELECT turn_id, seq, state FROM sandbox_turns WHERE session_id = ? AND state != 'running' ORDER BY seq DESC LIMIT 1").get(sessionId) as TurnRow | undefined;
    if (completed) return completed;
    const running = db.prepare("SELECT turn_id, seq, state FROM sandbox_turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(sessionId) as TurnRow | undefined;
    if (running) return running;
    throw new ManagedCopilotError("not_found", "This session has not completed a turn yet; send a prompt before waiting for its outputs.");
  }

  async waitForPublication(sessionId: string, options: { readonly turnId?: string; readonly timeoutMs?: number } = {}): Promise<PublicationResult> {
    const turn = this.#turn(sessionId, options.turnId);
    const deadline = Date.now() + Math.max(0, options.timeoutMs ?? 60_000);
    const key = `${sessionId}\0${turn.turn_id}`;
    for (;;) {
      const publication = this.#options.db.prepare("SELECT * FROM sandbox_publications WHERE session_id = ? AND turn_id = ?").get(sessionId, turn.turn_id) as PublicationRow | undefined;
      if (publication?.state === "published") {
        const ids = JSON.parse(publication.artifact_ids ?? "[]") as string[];
        const rows = ids.map((id) => this.#options.db.prepare("SELECT * FROM sandbox_artifacts WHERE id = ?").get(id) as ArtifactRow | undefined).filter((row): row is ArtifactRow => Boolean(row));
        return { turnId: turn.turn_id, state: "published", artifacts: rows.map(toInfo) };
      }
      if (publication?.state === "failed") {
        throw new ManagedCopilotError("publication_failed", publication.error ?? "Publishing the turn's outputs failed.", { turnId: turn.turn_id });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ManagedCopilotError("timeout", `The outputs of turn ${turn.turn_id} are not published yet${publication ? "" : " (the turn is still running)"}.`, { turnId: turn.turn_id, state: publication?.state ?? "running" });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(remaining, 2000));
        let waiters = this.#waiters.get(key);
        if (!waiters) {
          waiters = new Set();
          this.#waiters.set(key, waiters);
        }
        waiters.add(done);
        function done() {
          clearTimeout(timer);
          waiters!.delete(done);
          resolve();
        }
      });
    }
  }

  async open(sessionId: string, artifactId: string): Promise<{ info: ArtifactInfo; body: Readable }> {
    const row = this.#options.db.prepare("SELECT * FROM sandbox_artifacts WHERE id = ? AND session_id = ? AND state = 'published'").get(artifactId, sessionId) as ArtifactRow | undefined;
    if (!row) throw new ManagedCopilotError("not_found", `Artifact ${artifactId} was not found in this session.`, { artifactId });
    const blob = join(this.#dir(sessionId), row.digest);
    if (!existsSync(blob)) throw new ManagedCopilotError("internal", `Artifact ${artifactId} is recorded but its stored content is missing.`, { artifactId });
    return { info: toInfo(row), body: createReadStream(blob) };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const db = this.#options.db;
    transaction(db, () => {
      db.prepare("DELETE FROM sandbox_artifacts WHERE session_id = ?").run(sessionId);
      db.prepare("DELETE FROM sandbox_publications WHERE session_id = ?").run(sessionId);
      db.prepare("DELETE FROM sandbox_turns WHERE session_id = ?").run(sessionId);
    });
    await fs.rm(this.#dir(sessionId), { recursive: true, force: true });
  }
}
