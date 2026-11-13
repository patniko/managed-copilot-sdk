import {
  ManagedCopilotError,
  type ActionCapability,
  type ActionClaim,
  type ActionKind,
  type ActionResultRequest,
  type ActionState,
  type HandleActionResult,
  type PendingAction,
} from "@managed-copilot/protocol";
import {
  PENDING_LIST_METHODS,
  type ActionCaller,
  type ActionsService,
  type ClaimOptions,
  type PromptVisibility,
  type PromptVisibilityInput,
  type RuntimeSessionEvent,
  type VerifiedCapability,
} from "../contract.js";
import { hashSecret, newId, toIso } from "../ids.js";
import { mintCapabilityToken, verifyCapabilityToken } from "./capability.js";
import {
  ActionStore,
  OPEN_STATES,
  OWNED_STATES,
  runtimeRequestId,
  toOperatorRecord,
  toPendingAction,
  type ActionOperatorRecord,
  type ActionRow,
} from "./store.js";
import {
  ANNOUNCE_REPAIR_AFTER_MS,
  str,
  heldBefore,
  conflict,
  idempotencyKeyFor,
  parseExecutionEvent,
  isEligible,
  type DecisionResponder,
  withTimeout,
  describeUnclaimable,
} from "./support.js";
import { ActionsRouterHooks } from "./hooks.js";

export class DurableActions extends ActionsRouterHooks implements ActionsService {
  get store(): ActionStore {
    return this.actionStore;
  }

  // ---------------------------------------------------------------------------------------------------------
  // REST and service API
  // ---------------------------------------------------------------------------------------------------------

  list(sessionId: string, options: { readonly open?: boolean; readonly incarnation?: string } = {}): PendingAction[] {
    const incarnation = options.incarnation ?? this.current(sessionId)?.incarnation;
    if (incarnation === undefined) return [];
    return this.actionStore.listBySession(sessionId, incarnation, options.open ? OPEN_STATES : undefined).map(toPendingAction);
  }

  /**
   * Actions of every owner for the operator console, newest first: metadata only (never arguments, payloads,
   * results, or claim tokens). `state`: `open` (default), `attention` (needs reconciliation), `all`, or one state.
   */
  operatorActions(query: { readonly state?: string; readonly sessionId?: string; readonly incarnation?: string; readonly limit?: number } = {}): ActionOperatorRecord[] {
    const state = query.state ?? "open";
    const states: readonly ActionState[] | undefined = state === "open" ? OPEN_STATES : state === "attention" ? ["needs_reconciliation"] : state === "all" ? undefined : [state as ActionState];
    return this.actionStore
      .listForOperator({
        ...(states ? { states } : {}),
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
        ...(query.incarnation ? { incarnation: query.incarnation } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      })
      .map(toOperatorRecord);
  }

  operatorActionCounts(): Partial<Record<ActionState, number>> {
    return this.actionStore.countByState();
  }

  /**
   * True while the session's runtime may still wait on something the ledger owns: an action that is pending,
   * executing, or uncertain, or an answer recorded but not delivered yet. A runtime that resumes such a session
   * should continue its pending work (`continuePendingWork: true`) rather than treat it as interrupted.
   */
  hasOpenActions(sessionId: string, options: { readonly incarnation?: string } = {}): boolean {
    const incarnation = options.incarnation ?? this.current(sessionId)?.incarnation;
    if (incarnation === undefined) return false;
    return this.actionStore.hasOpenWork(sessionId, incarnation);
  }

  async listFor(caller: ActionCaller, sessionId: string, options: { readonly open?: boolean } = {}): Promise<PendingAction[]> {
    const incarnation = this.authorize(caller, sessionId);
    // A capability for a session that no longer exists covers nothing.
    if (incarnation === undefined) return [];
    const actions = this.list(sessionId, { ...options, incarnation });
    if (caller.type === "capability") return actions.filter((action) => caller.capability.actionIds.includes(action.id));
    return actions;
  }

  async claim(caller: ActionCaller, sessionId: string, actionId: string, options: ClaimOptions = {}): Promise<ActionClaim> {
    const row = this.requireAction(sessionId, actionId, this.authorize(caller, sessionId, actionId));
    const now = this.now();
    const leaseMs = Math.min(
      this.options.maxLeaseMs,
      Math.max(this.options.minLeaseMs, options.leaseSeconds !== undefined ? Math.round(options.leaseSeconds * 1000) : this.options.defaultLeaseMs),
    );

    if (options.claimToken !== undefined) {
      if (!this.actionStore.renew(row.id, row.claim_seq, hashSecret(options.claimToken), now + leaseMs, now)) {
        throw conflict("This claim is no longer valid; it expired, was released, or was superseded", row);
      }
      return { action: toPendingAction(this.actionStore.get(row.id)!), claimToken: options.claimToken, leaseExpiresAt: toIso(now + leaseMs)! };
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
    if (row.kind === "tool" && row.tool && this.deps.platformTools()?.get?.(row.tool, row.environment)) {
      throw new ManagedCopilotError("forbidden", `${row.tool} is a platform tool; the gateway answers it`);
    }
    const label =
      caller.type === "capability"
        ? `webhook:${options.responder ?? caller.capability.webhook}`
        : caller.type === "platform"
          ? `platform:${caller.responder}`
          : `poll:${caller.principal.login}${options.responder ? `/${options.responder}` : ""}`;
    const claimToken = newId("mct", 24);
    const claimed = this.actionStore.claim(
      row.id,
      { states: from, seq: row.claim_seq },
      { state: "executing", tokenHash: hashSecret(claimToken), claimedBy: label, responderType, liveConnection: null, leaseExpiresAt: now + leaseMs, now },
    );
    if (!claimed) {
      const latest = this.actionStore.get(row.id)!;
      throw conflict(describeUnclaimable(latest), latest);
    }
    this.log.info("Action claimed", { actionId: row.id, sessionId, kind: row.kind, tool: row.tool ?? undefined, responder: label });
    return { action: toPendingAction(this.actionStore.get(row.id)!), claimToken, leaseExpiresAt: toIso(now + leaseMs)! };
  }

  async submit(caller: ActionCaller, sessionId: string, actionId: string, request: ActionResultRequest): Promise<HandleActionResult> {
    const incarnation = this.authorize(caller, sessionId, actionId);
    if (typeof request?.claimToken !== "string" || request.claimToken.length === 0) {
      throw new ManagedCopilotError("invalid_request", "claimToken is required; claim the action first");
    }
    const row = this.requireAction(sessionId, actionId, incarnation);
    const tokenHash = hashSecret(request.claimToken);
    const now = this.now();

    if (request.release) {
      if (row.claim_token_hash !== tokenHash || !OWNED_STATES.includes(row.state)) throw conflict("Only the current claim can be released", row);
      if (!this.actionStore.transition(row.id, { states: OWNED_STATES, seq: row.claim_seq }, { state: "pending", clearClaim: true, now })) {
        throw conflict("This action changed while the claim was being released", this.actionStore.get(row.id));
      }
      // Announce it again, except when the webhook worker it was announced to releases it: that handler could not
      // decide, and re-announcing to it would loop. A poller's release must reach webhooks that skipped it while held.
      if (caller.type === "capability" && row.notified_at !== null) this.emit({ type: "pending", sessionId: row.session_id, actionId: row.id });
      else this.scheduleNotify(row);
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
    const outcome = this.outcomeFromSubmission(row, request, now, responder);
    if (row.state === "completed" || row.state === "failed") {
      if (row.claim_token_hash === tokenHash && row.result_hash === outcome.resultHash) return { actionId: row.id, state: row.state };
      throw conflict("This action already has a different recorded answer", row);
    }
    if (row.claim_token_hash !== tokenHash) throw conflict("This claim is no longer valid; it expired, was released, or was superseded", row);
    if (!this.actionStore.complete(row.id, { seq: row.claim_seq, tokenHash }, outcome)) {
      const latest = this.actionStore.get(row.id)!;
      if ((latest.state === "completed" || latest.state === "failed") && latest.claim_token_hash === tokenHash && latest.result_hash === outcome.resultHash) {
        return { actionId: row.id, state: latest.state };
      }
      throw conflict("This action changed while the answer was being recorded", latest);
    }
    this.log.info("Action answered", { actionId: row.id, sessionId, kind: row.kind, state: outcome.state, responder: row.claimed_by ?? undefined });
    this.emit({ type: "resolved", sessionId: row.session_id, actionId: row.id });
    try {
      await this.forward(row.id);
    } catch {
      // The answer is recorded; delivery to the runtime is retried by the sweeper.
    }
    return { actionId: row.id, state: outcome.state };
  }

  verifyCapability(token: string): VerifiedCapability {
    return verifyCapabilityToken(this.deps.capabilityKey, token, { audience: this.deps.publicUrl, now: this.now() });
  }

  mintCapability(sessionId: string, actionIds: readonly string[], webhook: string): ActionCapability | undefined {
    const current = this.current(sessionId);
    if (!current) return undefined;
    const pending = actionIds.filter((id) => {
      const row = this.actionStore.get(id);
      return row !== undefined && row.session_id === sessionId && row.incarnation === current.incarnation && row.state === "pending";
    });
    if (pending.length === 0) return undefined;
    const expiresAt = this.now() + this.options.capabilityTtlMs;
    const token = mintCapabilityToken(this.deps.capabilityKey, { sid: sessionId, inc: current.incarnation, aids: pending, aud: this.deps.publicUrl, exp: expiresAt, wh: webhook });
    return { token, expiresAt: toIso(expiresAt)!, sessionId, actionIds: pending, audience: this.deps.publicUrl };
  }

  /**
   * Compares the ledger with what the runtime still awaits: records tool calls and permission prompts the ledger
   * missed (for example ones emitted while the gateway was down), keeps one action per tool call when a restarted
   * runtime rebuilt it under a new request ID, and closes actions the runtime no longer waits for.
   */
  async reconcile(sessionId: string): Promise<void> {
    const sessions = this.deps.sessions();
    const start = this.current(sessionId);
    if (!sessions || !start) return;
    const { view, incarnation } = start;
    const timeout = this.options.upstreamTimeoutMs;
    // Actions recorded after this point may not be in the lists yet; never close those.
    const listedAt = this.now();
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
      return requestId !== undefined && !this.actionStore.findByRequest(sessionId, incarnation, "permission", requestId);
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
    const current = this.current(sessionId);
    if (!current || current.incarnation !== incarnation || current.view.generation !== view.generation) return;
    if ((this.placements.get(`${sessionId}\u0000${incarnation}`) ?? view.generation) > view.generation) return;
    const now = this.now();
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
        const known = this.actionStore.findByRequest(sessionId, incarnation, "tool", requestId);
        if (known) {
          this.adoptAnswered(known, view.generation, now);
          continue;
        }
        if (toolCallId && this.rebind(sessionId, incarnation, toolCallId, requestId, event, view.generation, now)) continue;
        const { row, created } = this.actionStore.insertIfAbsent({
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
          deadlineAt: now + this.options.answerTimeoutMs,
          now,
        });
        if (row.incarnation !== incarnation || !created) continue;
        this.log.info("Recorded a waiting tool call the ledger had not seen", { sessionId, actionId: row.id, tool: toolName });
        const platformTool = this.deps.platformTools()?.get?.(toolName, row.environment);
        if (platformTool) this.startPlatformTool(row, platformTool);
        else this.scheduleNotify(row);
      }
      this.closeNotAwaited(sessionId, incarnation, "tool", waiting, listedAt, now, view.generation);
    }
    if (permissionItems) {
      const waiting = new Set<string>();
      for (const item of permissionItems) {
        const requestId = str(item.requestId);
        if (!requestId) continue;
        waiting.add(requestId);
        const known = this.actionStore.findByRequest(sessionId, incarnation, "permission", requestId);
        if (known) {
          this.adoptAnswered(known, view.generation, now);
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
        const { row, created } = this.actionStore.insertIfAbsent({
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
          deadlineAt: now + this.options.answerTimeoutMs,
          now,
        });
        if (row.incarnation !== incarnation || !created) continue;
        this.log.info("Recorded a waiting permission prompt the ledger had not seen", { sessionId, actionId: row.id, tool: row.tool ?? undefined, fromHistory: recorded !== undefined });
        this.scheduleNotify(row);
      }
      this.closeNotAwaited(sessionId, incarnation, "permission", waiting, listedAt, now, view.generation);
    }
    this.signalRecorded(sessionId);
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
      const current = this.current(input.sessionId);
      if (!current || current.incarnation !== input.incarnation) return { status: "hidden", reason: "The session this client is attached to no longer exists" };
      if (current.view.generation !== input.generation) return { status: "hidden", reason: "The session moved to another placement; reattach to answer its prompts" };
      return undefined;
    };
    const early = stale();
    if (early) return early;
    // A CLI that detaches while this waits must not be handed the prompt afterwards.
    const detached = this.detachedSince(responder.connectionId, input.sessionId);
    let row = await this.#waitForRequest(input.sessionId, input.incarnation, input.kind, input.requestId, input.waitMs ?? 5_000);
    if (!row) {
      // Core may have missed the event (for example around a reconnect): the runtime's pending lists decide.
      await this.reconcile(input.sessionId).catch(() => undefined);
      row = this.actionStore.findByRequest(input.sessionId, input.incarnation, input.kind, input.requestId);
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
      this.claimLive(row, responder);
      row = this.actionStore.get(row.id)!;
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
      const row = this.actionStore.findByRequest(sessionId, incarnation, kind, requestId);
      if (row) return row;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await new Promise<void>((resolve) => {
        const waiters = this.recordWaiters.get(sessionId) ?? new Set<() => void>();
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          if (waiters.size === 0 && this.recordWaiters.get(sessionId) === waiters) this.recordWaiters.delete(sessionId);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        timer.unref?.();
        waiters.add(done);
        this.recordWaiters.set(sessionId, waiters);
      });
    }
  }

  /** Wakes `promptVisibility` calls waiting for this session's requests to be recorded. */
  protected signalRecorded(sessionId: string): void {
    const waiters = this.recordWaiters.get(sessionId);
    if (!waiters) return;
    this.recordWaiters.delete(sessionId);
    for (const wake of [...waiters]) wake();
  }

  /** One sweep: lease expiry, answer deadlines, and retrying answers the runtime has not acknowledged. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = this.now();
      for (const row of this.actionStore.listLeaseExpired(now)) this.orphan(row, "The responder's lease expired before it reported a result", now);
      for (const row of this.actionStore.listPastDeadline(now)) {
        const reason =
          row.state === "executing" || row.state === "claimed" || row.state === "needs_reconciliation"
            ? "The answer deadline passed while the action's outcome was unknown; it may have run"
            : "No eligible responder answered before the deadline";
        if (this.actionStore.transition(row.id, { states: OPEN_STATES, seq: row.claim_seq }, { state: "expired", reason, forwarded: false, now })) {
          this.log.warn("Action expired", { actionId: row.id, sessionId: row.session_id, kind: row.kind, tool: row.tool ?? undefined });
          this.emit({ type: "resolved", sessionId: row.session_id, actionId: row.id });
        }
      }
      for (const row of this.actionStore.listUnforwarded(now)) {
        if (row.forward_attempts >= this.options.maxForwardAttempts) {
          this.actionStore.markForwarded(row.id, now, "The answer was recorded but could not be delivered to the runtime", {
            generation: row.generation,
            requestId: runtimeRequestId(row),
          });
          continue;
        }
        void this.forward(row.id).catch(() => undefined);
      }
      this.announceUnnotified(now, ANNOUNCE_REPAIR_AFTER_MS);
    } finally {
      this.sweeping = false;
    }
  }
}

export { DEFAULT_ACTIONS_OPTIONS, idempotencyKeyFor, needsPerson, normalizeToolResult, permissionDecisionProblem } from "./support.js";
export type { ActionChange, ActionsDeps, ActionsOptions } from "./support.js";
