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
 * - Placement generations: an action belongs to the generation whose runtime asked. An answer recorded after the
 *   session moved to a newer generation stays recorded but is not delivered (reason says why).
 * - Identity: `idempotencyKey` is `${sessionId}:${toolCallId}` for tools, identical across live callbacks, webhooks,
 *   polling, resume, and restarts.
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
  readonly event: RuntimeSessionEvent;
  /** Connections attached to the session right now, in preference order (the creating connection first). */
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
  readonly connectionId: string;
  readonly responderKind: "sdk" | "cli";
  /** One of `ANSWER_METHODS`. */
  readonly method: string;
  readonly params: Record<string, unknown>;
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
  readonly responder: AttachedResponder;
}

export type ResponderType = "live" | "webhook" | "poll" | "cli" | "platform";

/** Who is asking to list, claim, or answer actions over REST. */
export type ActionCaller =
  | { readonly type: "user"; readonly principal: Principal }
  | { readonly type: "capability"; readonly capability: VerifiedCapability };

export interface VerifiedCapability {
  readonly sessionId: string;
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
  /** Owner-visible actions of a session (core uses this for `SessionInfo.pendingActions`). */
  list(sessionId: string, options?: { readonly open?: boolean }): PendingAction[];
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
  onDetached(connectionId: string): void;
  releaseLiveClaim(actionId: string, claimToken: string): void;
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
  readonly lastTurn?: { readonly status: "running" | "completed" | "failed" | "cancelled" };
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
  get(sessionId: string): DurableSessionView | undefined | Promise<DurableSessionView | undefined>;
  /** Server-side create as `principal` with a caller-chosen ID. Resolves `{ created: false }` when the ID already exists for that owner. */
  create(principal: Principal, request: DurableCreateSessionRequest): Promise<{ readonly sessionId: string; readonly created: boolean }>;
  /** Server-side send as the owner, `mode: "enqueue"` (queued behind a running turn, never steering it). Resumes placement if needed. */
  send(principal: Principal, sessionId: string, input: { readonly prompt: string; readonly source?: string }): Promise<{ readonly messageId: string }>;
  /** Forwards a session-scoped RPC to the runtime that currently owns the session (answers, pending lists, history). */
  request<T = unknown>(sessionId: string, method: string, params: Record<string, unknown>): Promise<T>;
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

declare module "../../app.js" {
  interface GatewayServices {
    actions: ActionsService;
    webhooks: WebhooksService;
    schedules: SchedulesService;
    credentials: CredentialsService;
  }
}
