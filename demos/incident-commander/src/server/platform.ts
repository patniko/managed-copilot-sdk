// The connection to Managed Copilot: one stock CopilotClient for the incident environment, kept healthy, plus the REST
// helpers the app reads workers, sandboxes, and files with. Everything here is the public SDK.
import type { CopilotClient, MessageOptions, ResumeSessionConfig, SessionConfig } from "@github/copilot-sdk";
import { isManagedCopilotError, ManagedCopilot, type DeploymentInfo, type ExecInfo, type SessionInfo, type WorkerInfo } from "@managed-copilot/sdk";
import type { EnvironmentSummary, PlatformStatus } from "../shared/types.js";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import { log } from "./log.js";

/** The parts of a stock `CopilotSession` an incident uses. */
export interface CoordinatorSession {
  readonly sessionId: string;
  send(options: MessageOptions): Promise<string>;
  disconnect(): Promise<void>;
}

/** What incidents need from Managed Copilot. Implemented by `Platform`; faked in tests. */
export interface IncidentPlatform {
  readonly status: PlatformStatus;
  /** The deployment's URL (for webhook capability checks). */
  readonly url: string | undefined;
  onStatus(listener: (status: PlatformStatus) => void): () => void;
  /** Runs after each (re)connection: sessions must be resumed on the new client. */
  onConnected(listener: () => void): () => void;
  createSession(config: SessionConfig): Promise<CoordinatorSession>;
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CoordinatorSession>;
  deleteSession(sessionId: string): Promise<void>;
  sessionInfo(sessionId: string): Promise<SessionInfo>;
  workers(coordinatorId: string): Promise<WorkerInfo[]>;
  /** Commands run in a sandbox: the coordinator's own commands in its sandbox. */
  execs(sandboxId: string): Promise<ExecInfo[]>;
  writeFile(sandboxId: string, path: string, content: string): Promise<void>;
  readFile(sandboxId: string, path: string): Promise<string>;
}

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
    if (error.code === "authentication_required") return "Sign in to GitHub (gh auth login) or set GH_TOKEN; Incident Commander connects by itself after that.";
    if (error.code === "forbidden") return "This GitHub account can't use this Managed Copilot deployment.";
    return error.message;
  }
  const message = (error as Error)?.message ?? String(error);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|did not answer/i.test(message)) return "Managed Copilot isn't reachable yet. Start it with `aspire run`, or set MANAGED_COPILOT_URL.";
  return message;
}

function network(policy: DeploymentInfo["environments"][number]["network"]): string {
  if (policy.access === "disabled") return "Off";
  if (policy.access === "enabled") return "Open";
  const hosts = policy.allowedDomains;
  return hosts.length <= 2 ? `${hosts.join(", ")} only` : `${hosts.length} hosts`;
}

/** The incident environment and its sandboxes' environments, or why this deployment can't run incidents. */
export function describeDeployment(info: DeploymentInfo, environment: string): { environments: EnvironmentSummary[]; problem?: string } {
  const coordinator = info.environments.find((candidate) => candidate.name === environment);
  if (!coordinator) return { environments: [], problem: `This deployment has no "${environment}" environment. Add Incident Commander's environments to the AppHost (demos/incident-commander/apphost.mts).` };
  if (coordinator.type !== "orchestrator" || coordinator.execution !== "mixed") {
    return { environments: [], problem: `"${environment}" must be an orchestrator with execution "mixed": its own sandbox for triage, and workers for the repro and the fix.` };
  }
  const workers = coordinator.workers ?? [];
  const environments: EnvironmentSummary[] = [
    { name: coordinator.name, role: "coordinator", ...(coordinator.description ? { description: coordinator.description } : {}), network: network(coordinator.network) },
    ...workers.flatMap((name, index): EnvironmentSummary[] => {
      const env = info.environments.find((candidate) => candidate.name === name);
      if (!env) return [];
      return [{ name, role: index === 0 ? "own" : "worker", ...(env.description ? { description: env.description } : {}), ...(env.size ? { size: env.size } : {}), network: network(env.network) }];
    }),
  ];
  if (!info.capabilities.includes("orchestrator")) {
    return { environments, problem: "Sandboxes aren't ready on this deployment yet, so incidents can't start. Incident Commander keeps checking." };
  }
  return { environments };
}

export class Platform implements IncidentPlatform {
  readonly #config: AppConfig;
  #managed: ManagedCopilot | undefined;
  #client: CopilotClient | undefined;
  #status: PlatformStatus = { state: "connecting", environments: [] };
  readonly #statusListeners = new Set<(status: PlatformStatus) => void>();
  readonly #connectedListeners = new Set<() => void>();
  #attempt = 0;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #connecting: Promise<void> | undefined;

  constructor(config: AppConfig) {
    this.#config = config;
  }

  get status(): PlatformStatus {
    return this.#status;
  }

  get url(): string | undefined {
    return this.#managed?.url;
  }

  onStatus(listener: (status: PlatformStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onConnected(listener: () => void): () => void {
    this.#connectedListeners.add(listener);
    return () => this.#connectedListeners.delete(listener);
  }

  start(): void {
    void this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    const client = this.#client;
    this.#client = undefined;
    await client?.forceStop().catch(() => undefined);
    await this.#managed?.close().catch(() => undefined);
  }

  async createSession(config: SessionConfig): Promise<CoordinatorSession> {
    return this.#requireClient().createSession(config);
  }

  async resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CoordinatorSession> {
    return this.#requireClient().resumeSession(sessionId, config);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#requireManaged().sessions.delete(sessionId);
  }

  sessionInfo(sessionId: string): Promise<SessionInfo> {
    return this.#requireManaged().sessions.get(sessionId);
  }

  workers(coordinatorId: string): Promise<WorkerInfo[]> {
    return this.#requireManaged().workers(coordinatorId).list();
  }

  execs(sandboxId: string): Promise<ExecInfo[]> {
    return this.#requireManaged().exec.list(sandboxId);
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    await this.#requireManaged().files(sandboxId).write(path, content);
  }

  readFile(sandboxId: string, path: string): Promise<string> {
    return this.#requireManaged().files(sandboxId).read(path);
  }

  #requireManaged(): ManagedCopilot {
    if (!this.#managed || this.#status.state !== "connected") throw new AppError("platform_unavailable", this.#status.message ?? "Managed Copilot isn't connected yet.", 503);
    return this.#managed;
  }

  #requireClient(): CopilotClient {
    this.#requireManaged();
    if (!this.#client) throw new AppError("platform_unavailable", this.#status.message ?? "Managed Copilot isn't connected yet.", 503);
    return this.#client;
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
        const connecting = ManagedCopilot.connect({ clientName: "incident-commander" });
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
      }
      const managed = this.#managed;
      const described = describeDeployment(managed.info, this.#config.environment);
      const account = managed.account;
      const base = {
        url: managed.url,
        mode: managed.info.mode,
        deployment: managed.info.name,
        account: { login: account.login, ...(account.name ? { name: account.name } : {}), ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}) },
        environments: described.environments,
      };
      if (described.problem) {
        this.#setStatus({ state: "unavailable", ...base, message: described.problem });
        // The deployment can change (sandboxes coming up, a new AppHost): check again with a fresh description.
        this.#managed = undefined;
        await managed.close().catch(() => undefined);
        this.#schedule(++this.#attempt);
        return;
      }
      const old = this.#client;
      this.#client = undefined;
      await old?.forceStop().catch(() => undefined);
      const starting = managed.client(this.#config.environment);
      let client: CopilotClient;
      try {
        client = await deadline(starting, 30_000, "Starting the incident client");
      } catch (error) {
        void starting.then((late) => late.forceStop()).catch(() => undefined);
        throw error;
      }
      if (this.#stopped || this.#managed !== managed) return void (await client.forceStop().catch(() => undefined));
      this.#client = client;
      this.#attempt = 0;
      this.#setStatus({ state: "connected", ...base });
      log.info(previous.state === "connected" ? "Reconnected to Managed Copilot" : "Connected to Managed Copilot", { url: managed.url, environment: this.#config.environment });
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
    const client = this.#client;
    if (!client || this.#stopped) return this.#schedule(1);
    try {
      await deadline(client.ping(), 8_000, "Managed Copilot");
      this.#schedule(0);
    } catch (error) {
      if (this.#stopped) return;
      log.warn("Lost the connection to Managed Copilot; reconnecting", { error: (error as Error).message });
      this.#setStatus({ ...this.#status, state: "reconnecting", message: "Reconnecting to Managed Copilot…" });
      // Connect afresh: the deployment may be back at another address or with other environments.
      const stale = this.#managed;
      this.#managed = undefined;
      this.#client = undefined;
      void client.forceStop().catch(() => undefined);
      void stale?.close().catch(() => undefined);
      void this.#connect();
    }
  }
}
