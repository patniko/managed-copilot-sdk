// Extension points between the core module and the other gateway modules.
//
// Core *provides* `sessions`, `events`, `platformTools`, `runtimeRequests`, and `environments` (typed in
// GatewayServices below, structurally compatible with the durable ports in ../durable/contract.ts).
// Core *consumes* optional services other modules provide: `actions` and `credentials` (durable, typed by the
// durable contract), and `sandboxes` / `policy` (sandbox and network modules) through the contracts in this file.
// Providers implement these interfaces (they may add members) and register with `app.provide(key, value)`.
import type { Duplex } from "node:stream";
import type {
  AccountInfo,
  EnvironmentConfig,
  EnvironmentRequest,
  EnvironmentType,
  NetworkPolicy,
  NetworkSetting,
  Placement,
  PlatformEvent,
  PlatformEventType,
  SandboxInfo,
  SandboxSize,
  SessionInference,
  SessionInfo,
  SessionState,
  ToolDeclaration,
} from "@managed-copilot/protocol";
import type { Principal } from "../../http.js";
import type { AppRegistry } from "./apps.js";
import type { AttachedResponder, PlatformToolDefinition, PlatformToolReplay, RuntimeSessionEvent } from "../durable/contract.js";

/** An environment resolved against the deployment for one client connection or internal request. */
export interface ResolvedEnvironment {
  /** Declared name, or `inline-<type>[-<size>]` for inline requests. */
  readonly name: string;
  readonly type: EnvironmentType;
  readonly inline: boolean;
  readonly config: EnvironmentConfig;
  /** Effective network policy: the environment ceiling narrowed by the caller's request. */
  readonly network: NetworkPolicy;
  /** The caller's request (files, packages, env, vaults apply to sandboxes). */
  readonly request: EnvironmentRequest;
  /** Deployed customizations (agents, skills, instructions), pinned when the gateway started. */
  readonly customizations?: CustomizationBundle;
}

export interface CustomizationBundle {
  /** Absolute path of the pinned copy the runtime reads. Sandbox providers mount it read-only. */
  readonly root: string;
  readonly digest: string;
  readonly agents: readonly { readonly name: string; readonly description?: string; readonly model?: string; readonly tools?: readonly string[] }[];
  readonly agentDirectory?: string;
  readonly skillDirectory?: string;
  readonly instructionDirectory?: string;
}

/** A session row in the core ledger (`core_sessions`). */
export interface SessionRecord {
  readonly id: string;
  /**
   * Tells this session apart from any other that used (or will use) the same ID: minted at creation, never reused.
   * Durable state about a session is scoped to it.
   */
  readonly incarnation: string;
  readonly ownerId: number;
  readonly owner: AccountInfo;
  readonly environment: string;
  readonly type: EnvironmentType;
  readonly placement: Placement;
  readonly state: SessionState;
  /** Placement generation (fencing); 0 until promotion exists. */
  readonly generation: number;
  readonly title?: string;
  readonly model?: string;
  readonly agent?: string;
  readonly clientName?: string;
  readonly scheduleId?: string;
  readonly webhook?: string;
  /**
   * The owner's session that started this one (an orchestrator's coordinator, for a worker) and the incarnation it had
   * then. While this session has no connected client of its own, its parent's connected clients serve its credential.
   */
  readonly parentSessionId?: string;
  readonly parentIncarnation?: string;
  /**
   * `workspace`: a workspace-only session, a sandbox for commands and files with no runtime. Core never opens a
   * runtime for it and refuses agent operations (send, resume, CLI attach) with `invalid_request`. Absent: an agent.
   */
  readonly kind?: "workspace";
  /** Where the session's model calls go, fixed at creation; absent is the owner's Copilot plan. */
  readonly inference?: SessionInference;
  readonly network: NetworkPolicy;
  readonly environmentRequest: EnvironmentRequest;
  readonly lastTurn?: { readonly turnId: string; readonly status: "running" | "completed" | "failed" | "cancelled"; readonly completedAt?: string };
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Runtime upstreams and platform-owned runtime requests

export interface UpstreamInfo {
  /** `shared`, or `sandbox:<sessionId>` for a session's own sandbox runtime. */
  readonly id: string;
  readonly kind: "shared" | "sandbox";
  readonly sandboxId?: string;
}

/** A server-to-client request from a runtime that the gateway answers itself (never forwarded to customer code). */
export interface RuntimeRequestContext {
  readonly method: string;
  readonly upstream: UpstreamInfo;
  /** Present when the request names a session the gateway routes. */
  readonly session?: SessionRecord;
  readonly params: unknown;
  readonly signal: AbortSignal;
}

export type RuntimeRequestHandler = (context: RuntimeRequestContext) => unknown | Promise<unknown>;

/**
 * Registry for platform-owned runtime requests (`gitHubToken.getToken`, `llmInference.*`, `sessionFs.*`, ...).
 * A handler registered for an upstream kind takes precedence over the `"*"` handler for that method. Methods ending
 * in `.*` match a whole namespace (e.g. `sessionFs.*`).
 */
export interface RuntimeRequestRegistry {
  register(method: string, handler: RuntimeRequestHandler, options?: { readonly upstream?: "shared" | "sandbox" | "*" }): () => void;
  resolve(method: string, upstream: UpstreamInfo): RuntimeRequestHandler | undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Placement (provided by the sandbox module as `sandboxes`)

export interface SandboxCreateRequest {
  /** The SDK's caller-assigned session ID (validated unique by core). */
  readonly sessionId: string;
  readonly ownerId: number;
  /** Environment name (`inline-<type>-<size>` for inline requests). */
  readonly environment: string;
  readonly size: SandboxSize;
  /** Effective network policy (from `policy.bindSession` when the network module is present). */
  readonly network: NetworkPolicy;
  readonly vaults?: readonly string[];
  /** Per-session additions from the environment request. */
  readonly additions: { readonly files?: Readonly<Record<string, string>>; readonly packages?: EnvironmentRequest["packages"]; readonly env?: Readonly<Record<string, string>> };
  /** The resolved environment (image, setup, customizations). */
  readonly resolved: ResolvedEnvironment;
  /** False: a workspace-only sandbox that never starts the Copilot runtime. */
  readonly runtime?: boolean;
}

/**
 * A session whose model calls go to Azure AI Foundry (spec section 15) instead of its owner's Copilot plan. The sandbox
 * runtime gets `provider` with a placeholder bearer token and no GitHub credential at all; the broker answers its model
 * calls only for `host`, with a token from `token()` in place of the placeholder.
 */
export interface SandboxInferenceRoute {
  /** The Foundry account (for logs and errors). */
  readonly account: string;
  /** The stock runtime's whole-session BYOK provider, without a credential. */
  readonly provider: Readonly<Record<string, unknown>>;
  /** The only host brokered model calls may reach (the account's OpenAI-compatible endpoint). */
  readonly host: string;
  /** An Entra ID token for the account, from the platform's own identity. */
  token(): Promise<string>;
}

/** A connection to one sandbox runtime. The sandbox module implements credential brokering; core relays. */
export interface SandboxRuntimeHandle {
  /** LSP-framed JSON-RPC to the sandbox runtime; ends when the sandbox stops. */
  readonly stream: Duplex;
  /** For the runtime `connect` handshake. */
  readonly connectionToken: string;
  /** Runtime→client request handlers for this upstream (e.g. `llmInference.httpRequestStart`). */
  readonly handlers?: ReadonlyMap<string, (params: unknown) => Promise<unknown>>;
  /** Runs after `connect` (e.g. `llmInference.setProvider`). */
  initialize?(send: (method: string, params?: unknown) => Promise<unknown>): Promise<void>;
  /** Rewrites create/resume params before they are forwarded. */
  prepareSessionParams?(method: string, params: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Runs after create/resume succeeded and before any other request for the session. */
  sessionOpened?(sessionId: string): Promise<void>;
  close?(): void;
}

export interface SandboxPlacement {
  /** The backend's latest readiness check; `false` while it cannot place sandboxes (`/v1/info` then omits `isolated`/`files`). */
  readonly available?: boolean;
  /** Allocates a fresh sandbox for the session; resolves when setup finished. */
  create(request: SandboxCreateRequest): Promise<unknown>;
  /** Starts (or restores) the session's sandbox if it stopped. */
  ensureRunning?(sessionId: string): Promise<unknown>;
  /** Opens a runtime connection to the session's sandbox. */
  openRuntime(sessionId: string, options: { readonly resolveToken: () => Promise<string>; readonly inference?: SandboxInferenceRoute }): Promise<SandboxRuntimeHandle>;
  /** Deletes the sandbox and its storage; reconciliation must finish cleanup after crashes. */
  delete(sessionId: string): Promise<void>;
  /** Sandbox details for `SessionInfo.sandbox`. */
  get(sessionId: string): Promise<SandboxInfo | undefined> | SandboxInfo | undefined;
  /** TCP to 127.0.0.1:<port> inside the session's sandbox (Copilot CLI attach). */
  connect?(sessionId: string, port: number): Promise<Duplex>;
}

// ---------------------------------------------------------------------------------------------------------------
// Network policy and vaults (provided by the network module as `policy` and `vaults`)

export interface PolicyBinding {
  readonly sessionId: string;
  readonly owner: number;
  /** Declared environment name; undefined for inline environments. */
  readonly environment: string | undefined;
  readonly type: EnvironmentType;
  readonly requested: NetworkSetting | undefined;
  readonly vaults: readonly string[] | undefined;
}

export interface NetworkPolicyService {
  /** Persists and returns the session's effective policy; validates vault ownership. Throws ManagedCopilotError. */
  bindSession(binding: PolicyBinding): NetworkPolicy | void | Promise<NetworkPolicy | void>;
  /** The binding of an existing session. */
  session?(sessionId: string): { readonly policy: NetworkPolicy } | undefined | Promise<{ readonly policy: NetworkPolicy } | undefined>;
  releaseSession?(sessionId: string): void | Promise<void>;
  /** Routes a shared session's remote MCP server through the gateway MCP adapter (policy, vault credentials). */
  adaptMcpServer?(sessionId: string, name: string, server: Record<string, unknown>, options?: { readonly baseUrl?: string }): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface VaultHeaderSource {
  /** Credential headers for a remote MCP endpoint, applied by the gateway (never placed in process env). */
  mcpHeaders?(sessionId: string, url: string, placement: "shared" | "sandbox"): Record<string, string> | undefined | Promise<Record<string, string> | undefined>;
}

// ---------------------------------------------------------------------------------------------------------------
// Services core provides (structurally compatible with ../durable/contract.ts ports)

export type SessionEventListener = (sessionId: string, event: RuntimeSessionEvent) => void;

export interface CreateSessionRequest {
  /** Caller-chosen session ID (UUID). An existing ID for the same owner returns `{ created: false }`. */
  readonly sessionId?: string;
  readonly environment: string | EnvironmentRequest;
  readonly model?: string;
  readonly agent?: string;
  readonly systemMessage?: unknown;
  readonly streaming?: boolean;
  /** Declarations only (no handlers): calls are answered by actions responders (webhooks, polling, clients). */
  readonly tools?: readonly ToolDeclaration[];
  readonly webhook?: string;
  readonly scheduleId?: string;
  readonly clientName?: string;
  /**
   * The owner's session that starts this one (an orchestrator's coordinator starting a worker); same owner only. While
   * the new session has no connected client of its own, the parent's connected clients' credentials serve it before
   * the owner's background sign-in, from its creation on: the creating principal only names its owner.
   */
  readonly parentSessionId?: string;
}

/** A workspace-only session: a sandbox of an isolated environment for commands and files, with no runtime. */
export interface CreateWorkspaceRequest {
  /** Caller-chosen ID. An existing workspace-only session of the same owner returns `{ created: false }`. */
  readonly sessionId?: string;
  readonly environment: string | EnvironmentRequest;
  /** The owner's session that starts this one (an orchestrator's coordinator, for its hands sandbox); same owner only. */
  readonly parentSessionId?: string;
  readonly clientName?: string;
}

export interface CliAttachOptions {
  /** The responder ID the actions ledger sees for this CLI (unique per attachment). */
  readonly connectionId: string;
  /** Attach time, for responder ordering (default: now). */
  readonly createdAt?: number;
  /** Receives what the session's attachments get: `session.event` (after action routing) and `session.lifecycle`. */
  readonly notify: (method: string, params: unknown) => void;
  /** The owner's verified principal, if the CLI should serve as the session's connected credential while attached. */
  readonly principal?: Principal;
}

/** A CLI operation the attach module forwards to the runtime over AHP (native turns, not RPC turns). */
export type CliOperation =
  | { readonly kind: "turn"; readonly text: string }
  | { readonly kind: "model"; readonly modelId: string }
  | { readonly kind: "abort" }
  /** The person's answer to an `ask_user` question (AHP `chat/inputCompleted`). */
  | { readonly kind: "userInput" };

export interface CliAttachment {
  readonly connectionId: string;
  readonly incarnation: string;
  readonly generation: number;
  /**
   * Admits a CLI operation under the session's policy (text-only turns that need any required SDK hooks connected,
   * allowed models, aborts, answers to `ask_user` unless a connected app answers questions) and runs `send`, the AHP
   * write, in the same synchronous step as the ownership, fence, and placement checks. Throws (`not_found`,
   * `session_busy`, `conflict`, or the admission error) instead of sending.
   */
  write(operation: CliOperation, send: () => void): void;
  /**
   * A CLI answer to a pending permission or elicitation request, through the actions ledger as `responderKind: "cli"`
   * for the pinned incarnation and generation (`requireRecorded`): an answer the ledger does not record is refused, not
   * forwarded. Without an actions service it goes to the pinned runtime. Never a tool result.
   */
  answer(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Detaches the CLI responder (`actions.onDetached`). Idempotent. */
  close(): void;
}

/** Options of service calls on a session. */
export interface SessionCallOptions {
  /**
   * The session incarnation the call is for. The call fails with `not_found` unless it is still the session's current
   * one when the call is written to the runtime (checked in the same step), so a deleted and re-created ID never
   * receives it.
   */
  readonly incarnation?: string;
}

/** Options of `sessions.send`. */
export interface SessionSendOptions extends SessionCallOptions {
  /**
   * Default true: the caller's verified credential serves the session while the send runs (a restore it triggers, for
   * example). False: only the session's own credential sources do (its connected clients, its parent's, the owner's
   * background sign-in), so a credential taken from a connection never serves the session after that connection
   * closes.
   */
  readonly lendCredential?: boolean;
}

export interface SessionsService {
  /** The session's ledger record; undefined for unknown and deleted sessions and for creates the gateway never finished. */
  get(sessionId: string): SessionRecord | undefined;
  /** Owner-scoped lookup; throws `not_found` for other accounts (existence is not revealed). */
  getOwned(accountId: number, sessionId: string): SessionRecord;
  /** Throws `not_found` for the caller's own session outside the app its request came through (spec section 2). */
  assertAppScope?(principal: Principal, sessionId: string): void;
  /** Owner-scoped `SessionInfo` (REST shape, including sandbox and pending actions). */
  info(accountId: number, sessionId: string): Promise<SessionInfo>;
  list(accountId: number, query?: { readonly environment?: string; readonly state?: SessionState; readonly limit?: number }): SessionRecord[];
  /**
   * Creates a session as `principal` with no client attached (schedules, background work). `incarnation` is the one it
   * created, or the existing session's when `created` is false.
   */
  create(principal: Principal, request: CreateSessionRequest): Promise<{ readonly sessionId: string; readonly created: boolean; readonly incarnation?: string }>;
  /**
   * Creates a workspace-only session (`kind: "workspace"`) as `principal`: a sandbox of an isolated environment, set
   * up like any other (network rules, vaults, setup), where no runtime ever starts. Commands run in it with
   * `sandboxes.exec`; files, artifacts, and delete work as for any sandbox session.
   */
  createWorkspace?(principal: Principal, request: CreateWorkspaceRequest): Promise<{ readonly sessionId: string; readonly created: boolean; readonly incarnation?: string }>;
  /**
   * Sends a prompt as the owner with `mode: "enqueue"`, resuming placement when needed. Settles in the same chain of
   * promise steps as the runtime's answer (no I/O in between), so a caller sees the close of the connection that
   * answered (`onLifecycle("stopped")`) only after the send settled.
   */
  send(principal: Principal, sessionId: string, input: { readonly prompt: string; readonly source?: string; readonly mode?: string }, options?: SessionSendOptions): Promise<{ readonly messageId: string }>;
  /** Forwards a session-scoped RPC to the runtime that owns the session. The caller is responsible for authorization. */
  request<T = unknown>(sessionId: string, method: string, params?: Record<string, unknown>, options?: SessionCallOptions): Promise<T>;
  abort(sessionId: string): Promise<void>;
  /** Owner-scoped delete: stops new work and removes runtime state, sandbox, and ledger entry. */
  delete(accountId: number, sessionId: string): Promise<void>;
  /** Observes runtime events of every session, synchronously and in order, before client fan-out. */
  subscribe(listener: SessionEventListener): () => void;
  /** Observes runtime events of one session. */
  subscribeSession(sessionId: string, listener: SessionEventListener): () => void;
  /** Connections attached to a session, creating connection first. */
  attached(sessionId: string): readonly AttachedResponder[];
  /** Where the session is resident now (resuming it upstream if needed); used by Copilot CLI attach. */
  runtime(sessionId: string): Promise<SessionRuntime>;
  /**
   * Marks the owner as present on a session without a `/v1/connect` attachment (an attached Copilot CLI): while held,
   * the principal's re-verified credential serves the session's runtime like an attached client's. Owner only.
   * Returns the release function.
   */
  presence?(sessionId: string, principal: Principal): () => void;
  /**
   * The verified owner principal whose credential serves the session right now (its connected client, a presence, its
   * parent's connected client, or the owner's background sign-in), for work the platform does on the owner's behalf in
   * that session's context (an orchestrator starting a worker). Use it at once; never keep it. `authentication_required`
   * when none is available.
   */
  ownerPrincipal?(sessionId: string): Promise<Principal>;
  /**
   * Attaches a Copilot CLI (attach module) to one session incarnation as a `cli` responder: no tools or callbacks of
   * its own beyond permission and elicitation prompts. Pins the incarnation, placement, generation, and runtime it
   * attached to; its writes are refused once any of them changes or a cutover fences the session. Owner only.
   */
  attachCli?(accountId: number, sessionId: string, options: CliAttachOptions): Promise<CliAttachment>;
  onLifecycle(listener: (event: { readonly sessionId: string; readonly type: "deleted" | "promoted" | "stopped" }) => void): () => void;
  /**
   * Opens a placement cutover (promotion): fails with `conflict` when `generation` is not the session's current one,
   * `promotion_busy` while another cutover is open, and `not_found` for unknown or deleting sessions.
   */
  cutover?(sessionId: string, options: { readonly generation: number }): Promise<PlacementCutover>;
}

/**
 * One placement change of a session from its current (source) runtime to its sandbox (destination). The promotion
 * module drives it: `source` RPCs to quiesce/suspend, `fence`, export/import state, `open`, then `commit` or `abort`.
 */
export interface PlacementCutover {
  /** The session's ledger record when the cutover opened. */
  readonly record: SessionRecord;
  /** The source runtime's state for the session (`<COPILOT_HOME>/session-state/<id>`); undefined when not local. */
  readonly sourceStateDir: string | undefined;
  /** A session-scoped request straight to the source upstream (`sessionId` filled in). Works after `fence()`. */
  source<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /**
   * Idempotent. From now on nothing the source sends for this session reaches clients, durable, observers, or the
   * ledger (its runtime requests get an error); new requests for the session wait for `commit`/`abort`; a client's
   * `sendAndWait` whose reply arrives fenced is completed later from the owning runtime's events. Ledger state
   * becomes `promoting`.
   */
  fence(): void;
  /**
   * Opens the session on its sandbox (which must exist, with state imported): the session's requested configuration
   * re-admitted for `sandbox` placement, attached clients' registrations, the sandbox platform tools, and `extra`
   * (e.g. `continuePendingWork: true`). Opening again replaces the previous destination.
   */
  open(extra?: Record<string, unknown>): Promise<{ request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> }>;
  /**
   * After `open`: placement `sandbox`, generation + 1, the sandbox-admitted configuration; routing moves. Resolves once
   * everything the cutover held back has been delivered, the fence has lifted, and `onLifecycle("promoted")` fired.
   */
  commit(): Promise<SessionRecord>;
  /** Before `commit`: closes the destination and lifts the fence; the source stays the owner and is resumed on next use with `resume` extras. */
  abort(options?: { readonly resume?: Record<string, unknown> }): Promise<void>;
}

export interface SessionRuntime {
  /** Changes whenever the upstream connection is replaced. */
  readonly connectionId: string;
  /** Connection-level JSON-RPC on the owning upstream connection. */
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** TCP to 127.0.0.1:<port> in the runtime's network namespace. */
  connect(port: number): Promise<Duplex>;
  /** Resolves when this upstream connection closes. */
  readonly closed: Promise<void>;
}

export interface PlatformEventMeta {
  readonly ownerId: number;
}

export interface EventsService {
  /**
   * Publishes to SSE subscribers (owner-scoped) and `subscribe` listeners (webhooks). Returns whether the event is
   * stored for `Last-Event-ID` replay, which includes an ID this owner already stored. Listeners are notified either
   * way, so a publisher that retries with a stable event ID gets at-least-once delivery (consumers dedupe by `id`).
   */
  publish(event: PlatformEvent, meta: PlatformEventMeta): boolean;
  /** Builds, publishes, and returns a platform event. */
  emit(type: PlatformEventType, input: { readonly ownerId: number; readonly sessionId?: string; readonly environment?: string; readonly data?: Record<string, unknown> }): PlatformEvent;
  subscribe(listener: (event: PlatformEvent, meta: PlatformEventMeta) => void): () => void;
}

/**
 * Context passed to platform tool handlers. Durable's ledger supplies the first five fields plus `agentId`,
 * `actionId`, and `signal`; core's own path (no ledger) supplies everything but `actionId`.
 */
export interface PlatformToolCallContext {
  readonly sessionId: string;
  readonly ownerId: number;
  readonly environment: string;
  readonly toolCallId: string;
  /** Stable across redelivery, resume, and restarts. */
  readonly idempotencyKey: string;
  readonly type?: EnvironmentType;
  readonly placement?: Placement;
  /**
   * The calling agent: the runtime request's `agentId` for a sub-agent (for example a stock `task` agent), undefined
   * for the root agent. Survives recovery (the ledger records it with the action).
   */
  readonly agentId?: string;
  /** The ledger action this call answers (durable path only). */
  readonly actionId?: string;
  /**
   * Aborted when the call's answer can no longer matter: the runtime stopped waiting for it (its turn was cancelled),
   * the session was deleted, the gateway is stopping, or (core's own path) after 10 minutes. `signal.reason` says which.
   */
  readonly signal?: AbortSignal;
}

/** Text for the model, or the stock SDK `ToolResultObject` shape. */
export type PlatformToolResult =
  | string
  | { readonly textResultForLlm: string; readonly resultType: "success" | "failure" | "rejected" | "denied"; readonly error?: string };

/** What modules register. A superset of durable's `PlatformToolDefinition`. */
export interface PlatformToolInput {
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments. */
  readonly parameters?: Record<string, unknown>;
  readonly overridesBuiltInTool?: boolean;
  /** Platform tools skip the runtime permission prompt by default (they are operator-approved); set false to prompt. */
  readonly skipPermission?: boolean;
  /** Inject into sessions of this environment (by name). */
  readonly enabledFor?: (environment: string) => boolean;
  /** Inject based on environment type and placement. Evaluated in addition to `enabledFor`. */
  readonly appliesTo?: (context: { readonly environment: string; readonly type: EnvironmentType; readonly placement: Placement }) => boolean;
  readonly handler: (args: unknown, context: PlatformToolCallContext) => unknown | Promise<unknown>;
  /**
   * Whether the actions ledger may rerun the handler for an interrupted call (see durable's `PlatformToolReplay`).
   * Default `"always"`: the handler is idempotent by `idempotencyKey`. Use `"never"` for tools with side effects
   * that must not repeat (a shell command); `recover` then answers interrupted calls, or they fail as "may have run".
   */
  readonly replay?: PlatformToolReplay;
  /** With `replay: "never"`: answers an interrupted call (reattach, or read the recorded outcome) instead of the handler. */
  readonly recover?: (args: unknown, context: PlatformToolCallContext) => unknown | Promise<unknown>;
  /**
   * The name is the platform's only in environments where `enabledFor` holds (`get`/`has` with that environment); in
   * any other session a client's tool of the same name stays the client's. For tools named like built-ins (`bash`).
   */
  readonly scoped?: boolean;
}

/** A registered tool, normalized so it also satisfies durable's `PlatformToolDefinition`. */
export interface RegisteredPlatformTool extends PlatformToolDefinition {
  readonly overridesBuiltInTool?: boolean;
  readonly scoped?: boolean;
  readonly skipPermission: boolean;
  readonly appliesTo?: PlatformToolInput["appliesTo"];
  readonly handler: (args: unknown, context: PlatformToolCallContext) => Promise<PlatformToolResult>;
  readonly recover?: (args: unknown, context: PlatformToolCallContext) => Promise<PlatformToolResult>;
}

export interface PlatformToolRegistry {
  register(definition: PlatformToolInput): () => void;
  /** The tool by name; a `scoped` tool only with an `environment` it is enabled for. */
  get(name: string, environment?: string): RegisteredPlatformTool | undefined;
  has(name: string, environment?: string): boolean;
  /** Tools injected into sessions of this environment and placement. */
  forSession(context: { readonly environment: string; readonly type: EnvironmentType; readonly placement: Placement }): readonly RegisteredPlatformTool[];
}

/** Resolves environment selectors against the deployment (shared by the router, REST routes, and other modules). */
export interface EnvironmentResolver {
  resolve(request: EnvironmentRequest | string): ResolvedEnvironment;
  /** The resolved environment a session was created in (its recorded request). */
  forSession(session: SessionRecord): ResolvedEnvironment;
}

declare module "../../app.js" {
  interface GatewayServices {
    sessions: SessionsService;
    events: EventsService;
    platformTools: PlatformToolRegistry;
    runtimeRequests: RuntimeRequestRegistry;
    environments: EnvironmentResolver;
    /** Apps that vouch for their own users (spec section 2): their environments, and their users' accounts. */
    apps: AppRegistry;
  }
}

/** Optional services provided by other modules but not declared in GatewayServices by them. */
export function optionalService<T>(services: object, key: string): T | undefined {
  return (services as Record<string, unknown>)[key] as T | undefined;
}

export type { Principal };
