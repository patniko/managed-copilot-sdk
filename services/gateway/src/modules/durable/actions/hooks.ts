// Durable actions: lifecycle and the router hooks core calls for session events, client answers, and attachments.
import { ManagedCopilotError, type ActionState } from "@managed-copilot/protocol";
import type {
  AttachInput,
  ClientAnswerDecision,
  ClientAnswerInput,
  GenerationChangeOptions,
  RuntimeSessionEvent,
  SessionEventDecision,
  SessionEventInput,
} from "../contract.js";
import { hashSecret, incarnationOf, newId, parseJson } from "../ids.js";
import { ANSWERED_STATES, OPEN_STATES, OWNED_STATES, runtimeRequestId, type ActionRow } from "./store.js";
import {
  type ActionChange,
  EXECUTION_TYPES,
  COMPLETION_KIND,
  METHOD_KIND,
  MAX_REMEMBERED,
  MOVED_WHILE_RUNNING,
  SHUTTING_DOWN,
  str,
  eventData,
  lacksRawRequest,
  withLiveClaimant,
  heldBefore,
  conflict,
  idempotencyKeyFor,
  parseExecutionEvent,
  isEligible,
  chooseOwner,
  needsPerson,
  permissionDecisionProblem,
} from "./support.js";
import { ActionsInternals } from "./internals.js";

export abstract class ActionsRouterHooks extends ActionsInternals {
  // Implemented by later layers of DurableActions.
  abstract sweep(): Promise<void>;
  protected abstract signalRecorded(sessionId: string): void;
  abstract reconcile(sessionId: string): Promise<void>;

  // ---------------------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------------------

  /** Recovers claims orphaned by a restart, then starts the lease/deadline/forwarding sweeper. */
  start(): void {
    this.assignIncarnations();
    this.recover();
    if (this.options.sweepIntervalMs > 0) {
      this.sweeper = setInterval(() => void this.sweep(), this.options.sweepIntervalMs);
      this.sweeper.unref?.();
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
    const sessions = this.deps.sessions();
    if (!sessions) return;
    for (const sessionId of this.actionStore.sessionsWithoutIncarnation()) {
      const current = this.current(sessionId);
      const createdAtMs = current?.view.createdAt ? Date.parse(current.view.createdAt) : undefined;
      this.actionStore.assignIncarnation(
        sessionId,
        current ? { incarnation: current.incarnation, ownerId: current.view.ownerId, ...(Number.isFinite(createdAtMs) ? { createdAtMs: createdAtMs! } : {}) } : undefined,
      );
    }
    for (const { session_id: sessionId, incarnation } of this.actionStore.provisionalIncarnations()) {
      const current = this.current(sessionId);
      if (current?.view.incarnation && current.view.createdAt && incarnation === incarnationOf({ createdAt: current.view.createdAt })) {
        this.actionStore.rekeyIncarnation(sessionId, incarnation, current.incarnation);
      }
    }
    for (const { session_id: sessionId, incarnation } of this.actionStore.liveIncarnations()) {
      if (this.current(sessionId)?.incarnation !== incarnation) this.onSessionDeleted(sessionId, incarnation);
    }
  }

  stop(): void {
    this.stopping = true;
    for (const { controller } of this.running.values()) controller.abort(SHUTTING_DOWN());
    this.running.clear();
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const timer of this.notifyTimers.values()) clearTimeout(timer);
    this.notifyTimers.clear();
  }

  onChange(listener: (change: ActionChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * After a restart no live connection survives. A tool a client may have been running becomes uncertain; prompts
   * (no external effect) return to `pending`. Gateway-executed platform tools are idempotent by key and run again,
   * except tools registered with `replay: "never"`: their `recover` hook answers, or the call fails as "may have run".
   */
  recover(): void {
    const now = this.now();
    for (const row of this.actionStore.listLiveClaims()) this.orphan(row, "The gateway restarted while a client was handling this action", now);
    for (const row of this.actionStore.listOwnedBy("platform")) {
      const definition = row.tool ? this.deps.platformTools()?.get?.(row.tool, row.environment) : undefined;
      if (!definition) {
        // Nothing can run or recover it now: it stays uncertain (keeping its platform claim, so a restarted runtime
        // that asks again once the tool is registered gets its recover path, never a blind rerun).
        const reason = `The gateway restarted while platform tool ${row.tool ?? "(unknown)"} was running and it is not registered now; it may have run.`;
        if (this.actionStore.transition(row.id, { states: OWNED_STATES, seq: row.claim_seq }, { state: "needs_reconciliation", reason, now })) {
          this.log.warn("Platform tool interrupted by a restart is not registered; it needs reconciliation", { actionId: row.id, tool: row.tool ?? undefined });
          this.emit({ type: "pending", sessionId: row.session_id, actionId: row.id });
        }
        continue;
      }
      if (this.actionStore.transition(row.id, { states: OWNED_STATES, seq: row.claim_seq }, { state: "pending", clearClaim: true, now })) {
        const latest = this.actionStore.get(row.id);
        if (latest) this.startPlatformTool(latest, definition, "The gateway restarted");
      }
    }
    this.announceUnnotified(now);
  }

  /** Pending actions whose `session.action_required` never went out (a crash inside the debounce window). */
  protected announceUnnotified(now: number, olderThanMs = 0): void {
    for (const row of this.actionStore.listUnnotifiedPending(now - olderThanMs)) {
      if (row.kind === "tool" && row.tool && this.deps.platformTools()?.get?.(row.tool, row.environment)) continue;
      // Only the session's current incarnation is ever announced (older ones are closed at startup).
      if (this.current(row.session_id)?.incarnation !== row.incarnation) continue;
      if (!this.notifyTimers.has(row.session_id)) this.scheduleNotify(row);
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Router hooks (core)
  // ---------------------------------------------------------------------------------------------------------

  async onSessionEvent(input: SessionEventInput): Promise<SessionEventDecision> {
    const { event } = input;
    const completionKind = COMPLETION_KIND[event.type];
    if (completionKind) return this.onCompletion(input, completionKind);
    if (!EXECUTION_TYPES.has(event.type)) return { withhold: [] };
    try {
      return this.#arbitrate(input);
    } finally {
      // Recorded and arbitrated: attach can now tell its CLI whether the prompt is answerable (`promptVisibility`).
      this.signalRecorded(input.sessionId);
    }
  }

  /** Records an execution-bearing request and decides who may execute it (claim before emission). Synchronous. */
  #arbitrate(input: SessionEventInput): SessionEventDecision {
    const { event } = input;
    const parsed = parseExecutionEvent(event);
    if (!parsed) return { withhold: [] };
    // Only the session's current incarnation records actions: a deleted (or replaced) session's requests can never be
    // answered, so nothing is recorded and nobody may execute them.
    const current = this.current(input.sessionId);
    if (!current || (input.incarnation !== undefined && input.incarnation !== current.incarnation)) {
      return { withhold: input.attached.map((responder) => responder.connectionId) };
    }
    const incarnation = current.incarnation;

    const now = this.now();
    // A runtime that restarted without suspending rebuilds a waiting call with a new request ID but the same tool call:
    // it is the same action, never a second one to execute.
    const known = this.actionStore.findByRequest(input.sessionId, incarnation, parsed.kind, parsed.requestId);
    const rebound =
      !known && parsed.kind === "tool" && parsed.toolCallId ? this.rebind(input.sessionId, incarnation, parsed.toolCallId, parsed.requestId, event, input.generation, now) : undefined;
    const existing = known ?? rebound;
    // The runtime asked again with the full request for a prompt recorded from its pending list alone: keep it.
    if (known && lacksRawRequest(known) && event.type === "permission.requested" && event.data?.permissionRequest !== undefined) {
      this.actionStore.updateEvent(known.id, event);
    }
    const { row, created } = existing
      ? { row: this.actionStore.get(existing.id) ?? existing, created: false }
      : this.actionStore.insertIfAbsent({
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
          deadlineAt: now + this.options.answerTimeoutMs,
          now,
        });
    if (row.incarnation !== incarnation) {
      // A reused session ID whose runtime also reused a request ID: fail closed rather than mix the two sessions.
      this.log.error("A runtime request ID collides with an earlier session's action; nobody will execute it", { sessionId: input.sessionId, requestId: parsed.requestId });
      return { withhold: input.attached.map((responder) => responder.connectionId) };
    }
    if (created) this.log.debug("Action recorded", { actionId: row.id, sessionId: row.session_id, kind: row.kind, tool: row.tool ?? undefined });

    const eligible = input.attached.filter((responder) => isEligible(responder, parsed));
    const everyEligible = eligible.map((responder) => responder.connectionId);
    // A late observation from an older placement (the action has since moved): it changes nothing and runs nowhere.
    if (row.generation > input.generation) return { actionId: row.id, withhold: everyEligible };
    if (row.state !== "pending") {
      // Re-emission of an action that already has an owner or an outcome: nobody else may execute it.
      if (ANSWERED_STATES.includes(row.state)) {
        // A newer placement asking for a request answered under an older one (carried across promotion) gets the
        // recorded answer.
        if (row.generation < input.generation) this.adoptAnswered(row, input.generation, now);
        else if (!row.forwarded) void this.forward(row.id).catch(() => undefined);
      }
      return { actionId: row.id, withhold: everyEligible };
    }

    const platformTool = parsed.kind === "tool" && parsed.tool ? this.deps.platformTools()?.get?.(parsed.tool, row.environment) : undefined;
    if (platformTool) {
      this.startPlatformTool(row, platformTool);
      return { actionId: row.id, withhold: everyEligible };
    }

    const owner = chooseOwner(
      eligible.filter((responder) => !heldBefore(row, responder.connectionId)),
      parsed.kind,
      parsed.kind === "permission" && needsPerson(event.data),
    );
    if (owner) {
      const claimToken = this.claimLive(row, owner);
      if (claimToken) {
        return { actionId: row.id, owner: owner.connectionId, claimToken, withhold: everyEligible.filter((id) => id !== owner.connectionId) };
      }
      return { actionId: row.id, withhold: everyEligible };
    }

    // Nobody attached can answer: the action waits durably for a webhook worker, a poller, or a client that resumes.
    this.scheduleNotify(row);
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
    const current = this.current(input.sessionId)?.incarnation;
    // An answer for a session that no longer exists, or that its ID no longer names, never reaches a runtime.
    if (current === undefined || (input.incarnation !== undefined && input.incarnation !== current)) throw conflict("This answer is for a session that no longer exists");
    const incarnation = input.incarnation ?? current;
    const row = this.actionStore.findByRequest(input.sessionId, incarnation, kind, requestId);
    if (!row) {
      // The ledger does not track it. A stock client's answer goes to the runtime as usual; attach fails closed.
      if (strict) throw conflict("This prompt is not waiting for this client");
      return { kind: "forward" };
    }
    if (input.generation !== undefined && input.generation !== row.generation) {
      throw conflict("This answer is for the session's previous placement; the request was offered again", row);
    }

    const outcome = this.outcomeFromLiveAnswer(kind, input.params);
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
      const claimed = this.actionStore.claim(
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
          now: this.now(),
        },
      );
      if (!claimed) throw conflict("Another responder took this action first", this.actionStore.get(row.id));
      seq += 1;
    } else if (row.live_connection !== input.connectionId) {
      throw conflict("Another responder owns this action", row);
    }

    if (!this.actionStore.complete(row.id, { seq, liveConnection: input.connectionId }, outcome)) {
      const latest = this.actionStore.get(row.id);
      if (latest && (latest.state === "completed" || latest.state === "failed") && latest.result_hash === outcome.resultHash) {
        return { kind: "respond", response: { success: true } };
      }
      throw conflict("This action changed while the answer was being recorded", latest);
    }
    this.emit({ type: "resolved", sessionId: row.session_id, actionId: row.id });
    try {
      return { kind: "respond", response: await this.forward(row.id) };
    } catch {
      // The answer is recorded and delivery is retried. Failing the client here would make the stock SDK send a
      // fallback answer (user-not-available / cancel) that conflicts with the one already recorded.
      return { kind: "respond", response: { success: true } };
    }
  }

  async onAttached(input: AttachInput): Promise<readonly RuntimeSessionEvent[]> {
    const detached = this.detachedSince(input.responder.connectionId, input.sessionId);
    const attached = this.current(input.sessionId);
    if (!attached || (input.incarnation !== undefined && input.incarnation !== attached.incarnation)) return [];
    try {
      await this.reconcile(input.sessionId);
    } catch (error) {
      this.log.debug("Reconciliation on attach skipped", { sessionId: input.sessionId, error: (error as Error).message });
    }
    // The connection (or just this attachment) may have gone away while reconciling: never claim for it then.
    // A later attach of the same connection captures the new generation and replays normally.
    if (detached()) return [];
    // Nor for a session that was deleted (or replaced by a new one with the same ID) meanwhile.
    if (this.current(input.sessionId)?.incarnation !== attached.incarnation) return [];
    const replay: RuntimeSessionEvent[] = [];
    for (const row of this.actionStore.listBySession(input.sessionId, attached.incarnation, ["pending"])) {
      if (!isEligible(input.responder, { kind: row.kind, tool: row.tool })) continue;
      if (row.kind === "tool" && row.tool && this.deps.platformTools()?.get?.(row.tool, row.environment)) continue;
      if (input.responder.kind === "sdk" && lacksRawRequest(row)) continue;
      if (heldBefore(row, input.responder.connectionId)) continue;
      if (this.claimLive(row, input.responder)) {
        const event = parseJson<RuntimeSessionEvent>(row.event);
        if (event) replay.push(event);
      }
    }
    if (replay.length > 0) this.log.info("Replaying waiting actions to a resumed client", { sessionId: input.sessionId, count: replay.length });
    return replay;
  }

  onDetached(connectionId: string, sessionId?: string): void {
    this.#bumpDetachGeneration(sessionId === undefined ? connectionId : `${connectionId}\u0000${sessionId}`);
    const now = this.now();
    for (const row of this.actionStore.listByLiveConnection(connectionId)) {
      if (sessionId !== undefined && row.session_id !== sessionId) continue;
      this.orphan(row, "The client handling this action disconnected before it answered", now);
    }
  }

  #bumpDetachGeneration(key: string): void {
    const next = (this.detachGenerations.get(key) ?? 0) + 1;
    // Re-inserted so the oldest counters are the ones evicted.
    this.detachGenerations.delete(key);
    this.detachGenerations.set(key, next);
    if (this.detachGenerations.size > MAX_REMEMBERED) this.detachGenerations.delete(this.detachGenerations.keys().next().value!);
  }

  /** Snapshots a connection's detach counters; the returned check is true once it (or this attachment) detached since. */
  protected detachedSince(connectionId: string, sessionId: string): () => boolean {
    const connectionKey = connectionId;
    const attachmentKey = `${connectionId}\u0000${sessionId}`;
    const before = [this.detachGenerations.get(connectionKey) ?? 0, this.detachGenerations.get(attachmentKey) ?? 0];
    return () => (this.detachGenerations.get(connectionKey) ?? 0) !== before[0] || (this.detachGenerations.get(attachmentKey) ?? 0) !== before[1];
  }

  /**
   * The session was deleted: its open actions can never be answered. They are cancelled (later claims and results
   * are refused) and recorded answers that were never delivered stop being retried. Only the deleted incarnation is
   * affected: a session that later reuses the ID records its own actions.
   */
  onSessionDeleted(sessionId: string, incarnation?: string): void {
    const now = this.now();
    const current = this.current(sessionId)?.incarnation;
    const deleted = (row: ActionRow) => (incarnation !== undefined ? row.incarnation === incarnation : row.incarnation !== current);
    for (const row of this.actionStore.listByAnyIncarnation(sessionId, OPEN_STATES)) {
      if (!deleted(row)) continue;
      if (this.actionStore.transition(row.id, { states: OPEN_STATES, seq: row.claim_seq }, { state: "cancelled", reason: "The session was deleted", clearClaim: true, forwarded: true, now })) {
        this.emit({ type: "resolved", sessionId, actionId: row.id });
      }
    }
    for (const row of this.actionStore.listByAnyIncarnation(sessionId, ANSWERED_STATES)) {
      if (deleted(row) && !row.forwarded) this.actionStore.markForwarded(row.id, now, "Not delivered: the session was deleted");
    }
    if (current === undefined) {
      const timer = this.notifyTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      this.notifyTimers.delete(sessionId);
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
    const current = this.current(sessionId);
    if (!current) return;
    const now = this.now();
    const carried = new Set(options.carried ?? []);
    const epochKey = `${sessionId}\u0000${current.incarnation}`;
    if ((this.placements.get(epochKey) ?? -1) < generation) {
      this.placements.delete(epochKey);
      this.placements.set(epochKey, generation);
      if (this.placements.size > MAX_REMEMBERED) this.placements.delete(this.placements.keys().next().value!);
    }
    for (const row of this.actionStore.listBySession(sessionId, current.incarnation, OPEN_STATES)) {
      if (row.generation >= generation) continue;
      const owned = OWNED_STATES.includes(row.state);
      if (row.state === "pending" || carried.has(runtimeRequestId(row)) || (owned && row.responder_type === "platform")) {
        // A live claim carried into the new placement is held there.
        const liveClaimants = owned && row.live_connection ? withLiveClaimant(row, row.live_connection, generation) : undefined;
        this.actionStore.moveToGeneration(row.id, row.claim_seq, { generation, state: row.state, clearClaim: false, reason: row.reason, ...(liveClaimants ? { liveClaimants } : {}), now });
        continue;
      }
      const state: ActionState = row.kind === "tool" ? "needs_reconciliation" : "pending";
      const reason = row.kind !== "tool" ? null : owned ? MOVED_WHILE_RUNNING : row.reason;
      if (!this.actionStore.moveToGeneration(row.id, row.claim_seq, { generation, state, clearClaim: true, reason, now })) continue;
      if (state === "pending") {
        this.scheduleNotify(row);
      } else if (owned) {
        this.log.warn("Action needs reconciliation", { actionId: row.id, sessionId, tool: row.tool ?? undefined, reason: "the session moved to a new placement" });
        this.emit({ type: "pending", sessionId, actionId: row.id });
      }
    }
    // Recorded answers for carried requests go to the new placement, even ones the old placement acknowledged: the
    // new one still waits for them.
    for (const row of this.actionStore.listBySession(sessionId, current.incarnation, ANSWERED_STATES)) {
      if (carried.has(runtimeRequestId(row))) this.adoptAnswered(row, generation, now);
    }
  }

  /** A newer placement waits for a request answered under an older one: the recorded answer goes to it. */
  protected adoptAnswered(row: ActionRow, generation: number, now: number): void {
    if (row.generation >= generation || !ANSWERED_STATES.includes(row.state)) return;
    if (!this.actionStore.adoptAnswer(row.id, row.generation, generation, now)) return;
    this.log.info("Delivering a recorded answer to the session's new placement", { actionId: row.id, sessionId: row.session_id, generation });
    void this.forward(row.id).catch(() => undefined);
  }

  releaseLiveClaim(actionId: string, claimToken: string): void {
    const row = this.actionStore.get(actionId);
    if (!row || row.claim_token_hash !== hashSecret(claimToken)) return;
    // The router never wrote the event, so no handler ran: the action is safely offered again.
    if (this.actionStore.transition(row.id, { states: OWNED_STATES, seq: row.claim_seq }, { state: "pending", clearClaim: true, now: this.now() })) {
      this.scheduleNotify(row);
    }
  }
}
