import {
  isManagedCopilotError,
  ManagedCopilotError,
  type ActionCapability,
  type ActionClaim,
  type ActionKind,
  type ActionResultRequest,
  type ActionState,
  type HandleActionResult,
  type PendingAction,
  type PlatformEvent,
} from "@managed-copilot/protocol";
import type { Database } from "../../../db.js";
import type { Logger } from "../../../log.js";
import {
  ANSWER_METHODS,
  COMPLETION_EVENT_TYPES,
  EXECUTION_EVENT_TYPES,
  PENDING_LIST_METHODS,
  type ActionCaller,
  type ActionsService,
  type AttachedResponder,
  type AttachInput,
  type ClaimOptions,
  type ClientAnswerDecision,
  type ClientAnswerInput,
  type DurablePlatformToolsPort,
  type DurableSessionView,
  type DurableSessionsPort,
  type GenerationChangeOptions,
  type PlatformEventMeta,
  type PlatformToolContext,
  type PlatformToolDefinition,
  type PromptVisibility,
  type PromptVisibilityInput,
  type RuntimeSessionEvent,
  type SessionEventDecision,
  type SessionEventInput,
  type VerifiedCapability,
} from "../contract.js";
import { canonicalJson, hashSecret, incarnationOf, isGone, newId, parseJson, toIso } from "../ids.js";
import { mintCapabilityToken, verifyCapabilityToken } from "./capability.js";
import { ActionStore, ANSWERED_STATES, OPEN_STATES, OWNED_STATES, runtimeRequestId, toOperatorRecord, toPendingAction, type ActionOperatorRecord, type ActionRow, type DeliveryAttempt, type Outcome } from "./store.js";

export interface ActionsOptions {
  /** Answer deadline for every action (spec: proposed 24 hours). */
  readonly answerTimeoutMs: number;
  /** Default and maximum lease for REST claims (webhook workers and pollers renew while they work). */
  readonly defaultLeaseMs: number;
  readonly minLeaseMs: number;
  readonly maxLeaseMs: number;
  /** Lifetime of webhook action capabilities. */
  readonly capabilityTtlMs: number;
  readonly sweepIntervalMs: number;
  /** Coalesces `session.action_required` for actions requested together (parallel tool calls). */
  readonly notifyDebounceMs: number;
  /** Upper bound for one upstream call (answers, pending lists). */
  readonly upstreamTimeoutMs: number;
  readonly maxForwardAttempts: number;
}

export const DEFAULT_ACTIONS_OPTIONS: ActionsOptions = {
  answerTimeoutMs: 24 * 60 * 60 * 1000,
  defaultLeaseMs: 60_000,
  minLeaseMs: 5_000,
  maxLeaseMs: 15 * 60_000,
  capabilityTtlMs: 15 * 60_000,
  sweepIntervalMs: 1_000,
  notifyDebounceMs: 100,
  upstreamTimeoutMs: 15_000,
  maxForwardAttempts: 30,
};

export interface ActionsDeps {
  readonly db: Database;
  readonly log: Logger;
  readonly capabilityKey: Buffer;
  /** Public base URL of this deployment (capability audience). */
  readonly publicUrl: string;
  readonly sessions: () => DurableSessionsPort | undefined;
  readonly platformTools: () => DurablePlatformToolsPort | undefined;
  /** Publishes a platform event to SSE subscribers and webhooks. */
  readonly publish: (event: PlatformEvent, meta: PlatformEventMeta) => void;
  readonly now?: () => number;
  readonly options?: Partial<ActionsOptions>;
}

/** Ledger changes other durable components react to (schedule runs move between `running` and `waiting`). */
export type ActionChange = { readonly type: "pending" | "resolved"; readonly sessionId: string; readonly actionId: string };

interface ParsedAction {
  readonly kind: ActionKind;
  readonly requestId: string;
  readonly tool?: string;
  readonly toolCallId?: string;
  readonly providerId?: string;
  readonly arguments?: unknown;
}

const EXECUTION_TYPES: ReadonlySet<string> = new Set(EXECUTION_EVENT_TYPES);
const COMPLETION_KIND: Readonly<Record<string, ActionKind>> = {
  "external_tool.completed": "tool",
  "permission.completed": "permission",
  "elicitation.completed": "elicitation",
};
const METHOD_KIND: Readonly<Record<string, ActionKind>> = {
  [ANSWER_METHODS.tool]: "tool",
  [ANSWER_METHODS.permission]: "permission",
  [ANSWER_METHODS.elicitation]: "elicitation",
};
const TOOL_RESULT_TYPES = new Set(["success", "failure", "rejected", "denied", "timeout"]);
const ELICITATION_ACTIONS = new Set(["accept", "decline", "cancel"]);
/** Reconciliation never closes an action this young: the runtime's lists may lag the event that created it. */
const RECONCILE_GRACE_MS = 2_000;
/** A pending action still unannounced after this long lost its notification (for example to a crash). */
const ANNOUNCE_REPAIR_AFTER_MS = 5_000;
/** Bound for in-memory per-connection and per-incarnation counters. */
const MAX_REMEMBERED = 10_000;
const MOVED_WHILE_RUNNING =
  "The session moved to a new placement while this tool was running; it may have run. Check its effect with the idempotency key, then answer it with a reconcile claim.";
const RESTARTED_WHILE_RUNNING =
  "The runtime restarted while this tool was being handled; it may have run. Check its effect with the idempotency key, then answer it with a reconcile claim.";
const SHUTTING_DOWN = () => new ManagedCopilotError("capability_unavailable", "The gateway is shutting down; try again shortly");

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
/** The runtime event an action was recorded from. */
const eventData = (row: Pick<ActionRow, "event">): Record<string, unknown> | undefined => parseJson<RuntimeSessionEvent>(row.event)?.data;
/**
 * A permission action recorded from the runtime's pending list alone carries only the derived prompt: an
 * application's handler needs the raw request, so only a person (an attached CLI) can answer it.
 */
const lacksRawRequest = (row: Pick<ActionRow, "kind" | "event">) => row.kind === "permission" && eventData(row)?.permissionRequest === undefined;

/** Live connections that held an action, with the placement generation each last held it in. */
function liveClaimants(row: Pick<ActionRow, "live_claimants">): Record<string, number> {
  const parsed = parseJson<Record<string, number>>(row.live_claimants);
  return parsed !== null && typeof parsed === "object" ? parsed : {};
}

function withLiveClaimant(row: Pick<ActionRow, "live_claimants">, connectionId: string, generation: number): string {
  return JSON.stringify({ ...liveClaimants(row), [connectionId]: generation });
}

/**
 * A connection that held this action only under an older placement (its claim voided by a move, or released before
 * it) may still be running that old callback. The stock protocol cannot tell its late answer from a new one, so it
 * is never offered the action again and its answers are refused; other responders can answer.
 */
function heldBefore(row: Pick<ActionRow, "live_claimants" | "live_connection" | "generation">, connectionId: string): boolean {
  const generation = liveClaimants(row)[connectionId];
  return generation !== undefined && generation < row.generation && row.live_connection !== connectionId;
}
const conflict = (message: string, row?: ActionRow) =>
  new ManagedCopilotError("conflict", message, row ? { actionId: row.id, state: row.state, ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}) } : undefined);

/** `${sessionId}:${toolCallId}` for tools, so live handlers can derive the same key from their `ToolInvocation`. */
export function idempotencyKeyFor(sessionId: string, action: { readonly kind: ActionKind; readonly toolCallId?: string | undefined; readonly requestId: string }): string {
  return action.kind === "tool" && action.toolCallId ? `${sessionId}:${action.toolCallId}` : `${sessionId}:${action.kind}:${action.requestId}`;
}

function parseExecutionEvent(event: RuntimeSessionEvent): ParsedAction | undefined {
  const data = event.data ?? {};
  const requestId = str(data.requestId);
  if (!requestId) return undefined;
  switch (event.type) {
    case "external_tool.requested": {
      const tool = str(data.toolName);
      if (!tool) return undefined;
      return {
        kind: "tool",
        requestId,
        tool,
        ...(str(data.toolCallId) ? { toolCallId: str(data.toolCallId)! } : {}),
        ...(str(data.providerId) ? { providerId: str(data.providerId)! } : {}),
        arguments: data.arguments ?? {},
      };
    }
    case "permission.requested": {
      // A permissionRequest hook already decided; nothing waits for a responder.
      if (data.resolvedByHook === true) return undefined;
      // A prompt reconstructed from the runtime's pending list may carry only its derived form.
      const request = (data.permissionRequest ?? data.promptRequest) as Record<string, unknown> | undefined;
      return {
        kind: "permission",
        requestId,
        // Custom and MCP tool prompts name their tool, which makes pending prompts readable.
        ...(str(request?.toolName) ? { tool: str(request?.toolName)! } : {}),
        ...(str(request?.toolCallId) ? { toolCallId: str(request?.toolCallId)! } : {}),
      };
    }
    case "elicitation.requested": {
      const { message, requestedSchema, mode, elicitationSource, url } = data;
      return { kind: "elicitation", requestId, arguments: { message, requestedSchema, mode, elicitationSource, url } };
    }
    default:
      return undefined;
  }
}

function isEligible(responder: AttachedResponder, action: { readonly kind: ActionKind; readonly tool?: string | null | undefined }): boolean {
  switch (action.kind) {
    case "tool":
      // A person can approve a prompt but cannot run an application's function.
      return responder.kind === "sdk" && !!action.tool && responder.tools.includes(action.tool);
    case "permission":
      return responder.kind === "cli" || responder.requestPermission;
    case "elicitation":
      return responder.kind === "cli" || responder.requestElicitation;
    default:
      return false;
  }
}

/**
 * Preference order (shared with core's fallback): the creating connection, then the others by attach time. An
 * attached person answers prompts only when no application handler is attached, except prompts that managed policy
 * reserves for a person: an attached Copilot CLI gets those first.
 */
function chooseOwner(eligible: readonly AttachedResponder[], kind: ActionKind, personRequired = false): AttachedResponder | undefined {
  const person = kind === "tool" ? undefined : eligible.find((responder) => responder.kind === "cli");
  if (personRequired && person) return person;
  return eligible.find((responder) => responder.kind === "sdk") ?? person;
}

/** Prompt kinds whose derived `promptRequest` decides whether a person is still required (stock SDK guidance). */
const STANDARD_PROMPT_KINDS: ReadonlySet<string> = new Set(["commands", "read", "write", "url", "workflow"]);
const marked = (value: unknown) => value !== undefined && value !== false;

/**
 * Whether managed policy requires a person to answer a permission prompt (`managedApprovalRequired`, read the way the
 * stock SDK documents it: the derived `promptRequest` decides for standard prompt kinds, the raw request otherwise).
 * A prompt known only from its derived form, without the raw request, always needs a person, whatever its kind: the
 * derived form alone cannot prove that no person is required.
 */
export function needsPerson(data: Record<string, unknown> | undefined): boolean {
  const raw = data?.permissionRequest as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return true;
  const prompt = data?.promptRequest as Record<string, unknown> | undefined;
  if (prompt && typeof prompt.kind === "string" && STANDARD_PROMPT_KINDS.has(prompt.kind)) return marked(prompt.managedApprovalRequired);
  return marked(raw.managedApprovalRequired);
}

/** Who answers a permission prompt: a webhook capability (application policy), the owner's poller or client, or a person at an attached CLI. */
type DecisionResponder = "webhook" | "poll" | "live" | "cli";
const ONE_SHOT_APPROVALS: ReadonlySet<string> = new Set(["approve-once", "approved"]);
/** Approvals that also change what the session may do later, without asking again. */
const STANDING_APPROVALS: ReadonlySet<string> = new Set([
  "approve-for-session",
  "approve-read-only-for-session",
  "approve-for-location",
  "approve-permanently",
  "approved-for-session",
  "approved-for-location",
]);
const DENIALS: ReadonlySet<string> = new Set([
  "reject",
  "user-not-available",
  "denied-interactively-by-user",
  "denied-by-rules",
  "denied-no-approval-rule-and-could-not-request-from-user",
  "denied-by-content-exclusion-policy",
  "denied-by-permission-request-hook",
  "cancelled",
]);
/** All a webhook capability may decide: it is application policy, never a person and never a change of policy. */
const CAPABILITY_DECISIONS: ReadonlySet<string> = new Set(["approve-once", "reject", "user-not-available"]);

/**
 * Checks a permission decision against who answers and what the prompt requires; returns why it is refused.
 * - Only the owner's own paths may say a person decided (`approvedInteractively`, `denied-interactively-by-user`).
 * - A webhook capability approves once, rejects, or reports that nobody is available; it never grants standing
 *   approvals or answers for a person.
 * - A prompt that managed policy reserves for a person accepts an approval only from an attached Copilot CLI, or from
 *   the owner's client or poller attesting that a person approved it (`approvedInteractively: true`).
 */
export function permissionDecisionProblem(decision: Record<string, unknown>, responder: DecisionResponder, personRequired: boolean): string | undefined {
  const kind = String(decision.kind);
  const approval = ONE_SHOT_APPROVALS.has(kind) || STANDING_APPROVALS.has(kind);
  if (!approval && !DENIALS.has(kind)) return `"${kind}" is not a permission decision`;
  if (responder === "webhook") {
    if (decision.approvedInteractively === true || kind === "denied-interactively-by-user") return "A webhook cannot answer on a person's behalf";
    if (!CAPABILITY_DECISIONS.has(kind)) return `A webhook can approve this request once, reject it, or report that nobody is available; "${kind}" needs the session's owner`;
  }
  if (personRequired && approval && responder !== "cli") {
    // Away from an attached CLI, only the owner's client or poller may attest that a person approved this one request.
    const attested = responder !== "webhook" && kind === "approve-once" && decision.approvedInteractively === true;
    if (!attested) return "Managed policy requires a person to approve this request; reject it, or leave it for a person to answer";
  }
  return undefined;
}

/** Mirrors the stock SDK: nullish → "", strings and `ToolResultObject`s unchanged, anything else JSON-encoded. */
export function normalizeToolResult(value: unknown): unknown {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (isToolResultObject(value)) return value;
  return JSON.stringify(value);
}

function isToolResultObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.textResultForLlm === "string" && typeof candidate.resultType === "string" && TOOL_RESULT_TYPES.has(candidate.resultType);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ManagedCopilotError("timeout", `${what} did not answer within ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class DurableActions implements ActionsService {
  readonly #store: ActionStore;
  readonly #deps: ActionsDeps;
  readonly #log: Logger;
  readonly #options: ActionsOptions;
  readonly #now: () => number;
  readonly #notifyTimers = new Map<string, NodeJS.Timeout>();
  readonly #forwarding = new Map<string, Promise<unknown>>();
  readonly #listeners = new Set<(change: ActionChange) => void>();
  /** Detach counters per connection and per connection+session (bounded); fence attaches that raced a detach. */
  readonly #detachGenerations = new Map<string, number>();
  /**
   * Latest placement generation the ledger applied per session incarnation (bounded). Updated synchronously by
   * `onGenerationChanged`, so work that awaited across a move can tell before it changes anything.
   */
  readonly #placements = new Map<string, number>();
  /** `promptVisibility` calls waiting for core's event stream to record a request, per session. */
  readonly #recordWaiters = new Map<string, Set<() => void>>();
  /** Platform tool calls running in this process, by action ID, with the claim they run under. */
  readonly #running = new Map<string, { readonly seq: number; readonly controller: AbortController }>();
  #stopping = false;
  #sweeper: NodeJS.Timeout | undefined;
  #sweeping = false;

  constructor(deps: ActionsDeps) {
    this.#deps = deps;
    this.#store = new ActionStore(deps.db);
    this.#log = deps.log;
    this.#options = { ...DEFAULT_ACTIONS_OPTIONS, ...deps.options };
    this.#now = deps.now ?? Date.now;
  }

  get store(): ActionStore {
    return this.#store;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------------------

  /** Recovers claims orphaned by a restart, then starts the lease/deadline/forwarding sweeper. */
  start(): void {
    this.assignIncarnations();
    this.recover();
    if (this.#options.sweepIntervalMs > 0) {
      this.#sweeper = setInterval(() => void this.sweep(), this.#options.sweepIntervalMs);
      this.#sweeper.unref?.();
    }
  }

  /**
   * Startup repair of incarnations. Actions recorded before incarnations existed join their session's current
   * incarnation if they are that owner's and not older than it, and the rest are retired. Actions recorded under a
   * provisional incarnation (the session's creation time, before core reported real ones) are re-keyed. Actions of
   * an incarnation that no longer exists are closed as deleted: a deletion the ledger could not observe (a crash, or
   * one core finished at startup).
   */
  assignIncarnations(): void {
    const sessions = this.#deps.sessions();
    if (!sessions) return;
    for (const sessionId of this.#store.sessionsWithoutIncarnation()) {
      const current = this.#current(sessionId);
      const createdAtMs = current?.view.createdAt ? Date.parse(current.view.createdAt) : undefined;
      this.#store.assignIncarnation(
        sessionId,
        current ? { incarnation: current.incarnation, ownerId: current.view.ownerId, ...(Number.isFinite(createdAtMs) ? { createdAtMs: createdAtMs! } : {}) } : undefined,
      );
    }
    for (const { session_id: sessionId, incarnation } of this.#store.provisionalIncarnations()) {
      const current = this.#current(sessionId);
      if (current?.view.incarnation && current.view.createdAt && incarnation === incarnationOf({ createdAt: current.view.createdAt })) {
        this.#store.rekeyIncarnation(sessionId, incarnation, current.incarnation);
      }
    }
    for (const { session_id: sessionId, incarnation } of this.#store.liveIncarnations()) {
      if (this.#current(sessionId)?.incarnation !== incarnation) this.onSessionDeleted(sessionId, incarnation);
    }
  }

  stop(): void {
    this.#stopping = true;
    for (const { controller } of this.#running.values()) controller.abort(SHUTTING_DOWN());
    this.#running.clear();
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = undefined;
    for (const timer of this.#notifyTimers.values()) clearTimeout(timer);
    this.#notifyTimers.clear();
  }

  onChange(listener: (change: ActionChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * After a restart no live connection survives. A tool a client may have been running becomes uncertain; prompts
   * (no external effect) return to `pending`. Gateway-executed platform tools are idempotent by key and run again,
   * except tools registered with `replay: "never"`: their `recover` hook answers, or the call fails as "may have run".
   */
  recover(): void {
    const now = this.#now();
    for (const row of this.#store.listLiveClaims()) this.#orphan(row, "The gateway restarted while a client was handling this action", now);
    for (const row of this.#store.listOwnedBy("platform")) {
      if (this.#store.transition(row.id, { states: OWNED_STATES, seq: row.claim_seq }, { state: "pending", clearClaim: true, now })) {
        const latest = this.#store.get(row.id);
        const definition = latest?.tool ? this.#deps.platformTools()?.get?.(latest.tool) : undefined;
        if (latest && definition) this.#startPlatformTool(latest, definition, "The gateway restarted");
      }
    }
    this.#announceUnnotified(now);
  }

  /** Pending actions whose `session.action_required` never went out (a crash inside the debounce window). */
  #announceUnnotified(now: number, olderThanMs = 0): void {
    for (const row of this.#store.listUnnotifiedPending(now - olderThanMs)) {
      if (row.kind === "tool" && row.tool && this.#deps.platformTools()?.get?.(row.tool)) continue;
      // Only the session's current incarnation is ever announced (older ones are closed at startup).
      if (this.#current(row.session_id)?.incarnation !== row.incarnation) continue;
      if (!this.#notifyTimers.has(row.session_id)) this.#scheduleNotify(row);
    }
  }

  /** The session's current incarnation as core records it; undefined once it is being deleted or gone. */
  #current(sessionId: string): { readonly view: DurableSessionView; readonly incarnation: string } | undefined {
    const view = this.#deps.sessions()?.get(sessionId);
    if (!view || isGone(view)) return undefined;
    return { view, incarnation: incarnationOf(view) };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Router hooks (core)
  // ---------------------------------------------------------------------------------------------------------

  async onSessionEvent(input: SessionEventInput): Promise<SessionEventDecision> {
    const { event } = input;
    const completionKind = COMPLETION_KIND[event.type];
    if (completionKind) return this.#onCompletion(input, completionKind);
    if (!EXECUTION_TYPES.has(event.type)) return { withhold: [] };
    try {
      return this.#arbitrate(input);
    } finally {
      // Recorded and arbitrated: attach can now tell its CLI whether the prompt is answerable (`promptVisibility`).
      this.#signalRecorded(input.sessionId);
    }
  }

  /** Records an execution-bearing request and decides who may execute it (claim before emission). Synchronous. */
  #arbitrate(input: SessionEventInput): SessionEventDecision {
    const { event } = input;
    const parsed = parseExecutionEvent(event);
    if (!parsed) return { withhold: [] };
    // Only the session's current incarnation records actions: a deleted (or replaced) session's requests can never be
    // answered, so nothing is recorded and nobody may execute them.
    const current = this.#current(input.sessionId);
    if (!current || (input.incarnation !== undefined && input.incarnation !== current.incarnation)) {
      return { withhold: input.attached.map((responder) => responder.connectionId) };
    }
    const incarnation = current.incarnation;

    const now = this.#now();
    // A runtime that restarted without suspending rebuilds a waiting call with a new request ID but the same tool call:
    // it is the same action, never a second one to execute.
    const known = this.#store.findByRequest(input.sessionId, incarnation, parsed.kind, parsed.requestId);
    const rebound =
      !known && parsed.kind === "tool" && parsed.toolCallId ? this.#rebind(input.sessionId, incarnation, parsed.toolCallId, parsed.requestId, event, input.generation, now) : undefined;
    const existing = known ?? rebound;
    // The runtime asked again with the full request for a prompt recorded from its pending list alone: keep it.
    if (known && lacksRawRequest(known) && event.type === "permission.requested" && event.data?.permissionRequest !== undefined) {
      this.#store.updateEvent(known.id, event);
    }
    const { row, created } = existing
      ? { row: this.#store.get(existing.id) ?? existing, created: false }
      : this.#store.insertIfAbsent({
          id: newId("act"),
          sessionId: input.sessionId,
          incarnation,
          ownerId: input.ownerId,
          environment: input.environment,
          kind: parsed.kind,
          requestId: parsed.requestId,
          toolCallId: parsed.toolCallId,
          tool: parsed.tool,
          providerId: parsed.providerId,
          agentId: event.agentId,
          arguments: parsed.arguments,
          event,
          generation: input.generation,
          idempotencyKey: idempotencyKeyFor(input.sessionId, parsed),
          deadlineAt: now + this.#options.answerTimeoutMs,
          now,
        });
    if (row.incarnation !== incarnation) {
      // A reused session ID whose runtime also reused a request ID: fail closed rather than mix the two sessions.
      this.#log.error("A runtime request ID collides with an earlier session's action; nobody will execute it", { sessionId: input.sessionId, requestId: parsed.requestId });
      return { withhold: input.attached.map((responder) => responder.connectionId) };
    }
    if (created) this.#log.debug("Action recorded", { actionId: row.id, sessionId: row.session_id, kind: row.kind, tool: row.tool ?? undefined });

    const eligible = input.attached.filter((responder) => isEligible(responder, parsed));
    const everyEligible = eligible.map((responder) => responder.connectionId);
    // A late observation from an older placement (the action has since moved): it changes nothing and runs nowhere.
    if (row.generation > input.generation) return { actionId: row.id, withhold: everyEligible };
    if (row.state !== "pending") {
      // Re-emission of an action that already has an owner or an outcome: nobody else may execute it.
      if (ANSWERED_STATES.includes(row.state)) {
        // A newer placement asking for a request answered under an older one (carried across promotion) gets the
        // recorded answer.
        if (row.generation < input.generation) this.#adoptAnswered(row, input.generation, now);
        else if (!row.forwarded) void this.#forward(row.id).catch(() => undefined);
      }
      return { actionId: row.id, withhold: everyEligible };
    }

    const platformTool = parsed.kind === "tool" && parsed.tool ? this.#deps.platformTools()?.get?.(parsed.tool) : undefined;
    if (platformTool) {
      this.#startPlatformTool(row, platformTool);
      return { actionId: row.id, withhold: everyEligible };
    }

    const owner = chooseOwner(
      eligible.filter((responder) => !heldBefore(row, responder.connectionId)),
      parsed.kind,
      parsed.kind === "permission" && needsPerson(event.data),
    );
    if (owner) {
      const claimToken = this.#claimLive(row, owner);
      if (claimToken) {
        return { actionId: row.id, owner: owner.connectionId, claimToken, withhold: everyEligible.filter((id) => id !== owner.connectionId) };
      }
      return { actionId: row.id, withhold: everyEligible };
    }

    // Nobody attached can answer: the action waits durably for a webhook worker, a poller, or a client that resumes.
    this.#scheduleNotify(row);
    return { actionId: row.id, withhold: everyEligible };
  }

  async onClientAnswer(input: ClientAnswerInput): Promise<ClientAnswerDecision> {
    const kind = METHOD_KIND[input.method];
    const requestId = str(input.params.requestId);
    const strict = input.requireRecorded === true;
    if (!kind || !requestId) {
      if (strict) throw new ManagedCopilotError("invalid_request", "An answer needs a known answer method and its requestId");
      return { kind: "forward" };
    }
    // A person can approve a prompt but cannot supply an application's tool result.
    if (kind === "tool" && input.responderKind === "cli") throw new ManagedCopilotError("forbidden", "A person cannot run an application's tool; only its app can answer it");
    const current = this.#current(input.sessionId)?.incarnation;
    // An answer for a session that no longer exists, or that its ID no longer names, never reaches a runtime.
    if (current === undefined || (input.incarnation !== undefined && input.incarnation !== current)) throw conflict("This answer is for a session that no longer exists");
    const incarnation = input.incarnation ?? current;
    const row = this.#store.findByRequest(input.sessionId, incarnation, kind, requestId);
    if (!row) {
      // The ledger does not track it. A stock client's answer goes to the runtime as usual; attach fails closed.
      if (strict) throw conflict("This prompt is not waiting for this client");
      return { kind: "forward" };
    }
    if (input.generation !== undefined && input.generation !== row.generation) {
      throw conflict("This answer is for the session's previous placement; the request was offered again", row);
    }

    const outcome = this.#outcomeFromLiveAnswer(kind, input.params);
    const responderType = input.responderKind === "cli" ? "cli" : "live";
    if (row.state === "completed" || row.state === "failed") {
      if (row.result_hash === outcome.resultHash) return { kind: "respond", response: { success: true } };
      throw conflict("This action already has a different recorded answer", row);
    }
    if (row.state === "expired" || row.state === "cancelled") throw conflict(`This action was ${row.state}${row.reason ? `: ${row.reason}` : ""}`, row);
    if (kind === "permission") {
      const problem = permissionDecisionProblem((outcome.result ?? {}) as Record<string, unknown>, responderType, needsPerson(eventData(row)));
      if (problem) throw new ManagedCopilotError("forbidden", problem, { actionId: row.id });
    }

    let seq = row.claim_seq;
    if (row.state === "pending") {
      // A client answering an action it was not offered (for example from `listPendingRequests`) takes it if eligible;
      // attach answers only what its CLI holds (it claims through `promptVisibility` first).
      if (strict) throw conflict("This prompt is not held by this client; it was offered again", row);
      if (heldBefore(row, input.connectionId)) {
        throw conflict("This answer is for the session's previous placement; the request was offered again", row);
      }
      const claimed = this.#store.claim(
        row.id,
        { states: ["pending"], seq },
        {
          state: "executing",
          tokenHash: hashSecret(newId("mct", 24)),
          claimedBy: `${responderType}:${input.connectionId}`,
          responderType,
          liveConnection: input.connectionId,
          leaseExpiresAt: null,
          liveClaimants: withLiveClaimant(row, input.connectionId, row.generation),
          now: this.#now(),
        },
      );
      if (!claimed) throw conflict("Another responder took this action first", this.#store.get(row.id));
      seq += 1;
    } else if (row.live_connection !== input.connectionId) {
      throw conflict("Another responder owns this action", row);
    }

    if (!this.#store.complete(row.id, { seq, liveConnection: input.connectionId }, outcome)) {
      const latest = this.#store.get(row.id);
      if (latest && (latest.state === "completed" || latest.state === "failed") && latest.result_hash === outcome.resultHash) {
        return { kind: "respond", response: { success: true } };
      }
      throw conflict("This action changed while the answer was being recorded", latest);
    }
    this.#emit({ type: "resolved", sessionId: row.session_id, actionId: row.id });
    try {
      return { kind: "respond", response: await this.#forward(row.id) };
    } catch {
      // The answer is recorded and delivery is retried. Failing the client here would make the stock SDK send a
      // fallback answer (user-not-available / cancel) that conflicts with the one already recorded.
      return { kind: "respond", response: { success: true } };
    }
  }

  async onAttached(input: AttachInput): Promise<readonly RuntimeSessionEvent[]> {
    const detached = this.#detachedSince(input.responder.connectionId, input.sessionId);
    const attached = this.#current(input.sessionId);
    if (!attached || (input.incarnation !== undefined && input.incarnation !== attached.incarnation)) return [];
    try {
      await this.reconcile(input.sessionId);
    } catch (error) {
      this.#log.debug("Reconciliation on attach skipped", { sessionId: input.sessionId, error: (error as Error).message });
    }
    // The connection (or just this attachment) may have gone away while reconciling: never claim for it then.
    // A later attach of the same connection captures the new generation and replays normally.
    if (detached()) return [];
    // Nor for a session that was deleted (or replaced by a new one with the same ID) meanwhile.
    if (this.#current(input.sessionId)?.incarnation !== attached.incarnation) return [];
    const replay: RuntimeSessionEvent[] = [];
    for (const row of this.#store.listBySession(input.sessionId, attached.incarnation, ["pending"])) {
      if (!isEligible(input.responder, { kind: row.kind, tool: row.tool })) continue;
      if (row.kind === "tool" && row.tool && this.#deps.platformTools()?.get?.(row.tool)) continue;
      if (input.responder.kind === "sdk" && lacksRawRequest(row)) continue;
      if (heldBefore(row, input.responder.connectionId)) continue;
      if (this.#claimLive(row, input.responder)) {
        const event = parseJson<RuntimeSessionEvent>(row.event);
        if (event) replay.push(event);
      }
    }
    if (replay.length > 0) this.#log.info("Replaying waiting actions to a resumed client", { sessionId: input.sessionId, count: replay.length });
    return replay;
  }

  onDetached(connectionId: string, sessionId?: string): void {
    this.#bumpDetachGeneration(sessionId === undefined ? connectionId : `${connectionId}\u0000${sessionId}`);
    const now = this.#now();
    for (const row of this.#store.listByLiveConnection(connectionId)) {
      if (sessionId !== undefined && row.session_id !== sessionId) continue;
      this.#orphan(row, "The client handling this action disconnected before it answered", now);
    }
  }

  #bumpDetachGeneration(key: string): void {
    const next = (this.#detachGenerations.get(key) ?? 0) + 1;
    // Re-inserted so the oldest counters are the ones evicted.
    this.#detachGenerations.delete(key);
    this.#detachGenerations.set(key, next);
    if (this.#detachGenerations.size > MAX_REMEMBERED) this.#detachGenerations.delete(this.#detachGenerations.keys().next().value!);
  }

  /** Snapshots a connection's detach counters; the returned check is true once it (or this attachment) detached since. */
  #detachedSince(connectionId: string, sessionId: string): () => boolean {
    const connectionKey = connectionId;
    const attachmentKey = `${connectionId}\u0000${sessionId}`;
    const before = [this.#detachGenerations.get(connectionKey) ?? 0, this.#detachGenerations.get(attachmentKey) ?? 0];
    return () => (this.#detachGenerations.get(connectionKey) ?? 0) !== before[0] || (this.#detachGenerations.get(attachmentKey) ?? 0) !== before[1];
  }

  /**
   * The session was deleted: its open actions can never be answered. They are cancelled (later claims and results
   * are refused) and recorded answers that were never delivered stop being retried. Only the deleted incarnation is
   * affected: a session that later reuses the ID records its own actions.
   */
  onSessionDeleted(sessionId: string, incarnation?: string): void {
    const now = this.#now();
    const current = this.#current(sessionId)?.incarnation;
    const deleted = (row: ActionRow) => (incarnation !== undefined ? row.incarnation === incarnation : row.incarnation !== current);
    for (const row of this.#store.listByAnyIncarnation(sessionId, OPEN_STATES)) {
      if (!deleted(row)) continue;
      if (this.#store.transition(row.id, { states: OPEN_STATES, seq: row.claim_seq }, { state: "cancelled", reason: "The session was deleted", clearClaim: true, forwarded: true, now })) {
        this.#emit({ type: "resolved", sessionId, actionId: row.id });
      }
    }
    for (const row of this.#store.listByAnyIncarnation(sessionId, ANSWERED_STATES)) {
      if (deleted(row) && !row.forwarded) this.#store.markForwarded(row.id, now, "Not delivered: the session was deleted");
    }
    if (current === undefined) {
      const timer = this.#notifyTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      this.#notifyTimers.delete(sessionId);
    }
  }

  /**
   * The session moved to a new placement generation (promotion). Idempotent: actions already at `generation` or
   * newer are untouched. Waiting actions move with the session. Carried actions (the new placement still waits for
   * their request) and the gateway's own platform tools keep their claims. Every other claim from the old placement
   * is void, including the standing claim of an uncertain tool's original claimant, so its late results are refused;
   * tools that may have run need a reconcile claim, and prompts are offered again. Live connections that held an
   * action only under an older placement are never offered it again (see `heldBefore`).
   */
  onGenerationChanged(sessionId: string, generation: number, options: GenerationChangeOptions = {}): void {
    const current = this.#current(sessionId);
    if (!current) return;
    const now = this.#now();
    const carried = new Set(options.carried ?? []);
    const epochKey = `${sessionId}\u0000${current.incarnation}`;
    if ((this.#placements.get(epochKey) ?? -1) < generation) {
      this.#placements.delete(epochKey);
      this.#placements.set(epochKey, generation);
      if (this.#placements.size > MAX_REMEMBERED) this.#placements.delete(this.#placements.keys().next().value!);
    }
    for (const row of this.#store.listBySession(sessionId, current.incarnation, OPEN_STATES)) {
      if (row.generation >= generation) continue;
      const owned = OWNED_STATES.includes(row.state);
      if (row.state === "pending" || carried.has(runtimeRequestId(row)) || (owned && row.responder_type === "platform")) {
        // A live claim carried into the new placement is held there.
        const liveClaimants = owned && row.live_connection ? withLiveClaimant(row, row.live_connection, generation) : undefined;
        this.#store.moveToGeneration(row.id, row.claim_seq, { generation, state: row.state, clearClaim: false, reason: row.reason, ...(liveClaimants ? { liveClaimants } : {}), now });
        continue;
      }
      const state: ActionState = row.kind === "tool" ? "needs_reconciliation" : "pending";
      const reason = row.kind !== "tool" ? null : owned ? MOVED_WHILE_RUNNING : row.reason;
      if (!this.#store.moveToGeneration(row.id, row.claim_seq, { generation, state, clearClaim: true, reason, now })) continue;
      if (state === "pending") {
        this.#scheduleNotify(row);
      } else if (owned) {
        this.#log.warn("Action needs reconciliation", { actionId: row.id, sessionId, tool: row.tool ?? undefined, reason: "the session moved to a new placement" });
        this.#emit({ type: "pending", sessionId, actionId: row.id });
      }
    }
    // Recorded answers for carried requests go to the new placement, even ones the old placement acknowledged: the
    // new one still waits for them.
    for (const row of this.#store.listBySession(sessionId, current.incarnation, ANSWERED_STATES)) {
      if (carried.has(runtimeRequestId(row))) this.#adoptAnswered(row, generation, now);
    }
  }

  /** A newer placement waits for a request answered under an older one: the recorded answer goes to it. */
  #adoptAnswered(row: ActionRow, generation: number, now: number): void {
    if (row.generation >= generation || !ANSWERED_STATES.includes(row.state)) return;
    if (!this.#store.adoptAnswer(row.id, row.generation, generation, now)) return;
    this.#log.info("Delivering a recorded answer to the session's new placement", { actionId: row.id, sessionId: row.session_id, generation });
    void this.#forward(row.id).catch(() => undefined);
  }

  releaseLiveClaim(actionId: string, claimToken: string): void {
    const row = this.#store.get(actionId);
    if (!row || row.claim_token_hash !== hashSecret(claimToken)) return;
    // The router never wrote the event, so no handler ran: the action is safely offered again.
    if (this.#store.transition(row.id, { states: OWNED_STATES, seq: row.claim_seq }, { state: "pending", clearClaim: true, now: this.#now() })) {
      this.#scheduleNotify(row);
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // REST and service API
  // ---------------------------------------------------------------------------------------------------------

  list(sessionId: string, options: { readonly open?: boolean; readonly incarnation?: string } = {}): PendingAction[] {
    const incarnation = options.incarnation ?? this.#current(sessionId)?.incarnation;
    if (incarnation === undefined) return [];
    return this.#store.listBySession(sessionId, incarnation, options.open ? OPEN_STATES : undefined).map(toPendingAction);
  }

  /**
   * Actions of every owner for the operator console, newest first: metadata only (never arguments, payloads,
   * results, or claim tokens). `state`: `open` (default), `attention` (needs reconciliation), `all`, or one state.
   */
  operatorActions(query: { readonly state?: string; readonly sessionId?: string; readonly incarnation?: string; readonly limit?: number } = {}): ActionOperatorRecord[] {
    const state = query.state ?? "open";
    const states: readonly ActionState[] | undefined = state === "open" ? OPEN_STATES : state === "attention" ? ["needs_reconciliation"] : state === "all" ? undefined : [state as ActionState];
    return this.#store
      .listForOperator({
        ...(states ? { states } : {}),
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
        ...(query.incarnation ? { incarnation: query.incarnation } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      })
      .map(toOperatorRecord);
  }

  operatorActionCounts(): Partial<Record<ActionState, number>> {
    return this.#store.countByState();
  }

  /**
   * True while the session's runtime may still wait on something the ledger owns: an action that is pending,
   * executing, or uncertain, or an answer recorded but not delivered yet. A runtime that resumes such a session
   * should continue its pending work (`continuePendingWork: true`) rather than treat it as interrupted.
   */
  hasOpenActions(sessionId: string, options: { readonly incarnation?: string } = {}): boolean {
    const incarnation = options.incarnation ?? this.#current(sessionId)?.incarnation;
    if (incarnation === undefined) return false;
    return this.#store.hasOpenWork(sessionId, incarnation);
  }

  async listFor(caller: ActionCaller, sessionId: string, options: { readonly open?: boolean } = {}): Promise<PendingAction[]> {
    const incarnation = this.#authorize(caller, sessionId);
    // A capability for a session that no longer exists covers nothing.
    if (incarnation === undefined) return [];
    const actions = this.list(sessionId, { ...options, incarnation });
    if (caller.type === "capability") return actions.filter((action) => caller.capability.actionIds.includes(action.id));
    return actions;
  }

  async claim(caller: ActionCaller, sessionId: string, actionId: string, options: ClaimOptions = {}): Promise<ActionClaim> {
    const row = this.#requireAction(sessionId, actionId, this.#authorize(caller, sessionId, actionId));
    const now = this.#now();
    const leaseMs = Math.min(
      this.#options.maxLeaseMs,
      Math.max(this.#options.minLeaseMs, options.leaseSeconds !== undefined ? Math.round(options.leaseSeconds * 1000) : this.#options.defaultLeaseMs),
    );

    if (options.claimToken !== undefined) {
      if (!this.#store.renew(row.id, row.claim_seq, hashSecret(options.claimToken), now + leaseMs, now)) {
        throw conflict("This claim is no longer valid; it expired, was released, or was superseded", row);
      }
      return { action: toPendingAction(this.#store.get(row.id)!), claimToken: options.claimToken, leaseExpiresAt: toIso(now + leaseMs)! };
    }

    const responderType = caller.type === "capability" ? "webhook" : "poll";
    if (row.kind === "elicitation" && caller.type === "capability") {
      throw new ManagedCopilotError("forbidden", "A webhook capability cannot answer a question meant for a person");
    }
    if (caller.type === "platform" && row.kind !== "permission") {
      throw new ManagedCopilotError("forbidden", `The platform answers only permission prompts on the owner's behalf, not ${row.kind} actions`);
    }
    const from: ActionState[] = row.state === "needs_reconciliation" && options.reconcile ? ["needs_reconciliation"] : ["pending"];
    if (!from.includes(row.state)) throw conflict(describeUnclaimable(row), row);
    if (row.kind === "tool" && row.tool && this.#deps.platformTools()?.get?.(row.tool)) {
      throw new ManagedCopilotError("forbidden", `${row.tool} is a platform tool; the gateway answers it`);
    }
    const label =
      caller.type === "capability"
        ? `webhook:${options.responder ?? caller.capability.webhook}`
        : caller.type === "platform"
          ? `platform:${caller.responder}`
          : `poll:${caller.principal.login}${options.responder ? `/${options.responder}` : ""}`;
    const claimToken = newId("mct", 24);
    const claimed = this.#store.claim(
      row.id,
      { states: from, seq: row.claim_seq },
      { state: "executing", tokenHash: hashSecret(claimToken), claimedBy: label, responderType, liveConnection: null, leaseExpiresAt: now + leaseMs, now },
    );
    if (!claimed) {
      const latest = this.#store.get(row.id)!;
      throw conflict(describeUnclaimable(latest), latest);
    }
    this.#log.info("Action claimed", { actionId: row.id, sessionId, kind: row.kind, tool: row.tool ?? undefined, responder: label });
    return { action: toPendingAction(this.#store.get(row.id)!), claimToken, leaseExpiresAt: toIso(now + leaseMs)! };
  }

  async submit(caller: ActionCaller, sessionId: string, actionId: string, request: ActionResultRequest): Promise<HandleActionResult> {
    const incarnation = this.#authorize(caller, sessionId, actionId);
    if (typeof request?.claimToken !== "string" || request.claimToken.length === 0) {
      throw new ManagedCopilotError("invalid_request", "claimToken is required; claim the action first");
    }
    const row = this.#requireAction(sessionId, actionId, incarnation);
    const tokenHash = hashSecret(request.claimToken);
    const now = this.#now();

    if (request.release) {
      if (row.claim_token_hash !== tokenHash || !OWNED_STATES.includes(row.state)) throw conflict("Only the current claim can be released", row);
      if (!this.#store.transition(row.id, { states: OWNED_STATES, seq: row.claim_seq }, { state: "pending", clearClaim: true, now })) {
        throw conflict("This action changed while the claim was being released", this.#store.get(row.id));
      }
      // Announce it again, except when the webhook worker it was announced to releases it: that handler could not
      // decide, and re-announcing to it would loop. A poller's release must reach webhooks that skipped it while held.
      if (caller.type === "capability" && row.notified_at !== null) this.#emit({ type: "pending", sessionId: row.session_id, actionId: row.id });
      else this.#scheduleNotify(row);
      return { actionId: row.id, state: "pending" };
    }

    if (row.state === "expired" || row.state === "cancelled") throw conflict(`This action was ${row.state}${row.reason ? `: ${row.reason}` : ""}`, row);
    if (caller.type === "platform") {
      const decision = request.result as { readonly kind?: unknown; readonly approvedInteractively?: unknown } | undefined;
      if (decision?.approvedInteractively === true || decision?.kind === "denied-interactively-by-user") {
        throw new ManagedCopilotError("forbidden", "The platform cannot answer on a person's behalf");
      }
    }
    // A claim taken with a capability stays a webhook's answer whoever submits it.
    const responder: DecisionResponder = caller.type === "capability" || row.responder_type === "webhook" ? "webhook" : "poll";
    const outcome = this.#outcomeFromSubmission(row, request, now, responder);
    if (row.state === "completed" || row.state === "failed") {
      if (row.claim_token_hash === tokenHash && row.result_hash === outcome.resultHash) return { actionId: row.id, state: row.state };
      throw conflict("This action already has a different recorded answer", row);
    }
    if (row.claim_token_hash !== tokenHash) throw conflict("This claim is no longer valid; it expired, was released, or was superseded", row);
    if (!this.#store.complete(row.id, { seq: row.claim_seq, tokenHash }, outcome)) {
      const latest = this.#store.get(row.id)!;
      if ((latest.state === "completed" || latest.state === "failed") && latest.claim_token_hash === tokenHash && latest.result_hash === outcome.resultHash) {
        return { actionId: row.id, state: latest.state };
      }
      throw conflict("This action changed while the answer was being recorded", latest);
    }
    this.#log.info("Action answered", { actionId: row.id, sessionId, kind: row.kind, state: outcome.state, responder: row.claimed_by ?? undefined });
    this.#emit({ type: "resolved", sessionId: row.session_id, actionId: row.id });
    try {
      await this.#forward(row.id);
    } catch {
      // The answer is recorded; delivery to the runtime is retried by the sweeper.
    }
    return { actionId: row.id, state: outcome.state };
  }

  verifyCapability(token: string): VerifiedCapability {
    return verifyCapabilityToken(this.#deps.capabilityKey, token, { audience: this.#deps.publicUrl, now: this.#now() });
  }

  mintCapability(sessionId: string, actionIds: readonly string[], webhook: string): ActionCapability | undefined {
    const current = this.#current(sessionId);
    if (!current) return undefined;
    const pending = actionIds.filter((id) => {
      const row = this.#store.get(id);
      return row !== undefined && row.session_id === sessionId && row.incarnation === current.incarnation && row.state === "pending";
    });
    if (pending.length === 0) return undefined;
    const expiresAt = this.#now() + this.#options.capabilityTtlMs;
    const token = mintCapabilityToken(this.#deps.capabilityKey, { sid: sessionId, inc: current.incarnation, aids: pending, aud: this.#deps.publicUrl, exp: expiresAt, wh: webhook });
    return { token, expiresAt: toIso(expiresAt)!, sessionId, actionIds: pending, audience: this.#deps.publicUrl };
  }

  /**
   * Compares the ledger with what the runtime still awaits: records tool calls and permission prompts the ledger
   * missed (for example ones emitted while the gateway was down), keeps one action per tool call when a restarted
   * runtime rebuilt it under a new request ID, and closes actions the runtime no longer waits for.
   */
  async reconcile(sessionId: string): Promise<void> {
    const sessions = this.#deps.sessions();
    const start = this.#current(sessionId);
    if (!sessions || !start) return;
    const { view, incarnation } = start;
    const timeout = this.#options.upstreamTimeoutMs;
    // Actions recorded after this point may not be in the lists yet; never close those.
    const listedAt = this.#now();
    // Fenced to the incarnation read above: a session that reused the ID answers nothing here.
    const fence = { incarnation };
    const [tools, permissions] = await Promise.all([
      withTimeout(sessions.request<{ items?: unknown[] }>(sessionId, PENDING_LIST_METHODS.tool, { sessionId }, fence), timeout, "The runtime").catch(() => undefined),
      withTimeout(sessions.request<{ items?: unknown[] }>(sessionId, PENDING_LIST_METHODS.permission, { sessionId }, fence), timeout, "The runtime").catch(() => undefined),
    ]);
    const toolItems = Array.isArray(tools?.items) ? (tools.items as Record<string, unknown>[]) : undefined;
    const permissionItems = Array.isArray(permissions?.items) ? (permissions.items as Record<string, unknown>[]) : undefined;
    // A prompt the runtime still waits for but the ledger never recorded keeps its full request (and with it the
    // authority it requires) from the session's history.
    const unrecorded = (permissionItems ?? []).filter((item) => {
      const requestId = str(item.requestId);
      return requestId !== undefined && !this.#store.findByRequest(sessionId, incarnation, "permission", requestId);
    });
    const history =
      unrecorded.length === 0
        ? undefined
        : await withTimeout(sessions.request<{ events?: unknown }>(sessionId, "session.getMessages", { sessionId }, fence), timeout, "The runtime")
            .then((result) => (Array.isArray(result?.events) ? (result.events as RuntimeSessionEvent[]) : undefined))
            .catch(() => undefined);
    // The lists describe the incarnation and placement asked. If the session was deleted, replaced, or moved
    // meanwhile, they are obsolete: never record, offer, or close anything from them. The ledger's own placement
    // epoch is checked last and synchronously, so a move applied while the re-read was pending is seen first.
    const current = this.#current(sessionId);
    if (!current || current.incarnation !== incarnation || current.view.generation !== view.generation) return;
    if ((this.#placements.get(`${sessionId}\u0000${incarnation}`) ?? view.generation) > view.generation) return;
    const now = this.#now();
    if (toolItems) {
      const waiting = new Set<string>();
      for (const item of toolItems) {
        const requestId = str(item.requestId);
        const toolName = str(item.toolName);
        if (!requestId || !toolName) continue;
        waiting.add(requestId);
        const toolCallId = str(item.toolCallId);
        const event: RuntimeSessionEvent = {
          id: newId("evt"),
          type: "external_tool.requested",
          timestamp: new Date(now).toISOString(),
          parentId: null,
          data: { requestId, sessionId, toolName, toolCallId: item.toolCallId, arguments: item.arguments, ...(item.providerId ? { providerId: item.providerId } : {}) },
          ...(str(item.agentId) ? { agentId: str(item.agentId)! } : {}),
        };
        const known = this.#store.findByRequest(sessionId, incarnation, "tool", requestId);
        if (known) {
          this.#adoptAnswered(known, view.generation, now);
          continue;
        }
        if (toolCallId && this.#rebind(sessionId, incarnation, toolCallId, requestId, event, view.generation, now)) continue;
        const { row, created } = this.#store.insertIfAbsent({
          id: newId("act"),
          sessionId,
          incarnation,
          ownerId: view.ownerId,
          environment: view.environment,
          kind: "tool",
          requestId,
          toolCallId,
          tool: toolName,
          providerId: str(item.providerId),
          agentId: str(item.agentId),
          arguments: item.arguments ?? {},
          event,
          generation: view.generation,
          idempotencyKey: idempotencyKeyFor(sessionId, { kind: "tool", toolCallId, requestId }),
          deadlineAt: now + this.#options.answerTimeoutMs,
          now,
        });
        if (row.incarnation !== incarnation || !created) continue;
        this.#log.info("Recorded a waiting tool call the ledger had not seen", { sessionId, actionId: row.id, tool: toolName });
        const platformTool = this.#deps.platformTools()?.get?.(toolName);
        if (platformTool) this.#startPlatformTool(row, platformTool);
        else this.#scheduleNotify(row);
      }
      this.#closeNotAwaited(sessionId, incarnation, "tool", waiting, listedAt, now, view.generation);
    }
    if (permissionItems) {
      const waiting = new Set<string>();
      for (const item of permissionItems) {
        const requestId = str(item.requestId);
        if (!requestId) continue;
        waiting.add(requestId);
        const known = this.#store.findByRequest(sessionId, incarnation, "permission", requestId);
        if (known) {
          this.#adoptAnswered(known, view.generation, now);
          continue;
        }
        const recorded = history?.find((event) => event?.type === "permission.requested" && event.data?.requestId === requestId);
        const event: RuntimeSessionEvent = recorded ?? {
          id: newId("evt"),
          type: "permission.requested",
          timestamp: new Date(now).toISOString(),
          parentId: null,
          // Only the derived prompt is known: without the raw request a person must answer it (see needsPerson).
          data: { requestId, ...(item.request !== undefined ? { promptRequest: item.request } : {}), ...(str(item.recoveryEpisodeId) ? { recoveryEpisodeId: item.recoveryEpisodeId } : {}) },
        };
        const parsed = parseExecutionEvent(event);
        if (!parsed) continue;
        const { row, created } = this.#store.insertIfAbsent({
          id: newId("act"),
          sessionId,
          incarnation,
          ownerId: view.ownerId,
          environment: view.environment,
          kind: "permission",
          requestId,
          toolCallId: parsed.toolCallId,
          tool: parsed.tool,
          agentId: event.agentId,
          event,
          generation: view.generation,
          idempotencyKey: idempotencyKeyFor(sessionId, parsed),
          deadlineAt: now + this.#options.answerTimeoutMs,
          now,
        });
        if (row.incarnation !== incarnation || !created) continue;
        this.#log.info("Recorded a waiting permission prompt the ledger had not seen", { sessionId, actionId: row.id, tool: row.tool ?? undefined, fromHistory: recorded !== undefined });
        this.#scheduleNotify(row);
      }
      this.#closeNotAwaited(sessionId, incarnation, "permission", waiting, listedAt, now, view.generation);
    }
    this.#signalRecorded(sessionId);
  }

  /**
   * Copilot CLI attach: whether a prompt the CLI saw on its raw runtime channel is answerable by that CLI. The raw
   * channel can run ahead of core's event stream, so this waits until the ledger recorded and arbitrated the request
   * (then reconciles once with the runtime); a request the ledger cannot account for is never answerable.
   */
  async promptVisibility(input: PromptVisibilityInput): Promise<PromptVisibility> {
    const { responder } = input;
    if (responder.kind !== "cli") return { status: "hidden", reason: "Only an attached Copilot CLI answers prompts this way" };
    if (input.kind === "tool") return { status: "hidden", reason: "A person cannot run an application's tool; only its app can answer it" };
    const stale = (): PromptVisibility | undefined => {
      const current = this.#current(input.sessionId);
      if (!current || current.incarnation !== input.incarnation) return { status: "hidden", reason: "The session this client is attached to no longer exists" };
      if (current.view.generation !== input.generation) return { status: "hidden", reason: "The session moved to another placement; reattach to answer its prompts" };
      return undefined;
    };
    const early = stale();
    if (early) return early;
    // A CLI that detaches while this waits must not be handed the prompt afterwards.
    const detached = this.#detachedSince(responder.connectionId, input.sessionId);
    let row = await this.#waitForRequest(input.sessionId, input.incarnation, input.kind, input.requestId, input.waitMs ?? 5_000);
    if (!row) {
      // Core may have missed the event (for example around a reconnect): the runtime's pending lists decide.
      await this.reconcile(input.sessionId).catch(() => undefined);
      row = this.#store.findByRequest(input.sessionId, input.incarnation, input.kind, input.requestId);
    }
    // From here on everything is synchronous: these checks hold through the claim below.
    const late = stale();
    if (late) return late;
    if (detached()) return { status: "hidden", reason: "This client detached from the session; reattach to answer its prompts" };
    if (!row) return { status: "hidden", reason: "The ledger has no record of this request, so it cannot be answered here" };
    if (row.generation !== input.generation) return { status: "hidden", reason: "This request belongs to another placement of the session" };
    if (!isEligible(responder, { kind: row.kind, tool: row.tool })) return { status: "hidden", reason: "This client cannot answer this kind of request" };
    if (row.state === "pending" && !heldBefore(row, responder.connectionId)) {
      // Waiting for any responder: the person who is here takes it (the same compare-and-set every responder uses).
      this.#claimLive(row, responder);
      row = this.#store.get(row.id)!;
    }
    if (OWNED_STATES.includes(row.state) && row.live_connection === responder.connectionId) return { status: "actionable", actionId: row.id };
    if (OPEN_STATES.includes(row.state)) {
      return { status: "observe", actionId: row.id, state: row.state, ...(row.claimed_by && OWNED_STATES.includes(row.state) ? { claimedBy: row.claimed_by } : {}) };
    }
    return { status: "hidden", reason: `This request was already ${row.state === "completed" || row.state === "failed" ? "answered" : row.state}` };
  }

  /** Resolves once the ledger has the request, or after `waitMs` without it (real time: it waits for core's events). */
  async #waitForRequest(sessionId: string, incarnation: string, kind: ActionKind, requestId: string, waitMs: number): Promise<ActionRow | undefined> {
    const deadline = Date.now() + Math.max(0, waitMs);
    for (;;) {
      const row = this.#store.findByRequest(sessionId, incarnation, kind, requestId);
      if (row) return row;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await new Promise<void>((resolve) => {
        const waiters = this.#recordWaiters.get(sessionId) ?? new Set<() => void>();
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          if (waiters.size === 0 && this.#recordWaiters.get(sessionId) === waiters) this.#recordWaiters.delete(sessionId);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        timer.unref?.();
        waiters.add(done);
        this.#recordWaiters.set(sessionId, waiters);
      });
    }
  }

  /** Wakes `promptVisibility` calls waiting for this session's requests to be recorded. */
  #signalRecorded(sessionId: string): void {
    const waiters = this.#recordWaiters.get(sessionId);
    if (!waiters) return;
    this.#recordWaiters.delete(sessionId);
    for (const wake of [...waiters]) wake();
  }

  /** One sweep: lease expiry, answer deadlines, and retrying answers the runtime has not acknowledged. */
  async sweep(): Promise<void> {
    if (this.#sweeping) return;
    this.#sweeping = true;
    try {
      const now = this.#now();
      for (const row of this.#store.listLeaseExpired(now)) this.#orphan(row, "The responder's lease expired before it reported a result", now);
      for (const row of this.#store.listPastDeadline(now)) {
        const reason =
          row.state === "executing" || row.state === "claimed" || row.state === "needs_reconciliation"
            ? "The answer deadline passed while the action's outcome was unknown; it may have run"
            : "No eligible responder answered before the deadline";
        if (this.#store.transition(row.id, { states: OPEN_STATES, seq: row.claim_seq }, { state: "expired", reason, forwarded: false, now })) {
          this.#log.warn("Action expired", { actionId: row.id, sessionId: row.session_id, kind: row.kind, tool: row.tool ?? undefined });
          this.#emit({ type: "resolved", sessionId: row.session_id, actionId: row.id });
        }
      }
      for (const row of this.#store.listUnforwarded(now)) {
        if (row.forward_attempts >= this.#options.maxForwardAttempts) {
          this.#store.markForwarded(row.id, now, "The answer was recorded but could not be delivered to the runtime", {
            generation: row.generation,
            requestId: runtimeRequestId(row),
          });
          continue;
        }
        void this.#forward(row.id).catch(() => undefined);
      }
      this.#announceUnnotified(now, ANNOUNCE_REPAIR_AFTER_MS);
    } finally {
      this.#sweeping = false;
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------------------

  #claimLive(row: ActionRow, responder: AttachedResponder): string | undefined {
    const claimToken = newId("mct", 24);
    const responderType = responder.kind === "cli" ? "cli" : "live";
    const claimed = this.#store.claim(
      row.id,
      { states: ["pending"], seq: row.claim_seq },
      {
        state: "executing",
        tokenHash: hashSecret(claimToken),
        claimedBy: `${responderType}:${responder.connectionId}`,
        responderType,
        liveConnection: responder.connectionId,
        leaseExpiresAt: null,
        liveClaimants: withLiveClaimant(row, responder.connectionId, row.generation),
        now: this.#now(),
      },
    );
    return claimed ? claimToken : undefined;
  }

  /** The owner went away without answering. Tools may have run; prompts have no external effect and are offered again. */
  #orphan(row: ActionRow, why: string, now: number): void {
    if (row.kind === "tool") {
      const reason = `${why}; the tool may have run. Check its effect with the idempotency key, then answer it with a reconcile claim.`;
      if (this.#store.transition(row.id, { states: OWNED_STATES, seq: row.claim_seq }, { state: "needs_reconciliation", reason, now })) {
        this.#log.warn("Action needs reconciliation", { actionId: row.id, sessionId: row.session_id, tool: row.tool ?? undefined, reason: why });
        this.#emit({ type: "pending", sessionId: row.session_id, actionId: row.id });
      }
      return;
    }
    if (this.#store.transition(row.id, { states: OWNED_STATES, seq: row.claim_seq }, { state: "pending", clearClaim: true, now })) {
      this.#scheduleNotify(row);
    }
  }

  /** Closes actions of one placement that its runtime no longer lists; a move since the lists were read voids it. */
  #closeNotAwaited(sessionId: string, incarnation: string, kind: ActionKind, waiting: ReadonlySet<string>, listedAt: number, now: number, generation: number): void {
    for (const row of this.#store.listBySession(sessionId, incarnation, OPEN_STATES)) {
      if (row.kind !== kind || row.generation !== generation || waiting.has(runtimeRequestId(row)) || row.created_at >= listedAt - RECONCILE_GRACE_MS) continue;
      if (
        this.#store.transition(
          row.id,
          { states: OPEN_STATES, seq: row.claim_seq, generation },
          { state: "cancelled", reason: "The runtime no longer waits for this request (for example, its turn was cancelled)", forwarded: true, now },
        )
      ) {
        this.#emit({ type: "resolved", sessionId, actionId: row.id });
      }
    }
  }

  /**
   * A runtime that restarted without suspending rebuilds a waiting tool call under a new request ID with the same tool
   * call ID. The existing action takes the new ID and keeps its owner, outcome, or uncertainty, so the tool never runs
   * twice: a recorded answer is delivered again under the new ID, and an action cancelled when the old runtime stopped
   * comes back as uncertain if someone held it (it may have run) or as waiting if nobody did. The gateway's own
   * platform tools are idempotent by key and nobody else can reconcile them, so one the old runtime stopped waiting for
   * runs again (or, registered with `replay: "never"`, is answered by its recover hook or fails as "may have run").
   * A call the ledger already tracks under a newer placement is returned unchanged (never a second action).
   */
  #rebind(sessionId: string, incarnation: string, toolCallId: string, requestId: string, event: RuntimeSessionEvent, generation: number, now: number): ActionRow | undefined {
    const row = this.#store.findByToolCall(sessionId, incarnation, toolCallId);
    if (!row) return undefined;
    if (runtimeRequestId(row) === requestId || row.generation > generation) return row;
    const platformTool = row.tool ? this.#deps.platformTools()?.get?.(row.tool) : undefined;
    const platform = platformTool !== undefined || row.responder_type === "platform";
    const answered = ANSWERED_STATES.includes(row.state);
    const revived = row.state === "cancelled" || (platform && row.state === "needs_reconciliation");
    const uncertain = revived && !platform && row.claimed_by !== null;
    const state: ActionState = revived ? (uncertain ? "needs_reconciliation" : "pending") : row.state;
    const reason = revived ? (uncertain ? RESTARTED_WHILE_RUNNING : null) : row.reason;
    const stored = parseJson<RuntimeSessionEvent>(row.event);
    const rebound = stored ? { ...stored, data: { ...stored.data, requestId } } : event;
    if (
      !this.#store.rebindRequest(row.id, {
        from: runtimeRequestId(row),
        to: requestId,
        event: rebound,
        state,
        reason,
        redeliver: answered,
        clearClaim: revived && !uncertain,
        generation,
        now,
      })
    ) {
      return undefined;
    }
    this.#log.warn("A restarted runtime asked again for a tool call the ledger already tracks; it stays one action", {
      actionId: row.id,
      sessionId,
      tool: row.tool ?? undefined,
      state,
    });
    const latest = this.#store.get(row.id)!;
    if (answered) void this.#forward(row.id).catch(() => undefined);
    // A platform run the old runtime stopped waiting for was cut off: tools that must not repeat recover instead.
    else if (latest.state === "pending" && platformTool) this.#startPlatformTool(latest, platformTool, row.claimed_by !== null ? "The runtime restarted" : undefined);
    else if (state === "pending" && revived) this.#scheduleNotify(latest);
    else if (uncertain) this.#emit({ type: "pending", sessionId, actionId: row.id });
    return this.#store.get(row.id)!;
  }

  #onCompletion(input: SessionEventInput, kind: ActionKind): SessionEventDecision {
    const requestId = str(input.event.data?.requestId);
    if (!requestId) return { withhold: [] };
    const incarnation = input.incarnation ?? this.#current(input.sessionId)?.incarnation;
    const row = incarnation === undefined ? undefined : this.#store.findByRequest(input.sessionId, incarnation, kind, requestId);
    if (!row) return { withhold: [] };
    // A completion observed in an older placement, or for a request ID a restarted runtime replaced, says nothing
    // about the request the runtime waits for now.
    if (row.generation > input.generation || runtimeRequestId(row) !== requestId) return { actionId: row.id, withhold: [] };
    const now = this.#now();
    if (row.state === "completed" || row.state === "failed" || row.state === "expired") {
      if (!row.forwarded) this.#store.markForwarded(row.id, now, undefined, { generation: row.generation, requestId });
    } else if (OPEN_STATES.includes(row.state)) {
      // The runtime resolved this request without an answer the ledger recorded: an aborted turn or another path.
      if (
        this.#store.transition(
          row.id,
          { states: OPEN_STATES, seq: row.claim_seq },
          { state: "cancelled", reason: "The runtime stopped waiting for this request (for example, its turn was cancelled)", forwarded: true, now },
        )
      ) {
        this.#emit({ type: "resolved", sessionId: row.session_id, actionId: row.id });
      }
    }
    return { actionId: row.id, withhold: [] };
  }

  #startPlatformTool(row: ActionRow, definition: PlatformToolDefinition, interrupted?: string): void {
    const claimToken = newId("mct", 24);
    const tokenHash = hashSecret(claimToken);
    const claimed = this.#store.claim(
      row.id,
      { states: ["pending"], seq: row.claim_seq },
      { state: "executing", tokenHash, claimedBy: `platform:${definition.name}`, responderType: "platform", liveConnection: null, leaseExpiresAt: null, now: this.#now() },
    );
    if (!claimed) return;
    const seq = row.claim_seq + 1;
    const controller = new AbortController();
    if (this.#stopping) controller.abort(SHUTTING_DOWN());
    this.#running.set(row.id, { seq, controller });
    // A tool that must not repeat answers an interrupted call through its recover hook, or fails as "may have run".
    const recovering = interrupted !== undefined && definition.replay === "never";
    void (async () => {
      let outcome: Omit<Outcome, "resultHash" | "now">;
      try {
        const args = parseJson(row.arguments) ?? {};
        const context: PlatformToolContext = {
          sessionId: row.session_id,
          ownerId: row.owner_id,
          environment: row.environment,
          toolCallId: row.tool_call_id ?? row.request_id,
          idempotencyKey: row.idempotency_key,
          ...(row.agent_id ? { agentId: row.agent_id } : {}),
          actionId: row.id,
          signal: controller.signal,
        };
        if (recovering && !definition.recover) {
          throw new ManagedCopilotError("needs_reconciliation", `${interrupted} while ${definition.name} was running, so it may have run. It was not run again: check its effect before retrying.`, {
            actionId: row.id,
          });
        }
        if (recovering) this.#log.info("Recovering an interrupted platform tool call without rerunning it", { actionId: row.id, tool: definition.name });
        const result = recovering ? await definition.recover!(args, context) : await definition.handler(args, context);
        outcome = { state: "completed", result: normalizeToolResult(result) };
      } catch (error) {
        // Stopped by shutdown: the action stays executing, and the next start recovers it.
        if (controller.signal.aborted && this.#stopping) {
          this.#log.info("Platform tool stopped by shutdown; it is recovered at the next start", { actionId: row.id, tool: definition.name });
          if (this.#running.get(row.id)?.controller === controller) this.#running.delete(row.id);
          return;
        }
        const message = error instanceof ManagedCopilotError ? error.message : "The platform tool failed";
        if (!(error instanceof ManagedCopilotError)) this.#log.error("Platform tool failed", { tool: definition.name, error: (error as Error)?.stack ?? String(error) });
        outcome = { state: "failed", error: message };
      }
      // Removed first, so the "resolved" change below does not abort the call that just finished.
      if (this.#running.get(row.id)?.controller === controller) this.#running.delete(row.id);
      const now = this.#now();
      if (this.#store.complete(row.id, { seq, tokenHash }, { ...outcome, resultHash: canonicalJson({ result: outcome.result, error: outcome.error }), now })) {
        this.#emit({ type: "resolved", sessionId: row.session_id, actionId: row.id });
        await this.#forward(row.id).catch(() => undefined);
      }
    })();
  }

  /**
   * Aborts a running platform tool whose action left its run (cancelled, expired, deleted, or claimed again): its
   * answer can no longer reach the runtime.
   */
  #abortIfDetached(actionId: string): void {
    const running = this.#running.get(actionId);
    if (!running) return;
    const row = this.#store.get(actionId);
    if (row && row.state === "executing" && row.claim_seq === running.seq) return;
    this.#running.delete(actionId);
    const current = row ? this.#current(row.session_id) : undefined;
    const reason =
      !row || !current || current.incarnation !== row.incarnation
        ? new ManagedCopilotError("not_found", `Session ${row?.session_id ?? "(unknown)"} was deleted`, { actionId })
        : row.state === "expired"
          ? new ManagedCopilotError("timeout", "The tool call's answer deadline passed", { actionId })
          : new ManagedCopilotError("conflict", "The runtime stopped waiting for this tool call (for example, its turn was cancelled)", { actionId });
    running.controller.abort(reason);
  }

  #outcomeFromLiveAnswer(kind: ActionKind, params: Record<string, unknown>): Outcome {
    const now = this.#now();
    if (kind === "tool") {
      const error = str(params.error);
      const result = error === undefined ? params.result : undefined;
      return { state: error === undefined ? "completed" : "failed", result, error, resultHash: canonicalJson({ result, error }), now };
    }
    return { state: "completed", result: params.result, resultHash: canonicalJson({ result: params.result, error: undefined }), now };
  }

  #outcomeFromSubmission(row: ActionRow, request: ActionResultRequest, now: number, responder: DecisionResponder): Outcome {
    const error = request.error === undefined || request.error === null ? undefined : String(request.error);
    switch (row.kind) {
      case "tool": {
        const result = error === undefined ? normalizeToolResult(request.result) : undefined;
        return { state: error === undefined ? "completed" : "failed", result, error, resultHash: canonicalJson({ result, error }), now };
      }
      case "permission": {
        const result = request.result as Record<string, unknown> | undefined;
        if (error === undefined && (typeof result !== "object" || result === null || typeof result.kind !== "string")) {
          throw new ManagedCopilotError("invalid_request", 'A permission answer needs a decision such as { "kind": "approve-once" } or { "kind": "reject" }');
        }
        if (result?.kind === "no-result") throw new ManagedCopilotError("invalid_request", "A permission handler that makes no decision should release its claim instead");
        if (error === undefined) {
          const problem = permissionDecisionProblem(result!, responder, needsPerson(eventData(row)));
          if (problem) throw new ManagedCopilotError("forbidden", problem, { actionId: row.id });
        }
        // A failing permission handler is never an approval: the runtime receives "user-not-available".
        const decision = error === undefined ? result : { kind: "user-not-available" };
        return { state: error === undefined ? "completed" : "failed", result: decision, error, resultHash: canonicalJson({ result: decision, error }), now };
      }
      case "elicitation": {
        const result = request.result as Record<string, unknown> | undefined;
        if (error === undefined && (typeof result !== "object" || result === null || !ELICITATION_ACTIONS.has(String(result.action)))) {
          throw new ManagedCopilotError("invalid_request", 'An elicitation answer needs { "action": "accept" | "decline" | "cancel", "content"? }');
        }
        const answer = error === undefined ? result : { action: "cancel" };
        return { state: error === undefined ? "completed" : "failed", result: answer, error, resultHash: canonicalJson({ result: answer, error }), now };
      }
      default:
        throw new ManagedCopilotError("capability_unavailable", `Actions of kind ${row.kind} cannot be answered over REST yet`);
    }
  }

  /**
   * Delivers a recorded answer (or expiry) to the runtime that asked. Concurrent calls for the same delivery (action,
   * placement, and runtime request ID) share it; an answer adopted by a newer placement, or rebound to a request ID a
   * restarted runtime rebuilt, gets its own delivery even while an older one is in flight.
   */
  #forward(actionId: string): Promise<unknown> {
    const row = this.#store.get(actionId);
    const key = row ? `${actionId}@${row.generation}@${runtimeRequestId(row)}` : actionId;
    const inFlight = this.#forwarding.get(key);
    if (inFlight) return inFlight;
    const delivery = this.#deliver(actionId).finally(() => this.#forwarding.delete(key));
    this.#forwarding.set(key, delivery);
    return delivery;
  }

  async #deliver(actionId: string): Promise<unknown> {
    const row = this.#store.get(actionId);
    if (!row || row.forwarded) return { success: true };
    const sessions = this.#deps.sessions();
    const now = this.#now();
    // Acknowledgments and retries count only for this delivery: this placement and this runtime request ID.
    const attempt: DeliveryAttempt = { generation: row.generation, requestId: runtimeRequestId(row) };
    const retryLater = (error: ManagedCopilotError) => {
      const delay = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(row.forward_attempts, 8));
      this.#store.deferForward(row.id, now + delay, now, attempt);
      return error;
    };
    if (!sessions) throw retryLater(new ManagedCopilotError("capability_unavailable", "The session router is not available yet; the answer is recorded and will be delivered"));
    const current = this.#current(row.session_id);
    if (!current || current.incarnation !== row.incarnation) {
      // Nothing can receive it any more (deleted, or its ID now names a different session); stop retrying.
      this.#store.markForwarded(row.id, now, "Not delivered: the session no longer exists");
      return { success: false };
    }
    const { view } = current;
    if (view.generation !== row.generation) {
      if (view.generation < row.generation) {
        throw retryLater(new ManagedCopilotError("capability_unavailable", "The session's placement is not current yet; the answer is recorded and will be delivered"));
      }
      // An answer belongs to its request: the session's current placement receives it only if that runtime still
      // waits for exactly this request (it was carried across promotion). Otherwise it stays recorded, undelivered.
      const awaited = await this.#awaitedNow(row);
      if (awaited === undefined) {
        throw retryLater(new ManagedCopilotError("capability_unavailable", "The session's new placement could not say whether it still waits for this answer; it will be retried"));
      }
      if (!awaited) {
        this.#store.markForwarded(row.id, now, `Not delivered: the session moved to placement generation ${view.generation}, which does not wait for this request`, attempt);
        return { success: false };
      }
      // Moved (here, or concurrently by a runtime asking again); delivered once for that placement.
      const adopted = this.#store.adoptAnswer(row.id, row.generation, view.generation, now);
      if (!adopted && this.#store.get(actionId)?.generation === row.generation) return { success: false };
      return this.#forward(actionId);
    }
    const { method, params } = forwardCall(row);
    try {
      // Fenced to the incarnation that asked: a session that reuses the ID never receives this answer.
      const response = await withTimeout(sessions.request<unknown>(row.session_id, method, params, { incarnation: current.incarnation }), this.#options.upstreamTimeoutMs, "The runtime");
      const accepted = (response as { success?: unknown } | undefined)?.success;
      this.#store.markForwarded(row.id, this.#now(), accepted === false ? "The runtime no longer waited for this answer" : undefined, attempt);
      return response ?? { success: true };
    } catch (error) {
      if (isManagedCopilotError(error, "not_found") && this.#current(row.session_id)?.incarnation !== row.incarnation) {
        this.#store.markForwarded(row.id, this.#now(), "Not delivered: the session no longer exists", attempt);
        return { success: false };
      }
      const managed = error instanceof ManagedCopilotError ? error : new ManagedCopilotError("capability_unavailable", "The runtime did not accept the answer yet; it is recorded and will be retried");
      this.#log.warn("Delivering an answer to the runtime failed; will retry", { actionId: row.id, sessionId: row.session_id, error: (error as Error).message });
      throw retryLater(managed);
    }
  }

  /** Whether the session's current runtime still waits for this request (`undefined` when it cannot tell yet). */
  async #awaitedNow(row: ActionRow): Promise<boolean | undefined> {
    const method = row.kind === "tool" ? PENDING_LIST_METHODS.tool : row.kind === "permission" ? PENDING_LIST_METHODS.permission : undefined;
    // Elicitations have no pending list; a placement that still waits for one asks again (see onSessionEvent).
    if (!method) return false;
    const sessions = this.#deps.sessions();
    if (!sessions) return undefined;
    // Only the incarnation that asked can still wait for it.
    const current = this.#current(row.session_id);
    if (!current || current.incarnation !== row.incarnation) return false;
    try {
      const list = await withTimeout(
        sessions.request<{ items?: unknown[] }>(row.session_id, method, { sessionId: row.session_id }, { incarnation: current.incarnation }),
        this.#options.upstreamTimeoutMs,
        "The runtime",
      );
      if (!Array.isArray(list?.items)) return undefined;
      return list.items.some((item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).requestId === runtimeRequestId(row));
    } catch (error) {
      // The session that asked is gone (its ID may now name another session): nothing there waits for this answer.
      if (isManagedCopilotError(error, "not_found") && this.#current(row.session_id)?.incarnation !== row.incarnation) return false;
      return undefined;
    }
  }

  /**
   * Who may act on a session's actions, and in which incarnation. Owners must own the session's current incarnation
   * (not found otherwise, so other accounts learn nothing). A capability covers only its session and listed actions;
   * it covers nothing (undefined) once its session is gone or its ID names a newer session.
   */
  #authorize(caller: ActionCaller, sessionId: string, actionId?: string): string | undefined {
    const current = this.#current(sessionId);
    if (caller.type === "capability") {
      if (caller.capability.sessionId !== sessionId) throw new ManagedCopilotError("forbidden", "This capability is for a different session");
      if (actionId !== undefined && !caller.capability.actionIds.includes(actionId)) {
        throw new ManagedCopilotError("forbidden", "This capability does not cover that action");
      }
      if (!current || (caller.capability.incarnation !== undefined && caller.capability.incarnation !== current.incarnation)) return undefined;
      return current.incarnation;
    }
    const accountId = caller.type === "platform" ? caller.ownerId : caller.principal.accountId;
    if (!current || current.view.ownerId !== accountId) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`);
    return current.incarnation;
  }

  #requireAction(sessionId: string, actionId: string, incarnation: string | undefined): ActionRow {
    if (incarnation === undefined) throw conflict("The session no longer exists, so its actions cannot be executed");
    const row = this.#store.get(actionId);
    if (!row || row.session_id !== sessionId || row.incarnation !== incarnation) throw new ManagedCopilotError("not_found", `Action ${actionId} was not found in session ${sessionId}`);
    return row;
  }

  #scheduleNotify(row: Pick<ActionRow, "session_id" | "id">): void {
    // Offered (again): it counts as announced only once this offer is published, so a failure stays repairable.
    this.#store.clearNotified(row.id);
    this.#emit({ type: "pending", sessionId: row.session_id, actionId: row.id });
    if (this.#notifyTimers.has(row.session_id)) return;
    const timer = setTimeout(() => {
      this.#notifyTimers.delete(row.session_id);
      this.#publishActionRequired(row.session_id);
    }, this.#options.notifyDebounceMs);
    timer.unref?.();
    this.#notifyTimers.set(row.session_id, timer);
  }

  /** Announces the current incarnation's waiting actions, to its owner and environment (an ID may be reused). */
  #publishActionRequired(sessionId: string): void {
    const current = this.#current(sessionId);
    if (!current) return;
    const { ownerId, environment } = current.view;
    const pending = this.#store.listBySession(sessionId, current.incarnation, ["pending"]);
    if (pending.length === 0) return;
    const event: PlatformEvent = {
      id: newId("evt"),
      type: "session.action_required",
      createdAt: new Date(this.#now()).toISOString(),
      sessionId,
      environment,
      data: {
        actions: pending.map((row) => ({
          id: row.id,
          kind: row.kind,
          state: row.state,
          ...(row.tool ? { tool: row.tool } : {}),
          ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
          idempotencyKey: row.idempotency_key,
          expiresAt: toIso(row.deadline_at),
        })),
      },
    };
    this.#log.info("Actions waiting for a responder", { sessionId, count: pending.length });
    try {
      this.#deps.publish(event, { ownerId });
    } catch (error) {
      // Left unmarked, so the sweeper announces it again.
      this.#log.error("Publishing session.action_required failed; it will be retried", { sessionId, error: (error as Error).message });
      return;
    }
    // Marked only once published (the webhook outbox row exists), so a failure stays repairable.
    this.#store.markNotified(
      pending.map((row) => row.id),
      this.#now(),
    );
  }

  #emit(change: ActionChange): void {
    if (change.type === "resolved") this.#abortIfDetached(change.actionId);
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        this.#log.warn("Action change listener failed", { error: (error as Error).message });
      }
    }
  }
}

function describeUnclaimable(row: ActionRow): string {
  switch (row.state) {
    case "claimed":
    case "executing":
      return `This action is already being handled${row.claimed_by ? ` by ${row.claimed_by}` : ""}`;
    case "completed":
    case "failed":
      return "This action was already answered";
    case "needs_reconciliation":
      return "This action may already have run; claim it with reconcile: true after checking its effect";
    default:
      return `This action was ${row.state}${row.reason ? `: ${row.reason}` : ""}`;
  }
}

/** The runtime RPC that delivers a recorded outcome. Expiry and failures never become approvals. */
function forwardCall(row: ActionRow): { method: string; params: Record<string, unknown> } {
  const base = { sessionId: row.session_id, requestId: runtimeRequestId(row) };
  const result = parseJson(row.result);
  switch (row.kind) {
    case "tool":
      if (row.state === "completed") return { method: ANSWER_METHODS.tool, params: { ...base, result } };
      if (row.state === "expired") {
        return { method: ANSWER_METHODS.tool, params: { ...base, error: `No responder answered ${row.tool ?? "this tool"} before its deadline` } };
      }
      return { method: ANSWER_METHODS.tool, params: { ...base, error: row.error ?? "The tool failed" } };
    case "permission":
      return { method: ANSWER_METHODS.permission, params: { ...base, result: row.state === "completed" ? result : { kind: "user-not-available" } } };
    case "elicitation":
      return { method: ANSWER_METHODS.elicitation, params: { ...base, result: row.state === "completed" ? result : { action: "cancel" } } };
    default:
      throw new ManagedCopilotError("capability_unavailable", `Actions of kind ${row.kind} cannot be delivered yet`);
  }
}
