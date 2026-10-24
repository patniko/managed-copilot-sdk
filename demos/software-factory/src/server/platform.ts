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
import { PlatformUnavailableError } from "./pipeline/errors.js";

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
  /** `note` receives user-facing remarks about how the session was set up (for the station's activity). */
  createSession(role: StationRole, config: SessionConfig, note?: (text: string) => void): Promise<StationSession>;
  resumeSession(role: StationRole, sessionId: string, config: ResumeSessionConfig, note?: (text: string) => void): Promise<StationSession>;
  sessionInfo(sessionId: string): Promise<SessionInfo>;
  /** The signed-in user's sessions in the factory's environments; may be capped, so absent doesn't mean deleted. */
  listSessions(): Promise<SessionInfo[]>;
  deleteSession(sessionId: string): Promise<void>;
  files(sessionId: string): StationFiles;
  artifacts(sessionId: string): StationArtifacts;
  environment(role: StationRole): EnvironmentInfo | undefined;
}

/** Platform capabilities the factory needs before it accepts work orders. */
export const REQUIRED_CAPABILITIES = ["shared", "isolated", "files", "artifacts"] as const;

/** Timings of the connection loop. Every step has a deadline, so a request held open in front of the gateway can't stall it. */
export interface PlatformTimings {
  /** First retry delay after a failure; doubles per attempt up to `retryMaxMs`, with jitter. */
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  /** One connect attempt: the deployment's info and the signed-in account. */
  readonly connectTimeoutMs: number;
  /** One health probe, or one read of a session's status. */
  readonly healthTimeoutMs: number;
  /** Model discovery (starting a client and listing models); the preferred defaults apply when it runs out. */
  readonly discoveryTimeoutMs: number;
  /** A graceful client stop, before the client is forced. */
  readonly stopTimeoutMs: number;
  /** Reattaching to a session, which can restart (or recreate) its sandbox first. */
  readonly resumeTimeoutMs: number;
  /** Interval of keepalive pings on each client's connection: proxies cut silent WebSockets (Azure Container Apps after 240 s). */
  readonly keepAliveMs: number;
}

/**
 * The gateway gives GitHub token verification up to 35 s, but it caches results and shares verifications in flight, so
 * a connect attempt abandoned at 15 s still lets the next one through quickly.
 */
export const PLATFORM_TIMINGS: PlatformTimings = {
  retryBaseMs: 1_000,
  retryMaxMs: 30_000,
  connectTimeoutMs: 15_000,
  healthTimeoutMs: 10_000,
  discoveryTimeoutMs: 20_000,
  stopTimeoutMs: 5_000,
  resumeTimeoutMs: 180_000,
  keepAliveMs: 60_000,
};

export interface PlatformOptions {
  readonly timings?: Partial<PlatformTimings>;
  /** Deployment URL; defaults to the SDK's resolution (`MANAGED_COPILOT_URL`, then the local AppHost). */
  readonly url?: string;
  /** GitHub token; defaults to the SDK's resolution (environment variables, then `gh auth token`). */
  readonly gitHubToken?: string;
}

/** Retry delay after the `attempt`-th consecutive failure: exponential up to the cap, then 50–100 % of that (jitter). */
export function reconnectDelay(
  attempt: number,
  timings: Pick<PlatformTimings, "retryBaseMs" | "retryMaxMs"> = PLATFORM_TIMINGS,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(timings.retryMaxMs, timings.retryBaseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/** Failures that retrying fixes by itself; sign-in and access problems need someone to act. */
export function isRetryable(error: unknown): boolean {
  return !isManagedCopilotError(error) || !["authentication_required", "forbidden", "invalid_request"].includes(error.code);
}

class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeadlineError";
  }
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

/**
 * Waits for an SDK call at most `ms`. The SDK's requests can't be aborted, so a call that misses its deadline is
 * abandoned: `onTimeout` runs when it does, and `onLate` disposes of whatever it resolves to afterwards.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string, onLate?: (value: T) => void, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      if (onLate) promise.then(onLate, () => undefined);
      reject(new DeadlineError(`${what} took longer than ${formatSeconds(ms)}.`));
    }, ms);
    timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** A platform call that ran out of time is the platform not answering: the pipeline pauses rather than failing a station. */
function unanswered<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error: unknown) => {
    throw error instanceof DeadlineError ? new PlatformUnavailableError(error.message) : error;
  });
}

/** Stops a client, forcing it when a dropped transport leaves the graceful stop waiting for answers that never come. */
async function stopClient(client: CopilotClient, ms: number): Promise<void> {
  try {
    await withDeadline(client.stop(), ms, "Stopping a client");
  } catch {
    await client.forceStop().catch(() => undefined);
  }
}

async function closeQuietly(managed: ManagedCopilot, ms: number): Promise<void> {
  await withDeadline(managed.close(), ms, "Closing the connection").catch(() => undefined);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
}

type StatusListener = (status: PlatformStatus) => void;

function describeFailure(error: unknown, url: string | undefined): Pick<PlatformStatus, "message" | "hint" | "state"> {
  if (error instanceof DeadlineError) {
    return { state: "unavailable", message: error.message, hint: "The factory retries automatically. Check the platform logs in the Aspire dashboard." };
  }
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
      case "capability_unavailable": {
        // Only "can't reach it" means the platform isn't up; anything else (GitHub unreachable, ...) is shown as is.
        if (!/cannot reach|no managed copilot deployment found/i.test(error.message)) {
          return { state: "unavailable", message: error.message, hint: "The factory retries automatically. Check the platform logs in the Aspire dashboard." };
        }
        return {
          state: "unavailable",
          message: url ? `Waiting for the Managed Copilot platform at ${url}.` : "The Managed Copilot platform isn't running.",
          hint: "Start it from the repository root with `aspire run`.",
        };
      }
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
  readonly #options: PlatformOptions;
  readonly #timings: PlatformTimings;
  readonly #listeners = new Set<StatusListener>();
  readonly #clients = new Map<StationRole, Promise<CopilotClient>>();
  #managed: ManagedCopilot | undefined;
  #models: Record<StationRole, string>;
  #status: PlatformStatus;
  #timer: NodeJS.Timeout | undefined;
  #keepAliveTimer: NodeJS.Timeout | undefined;
  /** Clients with a keepalive ping in flight (or still starting): one at a time each. */
  readonly #pinging = new WeakSet<Promise<CopilotClient>>();
  #stopped = false;
  /** Consecutive failed connect attempts. */
  #attempt = 0;
  /** Consecutive failed health probes. */
  #healthFailures = 0;
  /** Once connected, a lost connection is reported as `reconnecting`. */
  #connectedOnce = false;
  /** When the current outage began. */
  #lostAt: number | undefined;
  /** The last connected status: a reconnecting one keeps showing its deployment and account. */
  #lastConnected: PlatformStatus | undefined;

  constructor(config: FactoryConfig, options: PlatformOptions = {}) {
    this.#config = config;
    this.#options = options;
    this.#timings = { ...PLATFORM_TIMINGS, ...options.timings };
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
    this.#keepAliveTimer ??= setInterval(() => this.#keepAlive(), this.#timings.keepAliveMs);
    this.#keepAliveTimer.unref();
    void this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#keepAliveTimer) clearInterval(this.#keepAliveTimer);
    await this.#dispose();
  }

  /**
   * Checks the connection right away, for example after a station's transport dropped. Resolves true when the platform
   * answers; otherwise the factory starts reconnecting and resolves false.
   */
  async verify(): Promise<boolean> {
    const managed = this.#managed;
    if (this.#stopped || !managed || !this.#status.features.runs) return false;
    try {
      await withDeadline(managed.sessions.list({ limit: 1 }), this.#timings.healthTimeoutMs, "The health check");
      return true;
    } catch (error) {
      if (!this.#stopped && this.#managed === managed) this.#connectionLost(error);
      return false;
    }
  }

  #managedOrThrow(): ManagedCopilot {
    if (!this.#managed) {
      throw new PlatformUnavailableError(
        this.#status.state === "reconnecting"
          ? "The factory is reconnecting to Managed Copilot."
          : (this.#status.message ?? "The factory isn't connected to Managed Copilot."),
      );
    }
    return this.#managed;
  }

  environment(role: StationRole): EnvironmentInfo | undefined {
    return this.#managed?.info.environments.find((env) => env.name === FACTORY_ENVIRONMENTS[role]);
  }

  /** The environment's client. Returns the cached promise itself, so callers can tell whether it was replaced. */
  #client(role: StationRole): Promise<CopilotClient> {
    const existing = this.#clients.get(role);
    if (existing) return existing;
    let created: Promise<CopilotClient>;
    try {
      created = this.#managedOrThrow().client(FACTORY_ENVIRONMENTS[role]);
    } catch (error) {
      return Promise.reject(error);
    }
    this.#clients.set(role, created);
    created.catch(() => {
      if (this.#clients.get(role) === created) this.#clients.delete(role);
    });
    return created;
  }

  /** Creates a session with the station's deployed custom agent (`agent`), retrying once on a fresh client. */
  async createSession(role: StationRole, config: SessionConfig, _note?: (text: string) => void): Promise<StationSession> {
    return this.#withClient(role, (client) => client.createSession(config));
  }

  /**
   * Runs `use` on the environment's client, retrying once on a fresh client when its transport broke. Sessions are
   * created and resumed only through these tracked clients, so a lost connection stops (or forces) every one of them.
   * Once `attempt` is abandoned (its caller's deadline passed), no further SDK call is made: a late resume would replace
   * the session object, and so the event handlers, of a newer resume of the same session on the current client.
   */
  async #withClient<T>(role: StationRole, use: (client: CopilotClient) => Promise<T>, attempt?: { abandoned: boolean }): Promise<T> {
    const run = async (pending: Promise<CopilotClient>): Promise<T> => {
      const client = await pending;
      if (attempt?.abandoned) throw new PlatformUnavailableError("The platform didn't answer in time.");
      return use(client);
    };
    const client = this.#client(role);
    try {
      return await run(client);
    } catch (error) {
      if (attempt?.abandoned || isManagedCopilotError(error)) throw error;
      // Only a broken transport warrants a new client: a healthy client serves other sessions, and a session-level
      // rejection (admission, setup) must surface as is. A ping tells them apart.
      if (await this.#alive(client)) throw error;
      log.warn("The environment's connection dropped; retrying on a fresh client", { role, error: errorText(error) });
      if (this.#clients.get(role) === client) {
        this.#clients.delete(role);
        void client.then((stale) => stopClient(stale, this.#timings.stopTimeoutMs), () => undefined);
      }
      return run(this.#client(role));
    }
  }

  /**
   * Pings every client's connection. Proxies in front of the gateway close WebSockets that carry nothing for a while
   * (the Azure Container Apps ingress after 240 s), which would disconnect a station's session while it waits.
   */
  #keepAlive(): void {
    for (const [role, pending] of this.#clients) {
      if (this.#pinging.has(pending)) continue;
      this.#pinging.add(pending);
      void pending
        .then((client) => withDeadline(client.ping(), this.#timings.healthTimeoutMs, "A keepalive ping"))
        .catch((error: unknown) => log.debug("Keepalive ping failed", { role, error: errorText(error) }))
        .finally(() => this.#pinging.delete(pending));
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

  /**
   * Resumes a session through the station's environment client and makes sure its agent is still the selected one.
   * Bounded: a gateway that never answers (its sandbox runtime unreachable) can't hold a station forever. An abandoned
   * resume is left alone rather than detached: a detach is per client and session, so it would also detach a newer
   * resume of the same session on the same client.
   */
  async resumeSession(role: StationRole, sessionId: string, config: ResumeSessionConfig, note?: (text: string) => void): Promise<StationSession> {
    const { agent, ...rest } = config;
    const attempt = { abandoned: false };
    const session = await unanswered(
      withDeadline(
        this.#withClient(role, (client) => client.resumeSession(sessionId, rest), attempt),
        this.#timings.resumeTimeoutMs,
        `Reattaching to session ${sessionId}`,
        undefined,
        () => {
          attempt.abandoned = true;
        },
      ),
    );
    if (agent) {
      try {
        const timeoutMs = this.#timings.healthTimeoutMs;
        const current = await withDeadline(session.rpc.agent.getCurrent(), timeoutMs, "Reading the session's agent");
        if (current.agent?.name !== agent) {
          await withDeadline(session.rpc.agent.select({ name: agent }), timeoutMs, "Selecting the session's agent");
          note?.(`Re-selected the deployed "${agent}" agent`);
        }
      } catch (error) {
        log.warn("Couldn't confirm the session's agent after resume", { sessionId, agent, error: (error as Error).message });
      }
    }
    return session;
  }

  async sessionInfo(sessionId: string): Promise<SessionInfo> {
    return unanswered(withDeadline(this.#managedOrThrow().sessions.get(sessionId), this.#timings.healthTimeoutMs, "Reading the session's status"));
  }

  /** The signed-in user's sessions in the factory's environments (owner-scoped, newest first, capped per environment). */
  async listSessions(): Promise<SessionInfo[]> {
    const managed = this.#managedOrThrow();
    const environments = [...new Set(ROLES.map((role) => FACTORY_ENVIRONMENTS[role]))];
    const lists = await Promise.all(environments.map((environment) => managed.sessions.list({ environment, limit: 1000 })));
    return lists.flat();
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
    const url = this.#options.url ?? process.env.MANAGED_COPILOT_URL;
    this.#attempt++;
    const startedAt = Date.now();
    let managed: ManagedCopilot;
    try {
      managed = await withDeadline(
        ManagedCopilot.connect({
          clientName: "software-factory",
          ...(this.#options.url ? { url: this.#options.url } : {}),
          ...(this.#options.gitHubToken ? { gitHubToken: this.#options.gitHubToken } : {}),
        }),
        this.#timings.connectTimeoutMs,
        "Connecting to Managed Copilot",
        (late) => void closeQuietly(late, this.#timings.stopTimeoutMs),
      );
    } catch (error) {
      this.#connectFailed(error, url, Date.now() - startedAt);
      return;
    }
    if (this.#stopped) {
      void closeQuietly(managed, this.#timings.stopTimeoutMs);
      return;
    }
    this.#managed = managed;
    await this.#refreshModels();
    if (this.#stopped || this.#managed !== managed) return;
    const reconnected = this.#connectedOnce;
    const attempts = this.#attempt;
    const outageMs = this.#lostAt === undefined ? undefined : Date.now() - this.#lostAt;
    this.#attempt = 0;
    this.#healthFailures = 0;
    this.#lostAt = undefined;
    this.#connectedOnce = true;
    this.#lastConnected = this.#connectedStatus();
    this.#setStatus(this.#lastConnected);
    if (reconnected) log.info("Reconnected to Managed Copilot", { url: managed.url, attempts, ...(outageMs !== undefined ? { outageMs } : {}) });
    else log.info("Connected to Managed Copilot", { url: managed.url, account: managed.account.login, models: this.#models });
    this.#schedule(this.#config.healthIntervalMs, () => this.#healthCheck());
  }

  /** Backoff spaces attempt starts: an attempt that ran into its deadline already waited, so the next one follows soon. */
  #connectFailed(error: unknown, url: string | undefined, elapsedMs: number): void {
    const retryable = isRetryable(error);
    const backoff = retryable ? reconnectDelay(this.#attempt, this.#timings) : this.#timings.retryMaxMs;
    const delay = Math.max(Math.round(this.#timings.retryBaseMs / 4), backoff - elapsedMs);
    const failure = describeFailure(error, url);
    const status =
      retryable && this.#connectedOnce ? this.#reconnectingStatus(error, delay) : this.#baseStatus(failure.state, { ...failure, ...(url ? { url } : {}) });
    // Every reconnect attempt is logged: repeats of the same message, once suppressed, hid a stalled reconnect.
    if (this.#connectedOnce || status.message !== this.#status.message) {
      log.warn(this.#connectedOnce ? "Couldn't reconnect to Managed Copilot yet" : "Platform unavailable", {
        reason: failure.message,
        attempt: this.#attempt,
        retryInMs: delay,
      });
    }
    this.#setStatus(status);
    this.#schedule(delay, () => this.#connect());
  }

  async #healthCheck(): Promise<void> {
    const managed = this.#managed;
    if (this.#stopped || !managed) return;
    try {
      await withDeadline(managed.sessions.list({ limit: 1 }), this.#timings.healthTimeoutMs, "The health check");
      if (this.#stopped || this.#managed !== managed) return;
      this.#healthFailures = 0;
      this.#schedule(this.#config.healthIntervalMs, () => this.#healthCheck());
    } catch (error) {
      if (this.#stopped || this.#managed !== managed) return;
      // One failed probe can be a blip in front of the gateway: confirm before dropping the connection and pausing work.
      if (++this.#healthFailures < 2) {
        log.debug("Health check failed; checking again", { error: errorText(error) });
        this.#schedule(this.#timings.retryBaseMs, () => this.#healthCheck());
        return;
      }
      this.#connectionLost(error);
    }
  }

  /** Lets go of the connection without waiting for it and starts reconnecting. */
  #connectionLost(error: unknown): void {
    log.warn("Lost the platform connection; reconnecting", { error: errorText(error) });
    this.#lostAt = Date.now();
    this.#healthFailures = 0;
    this.#attempt = 0;
    void this.#dispose();
    const delay = reconnectDelay(1, this.#timings);
    this.#setStatus(this.#reconnectingStatus(error, delay));
    this.#schedule(delay, () => this.#connect());
  }

  async #refreshModels(): Promise<void> {
    const pending = this.#client("planner");
    try {
      const client = await withDeadline(pending, this.#timings.discoveryTimeoutMs, "Starting a client for model discovery");
      const models = await withDeadline(client.listModels(), this.#timings.discoveryTimeoutMs, "Listing models");
      this.#models = chooseModels(models, this.#config.modelOverrides);
    } catch (error) {
      // Model discovery is best effort; preferences still apply and sessions fail explicitly if a model is missing.
      if (!isManagedCopilotError(error) || error.code !== "environment_not_found") {
        log.warn("Model discovery failed; using preferred defaults", { error: errorText(error) });
      }
      if (this.#clients.get("planner") === pending) this.#clients.delete("planner");
      void pending.then((client) => stopClient(client, this.#timings.stopTimeoutMs), () => undefined);
      this.#models = chooseModels(undefined, this.#config.modelOverrides);
    }
  }

  #schedule(ms: number, task: () => Promise<void>): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void task(), ms);
    this.#timer.unref();
  }

  /**
   * Drops the clients and the connection. Bounded: a dropped transport can leave a graceful stop waiting forever, so
   * clients are forced after a grace period, and a client still starting is stopped when it does.
   */
  async #dispose(): Promise<void> {
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    const managed = this.#managed;
    this.#managed = undefined;
    const ms = this.#timings.stopTimeoutMs;
    const stops = Promise.allSettled(clients.map((pending) => pending.then((client) => stopClient(client, ms))));
    await withDeadline(stops, 2 * ms, "Stopping clients").catch(() => undefined);
    if (managed) await closeQuietly(managed, ms);
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

  /** While reconnecting, the floor keeps showing the deployment it was connected to, with runs paused. */
  #reconnectingStatus(error: unknown, retryInMs: number): PlatformStatus {
    const last = this.#lastConnected;
    const url = this.#options.url ?? process.env.MANAGED_COPILOT_URL ?? last?.url;
    const seconds = Math.max(1, Math.round(retryInMs / 1000));
    return this.#baseStatus("reconnecting", {
      message: "Reconnecting to Managed Copilot…",
      hint: `${describeFailure(error, url).message} Next attempt in ${seconds} s; running work orders pause and continue from their last checkpoint once it's back.`,
      ...(url ? { url } : {}),
      ...(last?.deployment ? { deployment: last.deployment } : {}),
      ...(last?.account ? { account: last.account } : {}),
      environments: last?.environments ?? [],
    });
  }

  #setStatus(status: PlatformStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }
}
