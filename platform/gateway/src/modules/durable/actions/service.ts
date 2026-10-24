import {
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
  type DurableSessionsPort,
  type PlatformEventMeta,
  type PlatformToolDefinition,
  type RuntimeSessionEvent,
  type SessionEventDecision,
  type SessionEventInput,
  type VerifiedCapability,
} from "../contract.js";
import { canonicalJson, hashSecret, newId, parseJson, toIso } from "../ids.js";
import { mintCapabilityToken, verifyCapabilityToken } from "./capability.js";
import { ActionStore, OPEN_STATES, OWNED_STATES, toPendingAction, type ActionRow, type Outcome } from "./store.js";

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

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
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
      const request = data.permissionRequest as Record<string, unknown> | undefined;
      return { kind: "permission", requestId, ...(str(request?.toolCallId) ? { toolCallId: str(request?.toolCallId)! } : {}) };
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
 * attached person answers prompts only when no application handler is attached.
 */
function chooseOwner(eligible: readonly AttachedResponder[], kind: ActionKind): AttachedResponder | undefined {
  return eligible.find((responder) => responder.kind === "sdk") ?? (kind === "tool" ? undefined : eligible.find((responder) => responder.kind === "cli"));
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
  /** Connections that detached (bounded); attach work still in flight for them must not claim anything. */
  readonly #detached = new Set<string>();
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
    this.recover();
    if (this.#options.sweepIntervalMs > 0) {
      this.#sweeper = setInterval(() => void this.sweep(), this.#options.sweepIntervalMs);
      this.#sweeper.unref?.();
    }
  }

  stop(): void {
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
   * (no external effect) return to `pending`. Gateway-executed platform tools are idempotent by key and run again.
   */
  recover(): void {
    const now = this.#now();
    for (const row of this.#store.listLiveClaims()) this.#orphan(row, "The gateway restarted while a client was handling this action", now);
    for (const row of this.#store.listOwnedBy("platform")) {
      if (this.#store.transition(row.id, { states: OWNED_STATES, seq: row.claim_seq }, { state: "pending", clearClaim: true, now })) {
        const latest = this.#store.get(row.id);
        const definition = latest?.tool ? this.#deps.platformTools()?.get?.(latest.tool) : undefined;
        if (latest && definition) this.#startPlatformTool(latest, definition);
      }
    }
    this.#announceUnnotified(now);
  }

  /** Pending actions whose `session.action_required` never went out (a crash inside the debounce window). */
  #announceUnnotified(now: number, olderThanMs = 0): void {
    for (const row of this.#store.listUnnotifiedPending(now - olderThanMs)) {
      if (row.kind === "tool" && row.tool && this.#deps.platformTools()?.get?.(row.tool)) continue;
      if (!this.#notifyTimers.has(row.session_id)) this.#scheduleNotify(row);
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Router hooks (core)
  // ---------------------------------------------------------------------------------------------------------

  async onSessionEvent(input: SessionEventInput): Promise<SessionEventDecision> {
    const { event } = input;
    const completionKind = COMPLETION_KIND[event.type];
    if (completionKind) return this.#onCompletion(input, completionKind);
    if (!EXECUTION_TYPES.has(event.type)) return { withhold: [] };
    const parsed = parseExecutionEvent(event);
    if (!parsed) return { withhold: [] };

    const now = this.#now();
    const { row, created } = this.#store.insertIfAbsent({
      id: newId("act"),
      sessionId: input.sessionId,
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
    if (created) this.#log.debug("Action recorded", { actionId: row.id, sessionId: row.session_id, kind: row.kind, tool: row.tool ?? undefined });

    const eligible = input.attached.filter((responder) => isEligible(responder, parsed));
    const everyEligible = eligible.map((responder) => responder.connectionId);
    if (row.state !== "pending") {
      // Re-emission of an action that already has an owner or an outcome: nobody else may execute it.
      if ((row.state === "completed" || row.state === "failed") && !row.forwarded) void this.#forward(row.id).catch(() => undefined);
      return { actionId: row.id, withhold: everyEligible };
    }

    const platformTool = parsed.kind === "tool" && parsed.tool ? this.#deps.platformTools()?.get?.(parsed.tool) : undefined;
    if (platformTool) {
      this.#startPlatformTool(row, platformTool);
      return { actionId: row.id, withhold: everyEligible };
    }

    const owner = chooseOwner(eligible, parsed.kind);
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
    if (!kind || !requestId) return { kind: "forward" };
    const row = this.#store.findByRequest(input.sessionId, kind, requestId);
    if (!row) return { kind: "forward" };

    const outcome = this.#outcomeFromLiveAnswer(kind, input.params);
    const responderType = input.responderKind === "cli" ? "cli" : "live";
    if (row.state === "completed" || row.state === "failed") {
      if (row.result_hash === outcome.resultHash) return { kind: "respond", response: { success: true } };
      throw conflict("This action already has a different recorded answer", row);
    }
    if (row.state === "expired" || row.state === "cancelled") throw conflict(`This action was ${row.state}${row.reason ? `: ${row.reason}` : ""}`, row);

    let seq = row.claim_seq;
    if (row.state === "pending") {
      // A client answering an action it was not offered (for example from `listPendingRequests`) takes it if eligible.
      if (kind === "tool" && responderType === "cli") throw new ManagedCopilotError("forbidden", "A person cannot run an application's tool; only its app can answer it");
      const claimed = this.#store.claim(
        row.id,
        { states: ["pending"], seq },
        { state: "executing", tokenHash: hashSecret(newId("mct", 24)), claimedBy: `${responderType}:${input.connectionId}`, responderType, liveConnection: input.connectionId, leaseExpiresAt: null, now: this.#now() },
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
    try {
      await this.reconcile(input.sessionId);
    } catch (error) {
      this.#log.debug("Reconciliation on attach skipped", { sessionId: input.sessionId, error: (error as Error).message });
    }
    // The connection may have closed while reconciling; never claim for a connection that can no longer answer.
    if (this.#detached.has(input.responder.connectionId)) return [];
    const replay: RuntimeSessionEvent[] = [];
    for (const row of this.#store.listBySession(input.sessionId, ["pending"])) {
      if (!isEligible(input.responder, { kind: row.kind, tool: row.tool })) continue;
      if (row.kind === "tool" && row.tool && this.#deps.platformTools()?.get?.(row.tool)) continue;
      if (this.#claimLive(row, input.responder)) {
        const event = parseJson<RuntimeSessionEvent>(row.event);
        if (event) replay.push(event);
      }
    }
    if (replay.length > 0) this.#log.info("Replaying waiting actions to a resumed client", { sessionId: input.sessionId, count: replay.length });
    return replay;
  }

  onDetached(connectionId: string): void {
    this.#detached.add(connectionId);
    if (this.#detached.size > 10_000) this.#detached.delete(this.#detached.values().next().value!);
    const now = this.#now();
    for (const row of this.#store.listByLiveConnection(connectionId)) {
      this.#orphan(row, "The client handling this action disconnected before it answered", now);
    }
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

  list(sessionId: string, options: { readonly open?: boolean } = {}): PendingAction[] {
    return this.#store.listBySession(sessionId, options.open ? OPEN_STATES : undefined).map(toPendingAction);
  }

  async listFor(caller: ActionCaller, sessionId: string, options: { readonly open?: boolean } = {}): Promise<PendingAction[]> {
    await this.#authorize(caller, sessionId);
    const actions = this.list(sessionId, options);
    if (caller.type === "capability") return actions.filter((action) => caller.capability.actionIds.includes(action.id));
    return actions;
  }

  async claim(caller: ActionCaller, sessionId: string, actionId: string, options: ClaimOptions = {}): Promise<ActionClaim> {
    await this.#authorize(caller, sessionId, actionId);
    const row = this.#requireAction(sessionId, actionId);
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
    const from: ActionState[] = row.state === "needs_reconciliation" && options.reconcile ? ["needs_reconciliation"] : ["pending"];
    if (!from.includes(row.state)) throw conflict(describeUnclaimable(row), row);
    if (row.kind === "tool" && row.tool && this.#deps.platformTools()?.get?.(row.tool)) {
      throw new ManagedCopilotError("forbidden", `${row.tool} is a platform tool; the gateway answers it`);
    }
    const label =
      caller.type === "capability"
        ? `webhook:${options.responder ?? caller.capability.webhook}`
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
    await this.#authorize(caller, sessionId, actionId);
    if (typeof request?.claimToken !== "string" || request.claimToken.length === 0) {
      throw new ManagedCopilotError("invalid_request", "claimToken is required; claim the action first");
    }
    const row = this.#requireAction(sessionId, actionId);
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
    const outcome = this.#outcomeFromSubmission(row, request, now);
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
    const pending = actionIds.filter((id) => {
      const row = this.#store.get(id);
      return row !== undefined && row.session_id === sessionId && row.state === "pending";
    });
    if (pending.length === 0) return undefined;
    const expiresAt = this.#now() + this.#options.capabilityTtlMs;
    const token = mintCapabilityToken(this.#deps.capabilityKey, { sid: sessionId, aids: pending, aud: this.#deps.publicUrl, exp: expiresAt, wh: webhook });
    return { token, expiresAt: toIso(expiresAt)!, sessionId, actionIds: pending, audience: this.#deps.publicUrl };
  }

  /**
   * Compares the ledger with what the runtime still awaits: records tool calls the ledger missed (for example events
   * emitted while the gateway was down) and closes actions the runtime no longer waits for.
   */
  async reconcile(sessionId: string): Promise<void> {
    const sessions = this.#deps.sessions();
    if (!sessions) return;
    const view = await sessions.get(sessionId);
    if (!view) return;
    const timeout = this.#options.upstreamTimeoutMs;
    // Actions recorded after this point may not be in the lists yet; never close those.
    const listedAt = this.#now();
    const [tools, permissions] = await Promise.all([
      withTimeout(sessions.request<{ items?: unknown[] }>(sessionId, PENDING_LIST_METHODS.tool, { sessionId }), timeout, "The runtime").catch(() => undefined),
      withTimeout(sessions.request<{ items?: unknown[] }>(sessionId, PENDING_LIST_METHODS.permission, { sessionId }), timeout, "The runtime").catch(() => undefined),
    ]);
    const now = this.#now();
    if (tools && Array.isArray(tools.items)) {
      const waiting = new Set<string>();
      for (const item of tools.items as Record<string, unknown>[]) {
        const requestId = str(item.requestId);
        const toolName = str(item.toolName);
        if (!requestId || !toolName) continue;
        waiting.add(requestId);
        const event: RuntimeSessionEvent = {
          id: newId("evt"),
          type: "external_tool.requested",
          timestamp: new Date(now).toISOString(),
          parentId: null,
          data: { requestId, sessionId, toolName, toolCallId: item.toolCallId, arguments: item.arguments, ...(item.providerId ? { providerId: item.providerId } : {}) },
          ...(str(item.agentId) ? { agentId: str(item.agentId)! } : {}),
        };
        const toolCallId = str(item.toolCallId);
        const { row, created } = this.#store.insertIfAbsent({
          id: newId("act"),
          sessionId,
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
        if (created) {
          this.#log.info("Recorded a waiting tool call the ledger had not seen", { sessionId, actionId: row.id, tool: toolName });
          const platformTool = this.#deps.platformTools()?.get?.(toolName);
          if (platformTool) this.#startPlatformTool(row, platformTool);
          else this.#scheduleNotify(row);
        }
      }
      this.#closeNotAwaited(sessionId, "tool", waiting, listedAt, now);
    }
    if (permissions && Array.isArray(permissions.items)) {
      const waiting = new Set((permissions.items as Record<string, unknown>[]).map((item) => str(item.requestId)).filter((id): id is string => !!id));
      this.#closeNotAwaited(sessionId, "permission", waiting, listedAt, now);
    }
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
          this.#store.markForwarded(row.id, now, "The answer was recorded but could not be delivered to the runtime");
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

  #closeNotAwaited(sessionId: string, kind: ActionKind, waiting: ReadonlySet<string>, listedAt: number, now: number): void {
    for (const row of this.#store.listBySession(sessionId, OPEN_STATES)) {
      if (row.kind !== kind || waiting.has(row.request_id) || row.created_at >= listedAt - RECONCILE_GRACE_MS) continue;
      if (
        this.#store.transition(
          row.id,
          { states: OPEN_STATES, seq: row.claim_seq },
          { state: "cancelled", reason: "The runtime no longer waits for this request (for example, its turn was cancelled)", forwarded: true, now },
        )
      ) {
        this.#emit({ type: "resolved", sessionId, actionId: row.id });
      }
    }
  }

  #onCompletion(input: SessionEventInput, kind: ActionKind): SessionEventDecision {
    const requestId = str(input.event.data?.requestId);
    if (!requestId) return { withhold: [] };
    const row = this.#store.findByRequest(input.sessionId, kind, requestId);
    if (!row) return { withhold: [] };
    const now = this.#now();
    if (row.state === "completed" || row.state === "failed" || row.state === "expired") {
      if (!row.forwarded) this.#store.markForwarded(row.id, now);
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

  #startPlatformTool(row: ActionRow, definition: PlatformToolDefinition): void {
    const claimToken = newId("mct", 24);
    const tokenHash = hashSecret(claimToken);
    const claimed = this.#store.claim(
      row.id,
      { states: ["pending"], seq: row.claim_seq },
      { state: "executing", tokenHash, claimedBy: `platform:${definition.name}`, responderType: "platform", liveConnection: null, leaseExpiresAt: null, now: this.#now() },
    );
    if (!claimed) return;
    const seq = row.claim_seq + 1;
    void (async () => {
      let outcome: Omit<Outcome, "resultHash" | "now">;
      try {
        const result = await definition.handler(parseJson(row.arguments) ?? {}, {
          sessionId: row.session_id,
          ownerId: row.owner_id,
          environment: row.environment,
          toolCallId: row.tool_call_id ?? row.request_id,
          idempotencyKey: row.idempotency_key,
        });
        outcome = { state: "completed", result: normalizeToolResult(result) };
      } catch (error) {
        const message = error instanceof ManagedCopilotError ? error.message : "The platform tool failed";
        if (!(error instanceof ManagedCopilotError)) this.#log.error("Platform tool failed", { tool: definition.name, error: (error as Error)?.stack ?? String(error) });
        outcome = { state: "failed", error: message };
      }
      const now = this.#now();
      if (this.#store.complete(row.id, { seq, tokenHash }, { ...outcome, resultHash: canonicalJson({ result: outcome.result, error: outcome.error }), now })) {
        this.#emit({ type: "resolved", sessionId: row.session_id, actionId: row.id });
        await this.#forward(row.id).catch(() => undefined);
      }
    })();
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

  #outcomeFromSubmission(row: ActionRow, request: ActionResultRequest, now: number): Outcome {
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

  /** Delivers a recorded answer (or expiry) to the runtime that asked. Concurrent calls share one delivery. */
  #forward(actionId: string): Promise<unknown> {
    const inFlight = this.#forwarding.get(actionId);
    if (inFlight) return inFlight;
    const delivery = this.#deliver(actionId).finally(() => this.#forwarding.delete(actionId));
    this.#forwarding.set(actionId, delivery);
    return delivery;
  }

  async #deliver(actionId: string): Promise<unknown> {
    const row = this.#store.get(actionId);
    if (!row || row.forwarded) return { success: true };
    const sessions = this.#deps.sessions();
    const now = this.#now();
    const retryLater = (error: ManagedCopilotError) => {
      const delay = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(row.forward_attempts, 8));
      this.#store.deferForward(row.id, now + delay, now);
      return error;
    };
    if (!sessions) throw retryLater(new ManagedCopilotError("capability_unavailable", "The session router is not available yet; the answer is recorded and will be delivered"));
    const view = await sessions.get(row.session_id);
    if (view && view.generation !== row.generation) {
      // Fencing: an answer belongs to the placement generation whose runtime asked for it.
      this.#store.markForwarded(row.id, now, `Not delivered: the session moved to placement generation ${view.generation}`);
      return { success: false };
    }
    const { method, params } = forwardCall(row);
    try {
      const response = await withTimeout(sessions.request<unknown>(row.session_id, method, params), this.#options.upstreamTimeoutMs, "The runtime");
      const accepted = (response as { success?: unknown } | undefined)?.success;
      this.#store.markForwarded(row.id, this.#now(), accepted === false ? "The runtime no longer waited for this answer" : undefined);
      return response ?? { success: true };
    } catch (error) {
      const managed = error instanceof ManagedCopilotError ? error : new ManagedCopilotError("capability_unavailable", "The runtime did not accept the answer yet; it is recorded and will be retried");
      this.#log.warn("Delivering an answer to the runtime failed; will retry", { actionId: row.id, sessionId: row.session_id, error: (error as Error).message });
      throw retryLater(managed);
    }
  }

  async #authorize(caller: ActionCaller, sessionId: string, actionId?: string): Promise<void> {
    if (caller.type === "capability") {
      if (caller.capability.sessionId !== sessionId) throw new ManagedCopilotError("forbidden", "This capability is for a different session");
      if (actionId !== undefined && !caller.capability.actionIds.includes(actionId)) {
        throw new ManagedCopilotError("forbidden", "This capability does not cover that action");
      }
      return;
    }
    const ownerId = await this.#ownerOf(sessionId);
    // Not found rather than forbidden: callers learn nothing about other owners' sessions.
    if (ownerId === undefined || ownerId !== caller.principal.accountId) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`);
  }

  async #ownerOf(sessionId: string): Promise<number | undefined> {
    const view = await this.#deps.sessions()?.get(sessionId);
    if (view) return view.ownerId;
    const row = this.#deps.db.prepare("SELECT owner_id FROM durable_actions WHERE session_id = ? LIMIT 1").get(sessionId) as { owner_id: number } | undefined;
    return row?.owner_id;
  }

  #requireAction(sessionId: string, actionId: string): ActionRow {
    const row = this.#store.get(actionId);
    if (!row || row.session_id !== sessionId) throw new ManagedCopilotError("not_found", `Action ${actionId} was not found in session ${sessionId}`);
    return row;
  }

  #scheduleNotify(row: Pick<ActionRow, "session_id" | "owner_id" | "environment" | "id">): void {
    this.#emit({ type: "pending", sessionId: row.session_id, actionId: row.id });
    if (this.#notifyTimers.has(row.session_id)) return;
    const timer = setTimeout(() => {
      this.#notifyTimers.delete(row.session_id);
      this.#publishActionRequired(row.session_id, row.owner_id, row.environment);
    }, this.#options.notifyDebounceMs);
    timer.unref?.();
    this.#notifyTimers.set(row.session_id, timer);
  }

  #publishActionRequired(sessionId: string, ownerId: number, environment: string): void {
    const pending = this.#store.listBySession(sessionId, ["pending"]);
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
    this.#store.markNotified(
      pending.map((row) => row.id),
      this.#now(),
    );
    try {
      this.#deps.publish(event, { ownerId });
    } catch (error) {
      this.#log.error("Publishing session.action_required failed", { sessionId, error: (error as Error).message });
    }
  }

  #emit(change: ActionChange): void {
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
  const base = { sessionId: row.session_id, requestId: row.request_id };
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
