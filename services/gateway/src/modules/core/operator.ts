// Core's operator views (spec section 16): the gateway process, the shared runtime, sessions of every owner with
// their harness configuration, live connections, accounts, environments with their deployed customizations, and
// platform events reduced to metadata. Read-only, and reading never makes a session resident. The operator module
// authorizes callers; nothing here returns a credential or conversation content.
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  DEFAULT_MAX_WORKERS,
  ManagedCopilotError,
  NETWORK_ENABLED,
  normalizeNetwork,
  SANDBOX_SIZES,
  sandboxedType,
  type AccountInfo,
  type CustomizationFile,
  type CustomizationFileInfo,
  type EnvironmentConfig,
  type GatewayStatus,
  type InfraFact,
  type OperatorConnection,
  type OperatorCustomizations,
  type OperatorEnvironment,
  type OperatorEnvironmentRequest,
  type OperatorEnvironments,
  type OperatorEvent,
  type OperatorSessionDetail,
  type OperatorSessionQuery,
  type OperatorSessionSummary,
  type OperatorUpstream,
  type OperatorVaultRef,
  type PlatformEvent,
  type SharedRuntimeStatus,
  type StorageStatus,
} from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import { looksSecret, redactPath, redactText, redactUrl, redactValue, REDACTED } from "../../redaction.js";
import { isRecord } from "./admission.js";
import { accountInfo } from "./auth.js";
import type { CustomizationBundle, SessionRecord } from "./contracts.js";
import { parseAgentFile, type Environments } from "./environments.js";
import { harnessOf, toolPolicyOf } from "./harness.js";
import type { SessionLedger } from "./ledger.js";
import type { PlatformTools } from "./registries.js";
import { deploymentInfo } from "./routes.js";
import type { ClientConnection } from "./router.js";
import type { SharedRuntime } from "./runtime.js";
import { pathScrubber, type LiveSessionSnapshot, type SessionManager } from "./sessions.js";

/** What the operator console shows of a customization file at most. */
const FILE_LIMIT_BYTES = 256 * 1024;
/** Keys of platform event data that may carry content; never shown. */
const CONTENT_KEYS = /^(prompt|content|arguments|args|result|results|payload|event|messages?|text|body|capability|output)$/i;
const SENSITIVE_KEYS = /token|secret|password|passwd|credential|cookie|authorization|apikey|api_key|private|signature|placeholder/i;

export interface CoreOperatorOptions {
  readonly app: GatewayApp;
  readonly ledger: SessionLedger;
  readonly manager: SessionManager;
  readonly runtime: SharedRuntime | undefined;
  readonly environments: Environments;
  readonly platformTools: PlatformTools;
  readonly connections: () => readonly ClientConnection[];
}

/** A session's detail as far as core knows it; the operator module adds sandbox, network, actions, and the rest. */
export type CoreSessionDetail = Omit<OperatorSessionDetail, "network" | "sandbox" | "actions" | "promotion" | "artifacts" | "schedules">;

export interface CoreAccountView {
  readonly account: AccountInfo;
  readonly lastSeenAt: string;
  readonly sessions: number;
  readonly live: number;
  readonly connections: number;
}

export class CoreOperator {
  readonly #options: CoreOperatorOptions;
  readonly #scrub: (value: unknown) => unknown;
  readonly #delay = monitorEventLoopDelay({ resolution: 20 });
  #lastDelay: { p50: number; p99: number; max: number } | undefined;
  readonly #delayTimer: NodeJS.Timeout;
  /** Customization views by environment and bundle digest (pinned bundles never change). */
  readonly #bundleViews = new Map<string, OperatorCustomizations>();

  constructor(options: CoreOperatorOptions) {
    this.#options = options;
    this.#scrub = pathScrubber(options.app.config.dataDir);
    this.#delay.enable();
    // Each reading covers the last full minute (or the current one, before a minute has passed).
    this.#delayTimer = setInterval(() => {
      this.#lastDelay = this.#readDelay();
      this.#delay.reset();
    }, 60_000);
    this.#delayTimer.unref();
  }

  close(): void {
    clearInterval(this.#delayTimer);
    this.#delay.disable();
  }

  #readDelay(): { p50: number; p99: number; max: number } {
    const ms = (ns: number) => (Number.isFinite(ns) ? Math.round(ns / 1e5) / 10 : 0);
    return { p50: ms(this.#delay.percentile(50)), p99: ms(this.#delay.percentile(99)), max: ms(this.#delay.max) };
  }

  // --- Process, runtime, storage --------------------------------------------------------------------------------

  /** The gateway process (operators are added by the operator module, which owns that rule). */
  gateway(): Omit<GatewayStatus, "operators"> {
    const { app } = this.#options;
    const config = app.config;
    const env = config.env;
    const memory = process.memoryUsage();
    const info = deploymentInfo(app, this.#options.environments, this.#options.runtime);
    const facts: InfraFact[] = [];
    const fact = (label: string, value: string | undefined, mono = true) => {
      if (value) facts.push({ label, value, mono });
    };
    fact("Instance", env.MANAGED_COPILOT_INSTANCE ?? "mc");
    fact("Data directory", config.dataDir);
    fact("AppHost directory", config.appHostDir);
    fact("Local discovery", config.writeDiscovery ? "Advertised for ManagedCopilot.connect()" : "Off", false);
    fact("GitHub API", config.githubApiUrl);
    fact("Container App", env.CONTAINER_APP_NAME);
    fact("Revision", env.CONTAINER_APP_REVISION);
    fact("Replica", env.CONTAINER_APP_REPLICA_NAME);
    fact("Lease generation", env.MANAGED_COPILOT_LEASE_GENERATION);
    fact("Lease stamp", env.MANAGED_COPILOT_LEASE_STAMP);
    fact("npm registry", env.MANAGED_COPILOT_NPM_REGISTRY);
    fact("pip index", env.MANAGED_COPILOT_PIP_INDEX_URL);
    return {
      version: config.version,
      mode: config.mode,
      publicUrl: config.publicUrl,
      listen: `${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}`,
      pid: process.pid,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      startedAt: app.startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - app.startedAt.getTime()) / 1000),
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal },
      eventLoopDelayMs: this.#lastDelay ?? this.#readDelay(),
      modules: [...app.modules],
      capabilities: info.capabilities,
      access: {
        githubUsers: config.deployment.access?.githubUsers ?? [],
        githubOrgs: config.deployment.access?.githubOrgs ?? [],
        open: !config.deployment.access?.githubUsers?.length && !config.deployment.access?.githubOrgs?.length,
      },
      facts,
    };
  }

  /** `/v1/info`'s capabilities and versions. */
  info(): ReturnType<typeof deploymentInfo> {
    return deploymentInfo(this.#options.app, this.#options.environments, this.#options.runtime);
  }

  storage(): StorageStatus {
    const dataDir = this.#options.app.config.dataDir;
    const size = (file: string) => {
      try {
        return statSync(join(dataDir, file)).size;
      } catch {
        return 0;
      }
    };
    return { dataDir, databaseBytes: size("gateway.db"), walBytes: size("gateway.db-wal") };
  }

  runtime(): SharedRuntimeStatus {
    const runtime = this.#options.runtime;
    const sessions = this.#options.manager.operatorLive().filter((live) => live.placement === "shared" && live.resident).length;
    if (!runtime) return { state: "disabled", external: false, generation: 0, restarts: 0, sessions };
    const status = runtime.status();
    return { ...status, ...(status.lastError ? { lastError: redactText(status.lastError) } : {}), sessions };
  }

  // --- Sessions ---------------------------------------------------------------------------------------------------

  /** The account ID an owner filter names (a login or a numeric ID); undefined when no account matches. */
  #ownerId(owner: string): number | undefined {
    const trimmed = owner.trim().replace(/^@/, "");
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    return this.#options.ledger.accounts().find((account) => account.login.toLowerCase() === trimmed.toLowerCase())?.id;
  }

  sessions(query: OperatorSessionQuery = {}): OperatorSessionSummary[] {
    const ownerId = query.owner ? this.#ownerId(query.owner) : undefined;
    if (query.owner && ownerId === undefined) return [];
    const records = this.#options.manager.operatorRecords({
      ...(ownerId !== undefined ? { ownerId } : {}),
      ...(query.environment ? { environment: query.environment } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(query.placement ? { placement: query.placement } : {}),
      ...(query.q ? { idPrefix: query.q.trim() } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    const live = new Map(this.#options.manager.operatorLive().map((snapshot) => [snapshot.id, snapshot]));
    return records.map((record) => summaryOf(record, live.get(record.id)));
  }

  /** One session's core detail; undefined for unknown and deleted sessions. */
  session(sessionId: string): CoreSessionDetail | undefined {
    const { manager, platformTools } = this.#options;
    const record = manager.get(sessionId);
    if (!record) return undefined;
    const snapshot = manager.operatorLive(sessionId)[0];
    let harness: CoreSessionDetail["harness"];
    let harnessProblem: string | undefined;
    try {
      const admitted = manager.operatorAdmitted(sessionId);
      if (admitted) {
        const tools = platformTools.forSession({ environment: record.environment, type: record.type, placement: record.placement });
        harness = harnessOf(admitted, { placement: record.placement, platformTools: tools, scrub: this.#scrub });
      } else harnessProblem = "The session has no stored configuration.";
    } catch (error) {
      harnessProblem = `The session's stored configuration could not be read (${(error as Error).message}).`;
    }
    const request = record.environmentRequest;
    const environmentRequest: OperatorEnvironmentRequest = {
      ...(request.name ? { name: request.name } : {}),
      ...(request.type ? { type: request.type } : {}),
      ...(request.size ? { size: request.size } : {}),
      ...(request.network !== undefined ? { network: request.network } : {}),
      ...(request.vaults ? { vaults: request.vaults } : {}),
      ...(request.packages ? { packages: redactPackages(request.packages) } : {}),
      ...(request.env ? { env: Object.keys(request.env).sort() } : {}),
      ...(request.files ? { files: Object.entries(request.files).map(([path, content]) => ({ path, bytes: base64Bytes(content) })) } : {}),
    };
    return {
      ...summaryOf(record, snapshot),
      incarnation: record.incarnation,
      ...(record.webhook ? { webhook: record.webhook } : {}),
      environmentRequest,
      ...(harness ? { harness } : {}),
      ...(harnessProblem ? { harnessProblem } : {}),
      attachments: snapshot?.attachments ?? [],
      ...(snapshot
        ? {
            runtime: {
              ready: snapshot.ready,
              ...(snapshot.upstream ? { upstream: snapshot.upstream } : {}),
              restoring: snapshot.restoring,
              cutover: snapshot.cutover,
              deleting: snapshot.deleting,
              waits: snapshot.waits,
              presences: snapshot.presences,
            },
          }
        : {}),
    };
  }

  sessionCounts(): ReturnType<SessionLedger["sessionCounts"]> & { live: number } {
    return { ...this.#options.ledger.sessionCounts(), live: this.#options.manager.operatorLive().filter((snapshot) => snapshot.resident).length };
  }

  // --- Connections and accounts -----------------------------------------------------------------------------------

  connections(): OperatorConnection[] {
    const live = this.#options.manager.operatorLive();
    const attachedTo = new Map<string, string[]>();
    const cli: OperatorConnection[] = [];
    for (const snapshot of live) {
      for (const attachment of snapshot.attachments) {
        const list = attachedTo.get(attachment.connectionId) ?? [];
        list.push(snapshot.id);
        attachedTo.set(attachment.connectionId, list);
        if (attachment.kind === "cli") {
          cli.push({
            id: attachment.connectionId,
            kind: "cli",
            account: attachment.account,
            environment: snapshot.environment,
            clientName: attachment.clientName ?? "copilot-cli",
            connectedAt: attachment.attachedAt,
            sessions: [snapshot.id],
          });
        }
      }
    }
    const sdk = this.#options.connections().map((connection): OperatorConnection => {
      const stats = connection.stats;
      return {
        id: connection.id,
        kind: "sdk",
        account: accountInfo(connection.principal),
        environment: connection.environment.name,
        ...(connection.clientName ? { clientName: connection.clientName } : {}),
        connectedAt: connection.connectedAt,
        lastActivityAt: stats.lastActivityAt,
        requests: stats.requests,
        notifications: stats.notifications,
        sessions: attachedTo.get(connection.id) ?? [],
      };
    });
    return [...sdk, ...cli].sort((a, b) => (b.connectedAt ?? "").localeCompare(a.connectedAt ?? ""));
  }

  upstreams(): OperatorUpstream[] {
    const groups = new Map<string, { kind: "shared" | "sandbox"; sessions: string[]; version?: string }>();
    const current = this.#options.runtime?.current();
    if (current) groups.set("shared", { kind: "shared", sessions: [], version: current.version });
    for (const snapshot of this.#options.manager.operatorLive()) {
      if (!snapshot.upstream || !snapshot.resident) continue;
      const group = groups.get(snapshot.upstream) ?? { kind: snapshot.upstream === "shared" ? "shared" : "sandbox", sessions: [], ...(snapshot.upstreamVersion ? { version: snapshot.upstreamVersion } : {}) };
      group.sessions.push(snapshot.id);
      groups.set(snapshot.upstream, group);
    }
    return [...groups].map(([id, group]) => ({ id, kind: group.kind, sessions: group.sessions, ...(group.version ? { version: group.version } : {}) }));
  }

  accounts(): CoreAccountView[] {
    const counts = this.#options.ledger.sessionCounts().byOwner;
    const live = this.#options.manager.operatorLive();
    const connections = this.connections();
    return this.#options.ledger.accounts().map(({ lastSeenAt, ...account }) => ({
      account,
      lastSeenAt,
      sessions: counts[account.id] ?? 0,
      live: live.filter((snapshot) => snapshot.ownerId === account.id && snapshot.resident).length,
      connections: connections.filter((connection) => connection.account.id === account.id).length,
    }));
  }

  /** Account details by ID, for records other modules keep by owner ID. */
  accountDirectory(): (id: number) => AccountInfo {
    const known = new Map(this.#options.ledger.accounts().map(({ lastSeenAt: _seen, ...account }) => [account.id, account as AccountInfo]));
    return (id) => known.get(id) ?? { id, login: String(id) };
  }

  // --- Environments and customizations ----------------------------------------------------------------------------

  environments(): OperatorEnvironments {
    const { app, environments, platformTools } = this.#options;
    const deployment = app.config.deployment;
    const counts = this.#options.ledger.sessionCounts().byEnvironment;
    const live = this.#options.manager.operatorLive().filter((snapshot) => snapshot.resident);
    const azureImages = parseImages(app.config.env.MANAGED_COPILOT_AZURE_SANDBOX_IMAGES);
    const list: OperatorEnvironment[] = Object.entries(deployment.environments).map(([name, config]) => {
      const state = environments.customizations(name);
      const network = environments.ceiling(config);
      const size = sandboxedType(config.type) ? (config.size ?? "small") : undefined;
      const image = config.image ? this.#appHostRelative(config.image) : sandboxedType(config.type) ? (azureImages[name] ?? azureImages["*"]) : undefined;
      return {
        name,
        type: config.type,
        ...(config.description ? { description: config.description } : {}),
        ...(config.models ? { models: config.models } : {}),
        network,
        ...(size ? { size, resources: { cpus: SANDBOX_SIZES[size].cpus, memoryMiB: SANDBOX_SIZES[size].memoryMiB } } : {}),
        ...(image ? { image } : {}),
        ...(config.packages ? { packages: redactPackages(config.packages) } : {}),
        ...(config.setupCommands ? { setupCommands: config.setupCommands.map(redactText) } : {}),
        // Meant to be non-secret, but nothing enforces that: values under credential-like names or shapes are masked.
        ...(config.env ? { env: redactValue(config.env) as Record<string, string> } : {}),
        vaults: (config.vaults ?? []).map((vault) => this.#vaultRef(vault)),
        scheduling: config.scheduling === true,
        ...(config.promoteTo ? { promoteTo: config.promoteTo } : {}),
        ...(config.workers ? { workers: config.workers, maxWorkers: config.maxWorkers ?? DEFAULT_MAX_WORKERS } : {}),
        ...(config.type === "orchestrator" ? { execution: config.execution ?? "delegate", ...(config.execution && config.execution !== "delegate" ? { subagents: config.subagents ?? "shared" } : {}) } : {}),
        ...(config.idleTimeoutSeconds !== undefined ? { idleTimeoutSeconds: config.idleTimeoutSeconds } : {}),
        ...(config.warm !== undefined ? { warm: config.warm } : {}),
        ...(config.inference ? { inference: config.inference } : {}),
        ...(state ? { customizations: this.#customizations(name, state.source, state.bundle, state.problem) } : {}),
        tools: toolPolicyOf(name, config, network, state?.bundle, platformTools),
        webhooks: Object.entries(deployment.webhooks ?? {})
          .filter(([, webhook]) => webhook.environments.includes(name))
          .map(([webhook]) => webhook),
        schedules: Object.entries(deployment.schedules ?? {})
          .filter(([, schedule]) => schedule.environment === name)
          .map(([schedule]) => schedule),
        sessions: { total: counts[name] ?? 0, live: live.filter((snapshot) => snapshot.environment === name).length },
      };
    });
    return {
      environments: list,
      ...(deployment.inline ? { inline: deployment.inline } : {}),
      defaultNetwork: normalizeNetwork(deployment.network, NETWORK_ENABLED),
    };
  }

  #appHostRelative(path: string): string {
    if (!isAbsolute(path)) return path;
    const rel = relative(this.#options.app.config.appHostDir, path);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : path;
  }

  #vaultRef(name: string): OperatorVaultRef {
    const { env, deployment } = this.#options.app.config;
    const credentials = deployment.vaults?.[name] ?? [];
    return {
      name,
      credentials: credentials.map((credential) =>
        "env" in credential
          ? { env: credential.env, hosts: credential.hosts, headers: credential.headers ?? ["authorization"] }
          : { mcpServer: redactUrl(credential.mcpServer), header: credential.header ?? "authorization" },
      ),
      configured: credentials.length > 0 && credentials.every((credential) => Boolean(env[credential.value.secretEnv])),
    };
  }

  #customizations(environment: string, source: string, bundle: CustomizationBundle | undefined, problem: string | undefined): OperatorCustomizations {
    const key = `${environment}:${bundle?.digest ?? "none"}`;
    const cached = this.#bundleViews.get(key);
    if (cached) return cached;
    const files = bundle ? this.#listFiles(bundle) : [];
    const agentFiles = new Map<string, string>();
    if (bundle) {
      for (const file of files.filter((candidate) => candidate.kind === "agent")) {
        const name = parseAgentFile(file.path.split("/").pop()!, this.#readText(bundle, file.path, 64 * 1024)).name;
        if (!agentFiles.has(name)) agentFiles.set(name, file.path);
      }
    }
    const view: OperatorCustomizations = {
      source: this.#appHostRelative(source),
      ...(bundle ? { digest: bundle.digest } : {}),
      ...(problem ? { problem } : {}),
      agents: (bundle?.agents ?? []).map((agent) => ({ ...agent, ...(agentFiles.has(agent.name) ? { file: agentFiles.get(agent.name)! } : {}) })),
      skills: bundle
        ? files
            .filter((file) => /^skills\/[^/]+\/SKILL\.md$/i.test(file.path))
            .map((file) => {
              const parsed = parseAgentFile(file.path.split("/")[1]!, this.#readText(bundle, file.path, 64 * 1024));
              return { name: parsed.name, ...(parsed.description ? { description: parsed.description } : {}), file: file.path };
            })
        : [],
      instructions: files.filter((file) => file.kind === "instruction").map((file) => ({ file: file.path })),
      files,
    };
    this.#bundleViews.set(key, view);
    return view;
  }

  #listFiles(bundle: CustomizationBundle): CustomizationFileInfo[] {
    const files: CustomizationFileInfo[] = [];
    const walk = (directory: string, prefix: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(directory, entry.name), path);
        else if (entry.isFile()) files.push({ path, size: statSync(join(directory, entry.name)).size, kind: fileKind(path) });
      }
    };
    try {
      walk(bundle.root, "");
    } catch {
      return [];
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Reads one deployed customization file of an environment (its pinned copy, which sessions use). */
  customizationFile(environment: string, path: string): CustomizationFile {
    const state = this.#options.environments.customizations(environment);
    if (!this.#options.app.config.deployment.environments[environment]) throw new ManagedCopilotError("environment_not_found", `Environment "${environment}" is not declared in this deployment`, { environment });
    const bundle = state?.bundle;
    if (!bundle) throw new ManagedCopilotError("not_found", state?.problem ?? `Environment "${environment}" deploys no customizations`, { environment });
    const relativePath = safeRelative(path);
    const full = this.#resolveInBundle(bundle, relativePath);
    const size = statSync(full).size;
    const buffer = readPrefix(full, FILE_LIMIT_BYTES);
    const binary = buffer.subarray(0, 8192).includes(0);
    return {
      environment,
      path: relativePath,
      size,
      kind: fileKind(relativePath),
      content: binary ? "" : buffer.toString("utf8"),
      truncated: size > FILE_LIMIT_BYTES,
      ...(binary ? { binary: true } : {}),
    };
  }

  #readText(bundle: CustomizationBundle, path: string, limit: number): string {
    try {
      return readPrefix(this.#resolveInBundle(bundle, path), limit).toString("utf8");
    } catch {
      return "";
    }
  }

  /** The file's absolute path inside the pinned bundle; anything outside it (or not a regular file) is not found. */
  #resolveInBundle(bundle: CustomizationBundle, relativePath: string): string {
    const notFound = () => new ManagedCopilotError("not_found", `No customization file "${relativePath}"`, { path: relativePath });
    const full = join(bundle.root, ...relativePath.split("/"));
    if (!existsSync(full)) throw notFound();
    const stat = lstatSync(full);
    if (!stat.isFile()) throw notFound();
    const root = realpathSync(bundle.root);
    const real = realpathSync(full);
    if (real !== root && !real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) throw notFound();
    return full;
  }

  // --- Events -------------------------------------------------------------------------------------------------------

  events(query: { readonly limit?: number; readonly type?: string } = {}): OperatorEvent[] {
    const account = this.accountDirectory();
    return this.#options.ledger.recentEvents(query).map(({ event, ownerId }) => this.toOperatorEvent(event, account(ownerId)));
  }

  /** A platform event reduced to metadata: content-like and credential-like fields are dropped, long text bounded. */
  toOperatorEvent(event: PlatformEvent, owner: AccountInfo): OperatorEvent {
    return {
      id: event.id,
      type: event.type,
      createdAt: event.createdAt,
      owner,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      ...(event.environment ? { environment: event.environment } : {}),
      ...(event.sandboxId ? { sandboxId: event.sandboxId } : {}),
      data: sanitizeEventData(event.data),
    };
  }
}

function fileKind(path: string): CustomizationFileInfo["kind"] {
  if (/^agents\/[^/]+\.md$/i.test(path)) return "agent";
  if (/^skills\//i.test(path)) return "skill";
  if (/^instructions\/[^/]+\.md$/i.test(path)) return "instruction";
  return "other";
}

function summaryOf(record: SessionRecord, snapshot: LiveSessionSnapshot | undefined): OperatorSessionSummary {
  return {
    id: record.id,
    owner: record.owner,
    environment: record.environment,
    type: record.type,
    placement: record.placement,
    state: record.state,
    generation: record.generation,
    ...(record.model ? { model: record.model } : {}),
    ...(record.agent ? { agent: record.agent } : {}),
    ...(record.clientName ? { clientName: record.clientName } : {}),
    ...(record.scheduleId ? { scheduleId: record.scheduleId } : {}),
    ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
    ...(record.lastTurn ? { lastTurn: record.lastTurn } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    live: snapshot?.resident ?? false,
    attached: snapshot?.attachments.length ?? 0,
  };
}

/** A bundle-relative POSIX path: no absolute paths, backslashes, empty, `.`, or `..` segments. */
function safeRelative(path: string): string {
  const invalid = () => new ManagedCopilotError("invalid_request", "path must be a relative path inside the customizations folder, such as agents/planner.agent.md");
  if (typeof path !== "string" || !path || path.length > 512 || path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) throw invalid();
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw invalid();
  return segments.join("/");
}

function readPrefix(file: string, limit: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const read = readSync(fd, buffer, 0, limit, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Package specs with credentials masked (`git+https://<token>@host/...`, index URLs with keys). */
function redactPackages<T extends { readonly python?: readonly string[]; readonly npm?: readonly string[]; readonly system?: readonly string[] }>(packages: T): T {
  return Object.fromEntries(Object.entries(packages).map(([kind, specs]) => [kind, Array.isArray(specs) ? specs.map((spec: string) => redactText(spec)) : specs])) as T;
}

function base64Bytes(value: string): number {
  const compact = value.replace(/\s+/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function parseImages(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  } catch {
    return {};
  }
}

/** Event data without content or credentials: summaries of action and artifact lists, bounded strings. */
export function sanitizeEventData(data: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (CONTENT_KEYS.test(key) && key !== "message") continue;
    if (SENSITIVE_KEYS.test(key)) continue;
    if (key === "actions" && Array.isArray(value)) {
      out[key] = value.filter(isRecord).map((action) => pick(action, ["id", "kind", "state", "tool", "expiresAt"]));
    } else if (key === "artifacts" && Array.isArray(value)) {
      out[key] = value.filter(isRecord).map((artifact) => pick(artifact, ["id", "path", "version", "size"]));
    } else if (key === "network" && isRecord(value)) {
      out[key] = pick(value, ["access", "allowedDomains"]);
    } else if ((key === "path" || key === "url") && typeof value === "string") {
      out[key] = key === "url" ? redactUrl(value).slice(0, 500) : redactPath(value).slice(0, 500);
    } else {
      const bounded = bound(value, 0);
      if (bounded !== undefined) out[key] = bounded;
    }
  }
  return out;
}

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const bounded = bound(value[key], 1);
    if (bounded !== undefined) out[key] = bounded;
  }
  return out;
}

function bound(value: unknown, depth: number): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    if (looksSecret(value)) return REDACTED;
    // Messages can quote URLs, tokens, or (setup failures) command output.
    const text = redactText(value);
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return depth > 1 ? undefined : value.slice(0, 20).map((item) => bound(item, depth + 1)).filter((item) => item !== undefined);
  return undefined;
}

declare module "../../app.js" {
  interface GatewayServices {
    /** Core's operator views (read by the operator module). */
    coreOperator: CoreOperator;
  }
}

export type { LiveSessionSnapshot };
