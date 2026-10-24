/**
 * Durable workstream contract (spec sections 2, 12, 13; architecture "Gateway extension points").
 *
 * This file is types and constants only, so other modules can import it without pulling in the implementation:
 *
 * - Services this module provides: `actions`, `webhooks`, `schedules`, `credentials`.
 * - Ports it consumes from core: `sessions`, `events`, `platformTools` (see the `Durable*Port` interfaces). Core's
 *   real services only need to be structurally compatible with these ports.
 *
 * ## Router integration (core's `/v1/connect` JSON-RPC router)
 *
 * Execution-bearing runtime events are **claimed before emission** so exactly one responder executes them:
 *
 * 1. For every upstream `session.event` whose `event.type` is in `ACTION_EVENT_TYPES`, call
 *    `actions.onSessionEvent(...)` **before** fan-out. Deliver the raw event to `decision.owner` (if any), deliver
 *    nothing to the connections in `decision.withhold`, and deliver it unchanged to every other attached connection
 *    (they cannot execute it). If writing to the owner fails, call `actions.releaseLiveClaim(...)`.
 * 2. When a client sends one of `ANSWER_METHODS`, call `actions.onClientAnswer(...)` instead of forwarding it, and
 *    reply to the client with `decision.response` (or the decision's error). `kind: "forward"` means the ledger does
 *    not track that request: forward it upstream as usual.
 * 3. After `session.create` / `session.resume` succeeds for a connection (after its response is written), call
 *    `actions.onAttached(...)` and deliver the returned events to that connection, in order. This replays actions that
 *    were waiting for a responder, already claimed for that connection.
 * 4. When a connection closes or stops (`client.stop`, socket close), call `actions.onDetached(connectionId)`.
 *
 * ## Action lifecycle (one ledger for live clients, webhook workers, pollers, attached people, and platform tools)
 *
 * - `pending` → `executing`: a responder claims it. Live clients are claimed at emission (or on resume replay);
 *   webhook workers (`mcc_` capability) and owners (polling) claim over REST; platform tools are claimed by the
 *   gateway. Every claim enters `executing` at once because the stock SDK runs a handler on receipt; `claimed` is
 *   reserved. Each claim bumps a claim sequence, so older claim tokens can never commit.
 * - Lease renewal: REST claims carry a lease; repeat the claim with `claimToken` to renew it (slow but healthy
 *   handlers keep ownership). Live and platform claims last as long as their connection or process.
 * - `executing` → `completed` / `failed`: the answer is persisted before it is acknowledged and before it is delivered
 *   to the runtime. A duplicate (same claim token, same canonical result) returns the recorded state; a different
 *   result is `conflict`.
 * - `executing` → `needs_reconciliation`: a tool's lease expired, its live client disconnected, or the gateway
 *   restarted. Execution may have happened, so it is never re-offered automatically. The original claimant's late
 *   result is still accepted (it is the true outcome); anyone else must claim with `reconcile: true` after checking
 *   the downstream effect with the action's `idempotencyKey`, then submit the reconciled result. Prompts
 *   (permission, elicitation) have no external effect and return to `pending` instead.
 * - Release: `result { claimToken, release: true }` returns an owned action to `pending` without answering.
 * - `expired`: the answer deadline (24h) passed. The runtime receives an error (tool), `user-not-available`
 *   (permission), or `cancel` (elicitation) — never an approval. Late results are `conflict`.
 * - `cancelled`: the runtime stopped waiting (completion event without a recorded answer, aborted turn, or
 *   reconciliation against the runtime's pending lists). Late results are `conflict`.
 * - Placement generations: an action belongs to the generation whose runtime asked. On promotion
 *   (`onGenerationChanged`), actions whose request the new placement still awaits (`carried`) and gateway-executed
 *   platform tools keep their claims and move; every other claim from an older generation is void, so late results
 *   from it are `conflict` (tools become `needs_reconciliation`, prompts are offered again, but never to a live
 *   connection that held them only under an older placement). A recorded answer is delivered to the session's
 *   current placement only if that runtime still waits for exactly that request (it was carried, or the runtime asks
 *   again); otherwise it stays recorded but undelivered (reason says why). Deliveries are per placement: an older
 *   placement's acknowledgment never counts for a newer one, and its pending lists or completion events never close
 *   an action that has moved on.
 * - Identity: `idempotencyKey` is `${sessionId}:${toolCallId}` for tools, identical across live callbacks, webhooks,
 *   polling, resume, and restarts. A runtime that restarts without suspending may rebuild a waiting tool call under a
 *   new request ID (same tool call ID): the action takes the new ID and keeps its owner, outcome, or uncertainty.
 * - Incarnations: a session ID can be reused after the session is deleted, by the same or another account. Every
 *   action belongs to the incarnation (`SessionRecord.incarnation`) that asked; listing, claiming, answering,
 *   capabilities, replay, delivery, and deletion only ever see the current incarnation's actions.
 * - Permission authority: decisions are checked against the responder. Webhook capabilities approve once, reject, or
 *   report nobody available; they never attest a person or grant standing approvals. Prompts managed policy reserves
 *   for a person (`managedApprovalRequired`) are approved only by an attached CLI or by the owner's client/poller
 *   attesting a person (`approve-once` + `approvedInteractively`); an attached CLI gets them first.
 * - Attach (Copilot CLI): `promptVisibility` before showing a raw-channel prompt as answerable; answers through
 *   `onClientAnswer` with `requireRecorded: true` (unknown requests and non-holders are refused, never forwarded).
 */
import type {
  ActionCapability,
  ActionClaim,
  ActionKind,
  ActionResultRequest,
  ActionState,
  BackgroundCredentialStatus,
  CreateScheduleRequest,
  HandleActionResult,
  PendingAction,
  PlatformEvent,
  ScheduleInfo,
  ScheduleRun,
  SessionState,
  ToolDeclaration,
} from "@managed-copilot/protocol";
import type { Principal } from "../../http.js";

// ---------------------------------------------------------------------------------------------------------------
// Runtime protocol shapes (SDK 1.0.26 / runtime 1.0.103)
// ---------------------------------------------------------------------------------------------------------------

/** A runtime `session.event` payload's `event` object (the stock SDK's `SessionEvent`). */
export interface RuntimeSessionEvent {
  readonly id: string;
  readonly type: string;
  readonly timestamp: string;
  readonly parentId: string | null;
  readonly data: Record<string, unknown>;
  readonly agentId?: string;
  readonly ephemeral?: boolean;
}

/** Events that start an action (claimed before emission). */
export const EXECUTION_EVENT_TYPES = ["external_tool.requested", "permission.requested", "elicitation.requested"] as const;
/** Events that tell the ledger an action was resolved by the runtime (answered, cancelled, or dismissed). */
export const COMPLETION_EVENT_TYPES = ["external_tool.completed", "permission.completed", "elicitation.completed"] as const;
/** Every event type the router passes to `actions.onSessionEvent`. */
export const ACTION_EVENT_TYPES: ReadonlySet<string> = new Set<string>([...EXECUTION_EVENT_TYPES, ...COMPLETION_EVENT_TYPES]);

/** Client → runtime answer RPCs the router hands to `actions.onClientAnswer` instead of forwarding. */
export const ANSWER_METHODS = {
  tool: "session.tools.handlePendingToolCall",
  permission: "session.permissions.handlePendingPermissionRequest",
  elicitation: "session.ui.handlePendingElicitation",
} as const;
export const ANSWER_METHOD_SET: ReadonlySet<string> = new Set<string>(Object.values(ANSWER_METHODS));

/** Runtime RPCs the ledger uses to reconcile with what the runtime still awaits. */
export const PENDING_LIST_METHODS = {
  tool: "session.tools.listPendingRequests",
  permission: "session.permissions.pendingRequests",
} as const;

// ---------------------------------------------------------------------------------------------------------------
// actions (provided by durable)
// ---------------------------------------------------------------------------------------------------------------

/** A client connection attached to a session, as the router sees it. */
export interface AttachedResponder {
  /** The router's connection ID, stable for the connection's lifetime. */
  readonly connectionId: string;
  /** `sdk`: a stock SDK client over the bridge. `cli`: an attached Copilot CLI, i.e. a person. */
  readonly kind: "sdk" | "cli";
  /** Tool names this connection declared for the session (`tools[].name` in its session.create/resume). */
  readonly tools: readonly string[];
  /** Wire flags from the connection's session.create/resume request. */
  readonly requestPermission: boolean;
  readonly requestElicitation: boolean;
}

export interface SessionEventInput {
  readonly sessionId: string;
  readonly ownerId: number;
  readonly environment: string;
  /** Placement generation of the runtime that emitted the event (fencing; 0 until promotion exists). */
  readonly generation: number;
  /** The session incarnation the event belongs to (`SessionRecord.incarnation`); looked up when absent. */
  readonly incarnation?: string;
  readonly event: RuntimeSessionEvent;
  /** Connections attached to the session right now, in preference order (the creating connection first, then by attach time). */
  readonly attached: readonly AttachedResponder[];
}

export interface SessionEventDecision {
  /** The ledger action this event created, matched, or completed. Absent when the event is not tracked. */
  readonly actionId?: string;
  /** The one connection that receives the actionable event. Absent: nobody executes it live. */
  readonly owner?: string;
  /** Proof of the live claim; pass it to `releaseLiveClaim` if the event could not be written to `owner`. */
  readonly claimToken?: string;
  /** Connections that must not receive this event (eligible responders that do not own it). */
  readonly withhold: readonly string[];
}

export interface ClientAnswerInput {
  readonly sessionId: string;
  readonly incarnation?: string;
  /** Placement generation the client saw the request in; an answer from another placement is refused as stale. */
  readonly generation?: number;
  readonly connectionId: string;
  readonly responderKind: "sdk" | "cli";
  /** One of `ANSWER_METHODS`. */
  readonly method: string;
  readonly params: Record<string, unknown>;
  /**
   * Fail closed (Copilot CLI attach): refuse with `conflict` instead of forwarding a request the ledger does not track,
   * and accept the answer only from the connection that holds the action's claim (see `promptVisibility`).
   */
  readonly requireRecorded?: boolean;
}

export type ClientAnswerDecision =
  /** The ledger recorded (or already had) this answer; reply to the client with `response`. */
  | { readonly kind: "respond"; readonly response: unknown }
  /** Not a ledger action (for example created before the ledger saw it); forward upstream unchanged. */
  | { readonly kind: "forward" };

export interface AttachInput {
  readonly sessionId: string;
  readonly ownerId: number;
  readonly environment: string;
  readonly generation: number;
  readonly incarnation?: string;
  readonly responder: AttachedResponder;
}

export type ResponderType = "live" | "webhook" | "poll" | "cli" | "platform";

/**
 * Copilot CLI attach: the CLI sees prompts on its raw runtime channel, which can run ahead of core's event stream.
 * Before showing one as answerable, attach asks the ledger, which waits until core recorded and arbitrated it.
 */
export interface PromptVisibilityInput {
  readonly sessionId: string;
  /** The session incarnation and placement generation the CLI is attached to. */
  readonly incarnation: string;
  readonly generation: number;
  /** The attached CLI, with the same connection ID core passes in `attached` (kind `cli`). */
  readonly responder: AttachedResponder;
  readonly kind: ActionKind;
  readonly requestId: string;
  /** How long to wait for core's event stream to record the request before reconciling with the runtime (default 5 s). */
  readonly waitMs?: number;
}

export type PromptVisibility =
  /** This CLI holds the action's claim (taken now if it was waiting): show it as answerable. */
  | { readonly status: "actionable"; readonly actionId: string }
  /** Another responder holds it (an application, a webhook worker, a poller, another CLI): show it read-only. */
  | { readonly status: "observe"; readonly actionId: string; readonly state: ActionState; readonly claimedBy?: string }
  /** Not answerable by this CLI: unknown, already resolved, a tool call, or from another incarnation or placement. */
  | { readonly status: "hidden"; readonly reason: string };

/** Who is asking to list, claim, or answer actions over REST. */
export type ActionCaller =
  | { readonly type: "user"; readonly principal: Principal }
  | { readonly type: "capability"; readonly capability: VerifiedCapability };

export interface VerifiedCapability {
  readonly sessionId: string;
  /** The session incarnation whose actions it covers (absent on capabilities minted before incarnations existed). */
  readonly incarnation?: string;
  readonly actionIds: readonly string[];
  readonly audience: string;
  readonly expiresAt: string;
  /** Webhook subscription the capability was minted for. */
  readonly webhook: string;
}

export interface ClaimOptions {
  /** Renew an existing claim instead of taking a new one. */
  readonly claimToken?: string;
  /** Requested lease in seconds (bounded by the service). */
  readonly leaseSeconds?: number;
  /** Explicitly take over an action in `needs_reconciliation` after checking its downstream effect. */
  readonly reconcile?: boolean;
  /** Free-form responder label recorded with the claim (for example a worker name). */
  readonly responder?: string;
}

export interface ActionsService extends ActionRouterHooks {
  /**
   * Owner-visible actions of a session's current incarnation (core uses this for `SessionInfo.pendingActions`).
   * Pass `incarnation` to read a specific one; nothing is returned for a session that no longer exists.
   */
  list(sessionId: string, options?: { readonly open?: boolean; readonly incarnation?: string }): PendingAction[];
  /**
   * True while the session's runtime may still wait on something the ledger owns: an action that is pending,
   * executing, or uncertain, or an answer recorded but not delivered yet. Resume such a session with
   * `continuePendingWork: true`.
   */
  hasOpenActions(sessionId: string, options?: { readonly incarnation?: string }): boolean;
  /**
   * Copilot CLI attach: whether a prompt the CLI saw on its raw channel is answerable by it. Resolves only after the
   * ledger recorded and arbitrated the request (waiting for core's event stream, then reconciling with the runtime);
   * an unknown request is never answerable. A waiting prompt is claimed for the CLI. Answer with `onClientAnswer`
   * (`responderKind: "cli"`, `requireRecorded: true`).
   */
  promptVisibility(input: PromptVisibilityInput): Promise<PromptVisibility>;
  /** REST: list/claim/answer as an owner, poller, or webhook capability holder. */
  listFor(caller: ActionCaller, sessionId: string, options?: { readonly open?: boolean }): Promise<PendingAction[]>;
  claim(caller: ActionCaller, sessionId: string, actionId: string, options?: ClaimOptions): Promise<ActionClaim>;
  submit(caller: ActionCaller, sessionId: string, actionId: string, request: ActionResultRequest): Promise<HandleActionResult>;
  /** Verifies an `mcc_` capability token for this deployment. */
  verifyCapability(token: string): VerifiedCapability;
  /** Mints a capability for a session's listed actions that are still pending. */
  mintCapability(sessionId: string, actionIds: readonly string[], webhook: string): ActionCapability | undefined;
  /** Compares the ledger with the runtime's pending lists. */
  reconcile(sessionId: string): Promise<void>;
}

export interface ActionRouterHooks {
  onSessionEvent(input: SessionEventInput): Promise<SessionEventDecision>;
  onClientAnswer(input: ClientAnswerInput): Promise<ClientAnswerDecision>;
  onAttached(input: AttachInput): Promise<readonly RuntimeSessionEvent[]>;
  /**
   * A connection stopped answering. Pass `sessionId` when it detached from one session (`session.disconnect`, a
   * failed resume, session deletion) so only that session's live claims are released; omit it when the whole
   * connection closed.
   */
  onDetached(connectionId: string, sessionId?: string): void;
  releaseLiveClaim(actionId: string, claimToken: string): void;
  /**
   * The session was deleted: its open actions are cancelled and nothing more is delivered for it. `incarnation`
   * (from `session.deleted` `data.incarnation`) limits it to the deleted incarnation; a later reuse of the ID is a new
   * session whose actions are recorded normally.
   */
  onSessionDeleted?(sessionId: string, incarnation?: string): void;
  /**
   * The session moved to a new placement generation (promotion). Call it right after the generation is committed;
   * it is idempotent (actions already at `generation` or newer are untouched), so the `session.promoted` event that
   * follows a direct call changes nothing. Waiting actions move; carried actions and gateway-executed platform tools
   * keep their claims; other claims from older generations are fenced.
   */
  onGenerationChanged?(sessionId: string, generation: number, options?: GenerationChangeOptions): void;
}

export interface GenerationChangeOptions {
  /**
   * Runtime request IDs the new placement still awaits (resumed with `continuePendingWork`, which keeps request
   * IDs). Their actions keep state, claim token, and claim sequence, and their answers (including ones recorded but
   * not yet delivered) go to the new placement.
   */
  readonly carried?: readonly string[];
}

export interface ActionRecordSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: ActionKind;
  readonly state: ActionState;
}

// ---------------------------------------------------------------------------------------------------------------
// webhooks, schedules, credentials (provided by durable)
// ---------------------------------------------------------------------------------------------------------------

export type WebhookDeliveryState = "pending" | "delivering" | "delivered" | "failed";

export interface WebhookDeliveryInfo {
  readonly id: string;
  readonly webhook: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly sessionId?: string;
  readonly state: WebhookDeliveryState;
  readonly attempts: number;
  readonly lastStatus?: number;
  readonly lastError?: string;
  readonly nextAttemptAt?: string;
  readonly createdAt: string;
  readonly deliveredAt?: string;
}

export interface WebhooksService {
  /** Queues a platform event for every authorized subscription (environment and event type). */
  enqueue(event: PlatformEvent, meta: PlatformEventMeta): number;
  /** Stops pending `session.action_required` deliveries for a deleted session (their actions were cancelled). */
  dropSession?(sessionId: string): number;
  /** Names of AppHost webhooks that cover an environment and event type. */
  subscribers(environment: string, eventType: string): string[];
  deliveries(options?: { readonly state?: WebhookDeliveryState; readonly limit?: number; readonly ownerId?: number }): WebhookDeliveryInfo[];
}

export interface SchedulesService {
  create(principal: Principal, request: CreateScheduleRequest, options?: { readonly createdBy?: "user" | "agent"; readonly originSessionId?: string }): Promise<ScheduleInfo>;
  list(ownerId: number): ScheduleInfo[];
  get(ownerId: number, scheduleId: string): ScheduleInfo;
  runs(ownerId: number, scheduleId: string): ScheduleRun[];
  pause(ownerId: number, scheduleId: string, reason?: string): ScheduleInfo;
  resume(ownerId: number, scheduleId: string): ScheduleInfo;
  delete(ownerId: number, scheduleId: string): void;
  runNow(ownerId: number, scheduleId: string, invocationId?: string): Promise<ScheduleRun>;
  /** Pauses every active schedule of an owner with a visible reason (logout, revoked credential). */
  pauseAllForOwner(ownerId: number, reason: string): number;
  /** Materializes AppHost-declared schedules whose `runAs` is this account (paused until the account approves). */
  syncAppHost?(account: { readonly accountId: number; readonly login: string }): void;
}

export interface CredentialsService {
  /** Stores the caller's own GitHub credential, sealed at rest (`managed-copilot login`). */
  store(principal: Principal): BackgroundCredentialStatus;
  status(principal: Principal): BackgroundCredentialStatus;
  /** Deletes the credential and pauses dependent schedules (`managed-copilot logout`). */
  revoke(principal: Principal, reason?: string): void;
  /**
   * Re-verifies the stored credential and returns the principal it authenticates. Fails with `authentication_required`
   * when it is missing, revoked, or now resolves to a different account; never substitutes another account.
   */
  principalFor(accountId: number): Promise<Principal>;
  has(accountId: number): boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Ports durable consumes from core. Core's services must be structurally compatible.
// ---------------------------------------------------------------------------------------------------------------

/** Minimal view of a ledger session that durable needs. */
export interface DurableSessionView {
  readonly id: string;
  readonly ownerId: number;
  readonly environment: string;
  readonly state: SessionState;
  /** Placement generation (0 until promotion exists). */
  readonly generation: number;
  /**
   * Immutable identity of this creation of the session ID (IDs are reusable after deletion). Durable falls back to
   * `createdAt` when it is absent.
   */
  readonly incarnation?: string;
  readonly createdAt?: string;
  readonly lastTurn?: { readonly turnId?: string; readonly status: "running" | "completed" | "failed" | "cancelled"; readonly completedAt?: string };
}

export interface DurableCreateSessionRequest {
  /** Caller-chosen session ID (deterministic per schedule occurrence). Creating an existing ID must not create a second session. */
  readonly sessionId: string;
  readonly environment: string;
  readonly model?: string;
  readonly agent?: string;
  /** Stored declarations only (no handlers): calls are answered by the `webhook` route or other responders. */
  readonly tools?: readonly ToolDeclaration[];
  /** Webhook that answers this session's external tools while no live client is attached. */
  readonly webhook?: string;
  /** Recorded as `SessionInfo.scheduleId`. */
  readonly scheduleId?: string;
}

export interface DurableSessionsPort {
  /** Synchronous ledger read (core's `sessions.get`); undefined once the session is deleted. */
  get(sessionId: string): DurableSessionView | undefined;
  /**
   * Server-side create as `principal` with a caller-chosen ID. Resolves `{ created: false }` when the ID already exists
   * for that owner, with the incarnation created (or found).
   */
  create(principal: Principal, request: DurableCreateSessionRequest): Promise<{ readonly sessionId: string; readonly created: boolean; readonly incarnation?: string }>;
  /**
   * Server-side send as the owner, `mode: "enqueue"` (queued behind a running turn, never steering it). Resumes placement
   * if needed. With `incarnation`, fails `not_found` unless the session is still that incarnation when the prompt is written.
   */
  send(
    principal: Principal,
    sessionId: string,
    input: { readonly prompt: string; readonly source?: string },
    options?: { readonly incarnation?: string },
  ): Promise<{ readonly messageId: string }>;
  /**
   * Forwards a session-scoped RPC to the runtime that currently owns the session (answers, pending lists, history).
   * With `incarnation`, fails `not_found` unless the session is still that incarnation when the request is written.
   */
  request<T = unknown>(sessionId: string, method: string, params: Record<string, unknown>, options?: { readonly incarnation?: string }): Promise<T>;
  /** Subscribes to runtime events of every session. Returns an unsubscribe function. */
  subscribe(listener: (sessionId: string, event: RuntimeSessionEvent) => void): () => void;
}

/** Owner metadata that travels with a platform event (not part of the customer-visible payload). */
export interface PlatformEventMeta {
  readonly ownerId: number;
}

export interface DurableEventsPort {
  /** Publishes to SSE subscribers (owner-scoped) and to `subscribe` listeners (webhooks). */
  publish(event: PlatformEvent, meta: PlatformEventMeta): void;
  subscribe(listener: (event: PlatformEvent, meta: PlatformEventMeta) => void): () => void;
}

export interface PlatformToolContext {
  readonly sessionId: string;
  readonly ownerId: number;
  readonly environment: string;
  readonly toolCallId: string;
  /** Stable across redelivery, resume, and restarts; use it for downstream idempotency. */
  readonly idempotencyKey: string;
}

/** Text for the model, or the stock SDK `ToolResultObject` shape. */
export type PlatformToolResult = string | { readonly textResultForLlm: string; readonly resultType: "success" | "failure" | "rejected" | "denied"; readonly error?: string };

export interface PlatformToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON schema of the arguments. */
  readonly parameters: Record<string, unknown>;
  /** Inject only into sessions whose environment passes (e.g. `scheduling: true`). */
  readonly enabledFor: (environment: string) => boolean;
  readonly handler: (args: unknown, context: PlatformToolContext) => Promise<PlatformToolResult>;
}

export interface DurablePlatformToolsPort {
  register(definition: PlatformToolDefinition): void;
  get?(name: string): PlatformToolDefinition | undefined;
}

/** Core's authenticator, as the background-credential service uses it. */
export interface DurableAuthPort {
  /** `background: true` verifies a stored background credential without recording it as the account's live one. */
  authenticate(token: string, options?: { readonly background?: boolean }): Promise<Principal>;
  /** Drops every reference core holds to a background credential that was removed (logout, invalidation). */
  forgetCredential?(token: string): void;
}

declare module "../../app.js" {
  interface GatewayServices {
    actions: ActionsService;
    webhooks: WebhooksService;
    schedules: SchedulesService;
    credentials: CredentialsService;
  }
}
