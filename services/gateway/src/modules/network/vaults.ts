/**
 * Vaults (spec section 8): AppHost vaults declared in configuration (values resolved from the gateway's environment
 * by `{ secretEnv }` reference) and per-user vaults created in code (values sealed at rest, owned by the creating
 * GitHub account). No API returns a value; values leave this store only to authorize one use by the egress proxy or
 * the MCP adapter.
 */
import { randomBytes } from "node:crypto";
import {
  isReservedEnvName,
  ManagedCopilotError,
  parseVaultDestination,
  VAULT_FORBIDDEN_HEADERS,
  type CreateVaultRequest,
  type ManagedCopilotConfig,
  type VaultDestination,
  type VaultInfo,
} from "@managed-copilot/protocol";
import type { Database } from "../../db.js";
import type { Logger } from "../../log.js";
import type { Sealer } from "./sealing.js";

export type CredentialMeta =
  | {
      readonly key: string;
      readonly kind: "env";
      readonly env: string;
      readonly destinations: readonly VaultDestination[];
      /** Lowercase header names eligible for substitution. */
      readonly headers: readonly string[];
    }
  | {
      readonly key: string;
      readonly kind: "mcp";
      /** Normalized URL of the MCP endpoint. */
      readonly mcpServer: string;
      /** Lowercase header the credential is sent in. */
      readonly header: string;
      /** True when the header defaulted to Authorization, so the value is sent with the Bearer scheme. */
      readonly bearer: boolean;
    };

export interface VaultRecord {
  /** AppHost vaults use their configured name; vaults created in code use `vlt_…`. */
  readonly id: string;
  readonly name: string;
  readonly kind: "apphost" | "user";
  readonly ownerId?: number;
  readonly credentials: readonly CredentialMeta[];
  readonly createdAt: string;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const VAULT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_VAULTS_PER_OWNER = 100;
const MAX_CREDENTIALS = 20;
const MAX_VALUE_LENGTH = 8192;

function invalid(message: string): ManagedCopilotError {
  return new ManagedCopilotError("invalid_request", message);
}

function headerName(value: unknown, where: string): string {
  if (typeof value !== "string" || !HEADER_NAME.test(value)) throw invalid(`${where} must be an HTTP header name`);
  const name = value.toLowerCase();
  if (VAULT_FORBIDDEN_HEADERS.includes(name)) throw invalid(`${where}: the ${name} header cannot carry a vault credential`);
  return name;
}

function mcpUrl(value: unknown, where: string): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw invalid(`${where} must be an https:// URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) throw invalid(`${where} must be an https:// URL without credentials`);
  url.hash = "";
  return url.toString();
}

function secretValue(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(`${where} must be a non-empty string`);
  if (value.length > MAX_VALUE_LENGTH) throw invalid(`${where} is longer than ${MAX_VALUE_LENGTH} characters`);
  if (/[\r\n\0]/.test(value)) throw invalid(`${where} cannot contain line breaks or NUL characters`);
  return value;
}

function envCredential(env: string, hosts: readonly unknown[], headers: readonly unknown[] | undefined, where: string): CredentialMeta {
  if (!ENV_NAME.test(env)) throw invalid(`${where}.env must be an environment variable name such as STRIPE_API_KEY`);
  if (isReservedEnvName(env)) throw invalid(`${where}.env: ${env} is reserved by the platform`);
  if (hosts.length === 0 || hosts.length > 20) throw invalid(`${where}.hosts must list 1 to 20 exact HTTPS hosts`);
  const destinations = hosts.map((host, index) => {
    try {
      return parseVaultDestination(String(host));
    } catch (error) {
      throw invalid(`${where}.hosts[${index}]: ${(error as Error).message}`);
    }
  });
  const names = headers === undefined ? ["authorization"] : headers.map((header, index) => headerName(header, `${where}.headers[${index}]`));
  if (names.length === 0 || names.length > 10) throw invalid(`${where}.headers must list 1 to 10 header names`);
  return { key: `env:${env}`, kind: "env", env, destinations, headers: [...new Set(names)] };
}

function mcpCredential(server: unknown, header: unknown, where: string): CredentialMeta {
  const mcpServer = mcpUrl(server, `${where}.mcpServer`);
  return { key: `mcp:${mcpServer}`, kind: "mcp", mcpServer, header: header === undefined ? "authorization" : headerName(header, `${where}.header`), bearer: header === undefined };
}

export function vaultInfo(record: VaultRecord): VaultInfo {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    credentials: record.credentials.map((credential) =>
      credential.kind === "env" ? { env: credential.env, hosts: credential.destinations.map((destination) => destination.host) } : { mcpServer: credential.mcpServer },
    ),
    createdAt: record.createdAt,
  };
}

interface VaultRow {
  id: string;
  owner_id: number;
  name: string;
  credentials: string;
  sealed: string;
  created_at: string;
}

export interface VaultStoreOptions {
  readonly db: Database;
  readonly sealer: Sealer;
  readonly deployment: ManagedCopilotConfig;
  /** Resolves `{ secretEnv }` references (the gateway's environment). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: Logger;
}

export class VaultStore {
  readonly #options: VaultStoreOptions;
  readonly #apphost = new Map<string, { record: VaultRecord; secretEnvs: ReadonlyMap<string, string> }>();
  readonly #deleteListeners = new Set<(vaultId: string) => void>();

  constructor(options: VaultStoreOptions) {
    this.#options = options;
    const startedAt = new Date().toISOString();
    for (const [name, credentials] of Object.entries(options.deployment.vaults ?? {})) {
      const metas: CredentialMeta[] = [];
      const secretEnvs = new Map<string, string>();
      credentials.forEach((credential, index) => {
        const where = `vaults.${name}[${index}]`;
        const meta = "env" in credential ? envCredential(credential.env, credential.hosts, credential.headers, where) : mcpCredential(credential.mcpServer, credential.header, where);
        if (metas.some((existing) => existing.key === meta.key)) throw new Error(`${where} duplicates another credential in vault "${name}"`);
        metas.push(meta);
        secretEnvs.set(meta.key, credential.value.secretEnv);
        if (!options.env[credential.value.secretEnv]) {
          options.log.warn("A vault secret is not set; sessions that use it will fail", { vault: name, secretEnv: credential.value.secretEnv });
        }
      });
      this.#apphost.set(name, { record: { id: name, name, kind: "apphost", credentials: metas, createdAt: startedAt }, secretEnvs });
    }
  }

  /** Called with a vault ID after it is deleted, so bindings and registrations can be revoked. */
  onDelete(listener: (vaultId: string) => void): () => void {
    this.#deleteListeners.add(listener);
    return () => this.#deleteListeners.delete(listener);
  }

  apphost(name: string): VaultRecord | undefined {
    return this.#apphost.get(name)?.record;
  }

  #row(id: string): VaultRow | undefined {
    return this.#options.db.prepare("SELECT * FROM network_vaults WHERE id = ?").get(id) as VaultRow | undefined;
  }

  #fromRow(row: VaultRow): VaultRecord {
    return { id: row.id, name: row.name, kind: "user", ownerId: row.owner_id, credentials: JSON.parse(row.credentials) as CredentialMeta[], createdAt: row.created_at };
  }

  /** Any vault by ID, without an owner check (internal use only). */
  find(id: string): VaultRecord | undefined {
    const apphost = this.#apphost.get(id);
    if (apphost) return apphost.record;
    const row = id.startsWith("vlt_") ? this.#row(id) : undefined;
    return row ? this.#fromRow(row) : undefined;
  }

  /** A user vault owned by `ownerId`, by ID or name. */
  owned(ownerId: number, idOrName: string): VaultRecord | undefined {
    const row = (
      idOrName.startsWith("vlt_")
        ? this.#options.db.prepare("SELECT * FROM network_vaults WHERE id = ? AND owner_id = ?").get(idOrName, ownerId)
        : this.#options.db.prepare("SELECT * FROM network_vaults WHERE name = ? AND owner_id = ?").get(idOrName, ownerId)
    ) as VaultRow | undefined;
    return row ? this.#fromRow(row) : undefined;
  }

  /** The caller's vaults plus the deployment's AppHost vaults. */
  list(ownerId: number): VaultInfo[] {
    const rows = this.#options.db.prepare("SELECT * FROM network_vaults WHERE owner_id = ? ORDER BY created_at, id").all(ownerId) as unknown as VaultRow[];
    return [...[...this.#apphost.values()].map((entry) => vaultInfo(entry.record)), ...rows.map((row) => vaultInfo(this.#fromRow(row)))];
  }

  get(ownerId: number, id: string): VaultInfo {
    const apphost = this.#apphost.get(id);
    if (apphost) return vaultInfo(apphost.record);
    const owned = this.owned(ownerId, id);
    if (!owned || !id.startsWith("vlt_")) throw new ManagedCopilotError("not_found", `Vault ${id} was not found`);
    return vaultInfo(owned);
  }

  create(ownerId: number, request: unknown): VaultInfo {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw invalid("The request body must be a vault: { name, credentials }");
    const body = request as Partial<CreateVaultRequest> & Record<string, unknown>;
    for (const key of Object.keys(body)) if (key !== "name" && key !== "credentials") throw invalid(`Unknown field "${key}"`);
    if (typeof body.name !== "string" || !VAULT_NAME.test(body.name)) throw invalid("name must be 1-100 letters, digits, dots, dashes, or underscores, starting with a letter or digit");
    if (this.#apphost.has(body.name)) throw new ManagedCopilotError("conflict", `"${body.name}" is the name of a vault declared in the AppHost; choose another name`);
    if (!Array.isArray(body.credentials) || body.credentials.length === 0 || body.credentials.length > MAX_CREDENTIALS) {
      throw invalid(`credentials must list 1 to ${MAX_CREDENTIALS} credentials`);
    }
    const metas: CredentialMeta[] = [];
    const values: Record<string, string> = {};
    body.credentials.forEach((credential: unknown, index) => {
      const where = `credentials[${index}]`;
      if (!credential || typeof credential !== "object") throw invalid(`${where} must be an object`);
      const fields = credential as Record<string, unknown>;
      let meta: CredentialMeta;
      if ("env" in fields) {
        for (const key of Object.keys(fields)) if (!["env", "value", "hosts", "headers"].includes(key)) throw invalid(`${where}: unknown field "${key}"`);
        if (typeof fields["env"] !== "string") throw invalid(`${where}.env must be a string`);
        if (!Array.isArray(fields["hosts"])) throw invalid(`${where}.hosts must list exact HTTPS hosts`);
        if (fields["headers"] !== undefined && !Array.isArray(fields["headers"])) throw invalid(`${where}.headers must be a list`);
        meta = envCredential(fields["env"], fields["hosts"], fields["headers"] as unknown[] | undefined, where);
      } else if ("mcpServer" in fields) {
        for (const key of Object.keys(fields)) if (!["mcpServer", "value", "header"].includes(key)) throw invalid(`${where}: unknown field "${key}"`);
        meta = mcpCredential(fields["mcpServer"], fields["header"], where);
      } else {
        throw invalid(`${where} needs either env (a sandbox credential) or mcpServer (an MCP credential)`);
      }
      if (metas.some((existing) => existing.key === meta.key)) throw invalid(`${where} duplicates another credential in this vault`);
      metas.push(meta);
      values[meta.key] = secretValue(fields["value"], `${where}.value`);
    });
    const count = (this.#options.db.prepare("SELECT COUNT(*) AS n FROM network_vaults WHERE owner_id = ?").get(ownerId) as { n: number }).n;
    if (count >= MAX_VAULTS_PER_OWNER) throw new ManagedCopilotError("conflict", `You already have ${MAX_VAULTS_PER_OWNER} vaults; delete one first`);
    const id = `vlt_${randomBytes(12).toString("hex")}`;
    const createdAt = new Date().toISOString();
    try {
      this.#options.db
        .prepare("INSERT INTO network_vaults (id, owner_id, name, credentials, sealed, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, ownerId, body.name, JSON.stringify(metas), this.#options.sealer.seal(JSON.stringify(values), `network_vaults:${id}`), createdAt);
    } catch (error) {
      if (/UNIQUE/i.test((error as Error).message)) throw new ManagedCopilotError("conflict", `You already have a vault named "${body.name}"`);
      throw error;
    }
    this.#options.log.info("Vault created", { vaultId: id, ownerId, name: body.name, entries: metas.length });
    return vaultInfo({ id, name: body.name, kind: "user", ownerId, credentials: metas, createdAt });
  }

  delete(ownerId: number, id: string): void {
    if (this.#apphost.has(id)) throw new ManagedCopilotError("forbidden", `Vault "${id}" is declared in the AppHost and cannot be deleted from code`);
    const owned = id.startsWith("vlt_") ? this.owned(ownerId, id) : undefined;
    if (!owned) throw new ManagedCopilotError("not_found", `Vault ${id} was not found`);
    this.#options.db.prepare("DELETE FROM network_vaults WHERE id = ? AND owner_id = ?").run(id, ownerId);
    this.#options.log.info("Vault deleted", { vaultId: id, ownerId });
    for (const listener of this.#deleteListeners) listener(id);
  }

  /**
   * The value of one credential, for one authorized use. User vaults are only usable by their owner's sessions.
   * Throws `forbidden` when the vault or credential no longer exists, or `capability_unavailable` when an AppHost
   * secret is not configured.
   */
  secret(vaultId: string, credentialKey: string, sessionOwnerId: number): string {
    const apphost = this.#apphost.get(vaultId);
    if (apphost) {
      const secretEnv = apphost.secretEnvs.get(credentialKey);
      if (!secretEnv) throw new ManagedCopilotError("forbidden", `Vault "${vaultId}" no longer has this credential`);
      const value = this.#options.env[secretEnv];
      if (!value) throw new ManagedCopilotError("capability_unavailable", `The AppHost secret for vault "${vaultId}" (${secretEnv}) is not set on the gateway`);
      return value;
    }
    const row = vaultId.startsWith("vlt_") ? this.#row(vaultId) : undefined;
    if (!row) throw new ManagedCopilotError("forbidden", "The vault for this credential was deleted");
    if (row.owner_id !== sessionOwnerId) throw new ManagedCopilotError("forbidden", "This vault belongs to a different GitHub account");
    const values = JSON.parse(this.#options.sealer.unseal(row.sealed, `network_vaults:${row.id}`)) as Record<string, string>;
    const value = values[credentialKey];
    if (value === undefined) throw new ManagedCopilotError("forbidden", "The vault no longer has this credential");
    return value;
  }
}
