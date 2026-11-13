// Placement cutover: moving a live session to its promoted placement.
import { ManagedCopilotError } from "@managed-copilot/protocol";
import { admitOptionsUpdate, admitSession, type AdmissionContext } from "../admission.js";
import type { PlacementCutover, SandboxRuntimeHandle, SessionRecord } from "../contracts.js";
import { streamTransport } from "../rpc.js";
import { RuntimeUpstream } from "../runtime.js";
import type { LiveSession, CutoverState } from "./types.js";
import { MAX_REOPENS, unfinished, wantsReopen, cutoverClosed, storedParams } from "./support.js";
import { SessionUpstream } from "./upstream.js";

export abstract class SessionCutover extends SessionUpstream {
  // ------------------------------------------------------------------------------------------------------------
  // Placement cutover (promotion)

  async cutover(sessionId: string, options: { readonly generation: number }): Promise<PlacementCutover> {
    const notFound = () => new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
    const record = this.get(sessionId);
    if (!record || record.state === "deleting") throw notFound();
    const live = this.liveFor(sessionId);
    if (live.deleting) throw notFound();
    if (live.cutover) throw new ManagedCopilotError("promotion_busy", `Session ${sessionId} is already moving`, { sessionId });
    if (record.generation !== options.generation) {
      throw new ManagedCopilotError("conflict", `Session ${sessionId} is at placement generation ${record.generation}, not ${options.generation}`, { sessionId, generation: record.generation });
    }
    if (live.placement !== "shared") throw new ManagedCopilotError("invalid_request", `Session ${sessionId} is not on shared placement`, { sessionId });
    const source = await this.resident(live);
    const current = this.get(sessionId);
    if (live.cutover) throw new ManagedCopilotError("promotion_busy", `Session ${sessionId} is already moving`, { sessionId });
    if (!current || live.deleting) throw notFound();
    if (current.generation !== options.generation) throw new ManagedCopilotError("conflict", `Session ${sessionId} moved while the cutover opened`, { sessionId, generation: current.generation });
    const state: CutoverState = {
      generation: options.generation,
      source,
      priorState: current.state,
      fenced: false,
      sealed: false,
      settled: false,
      sealing: [],
      buffered: [],
      destinationBuffer: [],
      replies: [],
      release: undefined,
      gate: undefined,
      destination: undefined,
      done: false,
      outcome: undefined,
      flushed: false,
    };
    live.cutover = state;
    const fence = (): void => {
      if (state.done || state.fenced) return;
      state.fenced = true;
      live.moves++;
      for (const wait of live.waits) wait.fenced = true;
      live.ready = false;
      // Requests wait for commit/abort, then find the session's owner afresh (the destination, or a re-resumed source).
      const gate = new Promise<void>((resolve) => {
        state.release = resolve;
      });
      const residency = gate.then(() => this.resident(live));
      residency.catch(() => undefined);
      state.gate = residency;
      live.residency = residency;
      this.ledger.update(sessionId, { state: "promoting" });
    };
    return {
      record: current,
      sourceStateDir: this.options.sharedRuntime?.sessionStateDirectory(sessionId),
      source: async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        if (state.done) throw cutoverClosed(sessionId);
        if (method !== "session.suspend" && method !== "sessions.close") return state.source.request<T>(method, { sessionId, ...params });
        // The seal: the source's output becomes a handoff (what the suspend causes at once, everything once it is
        // answered), and the calls waiting on it continue on the session's next owner.
        fence();
        if (!state.sealed) {
          state.sealed = true;
          for (const wait of live.waits) wait.held ??= this.hold(live, wait.signal);
        }
        const sent = state.source.request<T>(method, { sessionId, ...params }, { onSettle: () => (state.settled = true) });
        state.sealing.push(sent.catch(() => undefined));
        return sent;
      },
      fence,
      open: (extra = {}) => this.#openDestination(live, state, extra),
      commit: () => this.#commitCutover(live, state),
      abort: (abortOptions = {}) => this.abortCutover(live, state, abortOptions.resume),
    };
  }

  async #openDestination(live: LiveSession, state: CutoverState, extra: Record<string, unknown>): Promise<{ request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> }> {
    if (state.done) throw cutoverClosed(live.id);
    if (!state.fenced) throw new ManagedCopilotError("invalid_request", "Fence the session before opening its destination", { sessionId: live.id });
    const sandboxes = this.sandboxes;
    if (!sandboxes) throw new ManagedCopilotError("capability_unavailable", "The sandbox service is not available on this gateway");
    this.#closeDestination(state);
    const record = this.get(live.id);
    const stored = this.ledger.admitted(live.id);
    if (!record || !stored?.requested) throw new ManagedCopilotError("state_restore_failed", `Session ${live.id} has no stored configuration to move`, { sessionId: live.id });
    // The caller's own configuration, admitted again for sandbox placement, with the session's current model and agent.
    const requested: Record<string, unknown> = { ...stored.requested };
    if (record.model) requested["model"] = record.model;
    if (record.agent) requested["agent"] = record.agent;
    else delete requested["agent"];
    const network = (await this.policy?.session?.(live.id))?.policy ?? record.network;
    const context: AdmissionContext = {
      environment: live.environment,
      placement: "sandbox",
      network,
      platformTools: this.platformToolsFor(live.environment, "sandbox"),
      workingDirectory: this.workingDirectory("sandbox", live.id),
      tokenRegistrationId: live.tokenRegistrationId,
    };
    const admitted = admitSession(requested, context, "resume");
    delete admitted.params["gitHubTokenProviderRegistrationId"];
    // Options the caller changed later, admitted for the sandbox too (the model comes from the ledger).
    const { model: _model, ...callerOptions } = stored.requestedOptions ?? {};
    const optionsPatch = { ...admitted.optionsPatch, ...(Object.keys(callerOptions).length > 0 ? admitOptionsUpdate(callerOptions, context) : {}) };
    let handle!: SandboxRuntimeHandle;
    let upstream: RuntimeUpstream | undefined;
    const inference = await this.sandboxInference(live.id);
    for (let reopen = 0; ; reopen++) {
      handle = await sandboxes.openRuntime(live.id, { resolveToken: () => this.ownerToken(live).then((credential) => credential.token), ...(inference ? { inference } : {}) });
      upstream = undefined;
      try {
        // A cutover that closed while this opened found no destination to close: this one is never installed.
        if (state.done) throw cutoverClosed(live.id);
        upstream = await RuntimeUpstream.open({ id: `sandbox:${live.id}`, kind: "sandbox", sandboxId: live.id }, streamTransport(handle.stream), {
          token: handle.connectionToken,
          handlers: this.runtimeHandlers,
          log: this.log,
        });
        if (state.done) throw cutoverClosed(live.id);
        const opened = upstream;
        // Registered first, so the destination's requests (inference, credentials) and events route during the open.
        state.destination = { upstream: opened, sandbox: handle, admitted, optionsPatch };
        if (handle.initialize) await this.bounded(live, opened, "the sandbox runtime's setup", () => handle.initialize!((method, params) => opened.request(method, params)));
        break;
      } catch (error) {
        if (state.destination?.sandbox === handle) {
          state.destination = undefined;
          state.destinationBuffer.length = 0;
        }
        upstream?.close();
        handle.close?.();
        if (reopen < MAX_REOPENS && wantsReopen(error) && !state.done) {
          this.log.info("The sandbox restarted its runtime; opening the destination again", { sessionId: live.id });
          continue;
        }
        throw error;
      }
    }
    const opened = upstream!;
    try {
      const registrations = this.registrations(live, undefined, true);
      const params = await this.withVaultHeaders(live.id, { ...admitted.params, ...registrations.flags, sessionId: live.id, tools: [...registrations.tools, ...this.platformToolDeclarations(live, "sandbox")], ...extra }, "sandbox");
      const routed = await this.routeInference(live, params, "sandbox");
      const prepared = handle.prepareSessionParams ? await handle.prepareSessionParams("session.resume", routed) : routed;
      await this.bounded(live, opened, "session.resume", () => opened.request("session.resume", prepared));
      if (handle.sessionOpened) await this.bounded(live, opened, "the session's credential setup", () => handle.sessionOpened!(live.id));
      if (Object.keys(optionsPatch).length > 0) await this.bounded(live, opened, "session.options.update", () => opened.request("session.options.update", { ...optionsPatch, sessionId: live.id }));
      if (state.done || state.destination?.upstream !== opened) throw new ManagedCopilotError("conflict", "The cutover closed while its destination was opening", { sessionId: live.id });
      return { request: <T,>(method: string, params: Record<string, unknown> = {}) => opened.request<T>(method, { sessionId: live.id, ...params }) };
    } catch (error) {
      if (state.destination?.sandbox === handle) {
        state.destination = undefined;
        state.destinationBuffer.length = 0;
      }
      upstream?.close();
      handle.close?.();
      throw error;
    }
  }

  #closeDestination(state: CutoverState): void {
    const destination = state.destination;
    state.destination = undefined;
    state.destinationBuffer.length = 0;
    destination?.upstream.close();
    destination?.sandbox.close?.();
  }

  async #commitCutover(live: LiveSession, state: CutoverState): Promise<SessionRecord> {
    if (state.done) throw cutoverClosed(live.id);
    const destination = state.destination;
    if (!destination || destination.upstream.closed) throw new ManagedCopilotError("invalid_request", "Open the destination before committing the cutover", { sessionId: live.id });
    const record = this.get(live.id);
    if (!record || live.deleting) throw new ManagedCopilotError("not_found", `Session ${live.id} was not found`, { sessionId: live.id });
    if (record.generation !== state.generation) throw new ManagedCopilotError("conflict", `Session ${live.id} moved during the cutover`, { sessionId: live.id, generation: record.generation });
    const stored = this.ledger.admitted(live.id);
    const generation = state.generation + 1;
    // One update: placement, generation, and the sandbox-admitted configuration move together.
    this.ledger.update(live.id, {
      placement: "sandbox",
      generation,
      state: unfinished(record.lastTurn) ? "running" : "idle",
      admitted: {
        params: storedParams(destination.admitted.params),
        ...(stored?.tools ? { tools: stored.tools } : {}),
        ...(stored?.callbacks ? { callbacks: stored.callbacks } : {}),
        optionsPatch: destination.optionsPatch,
        ...(stored?.requested ? { requested: stored.requested } : {}),
        ...(stored?.requestedOptions ? { requestedOptions: stored.requestedOptions } : {}),
      },
    });
    state.done = true;
    state.outcome = "committed";
    const source = live.placement;
    live.placement = "sandbox";
    live.upstream = destination.upstream;
    live.sandbox = destination.sandbox;
    // The destination opened with the registrations in effect.
    live.unreconciled = false;
    // What the sealed source still sends for the session is handoff: hidden from history as well.
    if (state.sealed) live.sealedSource = { upstream: state.source, settled: Promise.resolve() };
    // Genuine source events from the fence window first (their placement and generation), then what the destination
    // sent before the commit; the fence stays up until they have been delivered.
    for (const item of state.buffered.splice(0)) this.dispatchNotification(live, item.method, item.params, { generation: state.generation, placement: source, beforeSeal: true });
    for (const item of state.destinationBuffer.splice(0)) this.dispatchNotification(live, item.method, item.params, { generation, placement: "sandbox" });
    await this.#finishCutover(live, state, () => live.upstream === destination.upstream && !destination.upstream.closed);
    this.log.info("Session moved to its sandbox", { sessionId: live.id, generation });
    // Last: listeners (CLI attach, promotion's action carry-over) see the sandbox, a settled state, and every action.
    if (!live.deleting) this.emitLifecycle(live.id, "promoted");
    return this.get(live.id) ?? record;
  }

  protected async abortCutover(live: LiveSession, state: CutoverState, resume: Record<string, unknown> | undefined): Promise<void> {
    if (state.outcome === "aborted") return;
    if (state.done) throw cutoverClosed(live.id);
    state.done = true;
    state.outcome = "aborted";
    this.#closeDestination(state);
    if (state.sealed) {
      // The session was suspended (and maybe closed) on its source: it is resumed there with `resume`, and until the
      // source answers that resume (after the sealing calls), what it sends for the session is still the handoff.
      live.resumeExtras = resume;
      live.sealedSource = { upstream: state.source, settled: Promise.all(state.sealing).then(() => undefined) };
    }
    if (!live.deleting && state.fenced) this.ledger.update(live.id, { state: state.priorState === "promoting" ? "idle" : state.priorState });
    for (const item of state.buffered.splice(0)) this.dispatchNotification(live, item.method, item.params, { generation: state.generation, placement: live.placement, beforeSeal: true });
    await this.#finishCutover(live, state, () => !state.sealed && live.upstream === state.source && !state.source.closed);
    this.log.info("Session move aborted; it stays on its source", { sessionId: live.id });
  }

  /**
   * Ends a cutover once everything it held back has been delivered: replies the source gave before the seal go out
   * after the flushed events, the session becomes routable again, and the fence lifts.
   */
  async #finishCutover(live: LiveSession, state: CutoverState, ready: () => boolean): Promise<void> {
    await live.queue.catch(() => undefined);
    const replies = state.replies.splice(0);
    state.flushed = true;
    if (live.cutover === state) live.cutover = undefined;
    for (const reply of replies) reply.resolve(reply.value);
    if (state.fenced) live.ready = ready() && !live.unreconciled && live.inflight !== live.upstream;
    if (state.gate && live.residency === state.gate) live.residency = undefined;
    state.release?.();
    // Held completions continue from the session's owner; one that is not running is resumed for them.
    this.driveHeld(live);
  }
}
