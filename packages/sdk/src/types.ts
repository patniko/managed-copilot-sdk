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
  ArtifactInfo,
  CreateScheduleRequest,
  CreateVaultRequest,
  DeploymentInfo,
  EnvironmentRequest,
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
} from "@managed-copilot/protocol";
import type { HttpClient } from "./http.js";

export interface ConnectOptions {
  /** Deployment URL. Defaults to `MANAGED_COPILOT_URL`, then the running local AppHost. */
  url?: string;
  /**
   * The caller's GitHub token. Defaults to `MANAGED_COPILOT_GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
   * `GITHUB_TOKEN`, then the signed-in GitHub CLI (`gh auth token`). Without one, `connect` fails with
   * `authentication_required` rather than using another account.
   */
  gitHubToken?: string;
  /** Label recorded with sessions this process creates. */
  clientName?: string;
}

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
 * permitted setup and narrow permissions, never broaden them.
 */
export interface ManagedClientOptions
  extends Omit<
    CopilotClientOptions,
    "connection" | "gitHubToken" | "useLoggedInUser" | "baseDirectory" | "workingDirectory" | "sessionFs" | "requestHandler" | "env" | "mode"
  > {
  /** Act as this GitHub user, e.g. a backend serving signed-in users. Ownership binds to that account. */
  gitHubToken?: string;
  vaults?: string[];
  network?: NetworkSetting;
  /** Python/npm packages installed into each session's sandbox (system packages belong in the image). */
  packages?: { python?: string[]; npm?: string[] };
  /** Non-secret environment variables visible to sandbox code. */
  env?: Record<string, string>;
  /** Small workspace-relative files written into each session's sandbox before the agent starts. */
  files?: Record<string, string | Uint8Array>;
}

/** A session object or its ID. */
export type SessionRef = CopilotSession | string;

export interface ManagedSessionConfig extends SessionConfig {
  /** Environment for this one session; per-session `files`, `packages`, and `env` apply only to it. */
  environment: EnvironmentSelector;
}

export interface ManagedResumeConfig extends ResumeSessionConfig {
  /** Optional; the platform resolves the session's recorded environment and placement. */
  environment?: EnvironmentSelector;
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
  list(path?: string): Promise<FileEntry[]>;
  /** Streams a local file into the sandbox workspace. */
  upload(localPath: string, remotePath: string): Promise<FileEntry>;
  write(remotePath: string, data: string | Uint8Array): Promise<FileEntry>;
  download(remotePath: string, localPath: string): Promise<void>;
  read(remotePath: string): Promise<string>;
  readBytes(remotePath: string): Promise<Uint8Array>;
}

export interface ManagedArtifacts {
  /** Waits for the most recent completed turn's publication (or `turnId`), not mere runtime idleness. */
  waitForPublication(options?: { turnId?: string; timeoutMs?: number }): Promise<PublicationResult>;
  list(options?: { versions?: "latest" | "all" }): Promise<ArtifactInfo[]>;
  read(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  download(path: string, localPath: string): Promise<void>;
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
  readonly token: string;
  readonly clientName: string | undefined;
  readonly info: DeploymentInfo;
  readonly account: AccountInfo;
  readonly http: HttpClient;
  readonly clients: Set<CopilotClient>;
  readonly listeners: Map<PlatformEventType | "*", Set<PlatformEventHandler>>;
  /** Resources to release on `close()` (event streams, timers). */
  readonly disposables: Set<() => void | Promise<void>>;
  /**
   * The REST client for the identity that created or resumed a session (`managed.client(env, { gitHubToken })`),
   * falling back to the connection's own identity. Feature helpers must use it for session-scoped calls.
   */
  httpFor(sessionId: string): HttpClient;
}
