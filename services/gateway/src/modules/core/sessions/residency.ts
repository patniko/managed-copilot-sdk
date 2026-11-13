// Upstream residency: opening, restoring, and bounding runtime connections, and ending turns a lost connection cut.
import { randomUUID } from "node:crypto";
import { isManagedCopilotError, ManagedCopilotError, type Placement } from "@managed-copilot/protocol";
import { PENDING_LIST_METHODS, type ActionsService, type RuntimeSessionEvent } from "../../durable/contract.js";
import type { ResolvedEnvironment, SessionRecord } from "../contracts.js";
import type { AdmittedConfig } from "../ledger.js";
import { RpcError, streamTransport } from "../rpc.js";
import { RuntimeUpstream } from "../runtime.js";
import type { ClientPeer, LiveSession, NotificationOrigin, TurnEnding } from "./types.js";
import {
  MAX_REOPENS,
  upstreamTimings,
  EXPIRED,
  INTERRUPTED_TURN,
  unfinished,
  UNKNOWN_SESSION,
  workspaceOnly,
  wantsReopen,
  duration,
  withoutHostMemory,
} from "./support.js";
import { SessionAttachments } from "./attachments.js";

export abstract class SessionResidency extends SessionAttachments {
  // Implemented by later layers of SessionManager.
  protected abstract ownerToken(live: LiveSession): Promise<{ token: string; expiresAt?: number; app?: string }>;
  protected abstract deliverEvent(live: LiveSession, event: RuntimeSessionEvent, origin?: NotificationOrigin): Promise<void>;

  // ------------------------------------------------------------------------------------------------------------
  // Residency

  protected register(record: SessionRecord, environment: ResolvedEnvironment, tokenRegistrationId: string): LiveSession {
    const live: LiveSession = {
      id: record.id,
      ownerId: record.ownerId,
      placement: record.placement,
      environment,
      tokenRegistrationId,
      upstream: undefined,
      ready: false,
      sandbox: undefined,
      attachments: new Map(),
      creator: undefined,
      presences: new Map(),
      registrations: Promise.resolve(),
      unreconciled: false,
      inflight: undefined,
      requests: 0,
      lastRequestAt: undefined,
      queue: Promise.resolve(),
      ending: new AbortController(),
      residency: undefined,
      deleting: false,
      closedWhileDeleting: false,
      cutover: undefined,
      waits: new Set(),
      held: [],
      resumeExtras: undefined,
      moves: 0,
      hidden: undefined,
      sealedSource: undefined,
      platformCalls: new Map(),
    };
    this.live.set(record.id, live);
    return live;
  }

  /** The live state for a ledger session, created lazily (after a gateway restart, sessions start non-resident). */
  protected liveFor(sessionId: string): LiveSession {
    const existing = this.live.get(sessionId);
    if (existing) {
      if (existing.deleting) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
      return existing;
    }
    const record = this.get(sessionId);
    if (!record || record.state === "deleting") throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
    // Every agent operation (send, resume, abort, CLI attach, promotion) needs a runtime, and this session never has one.
    if (record.kind === "workspace") throw workspaceOnly(sessionId);
    const environment = this.options.environments.forSession(record);
    return this.register(record, environment, `mc-${randomUUID()}`);
  }

  protected attachedLive(peer: ClientPeer, sessionId: string, method: string): LiveSession {
    const live = this.live.get(sessionId);
    if (live?.attachments.has(peer.id) && !live.deleting) return live;
    const record = this.get(sessionId);
    if (!record || record.ownerId !== peer.principal.accountId || record.state === "deleting") throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
    throw new ManagedCopilotError("invalid_request", `Resume session ${sessionId} on this client before calling ${method}`);
  }

  /**
   * Runs one registration change of a session (a client resume, a tools update) at a time. Taken before residency
   * (`#serialize`), never inside it, so it cannot deadlock with a restore.
   */
  protected async registering<T>(live: LiveSession, work: () => Promise<T>): Promise<T> {
    const previous = live.registrations;
    let release!: () => void;
    live.registrations = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await work();
    } finally {
      release();
    }
  }

  /**
   * After a registration that did not commit (`unreconciled`): the runtime may have applied it, so the session is not
   * routable until it was resumed with the registrations in effect, which this does now (unless a fenced cutover will:
   * its destination opens with them, and a source it leaves unreconciled stays unroutable). A failed attempt is
   * retried by the session's next request.
   */
  protected async reconcile(live: LiveSession): Promise<void> {
    if (!live.unreconciled || live.deleting || live.cutover?.fenced || this.live.get(live.id) !== live) return;
    try {
      await this.resident(live);
    } catch (error) {
      this.log.warn("Resuming a session again after a failed registration failed; its next request retries", { sessionId: live.id, error: (error as Error).message });
    }
  }

  /** Marks the session as possibly holding a registration that did not commit on `upstream` (see `#reconcile`). */
  protected unreconciled(live: LiveSession, upstream: RuntimeUpstream): void {
    if (live.upstream !== upstream) return;
    live.unreconciled = true;
    live.ready = false;
  }

  /**
   * Runs one create/resume/restore for a session at a time. Concurrent callers wait for it instead of using an
   * upstream on which the session is not open yet.
   */
  protected serialize(live: LiveSession, work: () => Promise<RuntimeUpstream>): Promise<RuntimeUpstream> {
    const residency = (async () => {
      const upstream = await work();
      if (live.deleting) throw new ManagedCopilotError("not_found", `Session ${live.id} was deleted`, { sessionId: live.id });
      return upstream;
    })();
    live.residency = residency;
    void residency
      .finally(() => {
        if (live.residency === residency) live.residency = undefined;
      })
      .catch(() => undefined);
    return residency;
  }

  /** Connects the session's upstream (shared runtime, or its sandbox) without opening the session on it. */
  protected async connect(live: LiveSession, moves = live.moves): Promise<RuntimeUpstream> {
    live.ready = false;
    // Still connected (the session needs resuming there, e.g. after a registration that did not commit): reuse it.
    if (live.upstream && !live.upstream.closed) return live.upstream;
    if (live.placement === "sandbox") {
      const sandboxes = this.sandboxes;
      if (!sandboxes) throw new ManagedCopilotError("capability_unavailable", "The sandbox service is not available on this gateway");
      await sandboxes.ensureRunning?.(live.id);
      return this.openSandbox(live);
    }
    const shared = this.options.sharedRuntime;
    if (!shared) throw new ManagedCopilotError("capability_unavailable", "Shared environments are disabled on this gateway");
    const upstream = await shared.ready();
    // A cutover that fenced (and maybe committed) while the runtime came back owns the session's routing now.
    if (live.moves === moves) live.upstream = upstream;
    return upstream;
  }

  /**
   * Returns a connected upstream where the session is open, resuming it with its stored admitted configuration when
   * the runtime restarted, the sandbox stopped, or the gateway restarted. A fence that went up meanwhile holds every
   * caller (not only the one that started the restore) until the cutover commits or aborts, and then the session's
   * owner after it is found afresh.
   */
  protected resident(live: LiveSession): Promise<RuntimeUpstream> {
    if (live.deleting) return Promise.reject(new ManagedCopilotError("not_found", `Session ${live.id} was not found`, { sessionId: live.id }));
    if (live.upstream && !live.upstream.closed && live.ready) return Promise.resolve(live.upstream);
    const moves = live.moves;
    const residency = live.residency ?? this.#restore(live);
    return residency.then((upstream) => (live.moves !== moves || live.cutover?.fenced ? this.resident(live) : upstream));
  }

  /** Resumes the session upstream with its stored configuration and registrations. */
  #restore(live: LiveSession): Promise<RuntimeUpstream> {
    const moves = live.moves;
    return this.serialize(live, async () => {
      const upstream = await this.connect(live, moves);
      if (live.moves !== moves) return upstream;
      const admitted = this.ledger.admitted(live.id);
      if (!admitted) throw new ManagedCopilotError("state_restore_failed", `Session ${live.id} has no stored configuration to resume with`);
      const extras = live.resumeExtras;
      // The session's committed registrations as the gateway owns them, so callbacks stay required with no client
      // attached (a registration still on its way, or one that failed, never reaches a restored runtime).
      const wire = this.registrations(live, undefined, true);
      const params = await this.withVaultHeaders(
        live.id,
        {
          ...admitted.params,
          sessionId: live.id,
          tools: [...wire.tools, ...this.platformToolDeclarations(live)],
          ...wire.flags,
          ...(live.placement === "shared" ? { gitHubTokenProviderRegistrationId: live.tokenRegistrationId } : {}),
          ...this.resumeExtras(live, admitted.params),
        },
        live.placement,
      );
      const prepared = await this.prepare(live, "session.resume", params);
      await this.sealSettled(live, upstream);
      // A fence that went up during the restore wins (even one whose cutover has ended since): nothing is sent to a
      // runtime after it, and callers find the session's owner afresh.
      if (live.moves !== moves || live.cutover?.fenced) return upstream;
      try {
        await this.resumeUpstream(live, upstream, prepared);
        await this.opened(live, upstream, admitted.optionsPatch);
      } catch (error) {
        throw error instanceof RpcError ? new ManagedCopilotError("state_restore_failed", `Session ${live.id} could not be restored: ${error.message}`) : error;
      }
      if (live.resumeExtras === extras) live.resumeExtras = undefined;
      // The runtime has the registrations in effect again.
      live.unreconciled = false;
      // A turn the lost connection cut ends before the session takes new work.
      if (live.moves === moves && !live.cutover?.fenced) await this.settleTurn(live, upstream);
      // A cutover fenced while this restore ran keeps the session fenced.
      if (live.moves === moves && !live.cutover?.fenced) live.ready = true;
      this.log.info("Session resumed upstream", { sessionId: live.id, upstream: upstream.info.id });
      return upstream;
    });
  }

  /** Updates the stored admitted configuration used to restore the session. */
  protected persist(sessionId: string, update: (stored: AdmittedConfig) => AdmittedConfig): void {
    const stored = this.ledger.admitted(sessionId);
    if (stored) this.ledger.update(sessionId, { admitted: update(stored) });
  }

  /**
   * Records a model selection: restores and placement changes select it, and a model an earlier option change set no
   * longer overrides it (restores apply option changes after the session's params).
   */
  protected recordModel(sessionId: string, model: string): void {
    this.ledger.update(sessionId, { model });
    this.persist(sessionId, (stored) => {
      const { model: _patched, ...optionsPatch } = stored.optionsPatch;
      const { model: _requested, ...requestedOptions } = stored.requestedOptions ?? {};
      const { requestedOptions: _previous, ...rest } = stored;
      return { ...rest, params: { ...stored.params, model }, optionsPatch, ...(Object.keys(requestedOptions).length > 0 ? { requestedOptions } : {}) };
    });
  }

  protected async openSandbox(live: LiveSession): Promise<RuntimeUpstream> {
    const sandboxes = this.sandboxes!;
    const inference = await this.sandboxInference(live.id);
    for (let reopen = 0; ; reopen++) {
      const handle = await sandboxes.openRuntime(live.id, { resolveToken: () => this.ownerToken(live).then((credential) => credential.token), ...(inference ? { inference } : {}) });
      let upstream: RuntimeUpstream | undefined;
      try {
        upstream = await RuntimeUpstream.open({ id: `sandbox:${live.id}`, kind: "sandbox", sandboxId: live.id }, streamTransport(handle.stream), {
          token: handle.connectionToken,
          handlers: this.runtimeHandlers,
          log: this.log,
        });
        const opened = upstream;
        if (handle.initialize) await this.bounded(live, opened, "the sandbox runtime's setup", () => handle.initialize!((method, params) => opened.request(method, params)));
      } catch (error) {
        upstream?.close();
        handle.close?.();
        if (reopen < MAX_REOPENS && wantsReopen(error)) {
          this.log.info("The sandbox restarted its runtime; opening it again", { sessionId: live.id });
          continue;
        }
        throw error;
      }
      // Routed only once open: a connection that failed to open never becomes the session's (or reports it stopped).
      live.sandbox = handle;
      live.upstream = upstream;
      return upstream;
    }
  }

  /**
   * Resumes the session on `upstream`. The stock runtime persists a session with its first turn, so a session that
   * never ran one is unknown to a restarted runtime (shared runtime restart, sandbox idle stop): it is created again
   * with the same ID and configuration. A session whose history the runtime lost still fails.
   */
  protected async resumeUpstream(live: LiveSession, upstream: RuntimeUpstream, params: Record<string, unknown>): Promise<unknown> {
    // On a source an aborted cutover sealed, what arrives before this resume is answered is still the suspend's
    // handoff; the resumed session's own output follows the answer (verified on runtime 1.0.103).
    const sealed = live.sealedSource?.upstream === upstream ? live.sealedSource : undefined;
    const reopened = () => {
      if (sealed && live.sealedSource === sealed) live.sealedSource = undefined;
    };
    try {
      return await this.bounded(live, upstream, "session.resume", () => upstream.request("session.resume", params, { onSettle: reopened }));
    } catch (error) {
      // Only for a session that still exists: never one deleted meanwhile (its runtime state is gone on purpose).
      const current = this.get(live.id);
      if (!(error instanceof RpcError) || !UNKNOWN_SESSION.test(error.message) || !current || live.deleting || current.lastTurn) throw error;
      this.log.info("The runtime has no state for a session that never ran a turn; creating it again", { sessionId: live.id });
      // With the session's model when this resume names none (the runtime would pick its default otherwise).
      const create = params["model"] === undefined && current.model ? { ...params, model: current.model } : params;
      return this.bounded(live, upstream, "session.create", () => upstream.request("session.create", create));
    }
  }

  /**
   * Waits for one answer of a session's runtime on its registration path (create, resume, restore, a tools update).
   * These steps run one at a time per session, so an answer that never comes (a half-open sandbox stream after a gateway
   * handover) would hold every later resume of the session. Each `upstreamTimings.answerMs` without the answer, the
   * connection is probed with `ping`. One that answers is still working on the step, which may yet apply: the wait goes
   * on, because giving up then would let the step land after whatever the session is sent next (a resume withdrawing
   * hooks after the reconcile that restored them). One that does not answer is closed, so nothing it carried can apply
   * later (a sandbox runtime is restarted before it serves the session again, and the shared runtime's supervisor
   * restarts it), and the caller fails with `timeout`, which it can retry.
   */
  protected async bounded<T>(live: LiveSession, upstream: RuntimeUpstream, step: string, run: () => Promise<T>): Promise<T> {
    // A sandbox runtime connection serves only this session: deleting the session or stopping the gateway closes it,
    // which ends the wait (the sandbox is deleted, or its runtime restarts before it serves again, so nothing the step
    // carried can apply later). The shared runtime serves every shared session and is not closed for one of them.
    const ending = live.ending.signal;
    const owned = upstream.info.kind === "sandbox";
    const abandon = () => {
      if (owned && !upstream.closed) upstream.close();
    };
    if (owned && ending.aborted) {
      abandon();
      throw ending.reason;
    }
    ending.addEventListener("abort", abandon, { once: true });
    try {
      const answer = run();
      for (let waited = upstreamTimings.answerMs; ; waited += upstreamTimings.answerMs) {
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<typeof EXPIRED>((resolve) => {
          timer = setTimeout(() => resolve(EXPIRED), upstreamTimings.answerMs);
        });
        let outcome: T | typeof EXPIRED;
        try {
          outcome = await Promise.race([answer, expired]);
        } catch (error) {
          if (owned && ending.aborted) throw ending.reason;
          throw error;
        } finally {
          clearTimeout(timer);
        }
        if (outcome !== EXPIRED) return outcome;
        if (await this.#probe(live, upstream)) {
          // The close settled it (rejected): nothing is left that could still apply.
          answer.catch(() => undefined);
          if (owned && ending.aborted) throw ending.reason;
          throw new ManagedCopilotError(
            "timeout",
            `The runtime of session ${live.id} did not answer ${step} within ${duration(waited)} and its connection stopped responding, so the gateway closed it. Try again; the session reconnects.`,
            { sessionId: live.id, step },
          );
        }
        this.log.warn("A session's runtime is still working on a step; waiting for its answer", { sessionId: live.id, step, waitedMs: waited });
      }
    } finally {
      ending.removeEventListener("abort", abandon);
    }
  }

  /** Whether a runtime connection that left a step unanswered is gone: closed, or closed now for not answering a `ping`. */
  async #probe(live: LiveSession, upstream: RuntimeUpstream): Promise<boolean> {
    if (upstream.closed) return true;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<typeof EXPIRED>((resolve) => {
      timer = setTimeout(() => resolve(EXPIRED), upstreamTimings.probeMs);
    });
    // Any answer, even an error, shows the connection works.
    const answered = upstream.request("ping", { message: "managed-copilot" }).then(
      () => true,
      () => !upstream.closed,
    );
    let outcome: boolean | typeof EXPIRED;
    try {
      outcome = await Promise.race([answered, expired]);
    } finally {
      clearTimeout(timer);
    }
    if (outcome === true) return false;
    if (!upstream.closed) {
      this.log.warn("A session's runtime connection stopped responding; closing it so the session connects again", { sessionId: live.id, upstream: upstream.info.id });
      upstream.close();
    }
    return true;
  }

  protected async prepare(live: LiveSession, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const routed = await this.routeInference(live, withoutHostMemory(live, params, this.log), live.placement);
    return live.sandbox?.prepareSessionParams ? await live.sandbox.prepareSessionParams(method, routed) : routed;
  }

  /** Before resuming on a source an aborted cutover sealed: its answers to the sealing calls come first. */
  protected async sealSettled(live: LiveSession, upstream: RuntimeUpstream): Promise<void> {
    const sealed = live.sealedSource;
    if (sealed?.upstream === upstream) await sealed.settled;
  }

  /** Waits for an open cutover's fence to lift (the session then has its next owner). */
  protected async fenceLifted(live: LiveSession): Promise<void> {
    if (live.cutover?.fenced) await live.residency?.catch(() => undefined);
  }

  /** Where a session's history comes from: a promotable session started on shared placement, wherever it runs now. */
  protected historyPlacement(live: LiveSession): Placement {
    return live.environment.type === "promotable" ? "shared" : live.placement;
  }

  /**
   * Extra params for a resume: an aborted cutover's, and `continuePendingWork` while durable still owns something the
   * runtime may await (otherwise the runtime drops its pending tool calls on resume). A caller's own choice stands.
   */
  protected resumeExtras(live: LiveSession, params: Record<string, unknown>): Record<string, unknown> | undefined {
    const extras = live.resumeExtras;
    if (params["continuePendingWork"] !== undefined || extras?.["continuePendingWork"] !== undefined || !this.#hasOpenActions(live.id)) return extras;
    return { ...extras, continuePendingWork: true };
  }

  #hasOpenActions(sessionId: string): boolean {
    const actions = this.actions as (ActionsService & { hasOpenActions?(sessionId: string, options?: { readonly incarnation?: string }): boolean }) | undefined;
    if (!actions) return false;
    try {
      // This incarnation's: actions an earlier session with the same ID left behind are not this session's work.
      return actions.hasOpenActions ? actions.hasOpenActions(sessionId, this.incarnationOf(sessionId)) : actions.list(sessionId, { open: true, ...this.incarnationOf(sessionId) }).length > 0;
    } catch (error) {
      // Continuing pending work that turns out not to exist is harmless; dropping it is not.
      this.log.warn("Could not check the session's open actions; continuing its pending work", { sessionId, error: (error as Error).message });
      return true;
    }
  }

  protected incarnationOf(sessionId: string): { readonly incarnation?: string } {
    const incarnation = this.get(sessionId)?.incarnation;
    return incarnation ? { incarnation } : {};
  }

  protected async opened(live: LiveSession, upstream: RuntimeUpstream, optionsPatch: Record<string, unknown>): Promise<void> {
    // Sandboxes install the owner's credential here, then select a requested agent (the runtime resolves agents only
    // for authenticated sessions, so the sandbox module defers `agent` out of create/resume params).
    const sandbox = live.sandbox;
    if (sandbox?.sessionOpened) await this.bounded(live, upstream, "the session's credential setup", () => sandbox.sessionOpened!(live.id));
    if (Object.keys(optionsPatch).length > 0) {
      const result = await this.bounded(live, upstream, "session.options.update", () =>
        upstream.request<{ success?: boolean; error?: string }>("session.options.update", { ...optionsPatch, sessionId: live.id }),
      );
      if (result && result.success === false) throw new ManagedCopilotError("internal", `The runtime rejected the session lockdown: ${result.error ?? "unknown error"}`);
    }
  }

  protected platformToolDeclarations(live: LiveSession, placement: Placement = live.placement): Record<string, unknown>[] {
    return this.platformToolsFor(live.environment, placement).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      skipPermission: tool.skipPermission,
      ...(tool.overridesBuiltInTool ? { overridesBuiltInTool: true } : {}),
    }));
  }

  protected onUpstreamClosed(upstream: RuntimeUpstream): void {
    for (const live of this.live.values()) {
      const cutover = live.cutover;
      if (cutover && !cutover.done && cutover.destination?.upstream === upstream) {
        this.log.warn("A promotion destination closed before commit", { sessionId: live.id });
        cutover.destination.sandbox.close?.();
        cutover.destination = undefined;
        cutover.destinationBuffer.length = 0;
        continue;
      }
      if (live.upstream !== upstream) continue;
      live.upstream = undefined;
      if (live.placement === "sandbox") {
        live.sandbox?.close?.();
        live.sandbox = undefined;
      }
      live.ready = false;
      // Held completions wait for the owner's events; outside a cutover, losing the owner's runtime fails them.
      if (!live.cutover) for (const held of live.held.splice(0)) held.reject(new RpcError(-32000, "The session's runtime connection closed before the turn completed", { code: "state_restore_failed" }));
      // A session being deleted ends with `deleted`, not `stopped`; if its deletion fails, the close is handled then.
      if (live.deleting) live.closedWhileDeleting = true;
      else this.emitLifecycle(live.id, "stopped");
      // Its running turn cannot finish without this connection (on stock 1.0.103 a sandbox's inference provider goes
      // with it, and a runtime that restarts loses its turns): it ends now, for the clients still waiting on it.
      if (!live.deleting && !live.cutover && !this.stopped) this.endLostTurn(live);
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Turns a lost runtime connection cut

  /**
   * Ends the session's unfinished turn (one whose root `session.idle` has not arrived, including one that already
   * reported an error) when the runtime connection it needed was lost and nothing can carry it: work durable owns (a
   * pending tool call or permission) survives in a resumed runtime (`continuePendingWork`, verified on 1.0.103), and an
   * external shared runtime keeps running its turns. The ending is what the runtime would send: a root `session.error`
   * and `session.idle`, so waits settle, observers (`sessions.subscribe`) see the turn end, and the ledger records it
   * `failed`. A turn the session's restore finds is still running continues (`#settleTurn`).
   */
  protected endLostTurn(live: LiveSession, turnId?: string): void {
    void this.#endTurn(live, (record) => (turnId === undefined || record.lastTurn?.turnId === turnId) && this.#lostTurnEnds(live));
  }

  /** Whether a turn whose runtime connection was lost ends: nothing carries it (durable's pending work, an external runtime). */
  #lostTurnEnds(live: LiveSession): boolean {
    if (live.placement === "shared" && this.options.sharedRuntime?.external) return false;
    return !this.#hasOpenActions(live.id);
  }

  /**
   * After a restore, a turn the ledger has not seen end is checked against the runtime that now owns the session:
   * one it still processes, or whose pending work durable owns and the runtime still awaits, continues; any other ended
   * while the connection was lost. Only answers decide: a check the runtime cannot answer leaves the turn as it is, and
   * a connection that is gone or stopped answering fails the restore (the session's next request tries again). The end
   * applies only while that runtime still owns the session (no cutover moved it meanwhile).
   */
  protected async settleTurn(live: LiveSession, upstream: RuntimeUpstream): Promise<void> {
    const turn = this.get(live.id)?.lastTurn;
    if (!unfinished(turn)) return;
    const moves = live.moves;
    const ask = <T,>(method: string): Promise<T | undefined> => this.#check<T>(live, upstream, method);
    if ((await ask<{ processing?: unknown }>("session.metadata.isProcessing"))?.processing !== false) return;
    if (this.#hasOpenActions(live.id)) {
      const [tools, permissions] = await Promise.all([ask<{ items?: unknown[] }>(PENDING_LIST_METHODS.tool), ask<{ items?: unknown[] }>(PENDING_LIST_METHODS.permission)]);
      if (!Array.isArray(tools?.items) || !Array.isArray(permissions?.items) || tools.items.length + permissions.items.length > 0) return;
    }
    const owned = (record: SessionRecord) => record.lastTurn?.turnId === turn.turnId && live.moves === moves && !live.cutover?.fenced && live.upstream === upstream && !upstream.closed;
    // An external shared runtime kept running the turn while the gateway was away: it ended as the runtime recorded.
    if (live.placement === "shared" && this.options.sharedRuntime?.external === true) {
      const outcome = await this.#unseenOutcome(live, upstream, turn.turnId);
      if (outcome) await this.#endTurn(live, owned, outcome);
      return;
    }
    await this.#endTurn(live, owned, "interrupted");
  }

  /** A runtime's answer to a check: undefined when it answered with an error; throws when its connection is gone or silent. */
  async #check<T>(live: LiveSession, upstream: RuntimeUpstream, method: string, params: Record<string, unknown> = {}): Promise<T | undefined> {
    try {
      return await this.bounded(live, upstream, method, () => upstream.request<T>(method, { ...params, sessionId: live.id }));
    } catch (error) {
      if (upstream.closed || (isManagedCopilotError(error) && error.code === "timeout")) throw error;
      return undefined;
    }
  }

  /**
   * How a turn an external runtime ran unseen ended, from the history it persisted after the turn's root `user.message`:
   * its own root `session.error`, an abort (cancelled), or evidence it completed (a root `session.idle`, a final reply
   * that requested no tools whose `assistant.turn_end` no later model call followed, or a later run). A turn the runtime
   * no longer processes and recorded no ending for, or no longer has, was lost (the runtime restarted): it is
   * interrupted. Undefined when the history cannot be read.
   */
  async #unseenOutcome(live: LiveSession, upstream: RuntimeUpstream, turnId: string): Promise<TurnEnding | undefined> {
    const events = (await this.#check<{ events?: RuntimeSessionEvent[] }>(live, upstream, "session.getMessages"))?.events;
    if (!Array.isArray(events)) return undefined;
    const start = events.findIndex((event) => event.type === "user.message" && !event.agentId && String(event.data?.["messageId"] ?? event.id) === turnId);
    if (start < 0) return "interrupted";
    const after = events.slice(start + 1).filter((event) => !event.agentId);
    // Only a new run ends this one: steering, autopilot continuations, and skill prompts are user messages inside it.
    const next = after.findIndex(
      (event) =>
        event.type === "user.message" && event.data?.["delivery"] !== "steering" && event.data?.["isAutopilotContinuation"] !== true && !String(event.data?.["source"] ?? "").startsWith("skill-"),
    );
    const own = next < 0 ? after : after.slice(0, next);
    const error = own.find((event) => event.type === "session.error");
    if (error) return { error };
    if (own.some((event) => event.type === "abort" || (event.type === "session.idle" && event.data?.["aborted"] === true))) return "cancelled";
    if (next >= 0 || own.some((event) => event.type === "session.idle")) return "completed";
    const reply = own.findLastIndex((event) => event.type === "assistant.message");
    const requested = own[reply]?.data?.["toolRequests"];
    const final = reply >= 0 && (!Array.isArray(requested) || requested.length === 0);
    // The reply's own model call ended, and no later one started (a later call that ended without a reply was cut).
    const ended = own.slice(reply + 1);
    if (final && ended.some((event) => event.type === "assistant.turn_end") && !ended.some((event) => event.type === "assistant.turn_start")) return "completed";
    return "interrupted";
  }

  /**
   * Ends the running turn (if `applies` still holds once the session's earlier events were tracked) with the root
   * events the runtime would have sent, delivered like the runtime's own: an interruption (a `session.error` the
   * platform reports), or how a runtime that ran it unseen ended it (its own error, an abort, a completion).
   */
  #endTurn(live: LiveSession, applies: (record: SessionRecord) => boolean, outcome: TurnEnding = "interrupted"): Promise<void> {
    const end = async (): Promise<void> => {
      const record = this.get(live.id);
      const turn = record?.lastTurn;
      if (!record || !unfinished(turn) || live.deleting || this.live.get(live.id) !== live || !applies(record)) return;
      const now = new Date().toISOString();
      if (outcome === "interrupted") {
        this.log.warn("Ending a turn whose runtime connection was lost", { sessionId: live.id, turnId: turn.turnId });
        const error: RuntimeSessionEvent = { id: randomUUID(), timestamp: now, parentId: null, ephemeral: true, type: "session.error", data: { errorType: "interrupted", message: INTERRUPTED_TURN, originatingMessageId: turn.turnId } };
        await this.deliverEvent(live, error);
      } else if (typeof outcome === "object") {
        await this.deliverEvent(live, outcome.error);
      }
      await this.deliverEvent(live, { id: randomUUID(), timestamp: now, parentId: null, ephemeral: true, type: "session.idle", data: outcome === "cancelled" ? { aborted: true } : {} });
    };
    const ended = live.queue.then(end);
    live.queue = ended.catch((error: unknown) => this.log.warn("Ending a lost turn failed", { sessionId: live.id, error: (error as Error).message }));
    return live.queue;
  }
}
