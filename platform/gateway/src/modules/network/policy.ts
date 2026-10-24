/**
 * The `policy` service (spec section 7): each session's effective network policy (deployment default, environment
 * setting, caller narrowing), persisted across resume and promotion; vault bindings with per-session placeholders;
 * per-sandbox proxy credentials; and the registrations the egress proxy enforces.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  EGRESS_PROXY_HOST,
  EGRESS_PROXY_PORT,
  formatIpAddress,
  isHostAllowed,
  ManagedCopilotError,
  narrowNetwork,
  NETWORK_DISABLED,
  normalizeDestinationHost,
  normalizeNetwork,
  parseIpAddress,
  VAULT_PLACEHOLDER_PREFIX,
  type EgressBlockReason,
  type EgressCredentialBinding,
  type EgressRegistration,
  type EgressReport,
  type EgressSecretRequest,
  type EnvironmentConfig,
  type EnvironmentType,
  type ManagedCopilotConfig,
  type NetworkPolicy,
  type NetworkSetting,
  type Placement,
} from "@managed-copilot/protocol";
import { transaction, type Database } from "../../db.js";
import type { Logger } from "../../log.js";
import type { CredentialMeta, VaultRecord, VaultStore } from "./vaults.js";

/** What core passes to `bindSession` (matches `PolicyBinding` in modules/core/contracts.ts). */
export interface SessionBindingInput {
  readonly sessionId: string;
  readonly owner: number;
  /**
   * Declared environment name; undefined (or an `inline-…` name the AppHost does not declare) for inline environments.
   * A declared name always wins, even one that starts with `inline-`.
   */
  readonly environment: string | undefined;
  readonly type: EnvironmentType;
  readonly requested: NetworkSetting | undefined;
  readonly vaults: readonly string[] | undefined;
}

export interface SessionNetwork {
  readonly sessionId: string;
  readonly ownerId: number;
  readonly environment: string | undefined;
  readonly type: EnvironmentType;
  /** Effective policy now: the stored session policy, narrowed by the environment's current ceiling. */
  readonly policy: NetworkPolicy;
  /** Vault IDs bound to the session (AppHost vault names and `vlt_…` IDs). */
  readonly vaults: readonly string[];
}

export interface SandboxRegistrationInput {
  readonly sandboxId: string;
  readonly sessionId: string;
  /** The sandbox's IP on its own network, when already known (see `updateSandbox`). */
  readonly address?: string;
  /** Where the sandbox reaches the egress proxy, when not at the `mc-egress:3128` alias (for example on Azure). */
  readonly proxy?: { readonly host: string; readonly port: number };
}

export interface SandboxEgress {
  readonly sandboxId: string;
  readonly sessionId: string;
  readonly policy: NetworkPolicy;
  /** `http://<sandboxId>:<credential>@mc-egress:3128` (or the requested proxy address); valid only for this sandbox. */
  readonly proxyUrl: string;
  /** Set for sandboxd, the runtime, and every workload process: proxy variables and vault placeholders. */
  readonly env: Readonly<Record<string, string>>;
  /** PEM of the platform egress CA to install in the sandbox trust stores ("" when the egress proxy has not started). */
  readonly caCertificate: string;
}

/** Push channel to connected egress proxies (implemented by the internal egress API). */
export interface EgressChannel {
  readonly ready: boolean;
  caCertificate(): string | undefined;
  waitReady(timeoutMs: number): Promise<void>;
  /** Kicks off the egress container when the platform manages it. */
  ensureStarted?(): void;
  upsert(registration: EgressRegistration): void;
  remove(sandboxId: string): void;
}

export interface BlockedEvent extends EgressReport {
  readonly id: number;
}

interface SessionRow {
  session_id: string;
  owner_id: number;
  environment: string | null;
  type: EnvironmentType;
  requested: string | null;
  policy: string;
  vaults: string;
  /** JSON `PromotionSnapshot` while a promotion is uncommitted. */
  promoted_from: string | null;
}

/** A session's binding before an uncommitted promotion, restored by `revertPromotion`. */
interface PromotionSnapshot {
  readonly environment: string | null;
  readonly type: EnvironmentType;
  /** The stored policy JSON, exactly as it was. */
  readonly policy: string;
}

interface CredentialRow {
  id: string;
  session_id: string;
  vault_id: string;
  credential_key: string;
  placeholder: string;
}

interface SandboxRow {
  sandbox_id: string;
  session_id: string;
  credential_hash: string;
  address: string | null;
  revision: number;
}

const SANDBOX_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EVENTS_PER_SESSION = 200;
const NO_PROXY = "localhost,127.0.0.1,::1";

export interface PolicyServiceOptions {
  readonly db: Database;
  readonly deployment: ManagedCopilotConfig;
  readonly vaults: VaultStore;
  readonly egress: EgressChannel;
  readonly log: Logger;
  /** How long `registerSandbox` waits for the egress proxy (first start may build its image). */
  readonly egressWaitMs?: number;
  /** Wait for the egress proxy even for sandboxes without network access (true when the platform runs the proxy). */
  readonly alwaysWaitForEgress?: boolean;
  /** Publishes `network.blocked` platform events (rate-limited by the caller). */
  readonly onBlocked?: (session: SessionNetwork, report: EgressReport) => void;
}

function placeholder(): string {
  return `${VAULT_PLACEHOLDER_PREFIX}${randomBytes(20).toString("hex")}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class PolicyService {
  readonly #options: PolicyServiceOptions;
  readonly #db: Database;
  readonly #log: Logger;

  constructor(options: PolicyServiceOptions) {
    this.#options = options;
    this.#db = options.db;
    this.#log = options.log;
    options.vaults.onDelete((vaultId) => this.#revokeVault(vaultId));
  }

  // --- Policy math -------------------------------------------------------------------------------------------

  /** The operator default for every environment (`network` at the top level of the AppHost). */
  get deploymentDefault(): NetworkPolicy {
    return normalizeNetwork(this.#options.deployment.network);
  }

  /** The environment's current declaration in the AppHost, if any. */
  #declared(environment: string | undefined): EnvironmentConfig | undefined {
    const environments = this.#options.deployment.environments;
    return environment !== undefined && Object.hasOwn(environments, environment) ? environments[environment] : undefined;
  }

  /** Inline environments have no name, or an `inline-…` name the AppHost does not declare (declared names always win). */
  #isInline(environment: string | undefined): boolean {
    return environment === undefined || (environment.startsWith("inline-") && !this.#declared(environment));
  }

  /** The ceiling of an environment: deployment default, then the environment's own setting. Inline uses the default. */
  ceiling(environment: string | undefined): NetworkPolicy {
    if (this.#isInline(environment)) return this.deploymentDefault;
    const config = this.#declared(environment);
    if (!config) throw new ManagedCopilotError("environment_not_found", `Environment "${environment}" is not declared in the AppHost`);
    return normalizeNetwork(config.network, this.deploymentDefault);
  }

  /** The ceiling narrowed by a caller's request (callers can only narrow). */
  effective(environment: string | undefined, requested: NetworkSetting | undefined): NetworkPolicy {
    return narrowNetwork(this.ceiling(environment), requested);
  }

  // --- Session bindings --------------------------------------------------------------------------------------

  /** Persists the session's effective policy and vault selection. Called once by admission at `session.create`. */
  bindSession(input: SessionBindingInput): NetworkPolicy {
    const environment = this.#isInline(input.environment) ? undefined : input.environment;
    const policy = this.effective(environment, input.requested);
    const vaults = this.#resolveVaults(input.owner, environment, input.type, input.vaults ?? []);
    const now = new Date().toISOString();
    transaction(this.#db, () => {
      this.#db.prepare("DELETE FROM network_credentials WHERE session_id = ?").run(input.sessionId);
      this.#db
        .prepare(
          `INSERT INTO network_sessions (session_id, owner_id, environment, type, requested, policy, vaults, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET owner_id = excluded.owner_id, environment = excluded.environment, type = excluded.type,
             requested = excluded.requested, policy = excluded.policy, vaults = excluded.vaults, promoted_from = NULL, updated_at = excluded.updated_at`,
        )
        .run(input.sessionId, input.owner, environment ?? null, input.type, input.requested === undefined ? null : JSON.stringify(input.requested), JSON.stringify(policy), JSON.stringify(vaults.map((vault) => vault.id)), now, now);
      const insert = this.#db.prepare("INSERT INTO network_credentials (id, session_id, vault_id, credential_key, placeholder, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const vault of vaults) {
        for (const credential of vault.credentials) insert.run(`cred_${randomBytes(10).toString("hex")}`, input.sessionId, vault.id, credential.key, placeholder(), now);
      }
    });
    this.#log.info("Session network bound", { sessionId: input.sessionId, environment: environment ?? "inline", access: policy.access, hosts: policy.allowedDomains.length, vaults: vaults.map((vault) => vault.name) });
    return policy;
  }

  #resolveVaults(ownerId: number, environment: string | undefined, type: EnvironmentType, requested: readonly string[]): VaultRecord[] {
    const declared = this.#declared(environment)?.vaults ?? [];
    const resolved = new Map<string, VaultRecord>();
    for (const name of declared) {
      const vault = this.#options.vaults.apphost(name);
      if (vault) resolved.set(vault.id, vault);
    }
    for (const reference of requested) {
      if (typeof reference !== "string" || !reference) throw new ManagedCopilotError("invalid_request", "vaults must list vault IDs or names");
      const apphost = this.#options.vaults.apphost(reference);
      if (apphost) {
        if (!declared.includes(reference)) {
          throw new ManagedCopilotError("policy_violation", `Vault "${reference}" is not available in ${environment ? `environment "${environment}"` : "inline environments"}; the AppHost decides which environments use it`);
        }
        continue;
      }
      const owned = this.#options.vaults.owned(ownerId, reference);
      if (!owned) throw new ManagedCopilotError("not_found", `Vault ${reference} was not found. Vaults created in code belong to the account that created them.`);
      resolved.set(owned.id, owned);
    }
    if (type === "shared") {
      for (const vault of resolved.values()) {
        if (vault.credentials.some((credential) => credential.kind === "env")) {
          throw new ManagedCopilotError(
            "policy_violation",
            `Vault "${vault.name}" holds sandbox credentials (environment variables), which shared environments cannot use. Use an isolated environment, or an MCP credential.`,
          );
        }
      }
    }
    return [...resolved.values()];
  }

  #sessionRow(sessionId: string): SessionRow | undefined {
    return this.#db.prepare("SELECT * FROM network_sessions WHERE session_id = ?").get(sessionId) as SessionRow | undefined;
  }

  #toSession(row: SessionRow): SessionNetwork {
    const stored = JSON.parse(row.policy) as NetworkPolicy;
    const environment = row.environment ?? undefined;
    const config = this.#declared(environment);
    // Bindings store declared names only (none for inline). An environment since removed from the AppHost means no
    // further egress, and AppHost vaults stay bound only while the current environment still grants them.
    const ceiling = environment === undefined ? this.deploymentDefault : config ? normalizeNetwork(config.network, this.deploymentDefault) : NETWORK_DISABLED;
    const granted = config?.vaults ?? [];
    return {
      sessionId: row.session_id,
      ownerId: row.owner_id,
      environment,
      type: row.type,
      policy: narrowNetwork(ceiling, stored),
      vaults: (JSON.parse(row.vaults) as string[]).filter((id) => !this.#options.vaults.apphost(id) || granted.includes(id)),
    };
  }

  /** The session's binding with its current effective policy, or undefined when it was never bound. */
  session(sessionId: string): SessionNetwork | undefined {
    const row = this.#sessionRow(sessionId);
    return row ? this.#toSession(row) : undefined;
  }

  /**
   * One-way promotion into an isolated environment: the target's ceiling can only narrow the session's current policy.
   * Until `commitPromotion`, the binding from before the promotion is kept so `revertPromotion` can restore it.
   */
  promoteSession(sessionId: string, targetEnvironment: string): NetworkPolicy {
    const row = this.#sessionRow(sessionId);
    if (!row) throw new ManagedCopilotError("not_found", `Session ${sessionId} has no network binding`);
    const target = this.#declared(targetEnvironment);
    if (!target || target.type !== "isolated") throw new ManagedCopilotError("invalid_request", `Promotion target "${targetEnvironment}" is not an isolated environment`);
    // The effective policy, not the stored one: a source ceiling tightened since creation must survive promotion.
    const policy = narrowNetwork(this.ceiling(targetEnvironment), this.#toSession(row).policy);
    // A retried promotion keeps the original source, so a rollback always returns to the session as it was.
    const previous = row.promoted_from ?? JSON.stringify({ environment: row.environment, type: row.type, policy: row.policy } satisfies PromotionSnapshot);
    this.#db
      .prepare("UPDATE network_sessions SET environment = ?, type = 'isolated', policy = ?, promoted_from = ?, updated_at = ? WHERE session_id = ?")
      .run(targetEnvironment, JSON.stringify(policy), previous, new Date().toISOString(), sessionId);
    this.#log.info("Session network promoted", { sessionId, environment: targetEnvironment, access: policy.access });
    this.#pushSession(sessionId);
    return policy;
  }

  /**
   * Pre-commit rollback of a promotion (spec 9.5): restores the environment, type, and stored policy from before the
   * uncommitted `promoteSession` and pushes them. Returns the restored effective policy, or undefined (a no-op) when no
   * promotion is pending.
   */
  revertPromotion(sessionId: string): NetworkPolicy | undefined {
    const row = this.#sessionRow(sessionId);
    if (!row?.promoted_from) return undefined;
    const previous = JSON.parse(row.promoted_from) as PromotionSnapshot;
    this.#db
      .prepare("UPDATE network_sessions SET environment = ?, type = ?, policy = ?, promoted_from = NULL, updated_at = ? WHERE session_id = ?")
      .run(previous.environment, previous.type, previous.policy, new Date().toISOString(), sessionId);
    this.#log.info("Session network promotion reverted", { sessionId, environment: previous.environment ?? "inline", type: previous.type });
    this.#pushSession(sessionId);
    return this.session(sessionId)?.policy;
  }

  /** The promotion committed: its binding is final, and a later `revertPromotion` is a no-op. */
  commitPromotion(sessionId: string): void {
    this.#db.prepare("UPDATE network_sessions SET promoted_from = NULL, updated_at = ? WHERE session_id = ? AND promoted_from IS NOT NULL").run(new Date().toISOString(), sessionId);
  }

  /** The session was deleted: revoke its sandboxes, placeholders, MCP routes, and history. */
  releaseSession(sessionId: string): void {
    const sandboxes = this.#db.prepare("SELECT sandbox_id FROM network_sandboxes WHERE session_id = ?").all(sessionId) as { sandbox_id: string }[];
    transaction(this.#db, () => {
      for (const table of ["network_sandboxes", "network_credentials", "network_mcp_routes", "network_events", "network_sessions"]) {
        this.#db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
      }
    });
    for (const { sandbox_id } of sandboxes) this.#options.egress.remove(sandbox_id);
  }

  // --- Vault credentials for a session -----------------------------------------------------------------------

  #credentialRows(sessionId: string): CredentialRow[] {
    return this.#db.prepare("SELECT * FROM network_credentials WHERE session_id = ? ORDER BY rowid").all(sessionId) as unknown as CredentialRow[];
  }

  /**
   * Live credentials of a session: rows whose vault and credential still exist, whose user vault still belongs to the
   * owner, and whose AppHost vault the session's current environment still grants (inline environments grant none).
   */
  #credentials(session: SessionNetwork): { row: CredentialRow; vault: VaultRecord; meta: CredentialMeta }[] {
    const granted = this.#declared(session.environment)?.vaults ?? [];
    const out: { row: CredentialRow; vault: VaultRecord; meta: CredentialMeta }[] = [];
    for (const row of this.#credentialRows(session.sessionId)) {
      const vault = this.#options.vaults.find(row.vault_id);
      if (!vault || (vault.kind === "user" ? vault.ownerId !== session.ownerId : !granted.includes(vault.id))) continue;
      const meta = vault.credentials.find((credential) => credential.key === row.credential_key);
      if (meta) out.push({ row, vault, meta });
    }
    return out;
  }

  /** Vault-backed headers for a remote MCP server. Shared placement goes through the MCP adapter instead. */
  mcpHeaders(sessionId: string, url: string, placement: Placement): Record<string, string> | undefined {
    const session = this.session(sessionId);
    if (!session) return undefined;
    const target = mcpKey(url);
    for (const { row, meta } of this.#credentials(session)) {
      if (meta.kind !== "mcp" || mcpKey(meta.mcpServer) !== target) continue;
      if (placement === "shared") return undefined;
      return { [meta.header]: meta.bearer ? `Bearer ${row.placeholder}` : row.placeholder };
    }
    return undefined;
  }

  /** The vault credential the MCP adapter attaches for `url`, resolved for one use. */
  mcpCredential(sessionId: string, url: string): { readonly header: string; readonly value: string; readonly vault: string } | undefined {
    const session = this.session(sessionId);
    if (!session) return undefined;
    const target = mcpKey(url);
    for (const { vault, meta } of this.#credentials(session)) {
      if (meta.kind !== "mcp" || mcpKey(meta.mcpServer) !== target) continue;
      const secret = this.#options.vaults.secret(vault.id, meta.key, session.ownerId);
      this.#log.info("Vault credential used", { sessionId, vault: vault.name, mcpServer: meta.mcpServer });
      return { header: meta.header, value: meta.bearer ? `Bearer ${secret}` : secret, vault: vault.name };
    }
    return undefined;
  }

  #revokeVault(vaultId: string): void {
    const sessions = this.#db.prepare("SELECT DISTINCT session_id FROM network_credentials WHERE vault_id = ?").all(vaultId) as { session_id: string }[];
    this.#db.prepare("DELETE FROM network_credentials WHERE vault_id = ?").run(vaultId);
    for (const { session_id } of sessions) {
      const row = this.#sessionRow(session_id);
      if (row) {
        const vaults = (JSON.parse(row.vaults) as string[]).filter((id) => id !== vaultId);
        this.#db.prepare("UPDATE network_sessions SET vaults = ?, updated_at = ? WHERE session_id = ?").run(JSON.stringify(vaults), new Date().toISOString(), session_id);
      }
      this.#pushSession(session_id);
    }
    if (sessions.length > 0) this.#log.info("Vault revoked from sessions", { vaultId, sessions: sessions.length });
  }

  // --- Sandboxes and egress registrations --------------------------------------------------------------------

  /**
   * Issues a fresh proxy credential for a sandbox (rotating any previous one) and returns the environment it needs.
   * Waits for the egress proxy when the session has network access or vault credentials. Throws rather than
   * returning a partial result.
   */
  async registerSandbox(input: SandboxRegistrationInput): Promise<SandboxEgress> {
    if (!SANDBOX_ID.test(input.sandboxId)) throw new ManagedCopilotError("invalid_request", "sandboxId must be 1-64 letters, digits, dashes, or underscores");
    const address = input.address === undefined ? undefined : canonicalIp(input.address);
    const authority = proxyAuthority(input.proxy);
    const session = this.session(input.sessionId);
    if (!session) throw new ManagedCopilotError("invalid_request", `Session ${input.sessionId} has no network binding; bind it (policy.bindSession) before allocating a sandbox`);
    if (session.type !== "isolated") throw new ManagedCopilotError("policy_violation", `Session ${input.sessionId} is a shared session; promote it before it gets a sandbox`);
    const credentials = this.#credentials(session).filter(({ meta }) => meta.kind === "env");
    const needsEgress = session.policy.access !== "disabled" || credentials.length > 0;
    // When the platform runs the egress proxy, every sandbox waits for it, so the proxy exists before the sandbox
    // provider attaches it to the sandbox's network (it then denies everything for network: false).
    if ((needsEgress || this.#options.alwaysWaitForEgress) && !this.#options.egress.ready) {
      this.#options.egress.ensureStarted?.();
      try {
        await this.#options.egress.waitReady(this.#options.egressWaitMs ?? 120_000);
      } catch {
        throw new ManagedCopilotError(
          "capability_unavailable",
          "The egress proxy is not running, so a sandbox with network access or vault credentials cannot start. Check that Docker is running and see the gateway log (network).",
        );
      }
    }
    const secret = randomBytes(32).toString("base64url");
    const existing = this.#db.prepare("SELECT revision FROM network_sandboxes WHERE sandbox_id = ?").get(input.sandboxId) as { revision: number } | undefined;
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO network_sandboxes (sandbox_id, session_id, credential_hash, address, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sandbox_id) DO UPDATE SET session_id = excluded.session_id, credential_hash = excluded.credential_hash, address = excluded.address,
           revision = excluded.revision, updated_at = excluded.updated_at`,
      )
      .run(input.sandboxId, input.sessionId, sha256(secret), address ?? null, (existing?.revision ?? 0) + 1, now, now);
    this.#pushSandbox(input.sandboxId);
    const proxyUrl = `http://${input.sandboxId}:${secret}@${authority}`;
    const env: Record<string, string> = {
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY,
      no_proxy: NO_PROXY,
      NODE_USE_ENV_PROXY: "1",
    };
    for (const { row, meta } of credentials) if (meta.kind === "env") env[meta.env] = row.placeholder;
    this.#log.info("Sandbox egress registered", { sandboxId: input.sandboxId, sessionId: input.sessionId, access: session.policy.access, vaultEntries: credentials.length });
    return { sandboxId: input.sandboxId, sessionId: input.sessionId, policy: session.policy, proxyUrl, env, caCertificate: this.#options.egress.caCertificate() ?? "" };
  }

  /** Pins the sandbox's proxy credential to its source address (its IP on its own network). */
  updateSandbox(sandboxId: string, update: { readonly address?: string }): void {
    const address = update.address === undefined ? undefined : canonicalIp(update.address);
    const result = this.#db.prepare("UPDATE network_sandboxes SET address = ?, revision = revision + 1, updated_at = ? WHERE sandbox_id = ?").run(address ?? null, new Date().toISOString(), sandboxId);
    if (result.changes === 0) throw new ManagedCopilotError("not_found", `Sandbox ${sandboxId} is not registered`);
    this.#pushSandbox(sandboxId);
  }

  unregisterSandbox(sandboxId: string): void {
    this.#db.prepare("DELETE FROM network_sandboxes WHERE sandbox_id = ?").run(sandboxId);
    this.#options.egress.remove(sandboxId);
  }

  #registration(row: SandboxRow): EgressRegistration | undefined {
    const session = this.session(row.session_id);
    if (!session) return undefined;
    // Only isolated sessions have sandbox egress; a sandbox left behind by a reverted promotion gets none.
    const isolated = session.type === "isolated";
    const credentials: EgressCredentialBinding[] = [];
    for (const { row: credential, meta } of isolated ? this.#credentials(session) : []) {
      if (meta.kind === "env") {
        credentials.push({ id: credential.id, placeholder: credential.placeholder, destinations: meta.destinations, headers: meta.headers });
      } else {
        const url = new URL(meta.mcpServer);
        const host = normalizeDestinationHost(url.hostname)?.host;
        if (host && (url.port === "" || url.port === "443")) credentials.push({ id: credential.id, placeholder: credential.placeholder, destinations: [{ host, port: 443 }], headers: [meta.header] });
      }
    }
    return {
      sandboxId: row.sandbox_id,
      sessionId: row.session_id,
      credentialHash: row.credential_hash,
      ...(row.address ? { address: row.address } : {}),
      policy: isolated ? session.policy : NETWORK_DISABLED,
      credentials,
      revision: row.revision,
    };
  }

  /** Every active registration, for the egress proxy's snapshot. */
  registrations(): EgressRegistration[] {
    const rows = this.#db.prepare("SELECT * FROM network_sandboxes ORDER BY rowid").all() as unknown as SandboxRow[];
    return rows.flatMap((row) => this.#registration(row) ?? []);
  }

  #pushSandbox(sandboxId: string): void {
    const row = this.#db.prepare("SELECT * FROM network_sandboxes WHERE sandbox_id = ?").get(sandboxId) as SandboxRow | undefined;
    const registration = row ? this.#registration(row) : undefined;
    if (registration) this.#options.egress.upsert(registration);
    else this.#options.egress.remove(sandboxId);
  }

  #pushSession(sessionId: string): void {
    const rows = this.#db.prepare("SELECT sandbox_id FROM network_sandboxes WHERE session_id = ?").all(sessionId) as { sandbox_id: string }[];
    for (const { sandbox_id } of rows) {
      this.#db.prepare("UPDATE network_sandboxes SET revision = revision + 1 WHERE sandbox_id = ?").run(sandbox_id);
      this.#pushSandbox(sandbox_id);
    }
  }

  /**
   * Authorizes one use of a vault credential by the egress proxy and returns its value. Every check is repeated
   * here: the sandbox and its session are active, the placeholder belongs to that session, the vault still exists
   * and belongs to the session's owner, and the destination, header, and network policy all allow the use.
   */
  resolveSecret(request: EgressSecretRequest): string {
    const deny = (message: string) => new ManagedCopilotError("forbidden", message);
    const sandbox = this.#db.prepare("SELECT * FROM network_sandboxes WHERE sandbox_id = ?").get(request.sandboxId) as SandboxRow | undefined;
    if (!sandbox) throw deny("This sandbox is no longer registered.");
    const session = this.session(sandbox.session_id);
    if (!session) throw deny("This sandbox's session no longer exists.");
    // Matches the registrations: only isolated sessions have sandbox egress (a reverted promotion's candidate has none).
    if (session.type !== "isolated") throw deny("This session is not running in an isolated sandbox, so its sandboxes cannot use vault credentials.");
    const credential = this.#credentials(session).find(({ row }) => row.id === request.credentialId && row.placeholder === request.placeholder);
    if (!credential) throw deny("This vault credential was revoked or never belonged to this session.");
    const { vault, meta } = credential;
    const host = normalizeDestinationHost(request.host)?.host;
    const destinationOk =
      meta.kind === "env"
        ? meta.destinations.some((destination) => destination.host === host && destination.port === request.port) && meta.headers.includes(request.header)
        : normalizeDestinationHost(new URL(meta.mcpServer).hostname)?.host === host && request.port === 443 && meta.header === request.header;
    if (!host || !destinationOk) throw deny(`This vault credential is not valid for ${request.header} on ${request.host}:${request.port}.`);
    if (!isHostAllowed(session.policy, host)) throw deny(`${host} is not allowed by this session's network policy.`);
    const value = this.#options.vaults.secret(vault.id, meta.key, session.ownerId);
    this.#log.info("Vault credential used", { sessionId: session.sessionId, sandboxId: request.sandboxId, vault: vault.name, entry: meta.kind === "env" ? meta.env : meta.mcpServer, host });
    return value;
  }

  // --- Blocked attempts --------------------------------------------------------------------------------------

  /** Records blocked attempts from the egress proxy, attributed by sandbox registration, never by the reported session. */
  record(reports: readonly EgressReport[]): void {
    for (const report of reports) {
      if (typeof report.sandboxId !== "string" || !report.sandboxId) continue;
      const sandbox = this.#db.prepare("SELECT session_id FROM network_sandboxes WHERE sandbox_id = ?").get(report.sandboxId) as { session_id: string } | undefined;
      if (sandbox) this.recordForSession(sandbox.session_id, report);
    }
  }

  recordForSession(sessionId: string, report: Omit<EgressReport, "sessionId">): void {
    const session = this.session(sessionId);
    if (!session) return;
    const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : null);
    const entry: EgressReport = {
      sandboxId: text(report.sandboxId, 64) ?? "",
      sessionId,
      at: text(report.at, 40) ?? new Date().toISOString(),
      reason: text(report.reason, 40) as EgressBlockReason,
      message: text(report.message, 500) ?? "",
      ...(typeof report.host === "string" ? { host: report.host.slice(0, 253) } : {}),
      ...(typeof report.port === "number" ? { port: report.port } : {}),
      ...(typeof report.method === "string" ? { method: report.method.slice(0, 16) } : {}),
      ...(typeof report.path === "string" ? { path: report.path.slice(0, 512) } : {}),
    };
    this.#db
      .prepare("INSERT INTO network_events (session_id, sandbox_id, at, reason, host, port, method, path, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sessionId, entry.sandboxId || null, entry.at, entry.reason, entry.host ?? null, entry.port ?? null, entry.method ?? null, entry.path ?? null, entry.message);
    this.#db
      .prepare("DELETE FROM network_events WHERE session_id = ? AND id NOT IN (SELECT id FROM network_events WHERE session_id = ? ORDER BY id DESC LIMIT ?)")
      .run(sessionId, sessionId, EVENTS_PER_SESSION);
    this.#options.onBlocked?.(session, entry);
  }

  /** Recent blocked attempts for a session, newest first. */
  blocked(sessionId: string, limit = 50): BlockedEvent[] {
    const rows = this.#db
      .prepare("SELECT * FROM network_events WHERE session_id = ? ORDER BY id DESC LIMIT ?")
      .all(sessionId, Math.max(1, Math.min(limit, EVENTS_PER_SESSION))) as {
      id: number;
      sandbox_id: string | null;
      at: string;
      reason: EgressBlockReason;
      host: string | null;
      port: number | null;
      method: string | null;
      path: string | null;
      message: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      sandboxId: row.sandbox_id ?? "",
      sessionId,
      at: row.at,
      reason: row.reason,
      message: row.message,
      ...(row.host ? { host: row.host } : {}),
      ...(row.port ? { port: row.port } : {}),
      ...(row.method ? { method: row.method } : {}),
      ...(row.path ? { path: row.path } : {}),
    }));
  }
}

function canonicalIp(value: string): string {
  const parsed = parseIpAddress(value);
  if (!parsed) throw new ManagedCopilotError("invalid_request", `"${value}" is not an IP address`);
  return value.trim().toLowerCase();
}

const PROXY_HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** `host:port` of the egress proxy as a sandbox reaches it: the `mc-egress:3128` alias unless the provider says otherwise. */
function proxyAuthority(proxy: SandboxRegistrationInput["proxy"]): string {
  if (proxy === undefined) return `${EGRESS_PROXY_HOST}:${EGRESS_PROXY_PORT}`;
  const { port } = proxy;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ManagedCopilotError("invalid_request", "proxy.port must be an integer from 1 to 65535");
  const host = String(proxy.host ?? "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const ip = parseIpAddress(host);
  if (ip) return ip.version === 6 ? `[${formatIpAddress(ip)}]:${port}` : `${formatIpAddress(ip)}:${port}`;
  if (!PROXY_HOST_NAME.test(host)) throw new ManagedCopilotError("invalid_request", "proxy.host must be a host name or an IP address");
  return `${host}:${port}`;
}

/** Normalizes an MCP URL for matching vault credentials (no fragment, default port, lowercase host). */
export function mcpKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}
