// The `sandboxes` service (spec sections 4 and 5): per-session sandboxes on the local Docker backend, created only
// when setup and the runtime are ready, stopped when idle after work drains, resumed without replaying setup, and
// deleted with crash-safe reconciliation.
import { randomBytes } from "node:crypto";
import { resolve as resolvePath, sep } from "node:path";
import type { Duplex, Readable } from "node:stream";
import {
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
import { InferenceBroker } from "./broker.js";
import type {
  CreateSandboxRequest,
  EgressRegistration,
  FileDownload,
  FileWriteOptions,
  OpenRuntimeOptions,
  SandboxesService,
  SandboxHandle,
  SandboxPolicyPort,
  SandboxRuntime,
  SandboxRuntimeEvent,
  SandboxSessionsPort,
} from "./contract.js";
import type { DockerClient } from "./docker.js";
import type { SandboxImages } from "./images.js";
import type { DockerSandboxProvider } from "./provider.js";
import type { SandboxRow, SandboxStore } from "./store.js";

const ACTION_REQUESTED = new Set(["external_tool.requested", "permission.requested", "elicitation.requested"]);
const ACTION_COMPLETED = new Set(["external_tool.completed", "permission.completed", "elicitation.completed"]);
const IDLE_SWEEP_MS = 30_000;
const RECONCILE_MS = 5 * 60_000;

interface LiveState {
  readonly runtimes: Set<SandboxRuntime>;
  readonly pending: Set<string>;
  busy: number;
  turnRunning: boolean;
  turnFailed: boolean;
  lastActivity: number;
}

export interface SandboxServiceOptions {
  readonly app: GatewayApp;
  readonly store: SandboxStore;
  readonly provider: DockerSandboxProvider;
  readonly images: SandboxImages;
  readonly docker: DockerClient;
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

function samePathPrefix(path: string, root: string): string | undefined {
  const normalize = (value: string) => resolvePath(value).split(sep).join("/");
  const candidate = normalize(path);
  const base = normalize(root).replace(/\/+$/, "");
  const fold = process.platform === "win32" ? (value: string) => value.toLowerCase() : (value: string) => value;
  if (fold(candidate) === fold(base)) return "";
  if (fold(candidate).startsWith(`${fold(base)}/`)) return candidate.slice(base.length + 1);
  return undefined;
}

export class SandboxService implements SandboxesService {
  readonly #options: SandboxServiceOptions;
  readonly #live = new Map<string, LiveState>();
  readonly #locks = new Map<string, Promise<unknown>>();
  /** Sessions with an active (non-deleted) sandbox; events for anything else are ignored cheaply. */
  readonly #active = new Set<string>();
  #artifacts: ArtifactService | undefined;
  #dockerReady: Promise<void> | undefined;
  #timers: NodeJS.Timeout[] = [];
  #unsubscribe: (() => void) | undefined;
  #stopping = false;

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

  #docker(): Promise<void> {
    this.#dockerReady ??= this.#options.docker.ping().then(
      (info) => {
        this.#log.info("Docker is available for sandboxes", { version: info.version, platform: `${info.os}/${info.arch}`, endpoint: this.#options.docker.endpoint.label });
      },
      (error: unknown) => {
        this.#dockerReady = undefined;
        throw new ManagedCopilotError("capability_unavailable", `Isolated sandboxes need Docker, which is not reachable (${(error as Error).message}). Start Docker Desktop and retry.`);
      },
    );
    return this.#dockerReady;
  }

  #agent(row: SandboxRow): SandboxAgentClient {
    return new SandboxAgentClient(
      () =>
        this.#options.provider.relay().catch((error: unknown) => {
          throw toManaged(error, "capability_unavailable");
        }),
      row.id,
      row.key,
    );
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
      return await policy.registerSandbox({ sandboxId: row.id, sessionId: row.sessionId });
    } catch (error) {
      throw toManaged(error, "capability_unavailable");
    }
  }

  async #pinAddress(row: SandboxRow): Promise<void> {
    const policy = this.#policy();
    if (!policy) return;
    const address = await this.#options.provider.address(row.id);
    if (!address) throw new ManagedCopilotError("internal", "The sandbox has no address on its network.");
    await policy.updateSandbox(row.id, { address });
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
      const bytes = Math.floor((content.length * 3) / 4);
      if (bytes > limits.fileBytes) throw new ManagedCopilotError("invalid_request", `Setup file "${path}" is larger than 1 MiB; upload it with managed.files(session).upload() instead.`);
      total += bytes;
    }
    if (total > limits.totalBytes) throw new ManagedCopilotError("invalid_request", "Setup files exceed 8 MiB in total; upload large files with managed.files(session).upload() instead.");
    const workloadEnv: Record<string, string> = { ...(config.env ?? {}), ...(additions.env ?? {}) };
    for (const name of Object.keys(workloadEnv)) {
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
    const { store, provider, images } = this.#options;
    const environment = this.#environment(request);
    const { plan, workloadEnv } = this.#setupPlan(environment.config, request);
    await this.#docker();
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
      const image = await images.ensureEnvironment(request.environment, environment.config);
      store.update(row.sessionId, { image: image.tag, imageId: image.id });
      const egress = await this.#registerEgress(row);
      const { subnet } = await provider.create({
        sandboxId: row.id,
        sessionId: row.sessionId,
        ownerId: row.ownerId,
        environment: row.environment,
        size: row.size,
        imageId: image.id,
        key: row.key,
        runtimeToken: row.runtimeToken,
        ...(row.customizations ? { customizations: row.customizations } : {}),
      });
      store.update(row.sessionId, { subnet, state: "setting_up", startedAt: new Date().toISOString() });
      const agent = this.#agent(row);
      await agent.waitHealthy();
      const final = await agent.start(
        { mode: "create", setup: plan, platformEnv: egress.env, workloadEnv, ...(egress.caCertificate ? { caCertificate: egress.caCertificate } : {}) },
        (event) => {
          if (event.type === "progress") store.update(row.sessionId, { setup: event.setup });
        },
      );
      if (final.type === "failed") {
        store.update(row.sessionId, { state: "failed", ...(final.setup ? { setup: final.setup } : {}), errorCode: final.code, error: final.message });
        const failedStep = final.setup?.steps.find((step) => step.state === "failed");
        throw new ManagedCopilotError(final.code === "internal" ? "internal" : "setup_failed", final.message, {
          sandboxId: row.id,
          ...(failedStep ? { step: failedStep.name, ...(failedStep.exitCode !== undefined ? { exitCode: failedStep.exitCode } : {}), ...(failedStep.output ? { output: failedStep.output.slice(-2000) } : {}) } : {}),
        });
      }
      if (final.type !== "ready") throw new ManagedCopilotError("internal", "The sandbox did not report ready.");
      store.update(row.sessionId, { state: "running", setup: final.setup, errorCode: null, error: null });
      await this.#pinAddress(row);
      this.#liveFor(row.sessionId).lastActivity = Date.now();
      this.#log.info("Sandbox ready", { sessionId: row.sessionId, sandboxId: row.id, ms: Date.now() - started });
      return this.#handle(this.#row(row.sessionId));
    } catch (error) {
      const managed = toManaged(error);
      const current = store.bySession(row.sessionId);
      if (current && current.state !== "failed") store.update(row.sessionId, { state: "failed", errorCode: managed.code, error: managed.message });
      this.#log.warn("Sandbox creation failed", { sessionId: row.sessionId, sandboxId: row.id, code: managed.code, error: managed.message });
      await this.#unregisterEgress(row);
      await provider.stop(row.id).catch(() => undefined);
      throw managed;
    }
  }

  ensureRunning(sessionId: string): Promise<SandboxHandle> {
    return this.#withLock(sessionId, () => this.#ensureRunning(sessionId));
  }

  async #ensureRunning(sessionId: string): Promise<SandboxHandle> {
    const { store, provider, docker } = this.#options;
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
        await this.#docker();
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
    await this.#docker();
    let fresh = false;
    if (!(await provider.start(row.id))) {
      if (!(await provider.volumesExist(row.id))) {
        store.update(sessionId, { state: "failed", errorCode: "state_restore_failed", error: "The sandbox's persistent storage no longer exists." });
        throw new ManagedCopilotError("state_restore_failed", "The sandbox's persistent storage no longer exists, so the session cannot be restored.", { sandboxId: row.id });
      }
      if (!row.imageId || !(await docker.inspectImage(row.imageId))) {
        store.update(sessionId, { state: "failed", errorCode: "state_restore_failed", error: `The sandbox's pinned image ${row.image ?? ""} is no longer available.` });
        throw new ManagedCopilotError("state_restore_failed", `The sandbox's pinned image (${row.image ?? row.imageId ?? "unknown"}) is no longer available, so its toolchain cannot be restored.`, { sandboxId: row.id });
      }
      await provider.create({
        sandboxId: row.id,
        sessionId: row.sessionId,
        ownerId: row.ownerId,
        environment: row.environment,
        size: row.size,
        imageId: row.imageId,
        key: row.key,
        runtimeToken: row.runtimeToken,
        ...(row.customizations ? { customizations: row.customizations } : {}),
      });
      fresh = true;
    }
    try {
      const egress = await this.#registerEgress(row);
      const agent = this.#agent(row);
      await agent.waitHealthy();
      const final = await agent.start({ mode: "resume", platformEnv: egress.env, workloadEnv: row.workloadEnv, ...(egress.caCertificate ? { caCertificate: egress.caCertificate } : {}) }, () => undefined);
      if (final.type === "failed") throw new ManagedCopilotError(final.code === "internal" ? "internal" : "state_restore_failed", final.message, { sandboxId: row.id });
      store.update(sessionId, { state: "running", startedAt: new Date().toISOString(), errorCode: null, error: null });
      row = this.#row(sessionId);
      await this.#pinAddress(row);
      this.#liveFor(sessionId).lastActivity = Date.now();
      this.#log.info("Sandbox resumed", { sessionId, sandboxId: row.id, ms: Date.now() - started, recreated: fresh });
      return this.#handle(row);
    } catch (error) {
      const managed = toManaged(error);
      if (managed.code === "state_restore_failed") store.update(sessionId, { state: "failed", errorCode: managed.code, error: managed.message });
      else store.update(sessionId, { state: "stopped", errorCode: managed.code, error: managed.message });
      await this.#unregisterEgress(row);
      await provider.stop(row.id).catch(() => undefined);
      throw managed;
    }
  }

  async openRuntime(sessionId: string, options: OpenRuntimeOptions): Promise<SandboxRuntime> {
    const row = this.#row(sessionId);
    if (row.state !== "running") throw new ManagedCopilotError("capability_unavailable", `The session's sandbox is ${row.state}; resume the session first.`, { sandboxId: row.id });
    const stream = await this.#agent(row).openStream(SANDBOXD_ROUTES.runtime);
    const live = this.#liveFor(sessionId);
    const broker = new InferenceBroker({ sessionId, placeholder: row.placeholder, resolveToken: () => options.resolveToken(), githubApiUrl: this.#options.app.config.githubApiUrl, log: this.#log });
    const runtime: SandboxRuntime = {
      sandboxId: row.id,
      stream,
      connectionToken: row.runtimeToken,
      handlers: broker.handlers,
      initialize: (send) => broker.initialize(send),
      prepareSessionParams: async (method, params) => this.#prepareSessionParams(row, method, params),
      sessionOpened: async (id) => {
        live.lastActivity = Date.now();
        await broker.sessionOpened(id);
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

  #prepareSessionParams(row: SandboxRow, _method: string, params: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...params };
    for (const key of ["gitHubToken", "gitHubTokenProviderRegistrationId", "enableManagedSettings"]) delete out[key];
    if (out["provider"] !== undefined && out["provider"] !== null) {
      throw new ManagedCopilotError(
        "policy_violation",
        "Custom model providers are not available in sandboxes: inference is brokered by the gateway with the session owner's Copilot entitlement.",
      );
    }
    out["workingDirectory"] ??= SANDBOX_PATHS.workspace;
    const root = row.customizations;
    if (root) {
      for (const key of ["skillDirectories", "agentDirectories", "instructionDirectories"]) {
        const value = out[key];
        if (!Array.isArray(value)) continue;
        out[key] = value.map((entry: unknown) => {
          if (typeof entry !== "string") return entry;
          const rest = samePathPrefix(entry, root);
          return rest === undefined ? entry : rest ? `${SANDBOX_PATHS.customizations}/${rest}` : SANDBOX_PATHS.customizations;
        });
      }
    }
    return out;
  }

  async connect(sessionId: string, port: number): Promise<Duplex> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ManagedCopilotError("invalid_request", "A port between 1 and 65535 is required.");
    await this.ensureRunning(sessionId);
    const row = this.#row(sessionId);
    this.touch(sessionId);
    return this.#agent(row).openStream(SANDBOXD_ROUTES.tunnel, { port: String(port) });
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
    if (idle && live && (live.turnRunning || live.pending.size > 0 || live.busy > 0 || Date.now() - live.lastActivity < row.idleTimeoutSeconds * 1000)) return;
    store.update(sessionId, { state: "stopping" });
    for (const runtime of [...(live?.runtimes ?? [])]) runtime.close();
    await this.#unregisterEgress(row);
    try {
      await provider.stop(row.id);
    } catch (error) {
      store.update(sessionId, { state: "running" });
      throw toManaged(error);
    }
    store.update(sessionId, { state: "stopped", stoppedAt: new Date().toISOString() });
    this.#log.info("Sandbox stopped", { sessionId, sandboxId: row.id, reason });
  }

  delete(sessionId: string): Promise<void> {
    return this.#withLock(sessionId, () => this.#delete(sessionId));
  }

  async #delete(sessionId: string): Promise<void> {
    const { store, provider } = this.#options;
    const row = store.bySession(sessionId);
    if (!row) {
      await this.#artifacts?.deleteSession(sessionId);
      return;
    }
    if (row.state === "deleted") return;
    store.update(sessionId, { state: "deleting" });
    for (const runtime of [...(this.#live.get(sessionId)?.runtimes ?? [])]) runtime.close();
    try {
      await this.#unregisterEgress(row);
      await this.#docker();
      await provider.remove(row.id);
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
    try {
      const file = await agent.readFile(path);
      const release = () => {
        live.busy = Math.max(0, live.busy - 1);
        live.lastActivity = Date.now();
      };
      file.body.once("close", release);
      const name = path.replace(/^\/workspace\//, "").replace(/^\.?\/+/, "");
      return { entry: { path: name, type: "file", size: file.size, modifiedAt: file.modifiedAt }, body: file.body };
    } catch (error) {
      live.busy = Math.max(0, live.busy - 1);
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
    } else if (event.type === "session.error") {
      if (live.turnRunning) live.turnFailed = true;
    } else if (event.type === "session.idle") {
      const outcome = data["aborted"] === true ? "cancelled" : live.turnFailed ? "failed" : "completed";
      live.turnRunning = false;
      live.turnFailed = false;
      live.pending.clear();
      const turnIds = artifacts?.turnsCompleted(sessionId, outcome) ?? [];
      if (artifacts && turnIds.length > 0) void artifacts.publish(sessionId, turnIds, outcome).catch((error: unknown) => this.#log.warn("Publication crashed", { sessionId, error: (error as Error).message }));
    }
  }

  #sweepIdle(): void {
    if (this.#stopping) return;
    for (const row of this.#options.store.inStates(["running"])) {
      const live = this.#liveFor(row.sessionId);
      if (live.turnRunning || live.pending.size > 0 || live.busy > 0) continue;
      if (Date.now() - live.lastActivity < row.idleTimeoutSeconds * 1000) continue;
      void this.#withLock(row.sessionId, () => this.#stop(row.sessionId, "idle", true)).catch((error: unknown) =>
        this.#log.warn("Idle stop failed", { sessionId: row.sessionId, error: (error as Error).message }),
      );
    }
  }

  /** Finishes interrupted work after a crash or restart and removes Docker resources no record owns. */
  async reconcile(): Promise<void> {
    const { store, provider } = this.#options;
    const rows = store.all().filter((row) => row.state !== "deleted");
    if (rows.length === 0 && !this.#options.prepareOnStart) return;
    try {
      await this.#docker();
    } catch (error) {
      this.#log.warn("Skipping sandbox reconciliation: Docker is not reachable", { error: (error as Error).message });
      return;
    }
    for (const row of rows) {
      try {
        if (row.state === "provisioning" || row.state === "setting_up") {
          await this.#withLock(row.sessionId, async () => {
            store.update(row.sessionId, { state: "failed", errorCode: "setup_failed", error: "Sandbox creation was interrupted before setup finished; it is not replayed." });
            await provider.stop(row.id).catch(() => undefined);
          });
        } else if (row.state === "deleting") {
          await this.delete(row.sessionId);
        } else if (row.state === "running" || row.state === "stopping") {
          if (!(await provider.isRunning(row.id))) store.update(row.sessionId, { state: "stopped", stoppedAt: new Date().toISOString() });
          else await provider.attachPlatform(provider.resources(row.id).network);
        } else if (row.state === "failed") {
          await provider.stop(row.id).catch(() => undefined);
        }
      } catch (error) {
        this.#log.warn("Sandbox reconciliation step failed", { sessionId: row.sessionId, sandboxId: row.id, state: row.state, error: (error as Error).message });
      }
    }
    try {
      const owned = new Set(rows.map((row) => row.id));
      for (const id of await provider.inventory()) {
        const row = store.byId(id);
        if (owned.has(id) && row && row.state !== "deleted") continue;
        this.#log.info("Removing orphaned sandbox resources", { sandboxId: id });
        await provider.remove(id);
      }
    } catch (error) {
      this.#log.warn("Orphan sweep failed", { error: (error as Error).message });
    }
  }

  async start(): Promise<void> {
    const sessions = this.#sessions();
    if (sessions?.subscribe) this.#unsubscribe = sessions.subscribe((sessionId, event) => this.#onEvent(sessionId, event));
    else this.#log.warn("The sessions service is unavailable; artifact publication and idle tracking are disabled");
    this.#timers.push(setInterval(() => this.#sweepIdle(), IDLE_SWEEP_MS).unref());
    this.#timers.push(
      setInterval(() => {
        for (const row of this.#options.store.inStates(["deleting"])) void this.delete(row.sessionId).catch(() => undefined);
      }, RECONCILE_MS).unref(),
    );
    await this.reconcile();
    if (this.#options.prepareOnStart) {
      void this.#docker()
        .then(() => this.#options.images.ensureBase())
        .then(() => this.#options.provider.relay())
        .catch((error: unknown) => this.#log.warn("Sandbox preparation failed; it will be retried on first use", { error: (error as Error).message }));
    }
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    this.#unsubscribe?.();
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
    const running = this.#options.store.inStates(["running"]);
    for (const live of this.#live.values()) for (const runtime of [...live.runtimes]) runtime.close();
    await Promise.all(
      running.map((row) =>
        this.#withLock(row.sessionId, async () => {
          await this.#unregisterEgress(row);
          await this.#options.provider.stop(row.id).catch(() => undefined);
          this.#options.store.update(row.sessionId, { state: "stopped", stoppedAt: new Date().toISOString() });
        }).catch(() => undefined),
      ),
    );
    if (running.length > 0) this.#log.info("Stopped sandboxes for shutdown; they resume on next use", { count: running.length });
    if (this.#dockerReady) await this.#options.provider.removeRelay().catch(() => undefined);
  }
}
