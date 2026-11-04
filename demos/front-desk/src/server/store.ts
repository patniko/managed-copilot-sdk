import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BillingRoute, UserKind } from "../shared/types.js";

/**
 * Front Desk's own records (SQLite): accounts and how each person signs in, browser sign-ins, each person's conversation
 * list, and their memory. Conversations themselves live in Managed Copilot.
 *
 * Every read or change of a person's data takes their user ID and filters on it, so one person's request can never
 * reach another person's rows, whatever ID it names.
 */

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     name TEXT NOT NULL,
     email TEXT UNIQUE,
     password_hash TEXT,
     github_id INTEGER UNIQUE,
     github_login TEXT,
     avatar_url TEXT,
     created_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL
   );
   CREATE TABLE github_tokens (
     user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
     token TEXT NOT NULL,
     refresh_token TEXT,
     expires_at TEXT,
     source TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE browser_sessions (
     id_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     last_used_at TEXT NOT NULL
   );
   CREATE INDEX browser_sessions_user ON browser_sessions (user_id);
   CREATE TABLE oauth_states (
     state_hash TEXT PRIMARY KEY,
     verifier TEXT NOT NULL,
     return_to TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE conversations (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     environment TEXT NOT NULL,
     route TEXT NOT NULL,
     model TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX conversations_user ON conversations (user_id, updated_at);
   CREATE TABLE memories (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     text TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX memories_user ON memories (user_id, created_at);
   CREATE TABLE usage_days (
     user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     day TEXT NOT NULL,
     messages INTEGER NOT NULL,
     PRIMARY KEY (user_id, day)
   );`,
];

export interface UserRecord {
  readonly id: string;
  readonly kind: UserKind;
  readonly name: string;
  readonly email?: string;
  readonly passwordHash?: string;
  readonly githubId?: number;
  readonly githubLogin?: string;
  readonly avatarUrl?: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}

export interface GitHubTokenRecord {
  readonly userId: string;
  /** Sealed. */
  readonly token: string;
  /** Sealed; present for expiring GitHub App user tokens. */
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  /** `oauth`: "Continue with GitHub". `local`: this computer's GitHub CLI sign-in (loopback only). */
  readonly source: "oauth" | "local";
  readonly updatedAt: string;
}

export interface ConversationRecord {
  readonly id: string;
  readonly userId: string;
  readonly title: string;
  readonly environment: string;
  readonly route: BillingRoute;
  readonly model?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryRecord {
  readonly id: string;
  readonly userId: string;
  readonly text: string;
  readonly createdAt: string;
}

type Row = Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : undefined);
const now = () => new Date().toISOString();

export const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;
export const hashSecret = (value: string) => createHash("sha256").update(value).digest("base64url");

function toUser(row: Row): UserRecord {
  return {
    id: String(row.id),
    kind: row.kind === "github" ? "github" : "email",
    name: String(row.name),
    ...(str(row.email) ? { email: str(row.email)! } : {}),
    ...(str(row.password_hash) ? { passwordHash: str(row.password_hash)! } : {}),
    ...(num(row.github_id) !== undefined ? { githubId: num(row.github_id)! } : {}),
    ...(str(row.github_login) ? { githubLogin: str(row.github_login)! } : {}),
    ...(str(row.avatar_url) ? { avatarUrl: str(row.avatar_url)! } : {}),
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
  };
}

function toConversation(row: Row): ConversationRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    title: String(row.title),
    environment: String(row.environment),
    route: row.route === "foundry" ? "foundry" : "copilot",
    ...(str(row.model) ? { model: str(row.model)! } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toMemory(row: Row): MemoryRecord {
  return { id: String(row.id), userId: String(row.user_id), text: String(row.text), createdAt: String(row.created_at) };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const row = this.db.prepare("SELECT version FROM schema_version").get() as Row | undefined;
    let version = typeof row?.version === "number" ? row.version : 0;
    if (!row) this.db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
    while (version < MIGRATIONS.length) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version]!);
        this.db.prepare("UPDATE schema_version SET version = ?").run(version + 1);
      });
      version++;
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- people ------------------------------------------------------------------------------------------------------

  getUser(id: string): UserRecord | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    return row ? toUser(row) : undefined;
  }

  findByEmail(email: string): UserRecord | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ? AND kind = 'email'").get(email.toLowerCase()) as Row | undefined;
    return row ? toUser(row) : undefined;
  }

  findByGitHubId(githubId: number): UserRecord | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE github_id = ?").get(githubId) as Row | undefined;
    return row ? toUser(row) : undefined;
  }

  /** Creates an email account; fails with `email_taken` when the address already has one. */
  createEmailUser(input: { name: string; email: string; passwordHash: string }): UserRecord {
    const id = newId("u");
    const at = now();
    try {
      this.db
        .prepare("INSERT INTO users (id, kind, name, email, password_hash, created_at, last_seen_at) VALUES (?, 'email', ?, ?, ?, ?, ?)")
        .run(id, input.name, input.email.toLowerCase(), input.passwordHash, at, at);
    } catch (error) {
      if (/UNIQUE/i.test((error as Error).message)) throw Object.assign(new Error("email_taken"), { code: "email_taken" });
      throw error;
    }
    return this.getUser(id)!;
  }

  /** Creates or refreshes the account of a GitHub user, keyed by their stable GitHub account ID (never the login). */
  upsertGitHubUser(input: { githubId: number; login: string; name?: string; avatarUrl?: string }): UserRecord {
    const at = now();
    const existing = this.findByGitHubId(input.githubId);
    const name = input.name?.trim() || input.login;
    if (existing) {
      this.db
        .prepare("UPDATE users SET name = ?, github_login = ?, avatar_url = ?, last_seen_at = ? WHERE id = ?")
        .run(name, input.login, input.avatarUrl ?? null, at, existing.id);
      return this.getUser(existing.id)!;
    }
    const id = newId("u");
    this.db
      .prepare("INSERT INTO users (id, kind, name, github_id, github_login, avatar_url, created_at, last_seen_at) VALUES (?, 'github', ?, ?, ?, ?, ?, ?)")
      .run(id, name, input.githubId, input.login, input.avatarUrl ?? null, at, at);
    return this.getUser(id)!;
  }

  touchUser(id: string): void {
    this.db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now(), id);
  }

  countUsers(): { github: number; email: number } {
    const rows = this.db.prepare("SELECT kind, COUNT(*) AS n FROM users GROUP BY kind").all() as Row[];
    const count = (kind: string) => num(rows.find((row) => row.kind === kind)?.n) ?? 0;
    return { github: count("github"), email: count("email") };
  }

  // ---- GitHub tokens (sealed by the caller) -----------------------------------------------------------------------

  getGitHubToken(userId: string): GitHubTokenRecord | undefined {
    const row = this.db.prepare("SELECT * FROM github_tokens WHERE user_id = ?").get(userId) as Row | undefined;
    if (!row) return undefined;
    return {
      userId,
      token: String(row.token),
      ...(str(row.refresh_token) ? { refreshToken: str(row.refresh_token)! } : {}),
      ...(str(row.expires_at) ? { expiresAt: str(row.expires_at)! } : {}),
      source: row.source === "local" ? "local" : "oauth",
      updatedAt: String(row.updated_at),
    };
  }

  saveGitHubToken(record: Omit<GitHubTokenRecord, "updatedAt">): void {
    this.db
      .prepare(
        `INSERT INTO github_tokens (user_id, token, refresh_token, expires_at, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET token = excluded.token, refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at, source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(record.userId, record.token, record.refreshToken ?? null, record.expiresAt ?? null, record.source, now());
  }

  deleteGitHubToken(userId: string): void {
    this.db.prepare("DELETE FROM github_tokens WHERE user_id = ?").run(userId);
  }

  // ---- browser sign-ins (only a hash of the cookie value is stored) ------------------------------------------------

  createBrowserSession(userId: string, ttlMs: number): string {
    const value = randomBytes(32).toString("base64url");
    const at = now();
    this.db
      .prepare("INSERT INTO browser_sessions (id_hash, user_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)")
      .run(hashSecret(value), userId, at, new Date(Date.now() + ttlMs).toISOString(), at);
    return value;
  }

  /** The person a browser sign-in belongs to, extending it when it was last used more than an hour ago. */
  resolveBrowserSession(value: string, ttlMs: number): UserRecord | undefined {
    const row = this.db.prepare("SELECT * FROM browser_sessions WHERE id_hash = ?").get(hashSecret(value)) as Row | undefined;
    if (!row) return undefined;
    if (Date.parse(String(row.expires_at)) <= Date.now()) {
      this.db.prepare("DELETE FROM browser_sessions WHERE id_hash = ?").run(row.id_hash as string);
      return undefined;
    }
    if (Date.now() - Date.parse(String(row.last_used_at)) > 60 * 60_000) {
      this.db
        .prepare("UPDATE browser_sessions SET last_used_at = ?, expires_at = ? WHERE id_hash = ?")
        .run(now(), new Date(Date.now() + ttlMs).toISOString(), row.id_hash as string);
    }
    return this.getUser(String(row.user_id));
  }

  deleteBrowserSession(value: string): string | undefined {
    const row = this.db.prepare("SELECT user_id FROM browser_sessions WHERE id_hash = ?").get(hashSecret(value)) as Row | undefined;
    this.db.prepare("DELETE FROM browser_sessions WHERE id_hash = ?").run(hashSecret(value));
    return row ? String(row.user_id) : undefined;
  }

  /** Whether a browser sign-in, by the hash of its cookie value, still exists and hasn't expired. */
  browserSessionActive(idHash: string): boolean {
    const row = this.db.prepare("SELECT expires_at FROM browser_sessions WHERE id_hash = ?").get(idHash) as Row | undefined;
    return row !== undefined && Date.parse(String(row.expires_at)) > Date.now();
  }

  countBrowserSessions(userId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM browser_sessions WHERE user_id = ? AND expires_at > ?").get(userId, now()) as Row;
    return num(row.n) ?? 0;
  }

  deleteBrowserSessionsOf(userId: string): void {
    this.db.prepare("DELETE FROM browser_sessions WHERE user_id = ?").run(userId);
  }

  // ---- GitHub OAuth states ------------------------------------------------------------------------------------------

  saveOAuthState(state: string, sealedVerifier: string, returnTo: string): void {
    this.db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(new Date(Date.now() - 60 * 60_000).toISOString());
    this.db.prepare("INSERT INTO oauth_states (state_hash, verifier, return_to, created_at) VALUES (?, ?, ?, ?)").run(hashSecret(state), sealedVerifier, returnTo, now());
  }

  /** Returns and deletes a pending OAuth state: each one is usable once. */
  takeOAuthState(state: string): { verifier: string; returnTo: string; createdAt: string } | undefined {
    const key = hashSecret(state);
    const row = this.db.prepare("SELECT * FROM oauth_states WHERE state_hash = ?").get(key) as Row | undefined;
    if (!row) return undefined;
    this.db.prepare("DELETE FROM oauth_states WHERE state_hash = ?").run(key);
    return { verifier: String(row.verifier), returnTo: String(row.return_to), createdAt: String(row.created_at) };
  }

  // ---- conversations -----------------------------------------------------------------------------------------------

  addConversation(record: Omit<ConversationRecord, "createdAt" | "updatedAt">): ConversationRecord {
    const at = now();
    this.db
      .prepare("INSERT INTO conversations (id, user_id, title, environment, route, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(record.id, record.userId, record.title, record.environment, record.route, record.model ?? null, at, at);
    return this.getConversation(record.userId, record.id)!;
  }

  /** The person's conversation, or undefined when it doesn't exist or belongs to someone else. */
  getConversation(userId: string, id: string): ConversationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
    return row ? toConversation(row) : undefined;
  }

  listConversations(userId: string, limit = 200): ConversationRecord[] {
    return (this.db.prepare("SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?").all(userId, limit) as Row[]).map(toConversation);
  }

  touchConversation(userId: string, id: string, title?: string): ConversationRecord | undefined {
    if (title) this.db.prepare("UPDATE conversations SET updated_at = ?, title = ? WHERE id = ? AND user_id = ?").run(now(), title, id, userId);
    else this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?").run(now(), id, userId);
    return this.getConversation(userId, id);
  }

  deleteConversation(userId: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?").run(id, userId).changes) > 0;
  }

  // ---- memory ------------------------------------------------------------------------------------------------------

  addMemory(userId: string, text: string, max: number): MemoryRecord | undefined {
    const count = num((this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id = ?").get(userId) as Row).n) ?? 0;
    if (count >= max) return undefined;
    const id = newId("m");
    const at = now();
    this.db.prepare("INSERT INTO memories (id, user_id, text, created_at) VALUES (?, ?, ?, ?)").run(id, userId, text, at);
    return { id, userId, text, createdAt: at };
  }

  listMemories(userId: string): MemoryRecord[] {
    return (this.db.prepare("SELECT * FROM memories WHERE user_id = ? ORDER BY created_at ASC, rowid ASC").all(userId) as Row[]).map(toMemory);
  }

  deleteMemory(userId: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM memories WHERE id = ? AND user_id = ?").run(id, userId).changes) > 0;
  }

  clearMemories(userId: string): number {
    return Number(this.db.prepare("DELETE FROM memories WHERE user_id = ?").run(userId).changes);
  }

  // ---- daily allowance ---------------------------------------------------------------------------------------------

  messagesOn(userId: string, day: string): number {
    const row = this.db.prepare("SELECT messages FROM usage_days WHERE user_id = ? AND day = ?").get(userId, day) as Row | undefined;
    return num(row?.messages) ?? 0;
  }

  /** Counts one message toward today's allowance; false (and nothing counted) when the allowance is used up. */
  countMessage(userId: string, day: string, limit: number): boolean {
    return this.transaction(() => {
      const used = this.messagesOn(userId, day);
      if (used >= limit) return false;
      this.db
        .prepare("INSERT INTO usage_days (user_id, day, messages) VALUES (?, ?, 1) ON CONFLICT (user_id, day) DO UPDATE SET messages = messages + 1")
        .run(userId, day);
      return true;
    });
  }

  /** Gives back a message that never reached the agent. */
  uncountMessage(userId: string, day: string): void {
    this.db.prepare("UPDATE usage_days SET messages = MAX(messages - 1, 0) WHERE user_id = ? AND day = ?").run(userId, day);
  }
}
