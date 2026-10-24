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
}

export interface FileDownload {
  readonly entry: FileEntry;
  readonly body: Readable;
}

export interface SandboxesService {
  create(request: CreateSandboxRequest): Promise<SandboxHandle>;
  /** Idempotent; restarts stopped compute and restores declared state without replaying setup. */
  ensureRunning(sessionId: string): Promise<SandboxHandle>;
  openRuntime(sessionId: string, options: OpenRuntimeOptions): Promise<SandboxRuntime>;
  /** Raw TCP tunnel to `127.0.0.1:<port>` inside the session's sandbox (CLI attach to an AHP listener). */
  connect(sessionId: string, port: number): Promise<Duplex>;
  get(sessionId: string): Promise<SandboxInfo | undefined>;
  /** Stops compute after pending work drains (idle stop). State volumes are kept. */
  stop(sessionId: string, reason?: string): Promise<void>;
  /** Marks `deleting`, removes compute, volumes, and artifacts; reconciliation finishes after a crash. */
  delete(sessionId: string): Promise<void>;
  /** Records activity that should postpone idle stop. */
  touch(sessionId: string): void;
  setupRecord(sessionId: string): SandboxSetupRecord | undefined;
  listFiles(sessionId: string, path: string, options?: { readonly recursive?: boolean }): Promise<FileEntry[]>;
  readFile(sessionId: string, path: string): Promise<FileDownload>;
  writeFile(sessionId: string, path: string, body: Readable, options?: FileWriteOptions): Promise<FileEntry>;
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
}

/** From core: `sessions`. `subscribe` listeners run synchronously, in order, before fan-out to clients. */
export interface SandboxSessionsPort {
  get(sessionId: string): SandboxSessionView | undefined | Promise<SandboxSessionView | undefined>;
  subscribe(listener: (sessionId: string, event: SandboxRuntimeEvent) => void): () => void;
}

/** From core: `events`. */
export interface SandboxEventsPort {
  publish(event: PlatformEvent, meta: { readonly ownerId: number }): void;
}

/** From network: `policy`. Throws on any failure; never returns a partial registration. */
export interface SandboxPolicyPort {
  registerSandbox(request: { readonly sandboxId: string; readonly sessionId: string }): Promise<EgressRegistration> | EgressRegistration;
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
