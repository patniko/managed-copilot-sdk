// The sandbox module's ledger tables. The gateway's records are authoritative for setup and lifecycle state; nothing
// sandbox-writable is trusted.
import type { NetworkPolicy, SandboxSetupRecord, SandboxSize, SandboxState } from "@managed-copilot/protocol";
import { migrate, type Database } from "../../db.js";

export const MIGRATIONS = [
  `CREATE TABLE sandbox_sandboxes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE,
    owner_id INTEGER NOT NULL,
    environment TEXT NOT NULL,
    size TEXT NOT NULL,
    network TEXT NOT NULL,
    vaults TEXT NOT NULL,
    image TEXT,
    image_id TEXT,
    state TEXT NOT NULL,
    sandbox_key TEXT NOT NULL,
    runtime_token TEXT NOT NULL,
    placeholder TEXT NOT NULL,
    subnet TEXT,
    customizations_host TEXT,
    workload_env TEXT NOT NULL,
    setup TEXT,
    error_code TEXT,
    error TEXT,
    idle_timeout_seconds INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    stopped_at TEXT
  )`,
  `CREATE TABLE sandbox_turns (
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    state TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (session_id, turn_id)
  )`,
  `CREATE TABLE sandbox_publications (
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    state TEXT NOT NULL,
    error TEXT,
    artifact_ids TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (session_id, turn_id)
  )`,
  `CREATE TABLE sandbox_artifacts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    path TEXT NOT NULL,
    version INTEGER NOT NULL,
    turn_id TEXT NOT NULL,
    size INTEGER NOT NULL,
    digest TEXT NOT NULL,
    content_type TEXT,
    state TEXT NOT NULL,
    published_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (session_id, path, version)
  )`,
  `CREATE INDEX sandbox_artifacts_session ON sandbox_artifacts (session_id, path, version)`,
];

export interface SandboxRow {
  readonly id: string;
  readonly sessionId: string;
  readonly ownerId: number;
  readonly environment: string;
  readonly size: SandboxSize;
  readonly network: NetworkPolicy;
  readonly vaults: readonly string[];
  readonly image?: string;
  readonly imageId?: string;
  readonly state: SandboxState;
  readonly key: string;
  readonly runtimeToken: string;
  readonly placeholder: string;
  readonly subnet?: string;
  /** Host path of the pinned customizations bundle mounted into the sandbox. */
  readonly customizations?: string;
  readonly workloadEnv: Readonly<Record<string, string>>;
  readonly setup?: SandboxSetupRecord;
  readonly errorCode?: string;
  readonly error?: string;
  readonly idleTimeoutSeconds: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly stoppedAt?: string;
}

type Raw = Record<string, unknown>;

function fromRaw(row: Raw): SandboxRow {
  const optional = (key: string) => (row[key] === null || row[key] === undefined ? undefined : String(row[key]));
  return {
    id: String(row["id"]),
    sessionId: String(row["session_id"]),
    ownerId: Number(row["owner_id"]),
    environment: String(row["environment"]),
    size: String(row["size"]) as SandboxSize,
    network: JSON.parse(String(row["network"])) as NetworkPolicy,
    vaults: JSON.parse(String(row["vaults"])) as string[],
    ...(optional("image") ? { image: optional("image")! } : {}),
    ...(optional("image_id") ? { imageId: optional("image_id")! } : {}),
    state: String(row["state"]) as SandboxState,
    key: String(row["sandbox_key"]),
    runtimeToken: String(row["runtime_token"]),
    placeholder: String(row["placeholder"]),
    ...(optional("subnet") ? { subnet: optional("subnet")! } : {}),
    ...(optional("customizations_host") ? { customizations: optional("customizations_host")! } : {}),
    workloadEnv: JSON.parse(String(row["workload_env"])) as Record<string, string>,
    ...(optional("setup") ? { setup: JSON.parse(optional("setup")!) as SandboxSetupRecord } : {}),
    ...(optional("error_code") ? { errorCode: optional("error_code")! } : {}),
    ...(optional("error") ? { error: optional("error")! } : {}),
    idleTimeoutSeconds: Number(row["idle_timeout_seconds"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    ...(optional("started_at") ? { startedAt: optional("started_at")! } : {}),
    ...(optional("stopped_at") ? { stoppedAt: optional("stopped_at")! } : {}),
  };
}

export interface SandboxPatch {
  readonly state?: SandboxState;
  readonly image?: string;
  readonly imageId?: string;
  readonly subnet?: string;
  readonly setup?: SandboxSetupRecord;
  readonly errorCode?: string | null;
  readonly error?: string | null;
  readonly startedAt?: string;
  readonly stoppedAt?: string;
}

const COLUMN: Record<keyof SandboxPatch, string> = {
  state: "state",
  image: "image",
  imageId: "image_id",
  subnet: "subnet",
  setup: "setup",
  errorCode: "error_code",
  error: "error",
  startedAt: "started_at",
  stoppedAt: "stopped_at",
};

export class SandboxStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
    migrate(db, "sandbox", MIGRATIONS);
  }

  get db(): Database {
    return this.#db;
  }

  insert(row: Omit<SandboxRow, "createdAt" | "updatedAt">): SandboxRow {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO sandbox_sandboxes (id, session_id, owner_id, environment, size, network, vaults, image, image_id, state, sandbox_key, runtime_token, placeholder, subnet, customizations_host, workload_env, idle_timeout_seconds, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.sessionId,
        row.ownerId,
        row.environment,
        row.size,
        JSON.stringify(row.network),
        JSON.stringify(row.vaults),
        row.image ?? null,
        row.imageId ?? null,
        row.state,
        row.key,
        row.runtimeToken,
        row.placeholder,
        row.subnet ?? null,
        row.customizations ?? null,
        JSON.stringify(row.workloadEnv),
        row.idleTimeoutSeconds,
        now,
        now,
      );
    return this.bySession(row.sessionId)!;
  }

  bySession(sessionId: string): SandboxRow | undefined {
    const row = this.#db.prepare("SELECT * FROM sandbox_sandboxes WHERE session_id = ?").get(sessionId) as Raw | undefined;
    return row ? fromRaw(row) : undefined;
  }

  byId(id: string): SandboxRow | undefined {
    const row = this.#db.prepare("SELECT * FROM sandbox_sandboxes WHERE id = ?").get(id) as Raw | undefined;
    return row ? fromRaw(row) : undefined;
  }

  inStates(states: readonly SandboxState[]): SandboxRow[] {
    const placeholders = states.map(() => "?").join(", ");
    return (this.#db.prepare(`SELECT * FROM sandbox_sandboxes WHERE state IN (${placeholders})`).all(...states) as Raw[]).map(fromRaw);
  }

  all(): SandboxRow[] {
    return (this.#db.prepare("SELECT * FROM sandbox_sandboxes").all() as Raw[]).map(fromRaw);
  }

  update(sessionId: string, patch: SandboxPatch): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof SandboxPatch, unknown][]) {
      if (value === undefined) continue;
      sets.push(`${COLUMN[key]} = ?`);
      values.push(value === null ? null : key === "setup" ? JSON.stringify(value) : (value as string));
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    this.#db.prepare(`UPDATE sandbox_sandboxes SET ${sets.join(", ")} WHERE session_id = ?`).run(...values, sessionId);
  }

  /** Clears credentials from a deleted sandbox's record (the row stays for audit). */
  scrub(sessionId: string): void {
    this.#db.prepare("UPDATE sandbox_sandboxes SET sandbox_key = '', runtime_token = '', placeholder = '', workload_env = '{}', updated_at = ? WHERE session_id = ?").run(new Date().toISOString(), sessionId);
  }

  /** Removes a finished (deleted or failed) record so the session ID can be placed again. */
  remove(sessionId: string): void {
    this.#db.prepare("DELETE FROM sandbox_sandboxes WHERE session_id = ?").run(sessionId);
  }
}
