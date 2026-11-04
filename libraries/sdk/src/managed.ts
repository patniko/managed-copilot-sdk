import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import type { AccountInfo, DeploymentInfo, ExecInfo, ExecResult, PlatformEventType, PromoteResult } from "@managed-copilot/protocol";
import { createContext, createView, type ManagedState } from "./connection.js";
import { actingIdentity, requireActor } from "./identity.js";
import { createArtifactsApi } from "./features/artifacts.js";
import { openCli } from "./features/cli.js";
import { createClient, createManagedSession, resumeManagedSession } from "./features/client.js";
import { ensureEventStream } from "./features/events.js";
import { createSandboxesApi, listExecs, runExec } from "./features/exec.js";
import { createFilesApi } from "./features/files.js";
import { promoteSession } from "./features/promote.js";
import { createSchedulesApi } from "./features/schedules.js";
import { createSessionsApi } from "./features/sessions.js";
import { createVaultsApi } from "./features/vaults.js";
import { createWorkersApi } from "./features/workers.js";
import type {
  ActingAs,
  ConnectOptions,
  EnvironmentSelector,
  ExecHandle,
  ExecOptions,
  ManagedArtifacts,
  ManagedClientOptions,
  ManagedFiles,
  ManagedResumeConfig,
  ManagedSandboxes,
  ManagedSchedules,
  ManagedSessionConfig,
  ManagedSessions,
  ManagedVaults,
  ManagedWorkers,
  OpenCliOptions,
  PlatformEventHandler,
  SessionRef,
} from "./types.js";

function sessionIdOf(session: SessionRef): string {
  return typeof session === "string" ? session : session.sessionId;
}

/** Commands run directly in a sandbox: `managed.exec(...)`, plus `managed.exec.list(...)`. */
export interface ManagedExec {
  /** Starts a background command and answers with its handle at once (see `ExecHandle`). */
  (session: SessionRef, command: string, options: ExecOptions & { background: true }): Promise<ExecHandle>;
  /**
   * Runs `bash -c <command>` in the session's sandbox (`/workspace`, the sandbox's network rules and vault
   * placeholders) and resolves when it ends, with its exit code and output. A non-zero exit is a result, not an error.
   */
  (session: SessionRef, command: string, options?: ExecOptions & { background?: false }): Promise<ExecResult>;
  /** The commands run in the session's sandbox, oldest first, with who ran them. */
  list(session: SessionRef): Promise<ExecInfo[]>;
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
  /** Workspace-only sandboxes for your own harness: commands and files, no agent. */
  readonly sandboxes: ManagedSandboxes;
  /**
   * Runs a command directly in any sandbox you own: a workspace-only sandbox, an isolated session's, or a worker's.
   * Fails with `policy_violation` where the operator turned `exec` off for the environment.
   */
  readonly exec: ManagedExec;

  private constructor(ctx: ManagedState) {
    this.#ctx = ctx;
    this.sessions = createSessionsApi(ctx);
    this.vaults = createVaultsApi(ctx);
    this.schedules = createSchedulesApi(ctx);
    this.sandboxes = createSandboxesApi(ctx);
    const exec = ((session: SessionRef, command: string, options?: ExecOptions) => runExec(ctx, sessionIdOf(session), command, options)) as ManagedExec;
    exec.list = (session: SessionRef) => listExecs(ctx, sessionIdOf(session));
    this.exec = exec;
  }

  /** Connects to a deployment: explicit `url`, `MANAGED_COPILOT_URL`, or the running local AppHost. */
  static async connect(options: ConnectOptions = {}): Promise<ManagedCopilot> {
    return new ManagedCopilot(await createContext(options));
  }

  /**
   * This API, acting for one person: one of your app's own users (`{ appUser }`, an app connection only) or someone
   * who signed in with GitHub (`{ gitHubToken }`). Sessions, files, artifacts, schedules, vaults, and events are theirs.
   * Views of the same person are shared; `close()` on the connection closes its views too.
   */
  async as(user: ActingAs): Promise<ManagedCopilot> {
    const identity = actingIdentity(this.#ctx.identity, user);
    requireActor(identity, "managed.as(...)");
    const view = await createView(this.#ctx, identity);
    let wrapper = VIEWS.get(view);
    if (!wrapper) {
      wrapper = new ManagedCopilot(view);
      VIEWS.set(view, wrapper);
    }
    return wrapper;
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

  /** An orchestrator session's workers: each one's state, task, and latest report, and its own session ID. */
  workers(session: SessionRef): ManagedWorkers {
    return createWorkersApi(this.#ctx, sessionIdOf(session));
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

  /** Detaches this process (or this view's clients). Does not delete sessions or cancel accepted work. */
  async close(): Promise<void> {
    const contexts = [this.#ctx];
    // The connection itself closes every view's clients and streams too.
    if (!this.#ctx.root) for (const pending of this.#ctx.views.values()) contexts.push(...(await pending.then((view) => [view], () => [])));
    const pending: Promise<unknown>[] = [];
    for (const ctx of contexts) {
      for (const client of ctx.clients) pending.push(client.stop().catch(() => undefined));
      for (const dispose of ctx.disposables) pending.push(Promise.resolve().then(dispose).catch(() => undefined));
      ctx.clients.clear();
      ctx.disposables.clear();
      ctx.listeners.clear();
    }
    if (!this.#ctx.root) {
      this.#ctx.cachedClients.clear();
      this.#ctx.views.clear();
    }
    await Promise.all(pending);
  }
}

/** The `ManagedCopilot` for each view, so `as(...)` for the same person returns the same object. */
const VIEWS = new WeakMap<ManagedState, ManagedCopilot>();
