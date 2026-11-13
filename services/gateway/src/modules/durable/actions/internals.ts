// Durable actions: state and internals (forwarding, delivery, notification, platform tools, and orphan handling).
import {
  isManagedCopilotError,
  ManagedCopilotError,
  type ActionKind,
  type ActionResultRequest,
  type ActionState,
  type PlatformEvent,
} from "@managed-copilot/protocol";
import type { Logger } from "../../../log.js";
import {
  PENDING_LIST_METHODS,
  type ActionCaller,
  type AttachedResponder,
  type DurableSessionView,
  type PlatformToolContext,
  type PlatformToolDefinition,
  type RuntimeSessionEvent,
  type SessionEventDecision,
  type SessionEventInput,
} from "../contract.js";
import { canonicalJson, hashSecret, incarnationOf, isGone, newId, parseJson, toIso } from "../ids.js";
import {
  ActionStore,
  ANSWERED_STATES,
  OPEN_STATES,
  OWNED_STATES,
  runtimeRequestId,
  type ActionRow,
  type DeliveryAttempt,
  type Outcome,
} from "./store.js";
import {
  type ActionsOptions,
  DEFAULT_ACTIONS_OPTIONS,
  type ActionsDeps,
  type ActionChange,
  ELICITATION_ACTIONS,
  RECONCILE_GRACE_MS,
  RESTARTED_WHILE_RUNNING,
  SHUTTING_DOWN,
  str,
  eventData,
  withLiveClaimant,
  conflict,
  needsPerson,
  type DecisionResponder,
  permissionDecisionProblem,
  normalizeToolResult,
  withTimeout,
  forwardCall,
} from "./support.js";

export abstract class ActionsInternals {
  protected readonly actionStore: ActionStore;
  protected readonly deps: ActionsDeps;
  protected readonly log: Logger;
  protected readonly options: ActionsOptions;
  protected readonly now: () => number;
  protected readonly notifyTimers = new Map<string, NodeJS.Timeout>();
  readonly #forwarding = new Map<string, Promise<unknown>>();
  protected readonly listeners = new Set<(change: ActionChange) => void>();
  /** Detach counters per connection and per connection+session (bounded); fence attaches that raced a detach. */
  protected readonly detachGenerations = new Map<string, number>();
  /**
   * Latest placement generation the ledger applied per session incarnation (bounded). Updated synchronously by
   * `onGenerationChanged`, so work that awaited across a move can tell before it changes anything.
   */
  protected readonly placements = new Map<string, number>();
  /** `promptVisibility` calls waiting for core's event stream to record a request, per session. */
  protected readonly recordWaiters = new Map<string, Set<() => void>>();
  /** Platform tool calls running in this process, by action ID, with the claim they run under. */
  protected readonly running = new Map<string, { readonly seq: number; readonly controller: AbortController }>();
  protected stopping = false;
  protected sweeper: NodeJS.Timeout | undefined;
  protected sweeping = false;

  constructor(deps: ActionsDeps) {
    this.deps = deps;
    this.actionStore = new ActionStore(deps.db);
    this.log = deps.log;
    this.options = { ...DEFAULT_ACTIONS_OPTIONS, ...deps.options };
    this.now = deps.now ?? Date.now;
  }

  /** The session's current incarnation as core records it; undefined once it is being deleted or gone. */
  protected current(sessionId: string): { readonly view: DurableSessionView; readonly incarnation: string } | undefined {
    const view = this.deps.sessions()?.get(sessionId);
    if (!view || isGone(view)) return undefined;
    return { view, incarnation: incarnationOf(view) };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------------------

  protected claimLive(row: ActionRow, responder: AttachedResponder): string | undefined {
    const claimToken = newId("mct", 24);
    const responderType = responder.kind === "cli" ? "cli" : "live";
    const claimed = this.actionStore.claim(
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
        now: this.now(),
      },
    );
    return claimed ? claimToken : undefined;
  }

  /** The owner went away without answering. Tools may have run; prompts have no external effect and are offered again. */
  protected orphan(row: ActionRow, why: string, now: number): void {
    if (row.kind === "tool") {
      const reason = `${why}; the tool may have run. Check its effect with the idempotency key, then answer it with a reconcile claim.`;
      if (this.actionStore.transition(row.id, { states: OWNED_STATES, seq: row.claim_seq }, { state: "needs_reconciliation", reason, now })) {
        this.log.warn("Action needs reconciliation", { actionId: row.id, sessionId: row.session_id, tool: row.tool ?? undefined, reason: why });
        this.emit({ type: "pending", sessionId: row.session_id, actionId: row.id });
      }
      return;
    }
    if (this.actionStore.transition(row.id, { states: OWNED_STATES, seq: row.claim_seq }, { state: "pending", clearClaim: true, now })) {
      this.scheduleNotify(row);
    }
  }

  /** Closes actions of one placement that its runtime no longer lists; a move since the lists were read voids it. */
  protected closeNotAwaited(sessionId: string, incarnation: string, kind: ActionKind, waiting: ReadonlySet<string>, listedAt: number, now: number, generation: number): void {
    for (const row of this.actionStore.listBySession(sessionId, incarnation, OPEN_STATES)) {
      if (row.kind !== kind || row.generation !== generation || waiting.has(runtimeRequestId(row)) || row.created_at >= listedAt - RECONCILE_GRACE_MS) continue;
      if (
        this.actionStore.transition(
          row.id,
          { states: OPEN_STATES, seq: row.claim_seq, generation },
          { state: "cancelled", reason: "The runtime no longer waits for this request (for example, its turn was cancelled)", forwarded: true, now },
        )
      ) {
        this.emit({ type: "resolved", sessionId, actionId: row.id });
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
  protected rebind(sessionId: string, incarnation: string, toolCallId: string, requestId: string, event: RuntimeSessionEvent, generation: number, now: number): ActionRow | undefined {
    const row = this.actionStore.findByToolCall(sessionId, incarnation, toolCallId);
    if (!row) return undefined;
    if (runtimeRequestId(row) === requestId || row.generation > generation) return row;
    const platformTool = row.tool ? this.deps.platformTools()?.get?.(row.tool, row.environment) : undefined;
    // Only a registered platform tool can be run (or recovered) again; one that is not registered now stays uncertain
    // with its claim, like a client's, until a rebuild finds it registered.
    const platform = platformTool !== undefined;
    const answered = ANSWERED_STATES.includes(row.state);
    const revived = row.state === "cancelled" || ((platform || row.responder_type === "platform") && row.state === "needs_reconciliation");
    const uncertain = revived && !platform && row.claimed_by !== null;
    const state: ActionState = revived ? (uncertain ? "needs_reconciliation" : "pending") : row.state;
    const reason = revived ? (uncertain ? RESTARTED_WHILE_RUNNING : null) : row.reason;
    const stored = parseJson<RuntimeSessionEvent>(row.event);
    const rebound = stored ? { ...stored, data: { ...stored.data, requestId } } : event;
    if (
      !this.actionStore.rebindRequest(row.id, {
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
    this.log.warn("A restarted runtime asked again for a tool call the ledger already tracks; it stays one action", {
      actionId: row.id,
      sessionId,
      tool: row.tool ?? undefined,
      state,
    });
    const latest = this.actionStore.get(row.id)!;
    if (answered) void this.forward(row.id).catch(() => undefined);
    // A platform run the old runtime stopped waiting for was cut off: tools that must not repeat recover instead.
    else if (latest.state === "pending" && platformTool) this.startPlatformTool(latest, platformTool, row.claimed_by !== null ? "The runtime restarted" : undefined);
    else if (state === "pending" && revived) this.scheduleNotify(latest);
    else if (uncertain) this.emit({ type: "pending", sessionId, actionId: row.id });
    return this.actionStore.get(row.id)!;
  }

  protected onCompletion(input: SessionEventInput, kind: ActionKind): SessionEventDecision {
    const requestId = str(input.event.data?.requestId);
    if (!requestId) return { withhold: [] };
    const incarnation = input.incarnation ?? this.current(input.sessionId)?.incarnation;
    const row = incarnation === undefined ? undefined : this.actionStore.findByRequest(input.sessionId, incarnation, kind, requestId);
    if (!row) return { withhold: [] };
    // A completion observed in an older placement, or for a request ID a restarted runtime replaced, says nothing
    // about the request the runtime waits for now.
    if (row.generation > input.generation || runtimeRequestId(row) !== requestId) return { actionId: row.id, withhold: [] };
    const now = this.now();
    if (row.state === "completed" || row.state === "failed" || row.state === "expired") {
      if (!row.forwarded) this.actionStore.markForwarded(row.id, now, undefined, { generation: row.generation, requestId });
    } else if (OPEN_STATES.includes(row.state)) {
      // The runtime resolved this request without an answer the ledger recorded: an aborted turn or another path.
      if (
        this.actionStore.transition(
          row.id,
          { states: OPEN_STATES, seq: row.claim_seq },
          { state: "cancelled", reason: "The runtime stopped waiting for this request (for example, its turn was cancelled)", forwarded: true, now },
        )
      ) {
        this.emit({ type: "resolved", sessionId: row.session_id, actionId: row.id });
      }
    }
    return { actionId: row.id, withhold: [] };
  }

  protected startPlatformTool(row: ActionRow, definition: PlatformToolDefinition, interrupted?: string): void {
    const claimToken = newId("mct", 24);
    const tokenHash = hashSecret(claimToken);
    const claimed = this.actionStore.claim(
      row.id,
      { states: ["pending"], seq: row.claim_seq },
      { state: "executing", tokenHash, claimedBy: `platform:${definition.name}`, responderType: "platform", liveConnection: null, leaseExpiresAt: null, now: this.now() },
    );
    if (!claimed) return;
    const seq = row.claim_seq + 1;
    const controller = new AbortController();
    if (this.stopping) controller.abort(SHUTTING_DOWN());
    this.running.set(row.id, { seq, controller });
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
        if (recovering) this.log.info("Recovering an interrupted platform tool call without rerunning it", { actionId: row.id, tool: definition.name });
        const result = recovering ? await definition.recover!(args, context) : await definition.handler(args, context);
        outcome = { state: "completed", result: normalizeToolResult(result) };
      } catch (error) {
        const message = error instanceof ManagedCopilotError ? error.message : "The platform tool failed";
        if (!(error instanceof ManagedCopilotError) && !this.stopping) this.log.error("Platform tool failed", { tool: definition.name, error: (error as Error)?.stack ?? String(error) });
        outcome = { state: "failed", error: message };
      }
      if (this.running.get(row.id)?.controller === controller) this.running.delete(row.id);
      // Settled after shutdown began (the ledger may already be closed): nothing is recorded, so the action stays
      // executing and the next start recovers it (replays it, or its recover hook answers).
      if (this.stopping) {
        this.log.info("Platform tool settled during shutdown; it is recovered at the next start", { actionId: row.id, tool: definition.name });
        return;
      }
      const now = this.now();
      try {
        if (this.actionStore.complete(row.id, { seq, tokenHash }, { ...outcome, resultHash: canonicalJson({ result: outcome.result, error: outcome.error }), now })) {
          this.emit({ type: "resolved", sessionId: row.session_id, actionId: row.id });
          await this.forward(row.id).catch(() => undefined);
        }
      } catch (error) {
        this.log.error("Recording a platform tool's outcome failed", { actionId: row.id, tool: definition.name, error: (error as Error).message });
      }
    })();
  }

  /**
   * Aborts a running platform tool whose action left its run (cancelled, expired, deleted, or claimed again): its
   * answer can no longer reach the runtime.
   */
  #abortIfDetached(actionId: string): void {
    const running = this.running.get(actionId);
    if (!running) return;
    const row = this.actionStore.get(actionId);
    if (row && row.state === "executing" && row.claim_seq === running.seq) return;
    this.running.delete(actionId);
    const current = row ? this.current(row.session_id) : undefined;
    const reason =
      !row || !current || current.incarnation !== row.incarnation
        ? new ManagedCopilotError("not_found", `Session ${row?.session_id ?? "(unknown)"} was deleted`, { actionId })
        : row.state === "expired"
          ? new ManagedCopilotError("timeout", "The tool call's answer deadline passed", { actionId })
          : new ManagedCopilotError("conflict", "The runtime stopped waiting for this tool call (for example, its turn was cancelled)", { actionId });
    running.controller.abort(reason);
  }

  protected outcomeFromLiveAnswer(kind: ActionKind, params: Record<string, unknown>): Outcome {
    const now = this.now();
    if (kind === "tool") {
      const error = str(params.error);
      const result = error === undefined ? params.result : undefined;
      return { state: error === undefined ? "completed" : "failed", result, error, resultHash: canonicalJson({ result, error }), now };
    }
    return { state: "completed", result: params.result, resultHash: canonicalJson({ result: params.result, error: undefined }), now };
  }

  protected outcomeFromSubmission(row: ActionRow, request: ActionResultRequest, now: number, responder: DecisionResponder): Outcome {
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
  protected forward(actionId: string): Promise<unknown> {
    const row = this.actionStore.get(actionId);
    const key = row ? `${actionId}@${row.generation}@${runtimeRequestId(row)}` : actionId;
    const inFlight = this.#forwarding.get(key);
    if (inFlight) return inFlight;
    const delivery = this.#deliver(actionId).finally(() => this.#forwarding.delete(key));
    this.#forwarding.set(key, delivery);
    return delivery;
  }

  async #deliver(actionId: string): Promise<unknown> {
    const row = this.actionStore.get(actionId);
    if (!row || row.forwarded) return { success: true };
    const sessions = this.deps.sessions();
    const now = this.now();
    // Acknowledgments and retries count only for this delivery: this placement and this runtime request ID.
    const attempt: DeliveryAttempt = { generation: row.generation, requestId: runtimeRequestId(row) };
    const retryLater = (error: ManagedCopilotError) => {
      const delay = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(row.forward_attempts, 8));
      this.actionStore.deferForward(row.id, now + delay, now, attempt);
      return error;
    };
    if (!sessions) throw retryLater(new ManagedCopilotError("capability_unavailable", "The session router is not available yet; the answer is recorded and will be delivered"));
    const current = this.current(row.session_id);
    if (!current || current.incarnation !== row.incarnation) {
      // Nothing can receive it any more (deleted, or its ID now names a different session); stop retrying.
      this.actionStore.markForwarded(row.id, now, "Not delivered: the session no longer exists");
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
        this.actionStore.markForwarded(row.id, now, `Not delivered: the session moved to placement generation ${view.generation}, which does not wait for this request`, attempt);
        return { success: false };
      }
      // Moved (here, or concurrently by a runtime asking again); delivered once for that placement.
      const adopted = this.actionStore.adoptAnswer(row.id, row.generation, view.generation, now);
      if (!adopted && this.actionStore.get(actionId)?.generation === row.generation) return { success: false };
      return this.forward(actionId);
    }
    const { method, params } = forwardCall(row);
    try {
      // Fenced to the incarnation that asked: a session that reuses the ID never receives this answer.
      const response = await withTimeout(sessions.request<unknown>(row.session_id, method, params, { incarnation: current.incarnation }), this.options.upstreamTimeoutMs, "The runtime");
      const accepted = (response as { success?: unknown } | undefined)?.success;
      this.actionStore.markForwarded(row.id, this.now(), accepted === false ? "The runtime no longer waited for this answer" : undefined, attempt);
      return response ?? { success: true };
    } catch (error) {
      if (isManagedCopilotError(error, "not_found") && this.current(row.session_id)?.incarnation !== row.incarnation) {
        this.actionStore.markForwarded(row.id, this.now(), "Not delivered: the session no longer exists", attempt);
        return { success: false };
      }
      const managed = error instanceof ManagedCopilotError ? error : new ManagedCopilotError("capability_unavailable", "The runtime did not accept the answer yet; it is recorded and will be retried");
      this.log.warn("Delivering an answer to the runtime failed; will retry", { actionId: row.id, sessionId: row.session_id, error: (error as Error).message });
      throw retryLater(managed);
    }
  }

  /** Whether the session's current runtime still waits for this request (`undefined` when it cannot tell yet). */
  async #awaitedNow(row: ActionRow): Promise<boolean | undefined> {
    const method = row.kind === "tool" ? PENDING_LIST_METHODS.tool : row.kind === "permission" ? PENDING_LIST_METHODS.permission : undefined;
    // Elicitations have no pending list; a placement that still waits for one asks again (see onSessionEvent).
    if (!method) return false;
    const sessions = this.deps.sessions();
    if (!sessions) return undefined;
    // Only the incarnation that asked can still wait for it.
    const current = this.current(row.session_id);
    if (!current || current.incarnation !== row.incarnation) return false;
    try {
      const list = await withTimeout(
        sessions.request<{ items?: unknown[] }>(row.session_id, method, { sessionId: row.session_id }, { incarnation: current.incarnation }),
        this.options.upstreamTimeoutMs,
        "The runtime",
      );
      if (!Array.isArray(list?.items)) return undefined;
      return list.items.some((item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).requestId === runtimeRequestId(row));
    } catch (error) {
      // The session that asked is gone (its ID may now name another session): nothing there waits for this answer.
      if (isManagedCopilotError(error, "not_found") && this.current(row.session_id)?.incarnation !== row.incarnation) return false;
      return undefined;
    }
  }

  /**
   * Who may act on a session's actions, and in which incarnation. Owners must own the session's current incarnation
   * (not found otherwise, so other accounts learn nothing). A capability covers only its session and listed actions;
   * it covers nothing (undefined) once its session is gone or its ID names a newer session.
   */
  protected authorize(caller: ActionCaller, sessionId: string, actionId?: string): string | undefined {
    const current = this.current(sessionId);
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

  protected requireAction(sessionId: string, actionId: string, incarnation: string | undefined): ActionRow {
    if (incarnation === undefined) throw conflict("The session no longer exists, so its actions cannot be executed");
    const row = this.actionStore.get(actionId);
    if (!row || row.session_id !== sessionId || row.incarnation !== incarnation) throw new ManagedCopilotError("not_found", `Action ${actionId} was not found in session ${sessionId}`);
    return row;
  }

  protected scheduleNotify(row: Pick<ActionRow, "session_id" | "id">): void {
    // Offered (again): it counts as announced only once this offer is published, so a failure stays repairable.
    this.actionStore.clearNotified(row.id);
    this.emit({ type: "pending", sessionId: row.session_id, actionId: row.id });
    if (this.notifyTimers.has(row.session_id)) return;
    const timer = setTimeout(() => {
      this.notifyTimers.delete(row.session_id);
      this.#publishActionRequired(row.session_id);
    }, this.options.notifyDebounceMs);
    timer.unref?.();
    this.notifyTimers.set(row.session_id, timer);
  }

  /** Announces the current incarnation's waiting actions, to its owner and environment (an ID may be reused). */
  #publishActionRequired(sessionId: string): void {
    const current = this.current(sessionId);
    if (!current) return;
    const { ownerId, environment } = current.view;
    const pending = this.actionStore.listBySession(sessionId, current.incarnation, ["pending"]);
    if (pending.length === 0) return;
    const event: PlatformEvent = {
      id: newId("evt"),
      type: "session.action_required",
      createdAt: new Date(this.now()).toISOString(),
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
    this.log.info("Actions waiting for a responder", { sessionId, count: pending.length });
    try {
      this.deps.publish(event, { ownerId });
    } catch (error) {
      // Left unmarked, so the sweeper announces it again.
      this.log.error("Publishing session.action_required failed; it will be retried", { sessionId, error: (error as Error).message });
      return;
    }
    // Marked only once published (the webhook outbox row exists), so a failure stays repairable.
    this.actionStore.markNotified(
      pending.map((row) => row.id),
      this.now(),
    );
  }

  protected emit(change: ActionChange): void {
    if (change.type === "resolved") this.#abortIfDetached(change.actionId);
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        this.log.warn("Action change listener failed", { error: (error as Error).message });
      }
    }
  }
}
