import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import type { AccountInfo, DeploymentInfo, PlatformEventType, PromoteResult } from "@managed-copilot/protocol";
import { createContext, type ManagedState } from "./connection.js";
import { createArtifactsApi } from "./features/artifacts.js";
import { openCli } from "./features/cli.js";
import { createClient, createManagedSession, resumeManagedSession } from "./features/client.js";
import { ensureEventStream } from "./features/events.js";
import { createFilesApi } from "./features/files.js";
import { promoteSession } from "./features/promote.js";
import { createSchedulesApi } from "./features/schedules.js";
import { createSessionsApi } from "./features/sessions.js";
import { createVaultsApi } from "./features/vaults.js";
import type {
  ConnectOptions,
  EnvironmentSelector,
  ManagedArtifacts,
  ManagedClientOptions,
  ManagedFiles,
  ManagedResumeConfig,
  ManagedSchedules,
  ManagedSessionConfig,
  ManagedSessions,
  ManagedVaults,
  OpenCliOptions,
  PlatformEventHandler,
  SessionRef,
} from "./types.js";

function sessionIdOf(session: SessionRef): string {
  return typeof session === "string" ? session : session.sessionId;
}

/**
 * Entry point for running stock Copilot SDK clients and sessions in environments you deployed.
 *
 * ```ts
 * const managed = await ManagedCopilot.connect();   // local `aspire run`, or your Azure deployment
 * const client = await managed.client("chat");      // a stock CopilotClient for the "chat" environment
 * ```
 */
export class ManagedCopilot {
  readonly #ctx: ManagedState;
  readonly sessions: ManagedSessions;
  readonly vaults: ManagedVaults;
  readonly schedules: ManagedSchedules;

  private constructor(ctx: ManagedState) {
    this.#ctx = ctx;
    this.sessions = createSessionsApi(ctx);
    this.vaults = createVaultsApi(ctx);
    this.schedules = createSchedulesApi(ctx);
  }

  /** Connects to a deployment: explicit `url`, `MANAGED_COPILOT_URL`, or the running local AppHost. */
  static async connect(options: ConnectOptions = {}): Promise<ManagedCopilot> {
    return new ManagedCopilot(await createContext(options));
  }

  get url(): string {
    return this.#ctx.url;
  }

  get info(): DeploymentInfo {
    return this.#ctx.info;
  }

  get account(): AccountInfo {
    return this.#ctx.account;
  }

  /** Returns a started, stock `CopilotClient` bound to an environment. Each isolated session gets its own sandbox. */
  client(environment: EnvironmentSelector, options?: ManagedClientOptions): Promise<CopilotClient> {
    return createClient(this.#ctx, environment, options);
  }

  /** One call that picks the environment (including per-session setup) and creates the session. */
  createSession(config: ManagedSessionConfig): Promise<CopilotSession> {
    return createManagedSession(this.#ctx, config);
  }

  /** Resumes an owned session; pass your tools and handlers again, as with the SDK. */
  resumeSession(sessionId: string, config?: ManagedResumeConfig): Promise<CopilotSession> {
    return resumeManagedSession(this.#ctx, sessionId, config);
  }

  files(session: SessionRef): ManagedFiles {
    return createFilesApi(this.#ctx, sessionIdOf(session));
  }

  artifacts(session: SessionRef): ManagedArtifacts {
    return createArtifactsApi(this.#ctx, sessionIdOf(session));
  }

  promote(session: SessionRef): Promise<PromoteResult> {
    return promoteSession(this.#ctx, sessionIdOf(session));
  }

  /** Runs Copilot CLI in this terminal, attached to the live session. Resolves with the CLI's exit code. */
  openCli(session: SessionRef, options?: OpenCliOptions): Promise<number> {
    return openCli(this.#ctx, sessionIdOf(session), options);
  }

  /** Subscribes to platform events such as `session.promoted` or `artifact.published`. Returns an unsubscribe function. */
  on(type: PlatformEventType | "*", handler: PlatformEventHandler): () => void {
    let handlers = this.#ctx.listeners.get(type);
    if (!handlers) {
      handlers = new Set();
      this.#ctx.listeners.set(type, handlers);
    }
    handlers.add(handler);
    ensureEventStream(this.#ctx);
    return () => {
      handlers.delete(handler);
    };
  }

  /** Detaches this process. Does not delete sessions or cancel accepted work. */
  async close(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const client of this.#ctx.clients) pending.push(client.stop().catch(() => undefined));
    for (const dispose of this.#ctx.disposables) pending.push(Promise.resolve().then(dispose).catch(() => undefined));
    this.#ctx.clients.clear();
    this.#ctx.cachedClients.clear();
    this.#ctx.disposables.clear();
    this.#ctx.listeners.clear();
    await Promise.all(pending);
  }
}
