// The `sandboxes` service (spec sections 4 and 5): per-session sandboxes on a pluggable backend (providers/), created
// only when setup and the runtime are ready, stopped when idle after work drains, resumed without replaying setup, and
// deleted with crash-safe reconciliation.
import { randomBytes } from "node:crypto";
import { createReadStream, promises as fs, type Stats } from "node:fs";
import { join } from "node:path";
import type { Duplex, Readable } from "node:stream";
import {
  isManagedCopilotError,
  isReservedSandboxEnv,
  ManagedCopilotError,
  SANDBOX_LIMITS,
  SANDBOX_PATHS,
  SANDBOXD_ROUTES,
  type EnvironmentConfig,
  type ErrorCode,
  type FileEntry,
  type SandboxInfo,
  type SandboxSetupPlan,
  type SandboxSetupRecord,
} from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import type { Logger } from "../../log.js";
import { SandboxAgentClient } from "./agent-client.js";
import type { ArtifactService } from "./artifacts.js";
import { InferenceBroker, isProviderTaken } from "./broker.js";
import type {
  CreateSandboxRequest,
  EgressRegistration,
  FileDownload,
  FileWriteOptions,
  OpenRuntimeOptions,
  RuntimeStateImport,
  SandboxesService,
  SandboxHandle,
  SandboxPolicyPort,
  SandboxRuntime,
  SandboxRuntimeEvent,
  SandboxSessionsPort,
} from "./contract.js";
import type { SandboxOperationOptions, SandboxProvider, SandboxSpec } from "./providers/types.js";
import { deferAgentSelection, rewriteSessionParams } from "./params.js";
import type { SandboxRow, SandboxStore } from "./store.js";

const ACTION_REQUESTED = new Set(["external_tool.requested", "permission.requested", "elicitation.requested"]);
const ACTION_COMPLETED = new Set(["external_tool.completed", "permission.completed", "elicitation.completed"]);
const IDLE_SWEEP_MS = Number(process.env.MANAGED_COPILOT_SANDBOX_IDLE_SWEEP_MS ?? 30_000) || 30_000;
const RECONCILE_MS = 5 * 60_000;
/** How long a failed publication waits for sandbox operations already queued for its session before classifying. */
const SETTLE_MS = 5_000;
/** How long gateway shutdown lets publications under way finish before it stops sandboxes. */
const SHUTDOWN_DRAIN_MS = 10_000;
/** How often the backend's readiness is re-checked for `available`. */
const PROBE_MS = 30_000;
/** How long a sandbox found running at startup stays protected while the ledger says its last turn was running. */
const RECOVERY_GRACE_MS = 2 * 60 * 60_000;
/** Why a turn's outputs were not published when the runtime process running the turn was replaced. */
const TURN_INTERRUPTED =
  "The sandbox runtime was restarted while this turn was running, so the turn ended and its outputs were not published. Send the prompt again to continue.";

interface LiveState {
  readonly runtimes: Set<SandboxRuntime>;
  readonly pending: Set<string>;
  busy: number;
  turnRunning: boolean;
  turnFailed: boolean;
  lastActivity: number;
  /** Set when reconciliation found the sandbox running after a gateway restart; cleared once its events flow again. */
  recoveredAt?: number;
  /** The runtime process (sandboxd's `runtime.instance`) the session's runtime connections last reached. */
  runtimeInstance?: string;
}

export interface SandboxServiceOptions {
  readonly app: GatewayApp;
  readonly store: SandboxStore;
  readonly provider: SandboxProvider;
  readonly log: Logger;
  readonly defaultIdleSeconds: number;
  /** Build the base image and reconcile on start even before any sandbox exists. */
  readonly prepareOnStart: boolean;
}

function optional<T>(app: GatewayApp, key: string): T | undefined {
  return (app.services as Record<string, unknown>)[key] as T | undefined;
}

function toManaged(error: unknown, fallback: ErrorCode = "internal"): ManagedCopilotError {
  if (error instanceof ManagedCopilotError) return error;
  return new ManagedCopilotError(fallback, (error as Error)?.message ?? String(error));
}

/** Appends the last lines of a failed step's (already redacted) output; clients may see only the error message. */
function withOutputTail(message: string, output: string | undefined): string {
  const lines = (output ?? "").trim().split("\n").slice(-8).join("\n").slice(-800).trim();
  return lines ? `${message}\nLast output:\n${lines}` : message;
}

const SETUP_PATH = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^\u0000-\u001f\u007f\\]+$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Exact decoded size of strict base64, or undefined when the text is not strict base64. */
function base64Size(value: string): number | undefined {
  const compact = value.replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || !BASE64.test(compact)) return undefined;
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return (compact.length / 4) * 3 - padding;
}

const IMPORT_LIMITS = { files: 10_000, bytes: 1024 * 1024 * 1024 } as const;

/** Regular files of a runtime-state export (relative POSIX paths), skipping lock files; anything else is refused. */
async function collectRuntimeState(directory: string): Promise<{ relative: string; absolute: string; size: number }[]> {
  let root: Stats;
  try {
    root = await fs.lstat(directory);
  } catch {
    throw new ManagedCopilotError("invalid_request", `The runtime state directory ${directory} does not exist.`);
  }
  if (!root.isDirectory()) throw new ManagedCopilotError("invalid_request", `The runtime state path ${directory} is not a directory.`);
  const files: { relative: string; absolute: string; size: number }[] = [];
  let total = 0;
  const walk = async (absolute: string, relative: string): Promise<void> => {
    for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
      // Lock files are never imported, whatever they are.
      if (entry.name.endsWith(".lock")) continue;
      const childAbsolute = join(absolute, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = await fs.lstat(childAbsolute);
      if (stat.isDirectory()) {
        await walk(childAbsolute, childRelative);
        continue;
      }
      if (!stat.isFile()) throw new ManagedCopilotError("invalid_request", `"${childRelative}" in the runtime state is a symbolic link or special file; only regular files can be imported.`);
      total += stat.size;
      if (files.length >= IMPORT_LIMITS.files) throw new ManagedCopilotError("invalid_request", `The runtime state has more than ${IMPORT_LIMITS.files} files.`);
      if (total > IMPORT_LIMITS.bytes) throw new ManagedCopilotError("invalid_request", "The runtime state is larger than 1 GiB.");
      files.push({ relative: childRelative, absolute: childAbsolute, size: stat.size });
    }
  };
  await walk(directory, "");
  return files;
}

export class SandboxService implements SandboxesService {
  readonly #options: SandboxServiceOptions;
  readonly #live = new Map<string, LiveState>();
  readonly #locks = new Map<string, Promise<unknown>>();
  /** Sessions with an active (non-deleted) sandbox; events for anything else are ignored cheaply. */
  readonly #active = new Set<string>();
  #artifacts: ArtifactService | undefined;
  /** Result of the latest backend readiness check; `/v1/info` advertises isolated placement only while true. */
  #available = false;
  /** The availability last logged (undefined until the first check finishes). */
  #reported: boolean | undefined;
  #probing: Promise<boolean> | undefined;
  /** Aborted at gateway shutdown; cancels slow backend operations. */
  readonly #shutdown = new AbortController();
  #timers: NodeJS.Timeout[] = [];
  #unsubscribe: (() => void) | undefined;
  #stopping = false;
  #stoppingCompute = false;
  /** Deletes requested through `delete()` that have not finished: the sandbox each targets (undefined = the current one). */
  readonly #pendingDeletes = new Map<string, (string | undefined)[]>();

  constructor(options: SandboxServiceOptions) {
    this.#options = options;
    for (const row of options.store.all()) if (row.state !== "deleted") this.#active.add(row.sessionId);
  }

  attachArtifacts(artifacts: ArtifactService): void {
    this.#artifacts = artifacts;
  }

  get #log(): Logger {
    return this.#options.log;
  }

  // Infrastructure helpers -------------------------------------------------------------------------------------

  /**
   * Whether the sandbox backend answered its latest readiness check (at registration, every 30 s, and before every
   * backend operation). `/v1/info` advertises `isolated` and `files` only while this is true.
   */
  get available(): boolean {
    return this.#available;
  }

  /** Checks the backend now (single flight) and records the result. */
  probe(): Promise<boolean> {
    this.#probing ??= this.#ready()
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        this.#probing = undefined;
      });
    return this.#probing;
  }

  #setAvailable(available: boolean, reason?: string): void {
    this.#available = available;
    if (this.#reported === available) return;
    this.#reported = available;
    const backend = this.#options.provider.kind;
    if (available) this.#log.info("Isolated sandboxes are available", { backend });
    else this.#log.warn("Isolated sandboxes are unavailable; /v1/info does not advertise them until the backend answers", { backend, reason });
  }

  async #ready(): Promise<void> {
    try {
      await this.#options.provider.ready();
      this.#setAvailable(true);
    } catch (error) {
      const managed = toManaged(error, "capability_unavailable");
      this.#setAvailable(false, managed.message);
      throw managed;
    }
  }

  #agent(row: SandboxRow): SandboxAgentClient {
    const { provider } = this.#options;
    return new SandboxAgentClient(
      () =>
        provider.endpoint(row.id).catch((error: unknown) => {
          throw toManaged(error, "capability_unavailable");
        }),
      row.key,
      () => provider.reportUnreachable?.(row.id),
    );
  }

  /** What the provider needs to (re)create this sandbox's compute. */
  #spec(row: SandboxRow, imageId: string): SandboxSpec {
    return {
      sandboxId: row.id,
      sessionId: row.sessionId,
      ownerId: row.ownerId,
      environment: row.environment,
      size: row.size,
      imageId,
      env: { SANDBOX_ID: row.id, SANDBOXD_KEY: row.key, SANDBOXD_RUNTIME_TOKEN: row.runtimeToken },
      ...(row.customizations ? { customizations: row.customizations } : {}),
    };
  }

  #policy(): SandboxPolicyPort | undefined {
    const policy = optional<SandboxPolicyPort>(this.#options.app, "policy");
    return policy && typeof policy.registerSandbox === "function" ? policy : undefined;
  }

  #sessions(): SandboxSessionsPort | undefined {
    return optional<SandboxSessionsPort>(this.#options.app, "sessions");
  }

  async #registerEgress(row: SandboxRow): Promise<EgressRegistration> {
    const policy = this.#policy();
    if (!policy) {
      if (row.network.access !== "disabled" || row.vaults.length > 0) {
        throw new ManagedCopilotError(
          "capability_unavailable",
          "Sandboxes with network access or vaults need the egress proxy, which this deployment does not provide. Use network: false for an offline sandbox.",
        );
      }
      return { env: {} };
    }
    try {
      const proxy = this.#options.provider.egressProxy?.();
      return await policy.registerSandbox({ sandboxId: row.id, sessionId: row.sessionId, ...(proxy ? { proxy } : {}) });
    } catch (error) {
      throw toManaged(error, "capability_unavailable");
    }
  }

  async #pinAddress(row: SandboxRow): Promise<void> {
    const policy = this.#policy();
    // Without source pinning (e.g. ingress-proxied backends) the per-sandbox proxy credential is the only binding.
    if (!policy || !this.#options.provider.capabilities.addressPinning) return;
    const address = await this.#options.provider.address(row.id);
    if (!address) throw new ManagedCopilotError("internal", "The sandbox has no address on its network.");
    await policy.updateSandbox(row.id, { address });
  }

  /** Progress and cancellation for slow backend operations. */
  #operation(row: SandboxRow): SandboxOperationOptions {
    return {
      signal: this.#shutdown.signal,
      onProgress: (message) => this.#log.info("Sandbox provisioning", { sessionId: row.sessionId, sandboxId: row.id, message }),
    };
  }

  get #startTimeoutMs(): number {
    return this.#options.provider.capabilities.startTimeoutMs ?? 60_000;
  }

  async #unregisterEgress(row: SandboxRow): Promise<void> {
    try {
      await this.#policy()?.unregisterSandbox(row.id);
    } catch (error) {
      this.#log.warn("Could not unregister the sandbox from egress", { sandboxId: row.id, error: (error as Error).message });
    }
  }

  #withLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.#locks.set(sessionId, settled);
    void settled.then(() => {
      if (this.#locks.get(sessionId) === settled) this.#locks.delete(sessionId);
    });
    return next;
  }

  #liveFor(sessionId: string): LiveState {
    let live = this.#live.get(sessionId);
    if (!live) {
      live = { runtimes: new Set(), pending: new Set(), busy: 0, turnRunning: false, turnFailed: false, lastActivity: Date.now() };
      this.#live.set(sessionId, live);
    }
    return live;
  }

  /** Marks the session busy for the duration of `work` (idle stop waits). */
  track<T>(sessionId: string, work: Promise<T>): Promise<T> {
    const live = this.#liveFor(sessionId);
    live.busy++;
    live.lastActivity = Date.now();
    return work.finally(() => {
      live.busy--;
      live.lastActivity = Date.now();
    });
  }

  touch(sessionId: string): void {
    const live = this.#live.get(sessionId);
    if (live) live.lastActivity = Date.now();
  }

  #info(row: SandboxRow): SandboxInfo {
    return {
      id: row.id,
      size: row.size,
      state: row.state,
      ...(row.image ? { image: row.imageId ? `${row.image}@${row.imageId}` : row.image } : {}),
      network: row.network,
      ...(row.state === "running" && row.startedAt ? { startedAt: row.startedAt } : {}),
    };
  }

  #handle(row: SandboxRow): SandboxHandle {
    return {
      sandboxId: row.id,
      info: this.#info(row),
      paths: { workspace: SANDBOX_PATHS.workspace, outputs: SANDBOX_PATHS.outputs, ...(row.customizations ? { customizations: SANDBOX_PATHS.customizations } : {}) },
    };
  }

  #row(sessionId: string): SandboxRow {
    const row = this.#options.store.bySession(sessionId);
    if (!row || row.state === "deleted") throw new ManagedCopilotError("not_found", `Session ${sessionId} has no sandbox.`, { sessionId });
    return row;
  }

  // Environment resolution ----------------------------------------------------------------------------------------

  #environment(request: CreateSandboxRequest): { config: EnvironmentConfig; customizations?: string } {
    const resolved = (request as CreateSandboxRequest & { resolved?: { config?: EnvironmentConfig; customizations?: { root?: string } } }).resolved;
    let config = resolved?.config ?? this.#options.app.config.deployment.environments[request.environment];
    if (!config && /^inline-isolated(-|$)/.test(request.environment)) config = { type: "isolated", size: request.size };
    if (!config) throw new ManagedCopilotError("environment_not_found", `Environment "${request.environment}" is not declared in this deployment.`);
    if (config.type !== "isolated") throw new ManagedCopilotError("invalid_request", `Environment "${request.environment}" is ${config.type}; only isolated environments get a sandbox.`);
    const root = resolved?.customizations?.root;
    return { config, ...(root ? { customizations: root } : {}) };
  }

  #setupPlan(config: EnvironmentConfig, request: CreateSandboxRequest): { plan: SandboxSetupPlan; workloadEnv: Record<string, string> } {
    const additions = request.additions ?? {};
    const python = [...(config.packages?.python ?? []), ...(additions.packages?.python ?? [])];
    const npm = [...(config.packages?.npm ?? []), ...(additions.packages?.npm ?? [])];
    const files = additions.files ?? {};
    const entries = Object.entries(files);
    const limits = SANDBOX_LIMITS.setupFiles;
    if (entries.length > limits.count) throw new ManagedCopilotError("invalid_request", `Sessions accept at most ${limits.count} setup files; upload the rest with managed.files(session).upload().`);
    let total = 0;
    for (const [path, content] of entries) {
      const relative = path.startsWith(`${SANDBOX_PATHS.workspace}/`) ? path.slice(SANDBOX_PATHS.workspace.length + 1) : path;
      if (!relative || relative.length > 4096 || !SETUP_PATH.test(relative)) {
        throw new ManagedCopilotError("invalid_request", `Setup file path "${path}" must be relative to /workspace, use forward slashes, and contain no ".." segments.`);
      }
      if (typeof content !== "string") throw new ManagedCopilotError("invalid_request", `Setup file "${path}" must be base64-encoded text.`);
      const bytes = base64Size(content);
      if (bytes === undefined) throw new ManagedCopilotError("invalid_request", `Setup file "${path}" is not valid base64.`);
      if (bytes > limits.fileBytes) throw new ManagedCopilotError("invalid_request", `Setup file "${path}" is larger than 1 MiB; upload it with managed.files(session).upload() instead.`);
      total += bytes;
    }
    if (total > limits.totalBytes) throw new ManagedCopilotError("invalid_request", "Setup files exceed 8 MiB in total; upload large files with managed.files(session).upload() instead.");
    const workloadEnv: Record<string, string> = { ...(config.env ?? {}), ...(additions.env ?? {}) };
    for (const [name, value] of Object.entries(workloadEnv)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ManagedCopilotError("invalid_request", `"${name}" is not a valid environment variable name.`);
      if (typeof value !== "string" || value.includes("\u0000")) throw new ManagedCopilotError("invalid_request", `The value of env "${name}" must be a string without NUL characters.`);
      if (isReservedSandboxEnv(name)) throw new ManagedCopilotError("policy_violation", `"${name}" is reserved by the platform (identity, proxy, trust, or runtime settings) and cannot be set in env.`);
    }
    const plan: SandboxSetupPlan = {
      ...(python.length || npm.length ? { packages: { ...(python.length ? { python } : {}), ...(npm.length ? { npm } : {}) } } : {}),
      ...(entries.length ? { files } : {}),
      ...(config.setupCommands?.length ? { setupCommands: config.setupCommands } : {}),
    };
    return { plan, workloadEnv };
  }

  // Lifecycle ----------------------------------------------------------------------------------------------------

  create(request: CreateSandboxRequest): Promise<SandboxHandle> {
    return this.#withLock(request.sessionId, () => this.#create(request));
  }

  async #create(request: CreateSandboxRequest): Promise<SandboxHandle> {
    const started = Date.now();
    const { store, provider } = this.#options;
    const environment = this.#environment(request);
    const { plan, workloadEnv } = this.#setupPlan(environment.config, request);
    await this.#ready();
    const previous = store.bySession(request.sessionId);
    if (previous) {
      if (previous.state !== "deleted" && previous.state !== "failed") throw new ManagedCopilotError("conflict", `Session ${request.sessionId} already has a sandbox.`);
      await provider.remove(previous.id).catch(() => undefined);
      store.remove(request.sessionId);
    }
    const row = store.insert({
      id: `sbx_${randomBytes(12).toString("hex")}`,
      sessionId: request.sessionId,
      ownerId: request.ownerId,
      environment: request.environment,
      size: request.size,
      network: request.network,
      vaults: [...(request.vaults ?? [])],
      state: "provisioning",
      key: randomBytes(32).toString("base64url"),
      runtimeToken: randomBytes(32).toString("base64url"),
      placeholder: `mcrt_${randomBytes(32).toString("base64url")}`,
      ...(environment.customizations ? { customizations: environment.customizations } : {}),
      workloadEnv,
      idleTimeoutSeconds: environment.config.idleTimeoutSeconds ?? this.#options.defaultIdleSeconds,
    });
    this.#active.add(request.sessionId);
    this.#log.info("Creating sandbox", { sessionId: row.sessionId, sandboxId: row.id, environment: row.environment, size: row.size, network: row.network.access });
    try {
      const image = await provider.ensureImage(request.environment, environment.config);
      store.update(row.sessionId, { image: image.ref, imageId: image.id });
      const egress = await this.#registerEgress(row);
      await provider.create(this.#spec(row, image.id), this.#operation(row));
      store.update(row.sessionId, { state: "setting_up", startedAt: new Date().toISOString() });
      // Egress pins the proxy credential to the sandbox's source address; setup installs already go through it.
      await this.#pinAddress(row);
      const agent = this.#agent(row);
      await agent.waitHealthy(this.#startTimeoutMs);
      const final = await agent.start(
        { mode: "create", setup: plan, platformEnv: egress.env, workloadEnv, ...(egress.caCertificate ? { caCertificate: egress.caCertificate } : {}) },
        (event) => {
          if (event.type === "progress") store.update(row.sessionId, { setup: event.setup });
        },
      );
      if (final.type === "failed") {
        store.update(row.sessionId, { state: "failed", ...(final.setup ? { setup: final.setup } : {}), errorCode: final.code, error: final.message });
        const failedStep = final.setup?.steps.find((step) => step.state === "failed");
        throw new ManagedCopilotError(final.code === "internal" ? "internal" : "setup_failed", withOutputTail(final.message, failedStep?.output), {
          sandboxId: row.id,
          ...(failedStep ? { step: failedStep.name, ...(failedStep.exitCode !== undefined ? { exitCode: failedStep.exitCode } : {}), ...(failedStep.output ? { output: failedStep.output.slice(-2000) } : {}) } : {}),
        });
      }
      if (final.type !== "ready") throw new ManagedCopilotError("internal", "The sandbox did not report ready.");
      store.update(row.sessionId, { state: "running", setup: final.setup, errorCode: null, error: null });
      this.#liveFor(row.sessionId).lastActivity = Date.now();
      this.#log.info("Sandbox ready", { sessionId: row.sessionId, sandboxId: row.id, ms: Date.now() - started });
      return this.#handle(this.#row(row.sessionId));
    } catch (error) {
      const managed = toManaged(error);
      const current = store.bySession(row.sessionId);
      if (current && current.state !== "failed") store.update(row.sessionId, { state: "failed", errorCode: managed.code, error: managed.message });
      this.#log.warn("Sandbox creation failed", { sessionId: row.sessionId, sandboxId: row.id, code: managed.code, error: managed.message });
      // A sandbox that never became ready holds no user state; release its container, volumes, and subnet now.
      await provider.remove(row.id).catch((cleanup: unknown) => this.#log.warn("Could not remove a failed sandbox; reconciliation retries", { sandboxId: row.id, error: (cleanup as Error).message }));
      await this.#unregisterEgress(row);
      throw managed;
    }
  }

  ensureRunning(sessionId: string): Promise<SandboxHandle> {
    return this.#withLock(sessionId, () => this.#ensureRunning(sessionId));
  }

  async #ensureRunning(sessionId: string): Promise<SandboxHandle> {
    const { store, provider } = this.#options;
    let row = this.#row(sessionId);
    switch (row.state) {
      case "deleting":
        throw new ManagedCopilotError("not_found", `Session ${sessionId}'s sandbox is being deleted.`, { sessionId });
      case "failed":
        throw new ManagedCopilotError("state_restore_failed", row.error ?? "The sandbox failed and cannot be resumed.", { sandboxId: row.id });
      case "provisioning":
      case "setting_up":
        throw new ManagedCopilotError("state_restore_failed", "The sandbox never finished its initial setup.", { sandboxId: row.id });
      case "running": {
        await this.#ready();
        if (await provider.isRunning(row.id)) {
          try {
            const status = await this.#agent(row).health();
            if (status.state === "ready" && status.runtime.state === "running") return this.#handle(row);
          } catch {
            // fall through and restart it
          }
        }
        break;
      }
      default:
        break;
    }
    if (row.setup?.state !== "succeeded") {
      store.update(sessionId, { state: "failed", errorCode: "state_restore_failed", error: "Initial setup did not complete, and setup is never replayed automatically." });
      throw new ManagedCopilotError("state_restore_failed", "This sandbox cannot be resumed because its initial setup did not complete; setup is never replayed automatically.", { sandboxId: row.id });
    }
    const started = Date.now();
    await this.#ready();
    let fresh = false;
    const outcome = await provider.start(row.id, this.#operation(row));
    if (outcome === "gone") {
      store.update(sessionId, { state: "failed", errorCode: "state_restore_failed", error: "The sandbox's persistent storage no longer exists." });
      throw new ManagedCopilotError("state_restore_failed", "The sandbox's persistent storage no longer exists, so the session cannot be restored.", { sandboxId: row.id });
    }
    if (outcome === "recreate") {
      if (!row.imageId || !(await provider.hasImage(row.imageId))) {
        store.update(sessionId, { state: "failed", errorCode: "state_restore_failed", error: `The sandbox's pinned image ${row.image ?? ""} is no longer available.` });
        throw new ManagedCopilotError("state_restore_failed", `The sandbox's pinned image (${row.image ?? row.imageId ?? "unknown"}) is no longer available, so its toolchain cannot be restored.`, { sandboxId: row.id });
      }
      await provider.create(this.#spec(row, row.imageId), this.#operation(row));
      fresh = true;
    }
    try {
      const egress = await this.#registerEgress(row);
      await this.#pinAddress(row);
      const agent = this.#agent(row);
      await agent.waitHealthy(this.#startTimeoutMs);
      const final = await agent.start({ mode: "resume", platformEnv: egress.env, workloadEnv: row.workloadEnv, ...(egress.caCertificate ? { caCertificate: egress.caCertificate } : {}) }, () => undefined);
      if (final.type === "failed") throw new ManagedCopilotError(final.code === "internal" ? "internal" : "state_restore_failed", final.message, { sandboxId: row.id });
      store.update(sessionId, { state: "running", startedAt: new Date().toISOString(), errorCode: null, error: null });
      row = this.#row(sessionId);
      this.#liveFor(sessionId).lastActivity = Date.now();
      this.#log.info("Sandbox resumed", { sessionId, sandboxId: row.id, ms: Date.now() - started, recreated: fresh });
      return this.#handle(row);
    } catch (error) {
      const managed = toManaged(error);
      if (managed.code === "state_restore_failed") store.update(sessionId, { state: "failed", errorCode: managed.code, error: managed.message });
      else store.update(sessionId, { state: "stopped", errorCode: managed.code, error: managed.message });
      await provider.stop(row.id).catch(() => undefined);
      await this.#unregisterEgress(row);
      throw managed;
    }
  }

  async openRuntime(sessionId: string, options: OpenRuntimeOptions): Promise<SandboxRuntime> {
    const row = this.#row(sessionId);
    if (row.state !== "running") throw new ManagedCopilotError("capability_unavailable", `The session's sandbox is ${row.state}; resume the session first.`, { sandboxId: row.id });
    const agent = this.#agent(row);
    // Which runtime process this connection reaches: a different one than before ended the turn the old one was running.
    // Best effort; an unreachable sandboxd fails the open below.
    const status = await agent.health().catch(() => undefined);
    if (status) this.#observeRuntime(sessionId, status.runtime.instance);
    const stream = await agent.openStream(SANDBOXD_ROUTES.runtime);
    const live = this.#liveFor(sessionId);
    const broker = new InferenceBroker({
      sessionId,
      placeholder: row.placeholder,
      resolveToken: () => options.resolveToken(),
      invalidateToken: (token) => this.#invalidateToken(token),
      githubApiUrl: this.#options.app.config.githubApiUrl,
      log: this.#log,
    });
    const deferredAgents = new Map<string, string>();
    const runtime: SandboxRuntime = {
      sandboxId: row.id,
      stream,
      connectionToken: row.runtimeToken,
      handlers: broker.handlers,
      initialize: async (send) => {
        try {
          await broker.initialize(send);
        } catch (error) {
          if (!isProviderTaken(error)) throw error;
          throw await this.#replaceHeldRuntime(sessionId, row.id, runtime);
        }
      },
      prepareSessionParams: async (_method, params) => {
        const deferred = deferAgentSelection(rewriteSessionParams(params, row.customizations));
        if (deferred.agent) deferredAgents.set(typeof params["sessionId"] === "string" ? params["sessionId"] : sessionId, deferred.agent);
        return deferred.params;
      },
      sessionOpened: async (id) => {
        live.lastActivity = Date.now();
        await broker.sessionOpened(id);
        const agent = deferredAgents.get(id);
        deferredAgents.delete(id);
        if (agent) await broker.selectAgent(id, agent);
      },
      close: () => {
        broker.close();
        stream.destroy();
        live.runtimes.delete(runtime);
      },
    };
    live.runtimes.add(runtime);
    live.lastActivity = Date.now();
    stream.once("close", () => {
      broker.close();
      live.runtimes.delete(runtime);
    });
    return runtime;
  }

  /**
   * Stock runtimes keep their inference-provider registration with the first connection that registered, even after that
   * connection closed (verified on 1.0.103; nothing releases it), so after a gateway restart or a dropped link the runtime
   * refuses every new provider. With no other connection of this gateway open to it, the registration belongs to a
   * connection that is gone: the runtime process is replaced (session state stays on disk) and the caller reopens
   * (`details.reopen`). Sandboxes on images from before sandboxd could restart its runtime are stopped instead, and the
   * reopen starts them again.
   */
  async #replaceHeldRuntime(sessionId: string, sandboxId: string, runtime: SandboxRuntime): Promise<ManagedCopilotError> {
    const live = this.#liveFor(sessionId);
    if ([...live.runtimes].some((other) => other !== runtime)) {
      return new ManagedCopilotError("conflict", "Another connection of this gateway is the sandbox runtime's inference provider; close it before opening the runtime again.", { sandboxId });
    }
    await this.#withLock(sessionId, async () => {
      const row = this.#row(sessionId);
      // A stop, delete, or recreate meanwhile replaced the process already.
      if (row.id !== sandboxId || row.state !== "running") return;
      try {
        const status = await this.#agent(row).restartRuntime();
        live.runtimeInstance = status.runtime.instance;
        this.#log.info("Restarted a sandbox runtime held by a connection that is gone", { sessionId, sandboxId });
      } catch (error) {
        if (!isManagedCopilotError(error, "not_found")) throw toManaged(error);
        // An older sandboxd without the route: stopping and starting the sandbox starts a fresh runtime. Started here,
        // because the reopen only opens the runtime again.
        await this.#stop(sessionId, "its runtime was held by a connection that is gone");
        await this.#ensureRunning(sessionId);
        this.#log.info("Restarted a sandbox whose runtime was held by a connection that is gone", { sessionId, sandboxId });
      }
      this.#runtimeReplaced(sessionId);
    });
    return new ManagedCopilotError("capability_unavailable", "The sandbox's runtime was restarted because a connection that is gone still held it. Reconnect to resume the session.", {
      sandboxId,
      reopen: true,
    });
  }

  /** Records which runtime process serves the session; a different process than before ended the old one's turn. */
  #observeRuntime(sessionId: string, instance: string | undefined): void {
    if (!instance) return;
    const live = this.#liveFor(sessionId);
    const previous = live.runtimeInstance;
    live.runtimeInstance = instance;
    if (previous !== undefined && previous !== instance) this.#runtimeReplaced(sessionId);
  }

  /**
   * The session's runtime process was replaced. A turn the old process was running cannot finish: stock runtimes neither
   * continue nor end it when the session is resumed in a new process, unless it was waiting on actions durable still owns
   * (`continuePendingWork` restores those, and answering them continues the turn). Otherwise its outputs are recorded as
   * interrupted and idle stop stops waiting for it; core ends the turn in its ledger.
   */
  #runtimeReplaced(sessionId: string): void {
    if (this.#hasOpenActions(sessionId)) return;
    const live = this.#liveFor(sessionId);
    const turns = this.#artifacts?.turnsInterrupted(sessionId, TURN_INTERRUPTED) ?? [];
    const wasRunning = live.turnRunning || turns.length > 0;
    live.turnRunning = false;
    live.turnFailed = false;
    live.pending.clear();
    live.recoveredAt = undefined;
    if (wasRunning) this.#log.info("A turn ended because the sandbox runtime running it was replaced", { sessionId, turns: turns.length });
  }

  /**
   * Core's authenticator forgets a token GitHub rejected for this session's inference, so the next `resolveToken`
   * verifies it with GitHub again instead of handing it out from its cache.
   */
  #invalidateToken(token: string): void {
    const auth = (this.#options.app.services as Record<string, unknown>)["auth"] as { invalidate?(token: string): void } | undefined;
    auth?.invalidate?.(token);
  }

  async connect(sessionId: string, port: number): Promise<Duplex> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ManagedCopilotError("invalid_request", "A port between 1 and 65535 is required.");
    await this.ensureRunning(sessionId);
    const row = this.#row(sessionId);
    this.touch(sessionId);
    return this.#agent(row).openStream(SANDBOXD_ROUTES.tunnel, { port: String(port) });
  }

  importRuntimeState(sessionId: string, options: RuntimeStateImport): Promise<{ files: number; bytes: number }> {
    return this.#withLock(sessionId, () => this.#importRuntimeState(sessionId, options));
  }

  async #importRuntimeState(sessionId: string, options: RuntimeStateImport): Promise<{ files: number; bytes: number }> {
    const row = this.#row(sessionId);
    if (row.state !== "running") {
      throw new ManagedCopilotError("capability_unavailable", `The session's sandbox is ${row.state}; runtime state can only be imported into a running sandbox.`, { sandboxId: row.id });
    }
    const files = await collectRuntimeState(options.sessionStateDir);
    // An empty directory cannot be resumed; refuse it before anything changes in the sandbox.
    if (files.length === 0) throw new ManagedCopilotError("invalid_request", `The runtime state directory ${options.sessionStateDir} has no files to import.`);
    const agent = this.#agent(row);
    const status = await agent.health();
    if (status.state !== "ready" || status.runtime.state !== "running") {
      throw new ManagedCopilotError("capability_unavailable", `The sandbox runtime is ${status.runtime.state}; runtime state can only be imported once it is ready.`, { sandboxId: row.id });
    }
    // The carried turn (`activeTurnId`) runs on this process.
    this.#observeRuntime(sessionId, status.runtime.instance);
    const staging = randomBytes(8).toString("hex");
    let bytes = 0;
    const upload = async (): Promise<void> => {
      try {
        for (const file of files) {
          await agent.writeRuntimeImport(staging, file.relative, createReadStream(file.absolute), file.size);
          bytes += file.size;
        }
        await agent.commitRuntimeImport(staging, sessionId);
      } catch (error) {
        await agent.abortRuntimeImport(staging).catch(() => undefined);
        throw toManaged(error);
      }
    };
    // Busy for the whole transfer, so idle stop waits for it.
    await this.track(sessionId, upload());
    if (options.activeTurnId) {
      this.#artifacts?.turnStarted(sessionId, options.activeTurnId);
      const live = this.#liveFor(sessionId);
      live.turnRunning = true;
      live.turnFailed = false;
    }
    this.touch(sessionId);
    this.#log.info("Imported runtime state", { sessionId, sandboxId: row.id, files: files.length, bytes, activeTurn: options.activeTurnId !== undefined });
    return { files: files.length, bytes };
  }

  async get(sessionId: string): Promise<SandboxInfo | undefined> {
    const row = this.#options.store.bySession(sessionId);
    return row ? this.#info(row) : undefined;
  }

  setupRecord(sessionId: string): SandboxSetupRecord | undefined {
    return this.#options.store.bySession(sessionId)?.setup;
  }

  stop(sessionId: string, reason = "requested"): Promise<void> {
    return this.#withLock(sessionId, () => this.#stop(sessionId, reason));
  }

  async #stop(sessionId: string, reason: string, idle = false): Promise<void> {
    const { store, provider } = this.#options;
    const row = store.bySession(sessionId);
    if (!row || row.state !== "running") return;
    const live = this.#live.get(sessionId);
    if (idle && live && (live.turnRunning || live.pending.size > 0 || live.busy > 0 || this.#durablyBusy(sessionId, live) || Date.now() - live.lastActivity < row.idleTimeoutSeconds * 1000)) return;
    store.update(sessionId, { state: "stopping" });
    for (const runtime of [...(live?.runtimes ?? [])]) runtime.close();
    try {
      await provider.stop(row.id);
    } catch (error) {
      store.update(sessionId, { state: "running" });
      throw toManaged(error);
    }
    // Only once the workload is stopped: unregistering first would leave a running sandbox without egress.
    await this.#unregisterEgress(row);
    store.update(sessionId, { state: "stopped", stoppedAt: new Date().toISOString() });
    this.#log.info("Sandbox stopped", { sessionId, sandboxId: row.id, reason });
  }

  delete(sessionId: string, options: { readonly sandboxId?: string } = {}): Promise<void> {
    const pending = this.#pendingDeletes.get(sessionId) ?? [];
    pending.push(options.sandboxId);
    this.#pendingDeletes.set(sessionId, pending);
    const done = () => {
      const index = pending.indexOf(options.sandboxId);
      if (index >= 0) pending.splice(index, 1);
      if (pending.length === 0 && this.#pendingDeletes.get(sessionId) === pending) this.#pendingDeletes.delete(sessionId);
    };
    return this.#withLock(sessionId, () => this.#delete(sessionId, options.sandboxId)).finally(done);
  }

  /**
   * Whether the session is being deleted or is gone, as far as anyone has decided: its sandbox record is missing,
   * deleting, or deleted; a delete of its current sandbox is queued; or core has started deleting the session (core
   * records that before it closes the session's runtime or asks for the sandbox's deletion). Work interrupted by a
   * deletion reports that outcome rather than the transport error the deletion caused.
   */
  isGone(sessionId: string): boolean {
    const row = this.#options.store.bySession(sessionId);
    if (!row || row.state === "deleting" || row.state === "deleted") return true;
    if ((this.#pendingDeletes.get(sessionId) ?? []).some((expected) => expected === undefined || expected === row.id)) return true;
    try {
      const state = this.#sessions()?.get(sessionId)?.state;
      return state === "deleting" || state === "deleted";
    } catch {
      return false;
    }
  }

  /** Resolves once operations already queued for the session (such as a delete) have run, or after `timeoutMs`. */
  async settled(sessionId: string, timeoutMs = SETTLE_MS): Promise<void> {
    const queued = this.#locks.get(sessionId);
    if (!queued) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([queued, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
  }

  /**
   * True once shutdown has started stopping sandboxes, after publications under way had their chance to finish: a
   * publication that fails from then on was cut off by the shutdown. (During the drain before it, compute is healthy and
   * failures are the publications' own.)
   */
  get stoppingCompute(): boolean {
    return this.#stoppingCompute;
  }

  async #delete(sessionId: string, expected: string | undefined): Promise<void> {
    const { store, provider } = this.#options;
    const row = store.bySession(sessionId);
    // Decided inside the lock: a delete that names the sandbox it means (promotion releasing its candidate, retries of
    // an interrupted delete) never removes a newer sandbox, or a newer session's artifacts, that reuse the session ID.
    if (expected !== undefined && row?.id !== expected) {
      if (row) this.#log.info("Skipped a delete for a sandbox that was already replaced", { sessionId, expected, current: row.id });
      return;
    }
    if (!row) {
      await this.#artifacts?.deleteSession(sessionId);
      return;
    }
    if (row.state === "deleted") return;
    store.update(sessionId, { state: "deleting" });
    for (const runtime of [...(this.#live.get(sessionId)?.runtimes ?? [])]) runtime.close();
    try {
      await this.#ready();
      await provider.remove(row.id);
      await this.#unregisterEgress(row);
      await this.#artifacts?.deleteSession(sessionId);
      store.update(sessionId, { state: "deleted", errorCode: null, error: null });
      store.scrub(sessionId);
      this.#live.delete(sessionId);
      this.#active.delete(sessionId);
      this.#log.info("Sandbox deleted", { sessionId, sandboxId: row.id });
    } catch (error) {
      const message = (error as Error).message;
      store.update(sessionId, { errorCode: "internal", error: `Cleanup is incomplete and will be retried: ${message}` });
      this.#log.warn("Sandbox deletion incomplete; will retry", { sessionId, sandboxId: row.id, error: message });
      throw new ManagedCopilotError("internal", "The sandbox could not be fully deleted yet; cleanup will be retried automatically.", { sandboxId: row.id, state: "deleting" });
    }
  }

  // Files --------------------------------------------------------------------------------------------------------

  /** The session's sandbox agent, starting the sandbox if it is stopped. */
  async agentFor(sessionId: string): Promise<SandboxAgentClient> {
    await this.ensureRunning(sessionId);
    return this.#agent(this.#row(sessionId));
  }

  async listFiles(sessionId: string, path: string, options: { readonly recursive?: boolean } = {}): Promise<FileEntry[]> {
    const agent = await this.agentFor(sessionId);
    return this.track(sessionId, agent.listFiles(path, options.recursive === true));
  }

  async readFile(sessionId: string, path: string): Promise<FileDownload> {
    const agent = await this.agentFor(sessionId);
    const live = this.#liveFor(sessionId);
    live.busy++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      live.busy = Math.max(0, live.busy - 1);
      live.lastActivity = Date.now();
    };
    try {
      const file = await agent.readFile(path);
      file.body.once("end", release);
      file.body.once("error", release);
      file.body.once("close", release);
      const name = path.replace(/^\/workspace\//, "").replace(/^\.?\/+/, "");
      return { entry: { path: name, type: "file", size: file.size, modifiedAt: file.modifiedAt }, body: file.body };
    } catch (error) {
      release();
      throw error;
    }
  }

  async writeFile(sessionId: string, path: string, body: Readable, options: FileWriteOptions = {}): Promise<FileEntry> {
    if (options.size !== undefined && options.size > SANDBOX_LIMITS.uploadBytes) {
      throw new ManagedCopilotError("invalid_request", `Uploads are limited to ${Math.round(SANDBOX_LIMITS.uploadBytes / (1024 * 1024))} MiB.`);
    }
    const agent = await this.agentFor(sessionId);
    const entry = await this.track(sessionId, agent.writeFile(path, body, { overwrite: options.overwrite !== false, ...(options.size !== undefined ? { size: options.size } : {}) }));
    return { path: entry.path, type: entry.type, size: entry.size, modifiedAt: entry.modifiedAt };
  }

  // Events, idle stop, and reconciliation --------------------------------------------------------------------------

  #onEvent(sessionId: string, event: SandboxRuntimeEvent): void {
    if (!this.#active.has(sessionId)) return;
    const live = this.#liveFor(sessionId);
    live.lastActivity = Date.now();
    const data = (event.data ?? {}) as Record<string, unknown>;
    const requestId = typeof data["requestId"] === "string" ? (data["requestId"] as string) : typeof data["toolCallId"] === "string" ? (data["toolCallId"] as string) : undefined;
    if (ACTION_REQUESTED.has(event.type)) {
      live.pending.add(requestId ?? event.id);
      return;
    }
    if (ACTION_COMPLETED.has(event.type)) {
      if (requestId) live.pending.delete(requestId);
      return;
    }
    if (event.agentId) return;
    const artifacts = this.#artifacts;
    if (event.type === "user.message") {
      const turnId = typeof data["messageId"] === "string" ? (data["messageId"] as string) : event.id;
      artifacts?.turnStarted(sessionId, turnId);
      live.turnRunning = true;
      live.turnFailed = false;
      // Root-turn tracking is re-established; the restart guard is no longer needed.
      live.recoveredAt = undefined;
    } else if (event.type === "session.error") {
      if (live.turnRunning) live.turnFailed = true;
    } else if (event.type === "session.idle") {
      const outcome = data["aborted"] === true ? "cancelled" : live.turnFailed ? "failed" : "completed";
      live.turnRunning = false;
      live.turnFailed = false;
      live.pending.clear();
      // The turn that was running across the restart (if any) has ended.
      live.recoveredAt = undefined;
      const turnIds = artifacts?.turnsCompleted(sessionId, outcome) ?? [];
      if (artifacts && turnIds.length > 0) {
        void artifacts.publish(sessionId, turnIds, outcome).catch((error: unknown) => {
          // Only possible when the ledger closes under a publication that outlasted the shutdown drain.
          if (this.#stoppingCompute) this.#log.info("A publication was cut off by gateway shutdown", { sessionId, error: (error as Error).message });
          else this.#log.warn("Publication crashed", { sessionId, error: (error as Error).message });
        });
      }
    }
  }

  #sweepIdle(): void {
    if (this.#stopping) return;
    for (const row of this.#options.store.inStates(["running"])) {
      const live = this.#liveFor(row.sessionId);
      if (live.turnRunning || live.pending.size > 0 || live.busy > 0 || this.#durablyBusy(row.sessionId, live)) continue;
      if (Date.now() - live.lastActivity < row.idleTimeoutSeconds * 1000) continue;
      void this.#withLock(row.sessionId, () => this.#stop(row.sessionId, "idle", true)).catch((error: unknown) =>
        this.#log.warn("Idle stop failed", { sessionId: row.sessionId, error: (error as Error).message }),
      );
    }
  }

  /**
   * Work that in-memory tracking cannot see after a gateway restart: open durable actions (the stock runtime does not
   * re-emit pending requests), and a turn the ledger last saw running in a sandbox recovered at startup, until its
   * events are observed again or the recovery grace ends.
   */
  #durablyBusy(sessionId: string, live: LiveState): boolean {
    if (this.#hasOpenActions(sessionId)) return true;
    if (live.recoveredAt !== undefined && Date.now() - live.recoveredAt < RECOVERY_GRACE_MS) {
      return this.#sessions()?.get?.(sessionId)?.lastTurn?.status === "running";
    }
    return false;
  }

  /**
   * Whether durable owns open actions of the session's current incarnation: its runtime may be waiting on them (including
   * answers recorded but not yet delivered), and `continuePendingWork` carries them into a new runtime process. The same
   * predicate core uses (`hasOpenActions`); read errors count as yes.
   */
  #hasOpenActions(sessionId: string): boolean {
    const actions = optional<{
      hasOpenActions?(sessionId: string, options?: { readonly incarnation?: string }): boolean;
      list?(sessionId: string, options: { readonly open?: boolean; readonly incarnation?: string }): readonly unknown[];
    }>(this.#options.app, "actions");
    if (!actions) return false;
    try {
      // This incarnation's: actions an earlier session with the same ID left behind are not this session's work.
      const incarnation = this.#sessions()?.get?.(sessionId)?.incarnation;
      const scope = incarnation ? { incarnation } : {};
      if (typeof actions.hasOpenActions === "function") return actions.hasOpenActions(sessionId, scope);
      return typeof actions.list === "function" && actions.list(sessionId, { open: true, ...scope }).length > 0;
    } catch (error) {
      this.#log.warn("Could not read pending actions; treating the session as waiting on them", { sessionId, error: (error as Error).message });
      return true;
    }
  }

  /** Finishes interrupted work after a crash or restart and removes backend resources no record owns. */
  async reconcile(): Promise<void> {
    const { store, provider } = this.#options;
    const rows = store.all().filter((row) => row.state !== "deleted");
    if (rows.length === 0 && !this.#options.prepareOnStart) return;
    try {
      await this.#ready();
    } catch (error) {
      this.#log.warn(`Skipping sandbox reconciliation: the ${provider.kind} backend is not reachable`, { error: (error as Error).message });
      return;
    }
    for (const row of rows) {
      try {
        if (row.state === "provisioning" || row.state === "setting_up") {
          await this.#withLock(row.sessionId, async () => {
            store.update(row.sessionId, { state: "failed", errorCode: "setup_failed", error: "Sandbox creation was interrupted before setup finished; it is not replayed." });
            await provider.remove(row.id);
            await this.#unregisterEgress(row);
          });
        } else if (row.state === "deleting") {
          await this.delete(row.sessionId, { sandboxId: row.id });
        } else if (row.state === "running" || row.state === "stopping") {
          if (!(await provider.isRunning(row.id))) store.update(row.sessionId, { state: "stopped", stoppedAt: new Date().toISOString() });
          else if (row.state === "stopping") {
            // A stop interrupted by the restart: finish it rather than leave the sandbox unmanaged.
            await this.#withLock(row.sessionId, async () => {
              await provider.stop(row.id);
              await this.#unregisterEgress(row);
              store.update(row.sessionId, { state: "stopped", stoppedAt: new Date().toISOString() });
            });
          } else {
            await provider.reattach?.(row.id);
            this.#liveFor(row.sessionId).recoveredAt = Date.now();
          }
        } else if (row.state === "failed") {
          // Never-ready sandboxes hold no user state; failed resumes keep their volumes until the session is deleted.
          if (row.setup?.state === "succeeded") await provider.stop(row.id);
          else await provider.remove(row.id);
        }
      } catch (error) {
        this.#log.warn("Sandbox reconciliation step failed", { sessionId: row.sessionId, sandboxId: row.id, state: row.state, error: (error as Error).message });
      }
    }
    try {
      for (const id of await provider.inventory()) {
        // Decide on current ownership: a sandbox created while this sweep ran already has its row.
        const row = store.byId(id);
        if (row && row.state !== "deleted") continue;
        this.#log.info("Removing orphaned sandbox resources", { sandboxId: id });
        await provider.remove(id);
      }
    } catch (error) {
      this.#log.warn("Orphan sweep failed", { error: (error as Error).message });
    }
  }

  async start(): Promise<void> {
    const interrupted = this.#artifacts?.failInterruptedTurns() ?? 0;
    if (interrupted > 0) this.#log.warn("Marked turns and publications interrupted by a gateway restart as failed", { count: interrupted });
    const sessions = this.#sessions();
    if (sessions?.subscribe) this.#unsubscribe = sessions.subscribe((sessionId, event) => this.#onEvent(sessionId, event));
    else this.#log.warn("The sessions service is unavailable; artifact publication and idle tracking are disabled");
    await this.reconcile();
    // Idle sweeps start only after reconciliation restored what in-memory state cannot know.
    this.#timers.push(setInterval(() => this.#sweepIdle(), IDLE_SWEEP_MS).unref());
    this.#timers.push(
      setInterval(() => {
        for (const row of this.#options.store.inStates(["deleting"])) void this.delete(row.sessionId, { sandboxId: row.id }).catch(() => undefined);
      }, RECONCILE_MS).unref(),
    );
    // Keeps `available` current: a backend that starts later is advertised, one that goes away stops being advertised.
    this.#timers.push(setInterval(() => void this.probe(), PROBE_MS).unref());
    if (this.#options.prepareOnStart) {
      const { provider } = this.#options;
      void this.#ready()
        .then(() => provider.prepare?.())
        .catch((error: unknown) => this.#log.warn("Sandbox preparation failed; it will be retried on first use", { error: (error as Error).message }));
    }
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    this.#shutdown.abort();
    this.#unsubscribe?.();
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
    // A turn that completed just before shutdown still publishes: publications under way finish (bounded) before
    // compute stops beneath them.
    if (this.#artifacts && !(await this.#artifacts.drain(SHUTDOWN_DRAIN_MS))) {
      this.#log.info("Stopping sandboxes while turn outputs are still being published; those publications are recorded as interrupted");
    }
    this.#stoppingCompute = true;
    const running = this.#options.store.inStates(["running"]);
    for (const live of this.#live.values()) for (const runtime of [...live.runtimes]) runtime.close();
    await Promise.all(
      running.map((row) =>
        this.#withLock(row.sessionId, async () => {
          await this.#options.provider.stop(row.id).catch(() => undefined);
          await this.#unregisterEgress(row);
          this.#options.store.update(row.sessionId, { state: "stopped", stoppedAt: new Date().toISOString() });
        }).catch(() => undefined),
      ),
    );
    // Publications that outlasted the drain fail fast once compute is gone; let them record that while the ledger is open.
    await this.#artifacts?.drain(5_000);
    if (running.length > 0) this.#log.info("Stopped sandboxes for shutdown; they resume on next use", { count: running.length });
    await this.#options.provider.shutdown?.().catch(() => undefined);
  }
}
