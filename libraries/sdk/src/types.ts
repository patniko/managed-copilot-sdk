import type {
  CopilotClient,
  CopilotClientOptions,
  CopilotSession,
  PermissionHandler,
  ResumeSessionConfig,
  SessionConfig,
  Tool,
} from "@github/copilot-sdk";
import type {
  AccountInfo,
  AppUser,
  ArtifactInfo,
  CreateScheduleRequest,
  CreateVaultRequest,
  DeploymentInfo,
  EnvironmentRequest,
  ExecInfo,
  ExecResult,
  FileEntry,
  HandleActionResult,
  NetworkSetting,
  PlatformEvent,
  PlatformEventType,
  PublicationResult,
  ScheduleInfo,
  ScheduleRun,
  SessionInfo,
  SessionListQuery,
  VaultInfo,
  WorkerInfo,
} from "@managed-copilot/protocol";
import type { HttpClient } from "./http.js";
import type { Identity } from "./identity.js";

export interface ConnectOptions {
  /** Deployment URL. Defaults to `MANAGED_COPILOT_URL`, then the running local AppHost. */
  url?: string;
  /**
   * The caller's GitHub token. Defaults to `MANAGED_COPILOT_GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
   * `GITHUB_TOKEN`, then the signed-in GitHub CLI (`gh auth token`). Without one, `connect` fails with
   * `authentication_required` rather than using another account. Not used by an app connection (`appKey`).
   */
  gitHubToken?: string;
  /**
   * This app's key, issued by the AppHost (`copilot.appKey(name)`). Defaults to `MANAGED_COPILOT_APP_KEY`. With a key,
   * the connection is the app itself, not a GitHub account: it acts for each person through `{ appUser }` (one of your
   * app's own users, billed to your Foundry) or `{ gitHubToken }` (someone who signed in to your app with GitHub).
   */
  appKey?: string;
  /** Label recorded with sessions this process creates. */
  clientName?: string;
}

/** One of your app's own users, as your app's sign-in identifies them (any identity provider). */
export type { AppUser };

/** Who an app connection acts for: one of its own users, or a person who signed in to it with GitHub. */
export type ActingAs = { readonly appUser: AppUser; readonly gitHubToken?: never } | { readonly gitHubToken: string; readonly appUser?: never };

/**
 * SDK-side environment descriptor. Same fields as the wire `EnvironmentRequest`, but `files` accept bytes
 * (e.g. `await readFile(...)`) or UTF-8 text; the SDK encodes them for transport.
 */
export interface EnvironmentDescriptor extends Omit<EnvironmentRequest, "files"> {
  files?: Record<string, string | Uint8Array>;
}

/** An environment name declared in the AppHost, or a descriptor that names one (or an allowed inline type). */
export type EnvironmentSelector = string | EnvironmentDescriptor;

/**
 * Options for `managed.client(...)`. These are defaults for every session the client creates; callers can add
 * permitted setup and narrow permissions, never broaden them. `network` is the environment's network rules here, not
 * the stock client's proxy callbacks: the platform owns the runtime's networking.
 */
export interface ManagedClientOptions
  extends Omit<
    CopilotClientOptions,
    "connection" | "gitHubToken" | "useLoggedInUser" | "baseDirectory" | "workingDirectory" | "sessionFs" | "requestHandler" | "env" | "mode" | "network"
  > {
  /** Act as this GitHub user, e.g. a backend serving signed-in users. Ownership binds to that account. */
  gitHubToken?: string;
  /**
   * Act for one of your app's own users (an app connection only). Their sessions are theirs, scoped to your app, and
   * their model calls go to the environment's Azure AI Foundry account.
   */
  appUser?: AppUser;
  vaults?: string[];
  network?: NetworkSetting;
  /** Python/npm packages installed into each session's sandbox (system packages belong in the image). */
  packages?: { python?: string[]; npm?: string[] };
  /** Non-secret environment variables visible to sandbox code. */
  env?: Record<string, string>;
  /** Small workspace-relative files written into each session's sandbox before the agent starts. */
  files?: Record<string, string | Uint8Array>;
}

/** A session object, a sandbox from `managed.sandboxes.create`, or a session ID. */
export type SessionRef = CopilotSession | { readonly sessionId: string } | string;

export interface ManagedSessionConfig extends SessionConfig {
  /** Environment for this one session; per-session `files`, `packages`, and `env` apply only to it. */
  environment: EnvironmentSelector;
  /** Create it for one of your app's own users (an app connection only); see `ManagedClientOptions.appUser`. */
  appUser?: AppUser;
}

export interface ManagedResumeConfig extends ResumeSessionConfig {
  /** Optional; the platform resolves the session's recorded environment and placement. */
  environment?: EnvironmentSelector;
  /** Resume it as one of your app's own users, the one who owns it (an app connection only). */
  appUser?: AppUser;
}

export interface ActionHandlers {
  tools?: Tool<any>[];
  onPermissionRequest?: PermissionHandler;
}

export interface ManagedSessions {
  list(query?: SessionListQuery): Promise<SessionInfo[]>;
  get(sessionId: string): Promise<SessionInfo>;
  delete(sessionId: string): Promise<void>;
  /** Claims and answers this session's eligible pending actions with the same contract as live delivery. */
  handleActions(sessionId: string, handlers: ActionHandlers): Promise<HandleActionResult[]>;
}

export interface ManagedFiles {
  /** Lists a workspace directory (default: the workspace root). Symbolic links and special files are omitted. */
  list(path?: string, options?: { recursive?: boolean }): Promise<FileEntry[]>;
  /** Streams a local file into the sandbox workspace (atomic replace by default; `overwrite: false` fails if it exists). */
  upload(localPath: string, remotePath: string, options?: { overwrite?: boolean }): Promise<FileEntry>;
  write(remotePath: string, data: string | Uint8Array, options?: { overwrite?: boolean }): Promise<FileEntry>;
  download(remotePath: string, localPath: string): Promise<void>;
  read(remotePath: string): Promise<string>;
  readBytes(remotePath: string): Promise<Uint8Array>;
}

export interface ManagedArtifacts {
  /** Waits for the most recent completed turn's publication (or `turnId`), not mere runtime idleness. */
  waitForPublication(options?: { turnId?: string; timeoutMs?: number }): Promise<PublicationResult>;
  list(options?: { versions?: "latest" | "all" }): Promise<ArtifactInfo[]>;
  /** Reads the newest published version of a file under `outputs/`, or a specific `version`. */
  read(path: string, options?: { version?: number }): Promise<string>;
  readBytes(path: string, options?: { version?: number }): Promise<Uint8Array>;
  download(path: string, localPath: string, options?: { version?: number }): Promise<void>;
}

/**
 * An orchestrator session's workers. Each is an ordinary session in its own sandbox: pass `worker.id` to
 * `managed.files`, `managed.artifacts`, `managed.resumeSession`, or `managed-copilot attach`.
 */
export interface ManagedWorkers {
  /** Every worker the session started, oldest first, stopped ones included. */
  list(): Promise<WorkerInfo[]>;
  /** One worker, by its ID or its name. */
  get(worker: string): Promise<WorkerInfo>;
}

/** Act for a specific GitHub user (for example a backend serving signed-in users); defaults to this connection's account. */
export interface VaultCallOptions {
  gitHubToken?: string;
}

export interface ManagedVaults {
  /** Creates a vault owned by the caller. Values are sealed by the platform and never returned by any API. */
  create(request: CreateVaultRequest, options?: VaultCallOptions): Promise<VaultInfo>;
  /** The caller's vaults plus the deployment's AppHost vaults (names, env names, and hosts only). */
  list(options?: VaultCallOptions): Promise<VaultInfo[]>;
  /** Deletes one of the caller's vaults; running sessions lose access to it immediately. */
  delete(vaultId: string, options?: VaultCallOptions): Promise<void>;
}

export interface CreateScheduleOptions extends Omit<CreateScheduleRequest, "session"> {
  /** Tool handlers are not uploaded: only their standard declarations are stored. */
  session?: { agent?: string; model?: string; tools?: Tool<any>[] };
}

export interface ManagedSchedules {
  create(options: CreateScheduleOptions): Promise<ScheduleInfo>;
  list(): Promise<ScheduleInfo[]>;
  get(scheduleId: string): Promise<ScheduleInfo>;
  runs(scheduleId: string): Promise<ScheduleRun[]>;
  pause(scheduleId: string): Promise<ScheduleInfo>;
  resume(scheduleId: string): Promise<ScheduleInfo>;
  delete(scheduleId: string): Promise<void>;
  /** Pass a retry-stable `invocationId` so a retried call never starts a second run. */
  runNow(scheduleId: string, options?: { invocationId?: string }): Promise<ScheduleRun>;
}

/** A workspace-only sandbox (`kind: "workspace"`): pass it to `managed.exec`, `managed.files`, or `managed.artifacts`. */
export interface ManagedSandbox extends SessionInfo {
  /** The same as `id`, so the sandbox works wherever a session is expected. */
  readonly sessionId: string;
}

export interface CreateSandboxOptions {
  /** An isolated environment: its image, setup, network rules, and vaults apply. Per-sandbox `files`, `packages`, and `env` too. */
  environment: EnvironmentSelector;
  /** Your own ID for it; creating the same ID again answers with that sandbox. */
  sessionId?: string;
  signal?: AbortSignal;
}

/**
 * Workspace-only sandboxes: isolated machines with no agent in them, for your own harness to run commands and move
 * files in (`managed.exec`, `managed.files`). Delete one with `managed.sessions.delete(sandbox.id)`.
 */
export interface ManagedSandboxes {
  /** Creates one; resolves once its setup finished. Fails with `policy_violation` where the operator turned `exec` off. */
  create(options: CreateSandboxOptions): Promise<ManagedSandbox>;
  /** Your workspace-only sandboxes, most recently used first. */
  list(): Promise<ManagedSandbox[]>;
}

export interface ExecOptions {
  /**
   * Kills the command's process group after this long. Default: 10 minutes, and no limit for `background` commands
   * (they run until they end, you stop them, or the sandbox stops).
   */
  timeoutMs?: number;
  /** Start it and get a handle at once: read its output as it goes, write to its stdin, wait for its result, or stop it. */
  background?: boolean;
  /** Your own ID for the command (`[A-Za-z0-9_-]{1,64}`): the same ID again answers with that command; it never runs twice. */
  id?: string;
  /** Default `closed`, `open` for background commands (write to it with the handle). */
  stdin?: "open" | "closed";
  /** Stops a command that is not `background` (its process group is killed) and resolves with its record. */
  signal?: AbortSignal;
}

/** A background command (`managed.exec(..., { background: true })`). */
export interface ExecHandle {
  readonly id: string;
  readonly sessionId: string;
  readonly command: string;
  /** Its output (stdout and stderr together) from the start, as it is written; ends when the command ends. */
  readonly output: AsyncIterable<string>;
  /** Resolves when it ends: its exit code (state `completed`), or why it ended otherwise, and its output. */
  readonly result: Promise<ExecResult>;
  /** Writes to its stdin. */
  write(data: string): Promise<void>;
  /** Closes its stdin (after `data`, if given). */
  end(data?: string): Promise<void>;
  /** Kills its process group; resolves with its record. */
  stop(): Promise<ExecInfo>;
  /** Its current record. */
  info(): Promise<ExecInfo>;
}

export interface OpenCliOptions {
  /** Path to the Copilot CLI executable. Defaults to `copilot` on PATH. */
  copilotPath?: string;
  /** Extra CLI arguments. */
  args?: string[];
}

export type PlatformEventHandler = (event: PlatformEvent) => void;

/** Internal state shared by the feature modules. */
export interface ManagedContext {
  readonly url: string;
  /**
   * Who this connection (or `managed.as(...)` view) acts for by default: a GitHub token, an app key, or an app key with
   * one of the app's users or a GitHub token.
   */
  readonly identity: Identity;
  readonly clientName: string | undefined;
  readonly info: DeploymentInfo;
  readonly account: AccountInfo;
  readonly http: HttpClient;
  readonly clients: Set<CopilotClient>;
  readonly listeners: Map<PlatformEventType | "*", Set<PlatformEventHandler>>;
  /** Resources to release on `close()` (event streams, timers). */
  readonly disposables: Set<() => void | Promise<void>>;
  /**
   * The REST client for the identity that created or resumed a session (`managed.client(env, { gitHubToken })`,
   * `{ appUser }`, or a `managed.as(...)` view), falling back to this context's identity. Feature helpers must use it
   * for session-scoped calls.
   */
  httpFor(sessionId: string): HttpClient;
}
