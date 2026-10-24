import type {
  AssistantMessageEvent,
  CopilotClient,
  MessageOptions,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import {
  isManagedCopilotError,
  ManagedCopilot,
  type ArtifactInfo,
  type EnvironmentInfo,
  type FileEntry,
  type PublicationResult,
  type SessionInfo,
} from "@managed-copilot/sdk";
import { FACTORY_ENVIRONMENTS, ROLES } from "../shared/environments.js";
import type { EnvironmentView, PlatformStatus, StationRole } from "../shared/types.js";
import type { FactoryConfig } from "./config.js";
import { log } from "./log.js";
import { chooseModels } from "./models.js";

/** The parts of a stock `CopilotSession` the pipeline uses. */
export interface StationSession {
  readonly sessionId: string;
  on(handler: (event: SessionEvent) => void): () => void;
  sendAndWait(options: MessageOptions, timeout?: number): Promise<AssistantMessageEvent | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface StationFiles {
  write(remotePath: string, data: string | Uint8Array): Promise<FileEntry>;
}

export interface StationArtifacts {
  waitForPublication(options?: { turnId?: string; timeoutMs?: number }): Promise<PublicationResult>;
  list(options?: { versions?: "latest" | "all" }): Promise<ArtifactInfo[]>;
  read(path: string, options?: { version?: number }): Promise<string>;
}

/** What the pipeline needs from Managed Copilot. Implemented by `Platform`; faked in unit tests. */
export interface FactoryPlatform {
  readonly models: Readonly<Record<StationRole, string>>;
  createSession(role: StationRole, config: SessionConfig): Promise<StationSession>;
  resumeSession(role: StationRole, sessionId: string, config: ResumeSessionConfig): Promise<StationSession>;
  sessionInfo(sessionId: string): Promise<SessionInfo>;
  deleteSession(sessionId: string): Promise<void>;
  files(sessionId: string): StationFiles;
  artifacts(sessionId: string): StationArtifacts;
  environment(role: StationRole): EnvironmentInfo | undefined;
}

/** Platform capabilities the factory needs before it accepts work orders. */
export const REQUIRED_CAPABILITIES = ["shared", "isolated", "files", "artifacts"] as const;

type StatusListener = (status: PlatformStatus) => void;

function describeFailure(error: unknown, url: string | undefined): Pick<PlatformStatus, "message" | "hint" | "state"> {
  if (isManagedCopilotError(error)) {
    switch (error.code) {
      case "authentication_required":
        return { state: "unavailable", message: "Sign in with GitHub to use the factory.", hint: "Run `gh auth login`, or set `GH_TOKEN`, then reload." };
      case "forbidden":
        return {
          state: "unavailable",
          message: "Your GitHub account isn't allowed on this deployment.",
          hint: "Ask the operator to add you to the AppHost's `access` rules.",
        };
      case "capability_unavailable":
        return {
          state: "unavailable",
          message: url ? `Waiting for the Managed Copilot platform at ${url}.` : "The Managed Copilot platform isn't running.",
          hint: "Start it from the repository root with `aspire run`.",
        };
      default:
        return { state: "unavailable", message: error.message, hint: "Check the platform logs in the Aspire dashboard." };
    }
  }
  return {
    state: "unavailable",
    message: "The factory can't reach the Managed Copilot platform.",
    hint: "Start it from the repository root with `aspire run`.",
  };
}

/** Connects to the deployment, keeps the connection healthy, and hands out stock clients per environment. */
export class Platform implements FactoryPlatform {
  readonly #config: FactoryConfig;
  readonly #listeners = new Set<StatusListener>();
  readonly #clients = new Map<StationRole, Promise<CopilotClient>>();
  #managed: ManagedCopilot | undefined;
  #models: Record<StationRole, string>;
  #status: PlatformStatus;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #attempt = 0;

  constructor(config: FactoryConfig) {
    this.#config = config;
    this.#models = chooseModels(undefined, config.modelOverrides);
    this.#status = this.#baseStatus("connecting", { message: "Connecting to the Managed Copilot platform…" });
  }

  get status(): PlatformStatus {
    return this.#status;
  }

  get models(): Readonly<Record<StationRole, string>> {
    return this.#models;
  }

  get connected(): boolean {
    return this.#status.state === "connected";
  }

  onStatus(listener: StatusListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    void this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#dispose();
  }

  #managedOrThrow(): ManagedCopilot {
    if (!this.#managed) throw new Error(this.#status.message ?? "The Managed Copilot platform is not connected.");
    return this.#managed;
  }

  environment(role: StationRole): EnvironmentInfo | undefined {
    return this.#managed?.info.environments.find((env) => env.name === FACTORY_ENVIRONMENTS[role]);
  }

  async #client(role: StationRole): Promise<CopilotClient> {
    const existing = this.#clients.get(role);
    if (existing) return existing;
    const created = this.#managedOrThrow().client(FACTORY_ENVIRONMENTS[role]);
    this.#clients.set(role, created);
    created.catch(() => this.#clients.delete(role));
    return created;
  }

  async createSession(role: StationRole, config: SessionConfig): Promise<StationSession> {
    const client = this.#client(role);
    try {
      return await (await client).createSession(config);
    } catch (error) {
      if (isManagedCopilotError(error)) throw error;
      // Only a broken transport warrants a new client: a healthy client serves other sessions, and a session-level
      // rejection (admission, setup) must surface as is. A ping tells them apart.
      if (await this.#alive(client)) throw error;
      log.warn("The environment's connection dropped; retrying on a fresh client", { role, error: (error as Error).message });
      if (this.#clients.get(role) === client) {
        this.#clients.delete(role);
        void client.then((stale) => stale.stop()).catch(() => undefined);
      }
      return (await this.#client(role)).createSession(config);
    }
  }

  async #alive(client: Promise<CopilotClient>): Promise<boolean> {
    try {
      const resolved = await client;
      await Promise.race([resolved.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error("ping timed out")), 5_000).unref())]);
      return true;
    } catch {
      return false;
    }
  }

  resumeSession(_role: StationRole, sessionId: string, config: ResumeSessionConfig): Promise<StationSession> {
    return this.#managedOrThrow().resumeSession(sessionId, config);
  }

  sessionInfo(sessionId: string): Promise<SessionInfo> {
    return this.#managedOrThrow().sessions.get(sessionId);
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.#managedOrThrow().sessions.delete(sessionId);
  }

  files(sessionId: string): StationFiles {
    return this.#managedOrThrow().files(sessionId);
  }

  artifacts(sessionId: string): StationArtifacts {
    const artifacts = this.#managedOrThrow().artifacts(sessionId);
    return {
      waitForPublication: (options) => artifacts.waitForPublication(options),
      list: (options) => artifacts.list(options),
      // `read(path, { version })` is an additive option; older SDK builds ignore it and return the newest version.
      read: (path, options) => (artifacts.read as (path: string, options?: { version?: number }) => Promise<string>)(path, options),
    };
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    const url = process.env.MANAGED_COPILOT_URL;
    try {
      const managed = await ManagedCopilot.connect({ clientName: "software-factory" });
      this.#managed = managed;
      this.#attempt = 0;
      await this.#refreshModels();
      this.#setStatus(this.#connectedStatus());
      log.info("Connected to Managed Copilot", { url: managed.url, account: managed.account.login, models: this.#models });
      this.#schedule(this.#config.healthIntervalMs, () => this.#healthCheck());
    } catch (error) {
      await this.#dispose();
      const failure = describeFailure(error, url);
      if (this.#status.message !== failure.message) log.warn("Platform unavailable", { reason: failure.message });
      this.#setStatus(this.#baseStatus(failure.state, { ...failure, ...(url ? { url } : {}) }));
      this.#attempt++;
      this.#schedule(Math.min(2_000 * this.#attempt, 10_000), () => this.#connect());
    }
  }

  async #healthCheck(): Promise<void> {
    if (this.#stopped || !this.#managed) return;
    try {
      await this.#managed.sessions.list({ limit: 1 });
      this.#schedule(this.#config.healthIntervalMs, () => this.#healthCheck());
    } catch (error) {
      log.warn("Lost the platform connection; reconnecting", { error: (error as Error).message });
      await this.#dispose();
      this.#setStatus(this.#baseStatus("connecting", { message: "Reconnecting to the Managed Copilot platform…" }));
      this.#schedule(1_000, () => this.#connect());
    }
  }

  async #refreshModels(): Promise<void> {
    try {
      const client = await this.#client("planner");
      this.#models = chooseModels(await client.listModels(), this.#config.modelOverrides);
    } catch (error) {
      // Model discovery is best effort; preferences still apply and sessions fail explicitly if a model is missing.
      if (!isManagedCopilotError(error) || error.code !== "environment_not_found") {
        log.warn("Model discovery failed; using preferred defaults", { error: (error as Error).message });
      }
      const failed = this.#clients.get("planner");
      this.#clients.delete("planner");
      void failed?.then((client) => client.stop()).catch(() => undefined);
      this.#models = chooseModels(undefined, this.#config.modelOverrides);
    }
  }

  #schedule(ms: number, task: () => Promise<void>): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void task(), ms);
    this.#timer.unref();
  }

  async #dispose(): Promise<void> {
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    const managed = this.#managed;
    this.#managed = undefined;
    await Promise.allSettled(clients.map(async (client) => (await client).stop()));
    await managed?.close().catch(() => undefined);
  }

  #environmentViews(): EnvironmentView[] {
    const managed = this.#managed;
    if (!managed) return [];
    const views: EnvironmentView[] = [];
    for (const role of ROLES) {
      const env = managed.info.environments.find((candidate) => candidate.name === FACTORY_ENVIRONMENTS[role]);
      if (!env) continue;
      views.push({
        role,
        name: env.name,
        type: env.type,
        ...(env.description ? { description: env.description } : {}),
        network: { access: env.network.access, allowedDomains: [...env.network.allowedDomains] },
        ...(env.size ? { size: env.size } : {}),
        agents: [...env.agents],
        model: this.#models[role],
      });
    }
    return views;
  }

  #connectedStatus(): PlatformStatus {
    const managed = this.#managedOrThrow();
    const capabilities = managed.info.capabilities;
    const missingEnvironments = ROLES.map((role) => FACTORY_ENVIRONMENTS[role]).filter(
      (name) => !managed.info.environments.some((env) => env.name === name),
    );
    const missingCapabilities = REQUIRED_CAPABILITIES.filter((capability) => !capabilities.includes(capability));
    const ready = missingEnvironments.length === 0 && missingCapabilities.length === 0;
    let message: string | undefined;
    let hint: string | undefined;
    if (missingEnvironments.length > 0) {
      message = "This deployment doesn't declare the factory's environments.";
      hint = "Add `softwareFactory()` from `demos/software-factory/apphost.mts` to your AppHost and restart `aspire run`.";
    } else if (missingCapabilities.length > 0) {
      message = `This deployment can't run the factory yet: it doesn't offer ${missingCapabilities.join(", ")}.`;
      hint = "Update the platform to a build with isolated sandboxes, files, and artifacts.";
    }
    return {
      state: ready ? "connected" : "misconfigured",
      url: managed.url,
      ...(message ? { message } : {}),
      ...(hint ? { hint } : {}),
      deployment: {
        name: managed.info.name,
        mode: managed.info.mode,
        version: managed.info.version,
        capabilities: [...capabilities],
        copilotSdk: managed.info.sdk.copilotSdk,
        copilotRuntime: managed.info.sdk.copilotRuntime,
      },
      account: {
        login: managed.account.login,
        ...(managed.account.name ? { name: managed.account.name } : {}),
        ...(managed.account.avatarUrl ? { avatarUrl: managed.account.avatarUrl } : {}),
      },
      environments: this.#environmentViews(),
      missingEnvironments,
      features: {
        runs: ready,
        isolated: capabilities.includes("isolated"),
        artifacts: capabilities.includes("artifacts"),
        files: capabilities.includes("files"),
        attach: capabilities.includes("attach.cli"),
      },
      checkedAt: new Date().toISOString(),
    };
  }

  #baseStatus(state: PlatformStatus["state"], extra: Partial<PlatformStatus>): PlatformStatus {
    return {
      state,
      environments: [],
      missingEnvironments: [],
      features: { runs: false, isolated: false, artifacts: false, files: false, attach: false },
      checkedAt: new Date().toISOString(),
      ...extra,
    };
  }

  #setStatus(status: PlatformStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }
}
