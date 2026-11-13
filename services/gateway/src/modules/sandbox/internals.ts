// The `sandboxes` service: state and the helpers every operation uses (backend readiness, provider calls, egress,
// locks, rows, and environment resolution).
import {
  isReservedSandboxEnv,
  ManagedCopilotError,
  SANDBOX_LIMITS,
  SANDBOX_PATHS,
  type EnvironmentConfig,
  type SandboxInfo,
  type SandboxSetupPlan,
} from "@managed-copilot/protocol";
import type { Logger } from "../../log.js";
import { SandboxAgentClient } from "./agent-client.js";
import type { ArtifactService } from "./artifacts.js";
import { SandboxExecs } from "./execs.js";
import type {
  CreateSandboxRequest,
  EgressRegistration,
  SandboxHandle,
  SandboxPolicyPort,
  SandboxSessionsPort,
} from "./contract.js";
import type { SandboxOperationOptions, SandboxSpec } from "./providers/types.js";
import type { ExecRow, SandboxRow } from "./store.js";
import { type LiveState, type SandboxServiceOptions, optional, toManaged, SETUP_PATH, base64Size } from "./support.js";

export abstract class SandboxInternals {
  // Implemented by later layers of SandboxService.
  protected abstract expectSandbox(sessionId: string, sandboxId: string | undefined, row?: SandboxRow | undefined): void;
  abstract agentFor(sessionId: string, sandboxId?: string): Promise<SandboxAgentClient>;
  protected abstract execEnded(row: ExecRow): void;
  protected abstract execActivity(sessionId: string): void;

  protected readonly options: SandboxServiceOptions;
  protected readonly live = new Map<string, LiveState>();
  protected readonly locks = new Map<string, Promise<unknown>>();
  /** Sessions with an active (non-deleted) sandbox; events for anything else are ignored cheaply. */
  protected readonly active = new Set<string>();
  protected artifacts: ArtifactService | undefined;
  /** Result of the latest backend readiness check; `/v1/info` advertises isolated placement only while true. */
  protected isAvailable = false;
  /** When the backend was last checked, and why it failed (operator console). */
  protected checkedAt: string | undefined;
  protected lastProbeError: string | undefined;
  /** The availability last logged (undefined until the first check finishes). */
  #reported: boolean | undefined;
  #probing: Promise<boolean> | undefined;
  /** Aborted at gateway shutdown; cancels slow backend operations. */
  protected readonly shutdownController = new AbortController();
  protected timers: NodeJS.Timeout[] = [];
  protected unsubscribe: (() => void) | undefined;
  protected stopping = false;
  protected computeStopping = false;
  /** Deletes requested through `delete()` that have not finished: the sandbox each targets (undefined = the current one). */
  protected readonly pendingDeletes = new Map<string, (string | undefined)[]>();
  /** Commands run directly in sandboxes. */
  protected readonly execs: SandboxExecs;
  /** Sessions whose sandbox is being stopped (their commands' ends publish nothing). */
  protected readonly stoppingSessions = new Set<string>();

  constructor(options: SandboxServiceOptions) {
    this.options = options;
    for (const row of options.store.all()) if (row.state !== "deleted") this.active.add(row.sessionId);
    this.execs = new SandboxExecs({
      store: options.store,
      log: options.log,
      row: (sessionId) => this.row(sessionId),
      expectSandbox: (sessionId, sandboxId, row) => this.expectSandbox(sessionId, sandboxId, row),
      agentFor: (sessionId, sandboxId) => this.agentFor(sessionId, sandboxId),
      agentOf: (row) => this.agent(row),
      track: (sessionId, work) => this.track(sessionId, work),
      touch: (sessionId) => this.touch(sessionId),
      ended: (row) => this.execEnded(row),
      activity: (sessionId) => this.execActivity(sessionId),
      shutdown: this.shutdownController.signal,
    });
  }

  protected get log(): Logger {
    return this.options.log;
  }

  // Infrastructure helpers -------------------------------------------------------------------------------------

  /**
   * Whether the sandbox backend answered its latest readiness check (at registration, every 30 s, and before every
   * backend operation). `/v1/info` advertises `isolated` and `files` only while this is true.
   */
  get available(): boolean {
    return this.isAvailable;
  }

  /** Checks the backend now (single flight) and records the result. */
  probe(): Promise<boolean> {
    this.#probing ??= this.ready()
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
    this.isAvailable = available;
    if (this.#reported === available) return;
    this.#reported = available;
    const backend = this.options.provider.kind;
    if (available) this.log.info("Isolated sandboxes are available", { backend });
    else this.log.warn("Isolated sandboxes are unavailable; /v1/info does not advertise them until the backend answers", { backend, reason });
  }

  protected async ready(): Promise<void> {
    try {
      await this.options.provider.ready();
      this.checkedAt = new Date().toISOString();
      this.lastProbeError = undefined;
      this.#setAvailable(true);
    } catch (error) {
      const managed = toManaged(error, "capability_unavailable");
      this.checkedAt = new Date().toISOString();
      this.lastProbeError = managed.message;
      this.#setAvailable(false, managed.message);
      throw managed;
    }
  }

  protected agent(row: SandboxRow): SandboxAgentClient {
    const { provider } = this.options;
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
  protected spec(row: SandboxRow, imageId: string): SandboxSpec {
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
    const policy = optional<SandboxPolicyPort>(this.options.app, "policy");
    return policy && typeof policy.registerSandbox === "function" ? policy : undefined;
  }

  protected sessions(): SandboxSessionsPort | undefined {
    return optional<SandboxSessionsPort>(this.options.app, "sessions");
  }

  protected async registerEgress(row: SandboxRow): Promise<EgressRegistration> {
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
      const proxy = this.options.provider.egressProxy?.();
      return await policy.registerSandbox({ sandboxId: row.id, sessionId: row.sessionId, ...(proxy ? { proxy } : {}) });
    } catch (error) {
      throw toManaged(error, "capability_unavailable");
    }
  }

  protected async pinAddress(row: SandboxRow): Promise<void> {
    const policy = this.#policy();
    // Without source pinning (e.g. ingress-proxied backends) the per-sandbox proxy credential is the only binding.
    if (!policy || !this.options.provider.capabilities.addressPinning) return;
    const address = await this.options.provider.address(row.id);
    if (!address) throw new ManagedCopilotError("internal", "The sandbox has no address on its network.");
    await policy.updateSandbox(row.id, { address });
  }

  /** Progress and cancellation for slow backend operations. */
  protected operation(row: SandboxRow): SandboxOperationOptions {
    return {
      signal: this.shutdownController.signal,
      onProgress: (message) => this.log.info("Sandbox provisioning", { sessionId: row.sessionId, sandboxId: row.id, message }),
    };
  }

  protected get startTimeoutMs(): number {
    return this.options.provider.capabilities.startTimeoutMs ?? 60_000;
  }

  protected async unregisterEgress(row: SandboxRow): Promise<void> {
    try {
      await this.#policy()?.unregisterSandbox(row.id);
    } catch (error) {
      this.log.warn("Could not unregister the sandbox from egress", { sandboxId: row.id, error: (error as Error).message });
    }
  }

  protected withLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.locks.set(sessionId, settled);
    void settled.then(() => {
      if (this.locks.get(sessionId) === settled) this.locks.delete(sessionId);
    });
    return next;
  }

  protected liveFor(sessionId: string): LiveState {
    let live = this.live.get(sessionId);
    if (!live) {
      live = { runtimes: new Set(), pending: new Set(), busy: 0, turnRunning: false, turnFailed: false, lastActivity: Date.now() };
      this.live.set(sessionId, live);
    }
    return live;
  }

  /** Marks the session busy for the duration of `work` (idle stop waits). */
  track<T>(sessionId: string, work: Promise<T>): Promise<T> {
    const live = this.liveFor(sessionId);
    live.busy++;
    live.lastActivity = Date.now();
    return work.finally(() => {
      live.busy--;
      live.lastActivity = Date.now();
    });
  }

  touch(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (live) live.lastActivity = Date.now();
  }

  protected info(row: SandboxRow): SandboxInfo {
    return {
      id: row.id,
      size: row.size,
      state: row.state,
      ...(row.image ? { image: row.imageId ? `${row.image}@${row.imageId}` : row.image } : {}),
      network: row.network,
      ...(row.state === "running" && row.startedAt ? { startedAt: row.startedAt } : {}),
    };
  }

  protected handle(row: SandboxRow): SandboxHandle {
    return {
      sandboxId: row.id,
      info: this.info(row),
      paths: { workspace: SANDBOX_PATHS.workspace, outputs: SANDBOX_PATHS.outputs, ...(row.customizations ? { customizations: SANDBOX_PATHS.customizations } : {}) },
    };
  }

  protected row(sessionId: string): SandboxRow {
    const row = this.options.store.bySession(sessionId);
    if (!row || row.state === "deleted") throw new ManagedCopilotError("not_found", `Session ${sessionId} has no sandbox.`, { sessionId });
    return row;
  }

  // Environment resolution ----------------------------------------------------------------------------------------

  protected environment(request: CreateSandboxRequest): { config: EnvironmentConfig; customizations?: string } {
    const resolved = (request as CreateSandboxRequest & { resolved?: { config?: EnvironmentConfig; customizations?: { root?: string } } }).resolved;
    let config = resolved?.config ?? this.options.app.config.deployment.environments[request.environment];
    if (!config && /^inline-isolated(-|$)/.test(request.environment)) config = { type: "isolated", size: request.size };
    if (!config) throw new ManagedCopilotError("environment_not_found", `Environment "${request.environment}" is not declared in this deployment.`);
    if (config.type !== "isolated") throw new ManagedCopilotError("invalid_request", `Environment "${request.environment}" is ${config.type}; only isolated environments get a sandbox.`);
    const root = resolved?.customizations?.root;
    return { config, ...(root ? { customizations: root } : {}) };
  }

  protected setupPlan(config: EnvironmentConfig, request: CreateSandboxRequest): { plan: SandboxSetupPlan; workloadEnv: Record<string, string> } {
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
}
