/**
 * Sandbox workstream contract (spec sections 4, 5, 6, 8; architecture "Isolated placement").
 *
 * Types only, so other modules can import it without the implementation:
 *
 * - Services this module provides: `sandboxes` (placement, lifecycle, runtime streams, files, tunnels) and
 *   `artifacts` (turn-scoped publication from `/workspace/outputs`).
 * - Ports it consumes: `sessions` and `events` from core, `policy` from network. The providers' real services only
 *   need to be structurally compatible with the `Sandbox*Port` interfaces below.
 *
 * ## Router integration for isolated placement (core's `/v1/connect` JSON-RPC router)
 *
 * 1. Admission forwards `session.create` with `workingDirectory: "/workspace"` and no GitHub token fields, after
 *    `await sandboxes.create({ sessionId, ... })` resolves (setup and runtime ready).
 * 2. `const rt = await sandboxes.openRuntime(sessionId, { resolveToken })` returns the upstream: wrap `rt.stream`
 *    (LSP-framed JSON-RPC bytes), send `connect` with `token: rt.connectionToken`, and answer runtime → client
 *    requests whose method is in `rt.handlers` with those handlers (before core's own registry).
 * 3. After `connect`: `await rt.initialize(send)`. This registers the gateway as the runtime's inference provider.
 * 4. Before forwarding `session.create` / `session.resume`: `params = await rt.prepareSessionParams(method, params)`.
 * 5. After it succeeds and before replying to the client or forwarding any `session.send`:
 *    `await rt.sessionOpened(sessionId)`. This installs a placeholder credential with a gateway-resolved identity.
 * 6. `rt.stream` ends when the sandbox stops (idle stop, delete). Treat that as a lost upstream: on next use call
 *    `ensureRunning(sessionId)`, `openRuntime`, then `session.resume` with the stored admitted config.
 *
 * ## Credential isolation
 *
 * The GitHub token never enters a sandbox's environment, disk, or runtime. The runtime holds only an opaque
 * per-session placeholder (`mcrt_…`) and a Copilot identity snapshot the gateway resolved itself. Model-layer HTTP
 * requests arrive as `llmInference.httpRequestStart`/`httpRequestChunk`; the gateway swaps the placeholder for the
 * owner's token (from `resolveToken`) only for allowlisted Copilot API hosts and streams the response back. If no
 * credential is available, inference fails with `authentication_required`; it never falls back to another account.
 */
import type { Duplex, Readable } from "node:stream";
import type {
  ArtifactInfo,
  EnvironmentConfig,
  ExecCaller,
  ExecInfo,
  ExecResult,
  FileEntry,
  NetworkPolicy,
  PlatformEvent,
  PublicationResult,
  SandboxInfo,
  SandboxSetupRecord,
  SandboxSize,
} from "@managed-copilot/protocol";

// ---------------------------------------------------------------------------------------------------------------
// sandboxes (provided by sandbox)
// ---------------------------------------------------------------------------------------------------------------

export interface CreateSandboxRequest {
  /** The session that owns this sandbox for its whole life (caller-assigned before `session.create`). */
  readonly sessionId: string;
  readonly ownerId: number;
  /** An `isolated` environment name from the AppHost, or `inline-isolated-<size>` for an allowed inline request. */
  readonly environment: string;
  readonly size: SandboxSize;
  /** Effective policy after caller narrowing; stored for resume. */
  readonly network: NetworkPolicy;
  /** Vault IDs or names bound to this session (resolved by the policy service). */
  readonly vaults?: readonly string[];
  /** Caller additions (client defaults plus the per-session descriptor), applied after the environment's own setup. */
  readonly additions?: {
    readonly packages?: { readonly python?: readonly string[]; readonly npm?: readonly string[] };
    /** Workspace-relative path → base64 content. */
    readonly files?: Readonly<Record<string, string>>;
    readonly env?: Readonly<Record<string, string>>;
  };
  /** Core's resolved environment: its configuration and the pinned customizations bundle (mounted read-only). */
  readonly resolved?: { readonly config?: EnvironmentConfig; readonly customizations?: { readonly root?: string } };
  /**
   * Default true. False: a workspace-only sandbox for commands and files (`exec`, the files API). sandboxd never starts
   * the Copilot runtime in it, `openRuntime` refuses it, and health checks ignore the runtime.
   */
  readonly runtime?: boolean;
  readonly signal?: AbortSignal;
}

export interface SandboxPaths {
  readonly workspace: string;
  readonly outputs: string;
  /** Present when the environment declares `customizations` (mounted read-only). */
  readonly customizations?: string;
}

export interface SandboxHandle {
  readonly sandboxId: string;
  readonly info: SandboxInfo;
  readonly paths: SandboxPaths;
}

/** A runtime-state export to place in a sandbox before `session.resume` (promotion). */
export interface RuntimeStateImport {
  /** Gateway-host directory holding the session's `session-state/<sessionId>/` files (paths already rewritten, no tokens). */
  readonly sessionStateDir: string;
  /** The `messageId` of a turn that started elsewhere and continues in the sandbox. */
  readonly activeTurnId?: string;
}

export interface OpenRuntimeOptions {
  /** The session owner's current GitHub token; rejects with `authentication_required` when none is usable. */
  resolveToken(): Promise<string>;
}

/** Sends a request on the upstream connection that `SandboxRuntime.stream` carries. */
export type UpstreamSend = (method: string, params: unknown) => Promise<unknown>;
/** Answers one runtime → client request on that upstream. */
export type RuntimeRequestHandler = (params: unknown) => Promise<unknown>;

export interface SandboxRuntime {
  readonly sandboxId: string;
  /** LSP-framed JSON-RPC byte stream to the sandbox's stock runtime. */
  readonly stream: Duplex;
  /** Pass as `connect` params `token`. */
  readonly connectionToken: string;
  /** Runtime → client requests the gateway answers itself on this upstream (`llmInference.*`, `gitHubToken.getToken`). */
  readonly handlers: ReadonlyMap<string, RuntimeRequestHandler>;
  /** Call once after `connect` succeeds. */
  initialize(send: UpstreamSend): Promise<void>;
  /** Call before forwarding `session.create` / `session.resume`; returns the params to forward. */
  prepareSessionParams(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Call after create/resume succeeds, before replying or forwarding any send. */
  sessionOpened(sessionId: string): Promise<void>;
  /** Closes the stream and cancels in-flight brokered requests. */
  close(): void;
}

export interface FileWriteOptions {
  /** Default true: atomically replace an existing file (last writer wins). False: fail with `conflict` if it exists. */
  readonly overwrite?: boolean;
  /** Declared size when known; uploads larger than the limit fail before streaming. */
  readonly size?: number;
  /** See `FileCallOptions.sandboxId`. */
  readonly sandboxId?: string;
}

export interface FileCallOptions {
  /**
   * The sandbox (from `get(sessionId).id`) the call is for: it fails with `not_found`, before and after starting a
   * stopped sandbox, unless that is still the session's sandbox, so a call made for one session never reaches a newer
   * session that reuses its ID.
   */
  readonly sandboxId?: string;
}

export interface FileDownload {
  readonly entry: FileEntry;
  readonly body: Readable;
}

/** Options of `sandboxes.exec`. */
export interface ExecOptions {
  /** The command's journal ID (`[A-Za-z0-9_-]{1,64}`). The same ID again reattaches to that command; it never runs twice. */
  readonly id?: string;
  /**
   * A durable identity for the call that runs it (a tool call's idempotency key), when `id` is not given: the command's
   * ID derives from it, so a replay of the call after a gateway restart reattaches instead of running it again.
   */
  readonly actionId?: string;
  /** Answer once it started (or after `waitMs`); it runs on after the call. Stdin defaults to open. */
  readonly background?: boolean;
  /** Kills its process group after this long. None by default. */
  readonly timeoutMs?: number;
  /**
   * How long the call waits for it to end: default until it ends (0 for `background`). A command still running then is
   * answered with `state: "running"` and its output so far; read the rest with `readExec`.
   */
  readonly waitMs?: number;
  /** Default `closed` (`open` for background commands). */
  readonly stdin?: "open" | "closed";
  /**
   * Cancels the call (the runtime cancelled the tool call, the session is being deleted, the gateway is stopping). A
   * command that is not `background` is stopped with it (its process group killed); the call answers with its record.
   */
  readonly signal?: AbortSignal;
  /** See `FileCallOptions.sandboxId`. */
  readonly sandboxId?: string;
  /** Recorded with the command: the owner through the API, or the platform tool that ran it (and the calling sub-agent). */
  readonly caller?: ExecCaller;
}

export interface ExecReadOptions extends FileCallOptions {
  /** Output from this byte offset (default 0). */
  readonly offset?: number;
  /** Waits up to this long (at most 30 s) for output past `offset`, or for the end. */
  readonly waitMs?: number;
  readonly signal?: AbortSignal;
}

export interface SandboxesService {
  /**
   * True while the backend answered its latest readiness check (at registration, every 30 s, and before every backend
   * operation). `/v1/info` advertises `isolated` and `files` only while this is true.
   */
  readonly available: boolean;
  /** Re-checks the backend now and returns the new `available`. */
  probe(): Promise<boolean>;
  create(request: CreateSandboxRequest): Promise<SandboxHandle>;
  /** Idempotent; restarts stopped compute and restores declared state without replaying setup. */
  ensureRunning(sessionId: string): Promise<SandboxHandle>;
  openRuntime(sessionId: string, options: OpenRuntimeOptions): Promise<SandboxRuntime>;
  /** Raw TCP tunnel to `127.0.0.1:<port>` inside the session's sandbox (CLI attach to an AHP listener). */
  connect(sessionId: string, port: number): Promise<Duplex>;
  /**
   * Promotion: copies the regular files of a gateway-host `session-state/<sessionId>` export into the running sandbox
   * runtime's COPILOT_HOME (replacing that one directory; `*.lock` files are skipped) as the workload identity, before
   * the session is resumed there. `activeTurnId` (the carried turn's `messageId`) is tracked so the turn's root
   * `session.idle` in the sandbox publishes its outputs and idle stop waits for it. Limits: 10,000 files, 1 GiB.
   */
  importRuntimeState(sessionId: string, options: RuntimeStateImport): Promise<{ readonly files: number; readonly bytes: number }>;
  get(sessionId: string): Promise<SandboxInfo | undefined>;
  /** Stops compute after pending work drains (idle stop). State volumes are kept. */
  stop(sessionId: string, reason?: string): Promise<void>;
  /**
   * Marks `deleting`, removes compute, volumes, and artifacts; reconciliation finishes after a crash. With `sandboxId`
   * (from `get(sessionId).id`), the delete applies only if that is still the session's sandbox when it runs (checked
   * under the session lock); otherwise it does nothing, so a stale delete never removes a newer sandbox or a newer
   * session's artifacts that reuse the session ID.
   */
  delete(sessionId: string, options?: { readonly sandboxId?: string }): Promise<void>;
  /** Records activity that should postpone idle stop. */
  touch(sessionId: string): void;
  setupRecord(sessionId: string): SandboxSetupRecord | undefined;
  listFiles(sessionId: string, path: string, options?: FileCallOptions & { readonly recursive?: boolean }): Promise<FileEntry[]>;
  readFile(sessionId: string, path: string, options?: FileCallOptions): Promise<FileDownload>;
  writeFile(sessionId: string, path: string, body: Readable, options?: FileWriteOptions): Promise<FileEntry>;
  /**
   * Runs `bash -c <command>` in the session's sandbox as the workload identity (cwd `/workspace`, egress settings and
   * vault placeholders, never a GitHub token), starting a stopped sandbox. Every command is journaled with its caller
   * and pinned to the sandbox like file calls. Works on any sandbox: an isolated session's, a worker's, or a
   * workspace-only one. Callers own any policy (the exec REST routes check the environment's `exec`).
   */
  exec(sessionId: string, command: string, options?: ExecOptions): Promise<ExecResult>;
  /** A command's record and output from `offset`. A command the platform lost track of reads as `uncertain`. */
  readExec(sessionId: string, execId: string, options?: ExecReadOptions): Promise<ExecResult>;
  /** Writes to a running command's stdin (`conflict` once it ended or its stdin is closed); `eof` closes it. */
  writeExec(sessionId: string, execId: string, input: { readonly data?: string; readonly eof?: boolean }, options?: FileCallOptions): Promise<ExecInfo>;
  /** Kills a running command's process group; an ended command answers with its record. */
  stopExec(sessionId: string, execId: string, options?: FileCallOptions & { readonly reason?: string }): Promise<ExecInfo>;
  /** The commands of the session's current sandbox, oldest first. */
  listExecs(sessionId: string, options?: FileCallOptions): ExecInfo[];
  /**
   * Publishes `/workspace/outputs` as the artifacts of `turnId` (a workspace-only sandbox has no turns of its own:
   * standalone ones publish after each command; an orchestrator publishes its hands sandbox on its coordinator's turns).
   */
  publishOutputs(sessionId: string, turnId: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------
// artifacts (provided by sandbox)
// ---------------------------------------------------------------------------------------------------------------

export interface ArtifactsService {
  list(sessionId: string, options?: { readonly versions?: "latest" | "all" }): ArtifactInfo[];
  /**
   * Waits for a turn's publication manifest. Without `turnId`, captures the session's most recent completed turn
   * (or the running one when none has completed). Rejects with `timeout`, `not_found`, or `publication_failed`.
   */
  waitForPublication(sessionId: string, options?: { readonly turnId?: string; readonly timeoutMs?: number }): Promise<PublicationResult>;
  open(sessionId: string, artifactId: string): Promise<{ readonly info: ArtifactInfo; readonly body: Readable }>;
  /** Removes a session's artifacts (called by `sandboxes.delete`). */
  deleteSession(sessionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------
// Ports consumed from other workstreams
// ---------------------------------------------------------------------------------------------------------------

/** A runtime `session.event` payload's `event` object (the stock SDK's `SessionEvent`). */
export interface SandboxRuntimeEvent {
  readonly id: string;
  readonly type: string;
  readonly timestamp: string;
  readonly data: Record<string, unknown>;
  readonly agentId?: string;
  readonly ephemeral?: boolean;
}

export interface SandboxSessionView {
  readonly id: string;
  readonly ownerId: number;
  readonly environment?: string;
  /** Core's session state; `deleting` is recorded before core closes the session's runtime or deletes its sandbox. */
  readonly state?: string;
  /** The ledger's last root turn; survives gateway restarts. */
  readonly lastTurn?: { readonly turnId: string; readonly status: string };
  /** Which life of a reused session ID this is; durable actions are scoped to it. */
  readonly incarnation?: string;
  /** `workspace`: a workspace-only session (a sandbox and no runtime). */
  readonly kind?: "agent" | "workspace";
  /** The session that started this one (an orchestrator's coordinator). */
  readonly parentSessionId?: string;
}

/** From core: `sessions`. `subscribe` listeners run synchronously, in order, before fan-out to clients. */
export interface SandboxSessionsPort {
  get(sessionId: string): SandboxSessionView | undefined;
  subscribe(listener: (sessionId: string, event: SandboxRuntimeEvent) => void): () => void;
  /**
   * How core is using the session's runtime (an operator's stop refuses while it is): `busy` names work in progress,
   * and `lastRequestAt` is when a call to the runtime last started or settled.
   */
  runtimeActivity?(sessionId: string): { readonly busy?: string; readonly lastRequestAt?: number } | undefined;
  /** How many commands run in a workspace-only session's sandbox now (its busy accounting). */
  execActivity?(sessionId: string, running: number): void;
}

/** From core: `events`. */
export interface SandboxEventsPort {
  publish(event: PlatformEvent, meta: { readonly ownerId: number }): void;
}

/** From network: `policy`. Throws on any failure; never returns a partial registration. */
export interface SandboxPolicyPort {
  registerSandbox(request: { readonly sandboxId: string; readonly sessionId: string; readonly proxy?: { readonly host: string; readonly port: number } }): Promise<EgressRegistration> | EgressRegistration;
  updateSandbox(sandboxId: string, update: { readonly address: string }): Promise<void> | void;
  unregisterSandbox(sandboxId: string): Promise<void> | void;
}

export interface EgressRegistration {
  readonly proxyUrl?: string;
  /** Proxy settings and vault placeholders for sandboxd, the runtime, and every workload process. Never logged. */
  readonly env: Readonly<Record<string, string>>;
  /** PEM CA certificate the sandbox must trust for TLS-terminated egress. */
  readonly caCertificate?: string;
  readonly policy?: NetworkPolicy;
}

declare module "../../app.js" {
  interface GatewayServices {
    sandboxes: SandboxesService;
    artifacts: ArtifactsService;
  }
}
