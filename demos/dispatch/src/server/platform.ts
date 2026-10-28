// The connection to Managed Copilot: one stock CopilotClient for the orchestrator environment, kept healthy, plus the
// REST helpers Dispatch reads workers, sandboxes, and files with. Everything here is the public SDK.
import type { CopilotClient, MessageOptions, ResumeSessionConfig, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { SANDBOX_SIZES } from "@managed-copilot/protocol";
import {
  isManagedCopilotError,
  ManagedCopilot,
  type ArtifactInfo,
  type DeploymentInfo,
  type ExecInfo,
  type FileEntry,
  type PlatformEvent,
  type SessionInfo,
  type WorkerInfo,
} from "@managed-copilot/sdk";
import { BLUEPRINT_LABELS, blueprintKind } from "../shared/catalog.js";
import type { Blueprint, CoordinatorInfo, ExecutionStyle, PlatformStatus, StyleInfo } from "../shared/types.js";
import { STYLES, type DispatchConfig } from "./config.js";
import { DispatchError } from "./errors.js";
import { log } from "./log.js";

/** The parts of a stock `CopilotSession` a conversation uses. */
export interface CoordinatorSession {
  readonly sessionId: string;
  on(handler: (event: SessionEvent) => void): () => void;
  send(options: MessageOptions): Promise<string>;
  getEvents(): Promise<SessionEvent[]>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

/** What conversations need from Managed Copilot. Implemented by `Platform`; faked in tests. */
export interface DispatchPlatform {
  readonly status: PlatformStatus;
  /** The default style's coordinator. */
  readonly coordinator: CoordinatorInfo | undefined;
  /** Each execution style's orchestrator environment, and whether this deployment has it. */
  readonly styles: readonly StyleInfo[];
  readonly blueprints: readonly Blueprint[];
  onStatus(listener: (status: PlatformStatus) => void): () => void;
  /** Runs after each (re)connection: sessions must be resumed on the new client. */
  onConnected(listener: () => void): () => void;
  onWorkerEvent(listener: (event: PlatformEvent) => void): () => void;
  /** Creates a coordinator session in an orchestrator environment (default: the default style's). */
  createSession(config: SessionConfig, environment?: string): Promise<CoordinatorSession>;
  resumeSession(sessionId: string, config: ResumeSessionConfig, environment?: string): Promise<CoordinatorSession>;
  deleteSession(sessionId: string): Promise<void>;
  /** The caller's sessions in an environment: Dispatch's conversations are the orchestrator environments' sessions. */
  listSessions(environment: string): Promise<SessionInfo[]>;
  sessionInfo(sessionId: string): Promise<SessionInfo>;
  workers(coordinatorId: string): Promise<WorkerInfo[]>;
  listFiles(sessionId: string): Promise<FileEntry[]>;
  readFile(sessionId: string, path: string): Promise<string>;
  artifacts(sessionId: string): Promise<ArtifactInfo[]>;
  /** Commands run in a sandbox (`managed.exec.list`): every command a coordinator or sub-agent ran in a hands sandbox. */
  execs(sessionId: string): Promise<ExecInfo[]>;
}

const WORKER_EVENTS = ["worker.started", "worker.idle", "worker.failed", "worker.stopped"] as const;

/** Retry delay after the `attempt`-th consecutive failure: exponential to 30 s, then 50–100 % of that (jitter). */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

function deadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Plain words for why connecting failed. */
export function describeConnectError(error: unknown): string {
  if (isManagedCopilotError(error)) {
    if (error.code === "authentication_required") return "Sign in to GitHub (gh auth login) or set GH_TOKEN, then Dispatch connects by itself.";
    if (error.code === "forbidden") return "This GitHub account can't use this Managed Copilot deployment.";
    return error.message;
  }
  const message = (error as Error)?.message ?? String(error);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|did not answer/i.test(message)) return "Managed Copilot isn't reachable yet. Start it with `aspire run`, or set MANAGED_COPILOT_URL.";
  return message;
}

/** The coordinator's environment and the blueprints its workers are created from, as the deployment declares them. */
export function describeDeployment(
  info: DeploymentInfo,
  environments: string | Readonly<Record<ExecutionStyle, string>>,
  model: string,
  defaultStyle: ExecutionStyle = "delegate",
): { coordinator?: CoordinatorInfo; styles: StyleInfo[]; blueprints: Blueprint[]; problem?: string } {
  const names: Readonly<Record<ExecutionStyle, string>> = typeof environments === "string" ? { delegate: environments, direct: `${environments}-direct`, mixed: `${environments}-mixed` } : environments;
  const styles = STYLES.map((style): StyleInfo => describeStyle(info, style, names[style], model));
  const available = styles.filter((style) => style.available);
  const preferred = styles.find((style) => style.style === defaultStyle);
  if (available.length === 0) {
    const missing = preferred?.reason ?? `This deployment has no "${names[defaultStyle]}" environment.`;
    return { styles, blueprints: [], problem: missing };
  }
  // Every style's worker environments, the default style's first: the sandboxes its conversations can have.
  const ordered = [...(preferred?.available ? [preferred] : []), ...available.filter((style) => style !== preferred)];
  const workerNames = [...new Set(ordered.flatMap((style) => [...(style.handsEnvironment ? [style.handsEnvironment] : []), ...style.workers]))];
  const blueprints = workerNames.flatMap((name, index): Blueprint[] => {
    const env = info.environments.find((candidate) => candidate.name === name);
    if (!env) return [];
    const kind = blueprintKind(name);
    const size = env.size ?? "small";
    const resources = (SANDBOX_SIZES as Record<string, { cpus: number; memoryMiB: number }>)[size];
    return [
      {
        name,
        kind,
        label: BLUEPRINT_LABELS[kind],
        ...(env.description ? { description: env.description } : {}),
        size,
        ...(resources ? { cpus: resources.cpus, memoryGiB: resources.memoryMiB / 1024 } : {}),
        network: { access: env.network.access, hosts: [...env.network.allowedDomains] },
        agents: [...env.agents],
        isDefault: index === 0,
      },
    ];
  });
  const coordinator = ordered[0]!.coordinator;
  if (!info.capabilities.includes("orchestrator")) {
    return { ...(coordinator ? { coordinator } : {}), styles, blueprints, problem: "Orchestrator environments aren't available on this deployment right now (sandboxes aren't ready). Dispatch keeps checking." };
  }
  return { ...(coordinator ? { coordinator } : {}), styles, blueprints };
}

/** One position of the style switch: whether the deployment declares its environment, with that execution style. */
function describeStyle(info: DeploymentInfo, style: ExecutionStyle, environment: string, model: string): StyleInfo {
  const declared = info.environments.find((candidate) => candidate.name === environment);
  const unavailable = (reason: string): StyleInfo => ({ style, environment, available: false, reason, workers: [] });
  if (!declared) return unavailable(`This deployment has no "${environment}" environment. Add Dispatch's environments to the AppHost (demos/dispatch/apphost.mts).`);
  if (declared.type !== "orchestrator") return unavailable(`"${environment}" is a ${declared.type} environment; Dispatch needs an orchestrator environment.`);
  const execution = declared.execution ?? "delegate";
  if (execution !== style) return unavailable(`"${environment}" is declared with execution "${execution}", not "${style}".`);
  const workers = declared.workers ?? [];
  const coordinator: CoordinatorInfo = {
    environment,
    model,
    maxWorkers: declared.maxWorkers ?? 4,
    ...(declared.description ? { description: declared.description } : {}),
    style,
  };
  return {
    style,
    environment,
    available: true,
    coordinator,
    ...(style !== "delegate" && workers[0] ? { handsEnvironment: workers[0], subagents: declared.subagents ?? "shared" } : {}),
    workers: style === "direct" ? [] : [...workers],
  };
}

export class Platform implements DispatchPlatform {
  readonly #config: DispatchConfig;
  #managed: ManagedCopilot | undefined;
  /** One stock client per available style's orchestrator environment. */
  #clients = new Map<string, CopilotClient>();
  #status: PlatformStatus = { state: "connecting" };
  #coordinator: CoordinatorInfo | undefined;
  #styles: StyleInfo[] = [];
  #blueprints: Blueprint[] = [];
  readonly #statusListeners = new Set<(status: PlatformStatus) => void>();
  readonly #connectedListeners = new Set<() => void>();
  readonly #workerListeners = new Set<(event: PlatformEvent) => void>();
  #attempt = 0;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #connecting: Promise<void> | undefined;

  constructor(config: DispatchConfig) {
    this.#config = config;
  }

  get status(): PlatformStatus {
    return this.#status;
  }

  get coordinator(): CoordinatorInfo | undefined {
    return this.#coordinator;
  }

  get styles(): readonly StyleInfo[] {
    return this.#styles;
  }

  get blueprints(): readonly Blueprint[] {
    return this.#blueprints;
  }

  onStatus(listener: (status: PlatformStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onConnected(listener: () => void): () => void {
    this.#connectedListeners.add(listener);
    return () => this.#connectedListeners.delete(listener);
  }

  onWorkerEvent(listener: (event: PlatformEvent) => void): () => void {
    this.#workerListeners.add(listener);
    return () => this.#workerListeners.delete(listener);
  }

  start(): void {
    void this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#managed?.close().catch(() => undefined);
  }

  async createSession(config: SessionConfig, environment?: string): Promise<CoordinatorSession> {
    return (await this.#requireClient(environment)).createSession(config);
  }

  async resumeSession(sessionId: string, config: ResumeSessionConfig, environment?: string): Promise<CoordinatorSession> {
    return (await this.#requireClient(environment)).resumeSession(sessionId, config);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#requireManaged().sessions.delete(sessionId);
  }

  listSessions(environment: string): Promise<SessionInfo[]> {
    return this.#requireManaged().sessions.list({ environment, limit: 200 });
  }

  sessionInfo(sessionId: string): Promise<SessionInfo> {
    return this.#requireManaged().sessions.get(sessionId);
  }

  workers(coordinatorId: string): Promise<WorkerInfo[]> {
    return this.#requireManaged().workers(coordinatorId).list();
  }

  listFiles(sessionId: string): Promise<FileEntry[]> {
    return this.#requireManaged().files(sessionId).list("", { recursive: true });
  }

  readFile(sessionId: string, path: string): Promise<string> {
    return this.#requireManaged().files(sessionId).read(path);
  }

  artifacts(sessionId: string): Promise<ArtifactInfo[]> {
    return this.#requireManaged().artifacts(sessionId).list({ versions: "latest" });
  }

  execs(sessionId: string): Promise<ExecInfo[]> {
    return this.#requireManaged().exec.list(sessionId);
  }

  #requireManaged(): ManagedCopilot {
    if (!this.#managed || this.#status.state !== "connected") throw new DispatchError("platform_unavailable", this.#status.message ?? "Managed Copilot isn't connected yet.", 503);
    return this.#managed;
  }

  async #requireClient(environment = this.#coordinator?.environment ?? this.#config.environment): Promise<CopilotClient> {
    this.#requireManaged();
    const client = this.#clients.get(environment);
    if (!client) {
      const style = this.#styles.find((candidate) => candidate.environment === environment);
      throw new DispatchError("platform_unavailable", style?.reason ?? `This deployment has no "${environment}" orchestrator environment for Dispatch.`, 503);
    }
    return client;
  }

  #setStatus(status: PlatformStatus): void {
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }

  #connect(): Promise<void> {
    this.#connecting ??= this.#connectOnce().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #connectOnce(): Promise<void> {
    if (this.#stopped) return;
    const previous = this.#status;
    try {
      if (!this.#managed) {
        const connecting = ManagedCopilot.connect({ clientName: "dispatch" });
        let managed: ManagedCopilot;
        try {
          managed = await deadline(connecting, 20_000, "Managed Copilot");
        } catch (error) {
          // A connection that completes after the deadline is closed, not leaked.
          void connecting.then((late) => late.close()).catch(() => undefined);
          throw error;
        }
        if (this.#stopped) return void (await managed.close().catch(() => undefined));
        this.#managed = managed;
        for (const type of WORKER_EVENTS) managed.on(type, (event) => this.#workerEvent(event));
      }
      const managed = this.#managed;
      const described = describeDeployment(managed.info, this.#config.environments, this.#config.model, this.#config.style);
      this.#coordinator = described.coordinator;
      this.#styles = described.styles;
      this.#blueprints = described.blueprints;
      const account = managed.account;
      const base = {
        url: managed.url,
        mode: managed.info.mode,
        deployment: managed.info.name,
        account: { login: account.login, ...(account.name ? { name: account.name } : {}), ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}) },
      };
      if (described.problem) {
        this.#setStatus({ state: "unavailable", ...base, message: described.problem });
        // The deployment can change (for example sandboxes coming up): check again, and re-read its description.
        this.#managed = undefined;
        await managed.close().catch(() => undefined);
        this.#schedule(++this.#attempt);
        return;
      }
      const old = [...this.#clients.values()];
      this.#clients = new Map();
      await Promise.all(old.map((client) => deadline(client.forceStop(), 5_000, "Stopping the old client").catch(() => undefined)));
      const clients = new Map<string, CopilotClient>();
      try {
        for (const style of described.styles.filter((candidate) => candidate.available)) {
          const starting = managed.client(style.environment);
          try {
            clients.set(style.environment, await deadline(starting, 30_000, "Starting the coordinator's client"));
          } catch (error) {
            // A client that finishes starting after the deadline is stopped, not leaked.
            void starting.then((late) => late.forceStop()).catch(() => undefined);
            throw error;
          }
        }
      } catch (error) {
        await Promise.all([...clients.values()].map((client) => client.forceStop().catch(() => undefined)));
        throw error;
      }
      if (this.#stopped || this.#managed !== managed) {
        await Promise.all([...clients.values()].map((client) => client.forceStop().catch(() => undefined)));
        return;
      }
      this.#clients = clients;
      this.#attempt = 0;
      this.#setStatus({ state: "connected", ...base });
      log.info(previous.state === "connected" ? "Reconnected to Managed Copilot" : "Connected to Managed Copilot", { url: managed.url, environments: [...clients.keys()].join(", ") });
      for (const listener of this.#connectedListeners) listener();
      this.#schedule(0);
    } catch (error) {
      if (this.#stopped) return;
      const message = describeConnectError(error);
      log.warn("Managed Copilot isn't available", { error: message });
      this.#setStatus({ ...this.#status, state: previous.state === "connected" || previous.state === "reconnecting" ? "reconnecting" : "unavailable", message });
      this.#schedule(++this.#attempt);
    }
  }

  /** Checks the connection (`attempt` 0) or tries again after a failure. */
  #schedule(attempt: number): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    const delay = attempt === 0 ? this.#config.healthIntervalMs : reconnectDelay(attempt);
    this.#timer = setTimeout(() => void (attempt === 0 ? this.#check() : this.#connect()), delay);
    this.#timer.unref?.();
  }

  async #check(): Promise<void> {
    const clients = [...this.#clients.values()];
    if (clients.length === 0 || this.#stopped) return this.#schedule(1);
    try {
      await Promise.all(clients.map((client) => deadline(client.ping(), 8_000, "Managed Copilot")));
      this.#schedule(0);
    } catch (error) {
      if (this.#stopped) return;
      log.warn("Lost the connection to Managed Copilot; reconnecting", { error: (error as Error).message });
      this.#setStatus({ ...this.#status, state: "reconnecting", message: "Reconnecting to Managed Copilot…" });
      // Connect afresh: the deployment may be back at another address or with other environments.
      const stale = this.#managed;
      this.#managed = undefined;
      this.#clients = new Map();
      for (const client of clients) void client.forceStop().catch(() => undefined);
      void stale?.close().catch(() => undefined);
      void this.#connect();
    }
  }

  #workerEvent(event: PlatformEvent): void {
    for (const listener of this.#workerListeners) {
      try {
        listener(event);
      } catch (error) {
        log.warn("A worker event listener failed", { error: (error as Error).message });
      }
    }
  }
}
