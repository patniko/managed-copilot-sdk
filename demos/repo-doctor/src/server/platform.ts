// The connection to Managed Copilot: one stock CopilotClient for Repo Doctor's isolated environment, kept healthy, plus
// the calls a run makes into its sandbox (commands, files) and the platform's `network.blocked` events.
// Everything here is the public SDK.
import type { AssistantMessageEvent, CopilotClient, MessageOptions, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import type { SandboxInfo } from "@managed-copilot/protocol";
import { isManagedCopilotError, ManagedCopilot, type DeploymentInfo, type PlatformEvent } from "@managed-copilot/sdk";
import type { EnvironmentView, PlatformStatus } from "../shared/types.js";
import type { DoctorConfig } from "./config.js";
import { DoctorError } from "./errors.js";
import { log } from "./log.js";

/** The parts of a stock `CopilotSession` a run uses. */
export interface DoctorSession {
  readonly sessionId: string;
  on(handler: (event: SessionEvent) => void): () => void;
  sendAndWait(options: MessageOptions, timeout?: number): Promise<AssistantMessageEvent | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

/** One `network.blocked` platform event: a request from a session's sandbox that its network rules refused. */
export interface BlockedRequest {
  readonly sessionId: string;
  readonly at: string;
  readonly reason: string;
  readonly host?: string;
  readonly port?: number;
}

export interface CommandResult {
  /** Absent when the command didn't finish on its own (it timed out, was stopped, or its state is uncertain). */
  readonly exitCode?: number;
  readonly state: string;
  readonly output: string;
  readonly reason?: string;
}

export interface CommandOptions {
  readonly timeoutMs: number;
  /** Output as it arrives. */
  readonly onOutput?: (chunk: string) => void;
  /** Stops the command. */
  readonly signal?: AbortSignal;
}

/** What runs need from Managed Copilot. Implemented by `Platform`; faked in tests. */
export interface DoctorPlatform {
  readonly status: PlatformStatus;
  onStatus(listener: (status: PlatformStatus) => void): () => void;
  onBlocked(listener: (request: BlockedRequest) => void): () => void;
  /** A new session of Repo Doctor's isolated environment: it returns once the session's own sandbox is ready. */
  createSession(config: SessionConfig): Promise<DoctorSession>;
  sandbox(sessionId: string): Promise<SandboxInfo | undefined>;
  /** Deletes the session, and with it its sandbox. */
  deleteSession(sessionId: string): Promise<void>;
  /** Runs `bash -c <command>` in the session's sandbox, in /workspace, with the sandbox's network rules. */
  run(sessionId: string, command: string, options: CommandOptions): Promise<CommandResult>;
  writeFile(sessionId: string, path: string, content: string): Promise<void>;
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
    if (error.code === "authentication_required") return "Sign in to GitHub (gh auth login) or set GH_TOKEN, then Repo Doctor connects by itself.";
    if (error.code === "forbidden") return "This GitHub account can't use this Managed Copilot deployment.";
    return error.message;
  }
  const message = (error as Error)?.message ?? String(error);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|did not answer/i.test(message)) return "Managed Copilot isn't reachable yet. Start it with `aspire run`, or set MANAGED_COPILOT_URL.";
  return message;
}

/** Repo Doctor's environment as the deployment declares it, or why it can't be used. */
export function describeEnvironment(info: DeploymentInfo, name: string): { environment?: EnvironmentView; problem?: string } {
  const declared = info.environments.find((environment) => environment.name === name);
  if (!declared) return { problem: `This deployment has no "${name}" environment. Add Repo Doctor's environment to the AppHost (demos/repo-doctor/apphost.mts).` };
  if (declared.type !== "isolated") return { problem: `"${name}" is a ${declared.type} environment; Repo Doctor needs an isolated one, so the agent and its tools share a sandbox.` };
  const environment: EnvironmentView = {
    name,
    ...(declared.size ? { size: declared.size } : {}),
    network: { access: declared.network.access, hosts: [...declared.network.allowedDomains] },
  };
  if (declared.exec === false) return { environment, problem: `Running commands directly is turned off for "${name}", and Repo Doctor runs the tests itself.` };
  if (!info.capabilities.includes("isolated")) return { environment, problem: "Sandboxes aren't available on this deployment right now. Repo Doctor keeps checking." };
  return { environment };
}

export class Platform implements DoctorPlatform {
  readonly #config: DoctorConfig;
  #managed: ManagedCopilot | undefined;
  #client: CopilotClient | undefined;
  #status: PlatformStatus = { state: "connecting" };
  readonly #statusListeners = new Set<(status: PlatformStatus) => void>();
  readonly #blockedListeners = new Set<(request: BlockedRequest) => void>();
  #attempt = 0;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #connecting: Promise<void> | undefined;

  constructor(config: DoctorConfig) {
    this.#config = config;
  }

  get status(): PlatformStatus {
    return this.#status;
  }

  onStatus(listener: (status: PlatformStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onBlocked(listener: (request: BlockedRequest) => void): () => void {
    this.#blockedListeners.add(listener);
    return () => this.#blockedListeners.delete(listener);
  }

  start(): void {
    void this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    const client = this.#client;
    this.#client = undefined;
    if (client) await deadline(client.forceStop(), 5_000, "Stopping the client").catch(() => undefined);
    await this.#managed?.close().catch(() => undefined);
  }

  async createSession(config: SessionConfig): Promise<DoctorSession> {
    this.#requireManaged();
    if (!this.#client) throw new DoctorError("platform_unavailable", this.#status.message ?? "Managed Copilot isn't connected yet.", 503);
    return this.#client.createSession(config);
  }

  async sandbox(sessionId: string): Promise<SandboxInfo | undefined> {
    return (await this.#requireManaged().sessions.get(sessionId)).sandbox;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#requireManaged().sessions.delete(sessionId);
  }

  async run(sessionId: string, command: string, options: CommandOptions): Promise<CommandResult> {
    const managed = this.#requireManaged();
    const job = await managed.exec(sessionId, command, { background: true, timeoutMs: options.timeoutMs, stdin: "closed" });
    const stop = () => void job.stop().catch(() => undefined);
    if (options.signal?.aborted) stop();
    options.signal?.addEventListener("abort", stop, { once: true });
    try {
      for await (const chunk of job.output) options.onOutput?.(chunk);
      const result = await job.result;
      return { state: result.state, output: result.output, ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}), ...(result.reason ? { reason: result.reason } : {}) };
    } finally {
      options.signal?.removeEventListener("abort", stop);
    }
  }

  async writeFile(sessionId: string, path: string, content: string): Promise<void> {
    await this.#requireManaged().files(sessionId).write(path, content, { overwrite: true });
  }

  #requireManaged(): ManagedCopilot {
    if (!this.#managed || this.#status.state !== "connected") throw new DoctorError("platform_unavailable", this.#status.message ?? "Managed Copilot isn't connected yet.", 503);
    return this.#managed;
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
        const connecting = ManagedCopilot.connect({ clientName: "repo-doctor" });
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
        managed.on("network.blocked", (event) => this.#blocked(event));
      }
      const managed = this.#managed;
      const described = describeEnvironment(managed.info, this.#config.environment);
      const account = managed.account;
      const base: PlatformStatus = {
        state: "connecting",
        url: managed.url,
        mode: managed.info.mode,
        deployment: managed.info.name,
        account: { login: account.login, ...(account.name ? { name: account.name } : {}), ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}) },
        ...(described.environment ? { environment: described.environment } : {}),
      };
      if (described.problem) {
        this.#setStatus({ ...base, state: "unavailable", message: described.problem });
        // The deployment can change (for example sandboxes coming up): check again, and re-read its description.
        this.#managed = undefined;
        await managed.close().catch(() => undefined);
        this.#schedule(++this.#attempt);
        return;
      }
      const old = this.#client;
      this.#client = undefined;
      if (old) await deadline(old.forceStop(), 5_000, "Stopping the old client").catch(() => undefined);
      const starting = managed.client(this.#config.environment);
      let client: CopilotClient;
      try {
        client = await deadline(starting, 30_000, "Starting Repo Doctor's client");
      } catch (error) {
        // A client that finishes starting after the deadline is stopped, not leaked.
        void starting.then((late) => late.forceStop()).catch(() => undefined);
        throw error;
      }
      if (this.#stopped || this.#managed !== managed) {
        await client.forceStop().catch(() => undefined);
        return;
      }
      this.#client = client;
      this.#attempt = 0;
      this.#setStatus({ ...base, state: "connected" });
      log.info(previous.state === "connected" ? "Reconnected to Managed Copilot" : "Connected to Managed Copilot", { url: managed.url, environment: this.#config.environment });
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

  #blocked(event: PlatformEvent): void {
    if (!event.sessionId) return;
    const data = event.data;
    const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
    const request: BlockedRequest = {
      sessionId: event.sessionId,
      at: text(data.at) ?? event.createdAt,
      reason: text(data.reason) ?? "blocked",
      ...(text(data.host) ? { host: text(data.host)! } : {}),
      ...(typeof data.port === "number" ? { port: data.port } : {}),
    };
    for (const listener of this.#blockedListeners) {
      try {
        listener(request);
      } catch (error) {
        log.warn("A network event listener failed", { error: (error as Error).message });
      }
    }
  }
}
