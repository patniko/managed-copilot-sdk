// Upstream traffic: runtime notifications and requests, owner tokens, presence, and CLI attach.
import { ManagedCopilotError, type Placement } from "@managed-copilot/protocol";
import { isGitHubPrincipal, type Principal } from "../../../http.js";
import { ACTION_EVENT_TYPES, ANSWER_METHODS, type RuntimeSessionEvent } from "../../durable/contract.js";
import { admitSend, checkModel } from "../admission.js";
import { appUserPrincipal } from "../apps.js";
import type { CliAttachment, CliAttachOptions, SessionCallOptions, SessionRecord } from "../contracts.js";
import { RpcError, unsupportedMethod, type IncomingRequestContext } from "../rpc.js";
import { RuntimeUpstream } from "../runtime.js";
import type { ClientPeer, Attachment, LiveSession, InflightWait, HeldCompletion, NotificationOrigin } from "./types.js";
import { TOKEN_LEASE_SECONDS, LOST_ANSWER, CLIENT_REQUESTS, isHandoffEvent, pinned } from "./support.js";
import { SessionResidency } from "./residency.js";

export abstract class SessionUpstream extends SessionResidency {
  // Implemented by later layers of SessionManager.
  abstract getOwned(accountId: number, sessionId: string): SessionRecord;
  abstract request<T = unknown>(sessionId: string, method: string, params?: Record<string, unknown>, options?: SessionCallOptions): Promise<T>;

  /**
   * A client's `sendAndWait`. During a placement cutover, a reply the source sends between the fence and the seal is
   * genuine and is delivered when the fence lifts. For a call the seal caught, an aborted reply or a failure is the
   * suspend's handoff, so the call completes from the owning runtime's events instead; a completed reply means the turn
   * ended on the source first, and is delivered as is. Replies are scrubbed for the placement that sent them.
   */
  protected async sendAndWait(live: LiveSession, upstream: RuntimeUpstream, params: Record<string, unknown>, signal: AbortSignal, placement: Placement): Promise<unknown> {
    const wait: InflightWait = { fenced: false, signal, held: undefined };
    live.waits.add(wait);
    let reply: unknown;
    let failure: { readonly error: unknown } | undefined;
    try {
      reply = await upstream.request("session.sendAndWait", params, { signal });
    } catch (error) {
      failure = { error };
    } finally {
      live.waits.delete(wait);
    }
    const held = wait.held;
    if (held) {
      if (!signal.aborted && (failure || (reply as { aborted?: unknown } | undefined)?.aborted === true)) {
        const handoff = failure ? undefined : (this.scrub(live, reply, placement) as Record<string, unknown> | undefined);
        held.messageId = handoff?.["messageId"];
        held.seed = handoff?.["response"];
        held.replied = true;
        this.#settleHeld(live, held);
        this.driveHeld(live);
        return held.promise;
      }
      this.#unhold(live, held);
    }
    if (failure) {
      // The runtime connection was lost under this call: the caller learns that, in plain words, rather than that some
      // internal connection closed (see LOST_ANSWER; a turn the loss cut also ends with its own `session.error`).
      const lost = failure.error instanceof RpcError && (failure.error.data as { code?: unknown } | undefined)?.code === "capability_unavailable";
      if (lost && upstream.closed && !signal.aborted && !wait.fenced) throw new RpcError(-32000, LOST_ANSWER, { code: "capability_unavailable" });
      throw failure.error;
    }
    const clean = this.scrub(live, reply, placement);
    const cutover = live.cutover;
    if (wait.fenced && cutover && !cutover.flushed) return new Promise((resolve) => cutover.replies.push({ value: clean, resolve }));
    return clean;
  }

  /** Starts holding a `sendAndWait` the seal caught: owner events after the seal record its outcome. */
  protected hold(live: LiveSession, signal: AbortSignal): HeldCompletion {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // Settled before its caller may have awaited it (a deletion while the source's reply is still on its way).
    promise.catch(() => undefined);
    const held: HeldCompletion = { promise, resolve, reject, messageId: undefined, seed: undefined, latest: undefined, outcome: undefined, replied: false };
    live.held.push(held);
    signal.addEventListener("abort", () => {
      if (this.#unhold(live, held)) reject(new RpcError(-32800, "Request cancelled"));
    }, { once: true });
    return held;
  }

  #unhold(live: LiveSession, held: HeldCompletion): boolean {
    const index = live.held.indexOf(held);
    if (index < 0) return false;
    live.held.splice(index, 1);
    return true;
  }

  /** Completes a held call once both its outcome on the owner and the source's handoff reply are known. */
  #settleHeld(live: LiveSession, held: HeldCompletion): void {
    const outcome = held.outcome;
    if (!held.replied || !outcome || !this.#unhold(live, held)) return;
    if ("error" in outcome) held.reject(outcome.error);
    else held.resolve({ ...(held.messageId !== undefined ? { messageId: held.messageId } : {}), response: held.latest ?? held.seed, aborted: outcome.aborted, completionEventId: outcome.completionEventId });
  }

  /**
   * Held completions need their session running somewhere. Outside a cutover: fail them for a deleted session, else
   * resume the session if it is not running (failing them if that fails), so they never wait on nothing.
   */
  protected driveHeld(live: LiveSession): void {
    if (live.held.length === 0 || live.cutover) return;
    if (live.deleting || this.live.get(live.id) !== live) {
      for (const held of live.held.splice(0)) held.reject(new RpcError(-32000, `Session ${live.id} was deleted`, { code: "not_found" }));
      return;
    }
    if (live.ready && live.upstream && !live.upstream.closed) return;
    void this.resident(live).catch((error: unknown) => {
      this.log.warn("Resuming a session with held completions failed", { sessionId: live.id, error: (error as Error).message });
      for (const held of live.held.splice(0)) held.reject(new RpcError(-32000, `The session could not be resumed: ${(error as Error).message}`, { code: "state_restore_failed" }));
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Upstream traffic

  protected onUpstreamNotification(upstream: RuntimeUpstream, method: string, params: unknown): void {
    const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof sessionId !== "string") return;
    const live = this.live.get(sessionId);
    if (!live) return;
    const cutover = live.cutover;
    const event = method === "session.event" ? (params as { event?: RuntimeSessionEvent } | undefined)?.event : undefined;
    if (live.sealedSource?.upstream === upstream && (method === "session.event" || method === "session.lifecycle")) {
      // Late output of a suspend whose cutover was aborted: the session runs here again once its resume is answered.
      if (event) this.#hide(live, event.id);
      return;
    }
    if (cutover && !cutover.done && (method === "session.event" || method === "session.lifecycle")) {
      if (cutover.destination?.upstream === upstream) {
        cutover.destinationBuffer.push({ method, params });
        return;
      }
      if (cutover.fenced && upstream === cutover.source) {
        // Before the seal the source's events are genuine and wait for commit/abort. Until a sealing call is answered,
        // what the suspend causes (interruptions, ended or failed turns, the aborted idle, shutdown) is a handoff and
        // the rest was already on its way; once it is answered, all of it is a handoff, which nobody may see, now or
        // in history.
        if (!cutover.sealed || (!cutover.settled && event && !isHandoffEvent(event))) cutover.buffered.push({ method, params });
        else if (event) this.#hide(live, event.id);
        return;
      }
    }
    if (live.upstream !== upstream) return;
    this.dispatchNotification(live, method, params);
  }

  #hide(live: LiveSession, eventId: unknown): void {
    if (typeof eventId !== "string" || !eventId) return;
    live.hidden ??= this.ledger.hiddenEvents(live.id);
    live.hidden.add(eventId);
    this.ledger.hideEvents(live.id, [eventId]);
  }

  protected dispatchNotification(live: LiveSession, method: string, params: unknown, origin?: NotificationOrigin): void {
    if (method === "session.event") {
      const event = (params as { event?: RuntimeSessionEvent }).event;
      if (!event || typeof event.type !== "string") return;
      live.queue = live.queue.then(() => this.deliverEvent(live, event, origin)).catch((error: unknown) => {
        this.log.warn("Session event delivery failed", { sessionId: live.id, type: event.type, error: (error as Error).message });
      });
    } else if (method === "session.lifecycle") {
      live.queue = live.queue
        .then(() => {
          const scrubbed = this.scrub(live, params, origin?.placement);
          for (const attachment of live.attachments.values()) attachment.peer.notify("session.lifecycle", scrubbed);
        })
        .catch((error: unknown) => this.log.warn("Session lifecycle delivery failed", { sessionId: live.id, error: (error as Error).message }));
    }
    // Other notifications (host.event, telemetry) carry runtime-wide or account details and are never relayed.
  }

  /**
   * Completes `sendAndWait` calls the seal caught, like the stock request-owned completion: at the owner's next root
   * `session.idle` after the seal, with the last root `assistant.message`; a root `session.error` fails them.
   */
  #advanceHeld(live: LiveSession, event: RuntimeSessionEvent): void {
    for (const held of [...live.held]) {
      if (held.outcome) continue;
      if (event.type === "assistant.message") held.latest = event;
      else if (event.type === "session.idle") held.outcome = { aborted: event.data?.["aborted"] === true, completionEventId: event.id };
      else if (event.type === "session.error") held.outcome = { error: new RpcError(-32603, String(event.data?.["message"] ?? "The session failed"), { completionEventId: event.id }) };
      this.#settleHeld(live, held);
    }
  }

  protected async deliverEvent(live: LiveSession, event: RuntimeSessionEvent, origin?: NotificationOrigin): Promise<void> {
    this.track(live, event);
    if (event.type === "external_tool.completed" && live.platformCalls.size > 0) {
      // Core runs this call itself (no ledger) and has not answered it: the runtime stopped waiting (turn cancelled).
      const requestId = String(event.data?.["requestId"] ?? "");
      const call = live.platformCalls.get(requestId);
      if (call) {
        live.platformCalls.delete(requestId);
        call.abort(new ManagedCopilotError("conflict", "The runtime stopped waiting for this tool call (for example, its turn was cancelled)"));
      }
    }
    // Sanitized for the placement that emitted it, which a cutover may have changed since.
    const sanitized = this.scrub(live, this.sanitizeEvent(live, event, origin?.placement), origin?.placement);
    // Only the owner's events after a seal complete the calls it caught; what the source said before it cannot.
    if (!event.agentId && live.held.length > 0 && !origin?.beforeSeal) this.#advanceHeld(live, sanitized);
    for (const listener of this.listeners) {
      try {
        listener(live.id, event);
      } catch (error) {
        this.log.warn("Session event listener failed", { error: (error as Error).message });
      }
    }
    for (const listener of this.sessionListeners.get(live.id) ?? []) {
      try {
        listener(live.id, event);
      } catch (error) {
        this.log.warn("Session event listener failed", { error: (error as Error).message });
      }
    }
    const notification = { sessionId: live.id, event: sanitized };
    if (!ACTION_EVENT_TYPES.has(event.type)) {
      for (const attachment of live.attachments.values()) attachment.peer.notify("session.event", notification);
      return;
    }
    // The actions ledger stores and replays what clients see, never platform host paths.
    const decision = await this.#routeAction(live, sanitized, origin?.generation);
    for (const attachment of live.attachments.values()) {
      const id = attachment.peer.id;
      if (decision.withhold.includes(id) && decision.owner !== id) continue;
      if (id === decision.owner) {
        if (attachment.peer.closed && decision.actionId && decision.claimToken) {
          this.actions?.releaseLiveClaim(decision.actionId, decision.claimToken);
          continue;
        }
      }
      attachment.peer.notify("session.event", notification);
    }
  }

  async #routeAction(live: LiveSession, event: RuntimeSessionEvent, generation?: number): Promise<{ owner?: string; withhold: readonly string[]; actionId?: string; claimToken?: string }> {
    const record = this.get(live.id);
    const actions = this.actions;
    const toolName = event.type === "external_tool.requested" ? (event.data["toolName"] as string | undefined) : undefined;
    const platformTool = toolName ? this.options.platformTools.get(toolName, live.environment.name) : undefined;
    if (actions && record) {
      // Events flushed after a cutover belong to the placement generation whose runtime emitted them.
      return actions.onSessionEvent({ sessionId: live.id, ...this.incarnationOf(live.id), ownerId: record.ownerId, environment: record.environment, generation: generation ?? record.generation, event, attached: this.responders(live) });
    }
    if (platformTool && record) {
      void this.#runPlatformTool(live, record, event, platformTool.name);
      return { withhold: [...live.attachments.keys()] };
    }
    // Default claim-before-emit (no durable module): the first eligible client in the same preference order durable
    // uses executes; other eligible clients are withheld.
    const attachments = this.preferred(live);
    let eligible: Attachment[] = [];
    if (event.type === "external_tool.requested") eligible = attachments.filter((attachment) => toolName !== undefined && attachment.tools.has(toolName));
    else if (event.type === "permission.requested") eligible = attachments.filter((attachment) => attachment.requestPermission);
    else if (event.type === "elicitation.requested") eligible = attachments.filter((attachment) => attachment.requestElicitation);
    else return { withhold: [] };
    const owner = eligible.find((attachment) => !attachment.peer.closed)?.peer.id;
    return { ...(owner ? { owner } : {}), withhold: eligible.map((attachment) => attachment.peer.id) };
  }

  async #runPlatformTool(live: LiveSession, record: SessionRecord, event: RuntimeSessionEvent, name: string): Promise<void> {
    const tool = this.options.platformTools.get(name, record.environment);
    const requestId = event.data["requestId"];
    const toolCallId = String(event.data["toolCallId"] ?? requestId);
    const call = new AbortController();
    const key = String(requestId);
    live.platformCalls.set(key, call);
    let answer: Record<string, unknown>;
    try {
      const result = await tool!.handler(event.data["arguments"], {
        sessionId: live.id,
        ownerId: record.ownerId,
        environment: record.environment,
        toolCallId,
        idempotencyKey: `${live.id}:${toolCallId}`,
        type: record.type,
        placement: record.placement,
        ...(typeof event.agentId === "string" && event.agentId.length > 0 ? { agentId: event.agentId } : {}),
        // The runtime stopped waiting (turn cancelled), the session was deleted, or the gateway is stopping; else 10 minutes.
        signal: AbortSignal.any([call.signal, live.ending.signal, AbortSignal.timeout(10 * 60_000)]),
      });
      answer = { requestId, result };
    } catch (error) {
      answer = { requestId, error: error instanceof ManagedCopilotError ? error.message : `Platform tool ${name} failed` };
      this.log.warn("Platform tool failed", { sessionId: live.id, tool: name, error: (error as Error).message });
    } finally {
      // Before answering, so the runtime's completion of this request does not abort the call that just finished.
      if (live.platformCalls.get(key) === call) live.platformCalls.delete(key);
    }
    // The runtime no longer waits for an answer.
    if (call.signal.aborted) return;
    try {
      await this.request(live.id, "session.tools.handlePendingToolCall", answer, pinned(record));
    } catch (error) {
      this.log.warn("Could not answer platform tool call", { sessionId: live.id, tool: name, error: (error as Error).message });
    }
  }

  protected async onUpstreamRequest(upstream: RuntimeUpstream, method: string, params: unknown, context: IncomingRequestContext): Promise<unknown> {
    const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId;
    const live = typeof sessionId === "string" ? this.live.get(sessionId) : undefined;
    const destination = live?.cutover?.destination?.upstream === upstream ? live.cutover.destination : undefined;
    const stale = live !== undefined && live.upstream !== upstream && live.residency === undefined && !destination;
    // The runtime carries on after an error from hooks.invoke, so a hook nobody may answer gets the closed answer.
    if (method === "hooks.invoke") {
      const body = (params ?? {}) as Record<string, unknown>;
      const id = typeof sessionId === "string" ? sessionId : "(unknown)";
      if (!live) return this.hookClosed(id, body, `Session ${id} is not running on this runtime.`);
      if (stale || (live.cutover?.fenced && upstream === live.cutover.source) || live.sealedSource?.upstream === upstream) {
        return this.hookClosed(id, body, `Session ${id} is moving to another runtime.`);
      }
      return this.invokeHook(live, body, context);
    }
    if (stale) throw new RpcError(-32000, "Stale runtime connection", { code: "conflict" });
    const sandboxHandler =
      (destination ? destination.sandbox.handlers?.get(method) : live?.sandbox?.handlers?.get(method)) ?? (upstream.info.kind === "sandbox" ? this.#sandboxHandlerFor(upstream, method) : undefined);
    if (sandboxHandler) return sandboxHandler(params);
    const registered = this.options.runtimeRequests.resolve(method, upstream.info);
    if (registered) {
      const record = live ? this.get(live.id) : undefined;
      return registered({ method, upstream: upstream.info, ...(record ? { session: record } : {}), params, signal: context.signal });
    }
    if (method in CLIENT_REQUESTS && live) {
      // A fenced source asks nobody: the session is moving, and after the seal its requests are handoff artifacts
      // (as they are from a source an aborted cutover sealed, until the session's resume there is answered).
      if ((live.cutover?.fenced && upstream === live.cutover.source) || live.sealedSource?.upstream === upstream) {
        throw new RpcError(-32000, "The session is moving to another runtime", { code: "promotion_busy" });
      }
      const flag = CLIENT_REQUESTS[method];
      const attachments = [...live.attachments.values()].sort((a, b) => b.attachedAt - a.attachedAt);
      const target = attachments.find((attachment) => !attachment.peer.closed && (flag === undefined || attachment[flag] === true));
      if (!target) throw new ManagedCopilotError("background_callback_unsupported", `No connected client can answer ${method} for session ${live.id}`);
      return target.peer.request(method, this.scrub(live, params), context.signal);
    }
    throw unsupportedMethod(method, `The gateway does not answer ${method}`);
  }

  /** Sandbox handlers by connection: inference body chunks carry no session ID, and a cutover's destination counts. */
  #sandboxHandlerFor(upstream: RuntimeUpstream, method: string): ((params: unknown) => Promise<unknown>) | undefined {
    for (const live of this.live.values()) {
      if (live.upstream === upstream) return live.sandbox?.handlers?.get(method);
      const destination = live.cutover?.destination;
      if (destination?.upstream === upstream) return destination.sandbox.handlers?.get(method);
    }
    return undefined;
  }

  /** Answers the runtime's `gitHubToken.getToken` for shared sessions with the owner's freshest credential. */
  async answerTokenRequest(params: unknown): Promise<unknown> {
    const request = params as { registrationId?: string; sessionId?: string; host?: string };
    const live = request.sessionId ? this.live.get(request.sessionId) : [...this.live.values()].find((candidate) => candidate.tokenRegistrationId === request.registrationId);
    if (!live || live.tokenRegistrationId !== request.registrationId) {
      this.log.warn("Refusing a GitHub token request for an unknown registration", { sessionId: request.sessionId });
      return { kind: "cancelled" };
    }
    // Only for a shared session the runtime still hosts: not one that moved into its sandbox or is being deleted.
    if (live.placement !== "shared" || live.deleting) {
      this.log.warn("Refusing a GitHub token request for a session the shared runtime no longer hosts", { sessionId: live.id });
      return { kind: "cancelled" };
    }
    if (request.host && !/^https:\/\/github\.com\/?$/i.test(request.host)) {
      this.log.warn("Refusing a GitHub token request for an unsupported host", { sessionId: live.id, host: request.host });
      return { kind: "cancelled" };
    }
    try {
      const credential = await this.ownerToken(live);
      const remaining = credential.expiresAt ? Math.floor((credential.expiresAt - Date.now()) / 1000) : TOKEN_LEASE_SECONDS;
      // The runtime asks again only once a token is within an hour of expiry (a cancelled refresh fails its next model
      // call, verified on 1.0.103), so answers stay short and the gateway decides again every few minutes.
      return { kind: "token", accessToken: credential.token, tokenType: "bearer", expiresIn: Math.min(remaining, TOKEN_LEASE_SECONDS) };
    } catch (error) {
      this.log.warn("No credential available for session owner", { sessionId: live.id, error: (error as Error).message });
      return { kind: "cancelled" };
    }
  }

  /**
   * The session owner's credential for its runtime: the token of a connected client of the owner (attached to the
   * session, or present on it like an attached Copilot CLI), re-verified; then, for a session another one started (an
   * orchestrator's worker), its parent's connected clients the same way; otherwise only the owner's current
   * background sign-in, re-verified too, never a token remembered from an earlier connection. Only attached clients'
   * tokens count as the account's live credential (presences may be background work, like a schedule's send).
   */
  protected async ownerToken(live: LiveSession): Promise<{ token: string; expiresAt?: number; app?: string }> {
    const auth = this.options.auth;
    // An app's own users have no GitHub credential at all: their sessions only ever use Foundry or an OpenAI-compatible
    // endpoint (refused at creation otherwise), so nothing may ask for one.
    if (this.get(live.id)?.owner.kind === "app-user") {
      throw new ManagedCopilotError("inference_unavailable", `Session ${live.id} belongs to an app user, who has no GitHub Copilot plan; its environment must send model calls to Azure AI Foundry or an OpenAI-compatible endpoint.`, { sessionId: live.id });
    }
    const parent = this.#credentialParent(live);
    // Each candidate must still be connected (or present) once its verification finishes.
    const present: { readonly principal: Principal; readonly current: () => boolean; readonly background: boolean }[] = [];
    for (const source of parent ? [live, parent] : [live]) {
      const usable = () => !source.deleting && (source === live || this.#credentialParent(live) === source);
      present.push(
        ...this.preferred(source).map((attachment) => ({ principal: attachment.peer.principal, current: () => usable() && source.attachments.get(attachment.peer.id) === attachment && !attachment.peer.closed, background: false })),
        ...[...source.presences.entries()].map(([key, principal]) => ({ principal, current: () => usable() && source.presences.get(key) === principal, background: true })),
      );
    }
    for (const { principal, current, background } of present) {
      if (principal.accountId !== live.ownerId || !isGitHubPrincipal(principal)) continue;
      try {
        // Through the app the caller came through, when it did: an app that admits any GitHub user admits it here too.
        const verified = await auth.authenticate(principal.token, { background, ...(principal.app ? { app: principal.app } : {}) });
        if (verified.accountId !== live.ownerId || !current() || live.deleting) continue;
        const expiresAt = auth.tokenExpiration(principal.token);
        return { token: principal.token, ...(expiresAt !== undefined ? { expiresAt } : {}), ...(principal.app ? { app: principal.app } : {}) };
      } catch (error) {
        this.log.debug("A connected client's credential could not be used for the session", { sessionId: live.id, error: (error as Error).message });
      }
    }
    const credentials = this.options.app.services.credentials;
    if (credentials) {
      const principal = await credentials.principalFor(live.ownerId);
      if (!isGitHubPrincipal(principal)) throw new ManagedCopilotError("authentication_required", "The stored credential is not a GitHub sign-in");
      // The gateway's own verification decides too: a token GitHub rejected since (an invalidated 401) is never used.
      const verified = await auth.authenticate(principal.token, { background: true });
      if (principal.accountId !== live.ownerId || verified.accountId !== live.ownerId) throw new ManagedCopilotError("authentication_required", "The stored credential belongs to another account");
      // The sign-in must still be the owner's current one once that finishes (a logout meanwhile ends it).
      const current = await credentials.principalFor(live.ownerId);
      if (current.token !== principal.token) throw new ManagedCopilotError("authentication_required", "The owner's background sign-in changed while it was being checked");
      if (live.deleting) throw new ManagedCopilotError("not_found", `Session ${live.id} is being deleted`, { sessionId: live.id });
      const expiresAt = auth.tokenExpiration(principal.token);
      return { token: principal.token, ...(expiresAt !== undefined ? { expiresAt } : {}) };
    }
    throw new ManagedCopilotError("authentication_required", "The session owner has no connected client and no background sign-in; reconnect, or run `managed-copilot login` for work while you are away");
  }

  /**
   * The live parent whose connected clients may serve this session's credential: the same owner's session that
   * started it, still the incarnation that did, and not being deleted. One level only.
   */
  #credentialParent(live: LiveSession): LiveSession | undefined {
    const record = this.ledger.get(live.id);
    if (!record?.parentSessionId) return undefined;
    const parent = this.live.get(record.parentSessionId);
    if (!parent || parent === live || parent.deleting || parent.ownerId !== live.ownerId) return undefined;
    if (this.get(record.parentSessionId)?.incarnation !== record.parentIncarnation) return undefined;
    return parent;
  }

  presence(sessionId: string, principal: Principal): () => void {
    this.getOwned(principal.accountId, sessionId);
    const live = this.liveFor(sessionId);
    const key = Symbol(sessionId);
    live.presences.set(key, principal);
    return () => {
      live.presences.delete(key);
    };
  }

  async ownerPrincipal(sessionId: string): Promise<Principal> {
    const live = this.liveFor(sessionId);
    const owner = this.get(sessionId)?.owner;
    // An app's own user has no credential to present: the account is the deployment's own, kept while its app is.
    if (owner?.kind === "app-user") {
      if (!owner.app || !this.options.app.services.apps?.get(owner.app)) {
        throw new ManagedCopilotError("authentication_required", `Session ${sessionId} belongs to a user of the "${owner.app}" app, which this deployment no longer declares`, { sessionId });
      }
      return appUserPrincipal(owner, owner.app);
    }
    const credential = await this.ownerToken(live);
    // Background: work the platform does for the owner never becomes the account's live credential. Through the app
    // its credential came through, so an app that admits any GitHub user still admits it.
    const principal = await this.options.auth.authenticate(credential.token, { background: true, ...(credential.app ? { app: credential.app } : {}) });
    if (principal.accountId !== live.ownerId) throw new ManagedCopilotError("authentication_required", "The session's credential belongs to another account");
    return credential.app ? { ...principal, app: credential.app } : principal;
  }

  async attachCli(accountId: number, sessionId: string, options: CliAttachOptions): Promise<CliAttachment> {
    const record = this.getOwned(accountId, sessionId);
    if (options.principal && options.principal.accountId !== accountId) throw new ManagedCopilotError("forbidden", "The attached CLI's credential belongs to another account");
    const live = this.liveFor(sessionId);
    const busy = () => new ManagedCopilotError("session_busy", `Session ${sessionId} is moving into a sandbox. Attach again when the move finishes.`, { sessionId });
    if (live.cutover?.fenced) throw busy();
    // The CLI's own credential serves a restore this attach needs (a stopped sandbox gets the owner's credential).
    const release = options.principal ? this.presence(sessionId, options.principal) : undefined;
    let upstream: RuntimeUpstream;
    try {
      upstream = await this.resident(live);
    } finally {
      release?.();
    }
    const current = this.get(sessionId);
    if (!current || current.incarnation !== record.incarnation || live.deleting || this.live.get(sessionId) !== live) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
    if (live.cutover?.fenced) throw busy();
    const pinned = { incarnation: record.incarnation, generation: current.generation, placement: live.placement, upstream };
    let closed = false;
    const peer: ClientPeer = {
      id: options.connectionId,
      kind: "cli",
      principal: options.principal ?? { accountId, login: record.owner.login, token: "" },
      environment: live.environment,
      clientName: "copilot-cli",
      notify: options.notify,
      request: (method) => Promise.reject(new ManagedCopilotError("background_callback_unsupported", `An attached Copilot CLI does not answer ${method}`)),
      get closed() {
        return closed;
      },
    };
    if (live.attachments.has(peer.id)) throw new ManagedCopilotError("conflict", `Connection ${peer.id} is already attached to session ${sessionId}`);
    live.attachments.set(peer.id, {
      peer,
      attachedAt: options.createdAt ?? Date.now(),
      tools: new Set(),
      requestPermission: true,
      requestUserInput: false,
      requestElicitation: true,
      requestExitPlanMode: false,
      requestAutoModeSwitch: false,
      hooks: false,
      skillProvider: false,
      memoryStore: false,
      transforms: false,
      canvases: false,
      declarations: [],
      flags: {},
      registered: { tools: {}, flags: {} },
    });
    // The CLI's operations apply only to what it attached to: never queued into another runtime or incarnation.
    const owned = (): void => {
      if (closed) throw new ManagedCopilotError("conflict", "This Copilot CLI attachment was closed. Attach again.");
      if (live.deleting || this.live.get(sessionId) !== live || this.get(sessionId)?.incarnation !== pinned.incarnation) {
        throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
      }
      if (live.cutover?.fenced) throw busy();
      if (this.get(sessionId)?.generation !== pinned.generation || live.placement !== pinned.placement || live.upstream !== pinned.upstream || !live.ready || pinned.upstream.closed) {
        throw new ManagedCopilotError("conflict", `Session ${sessionId} moved to another runtime since the CLI attached. Attach again.`, { sessionId });
      }
    };
    return {
      connectionId: peer.id,
      incarnation: pinned.incarnation,
      generation: pinned.generation,
      write: (operation, send) => {
        owned();
        switch (operation.kind) {
          case "turn": {
            if (typeof operation.text !== "string" || !operation.text.trim()) throw new ManagedCopilotError("invalid_request", "A Copilot CLI turn needs text");
            // A turn without the client that answers the session's hooks would run unguarded.
            this.assertHooks(live);
            const latest = this.get(sessionId)!;
            admitSend(
              { prompt: operation.text },
              {
                environment: live.environment,
                placement: live.placement,
                network: latest.network,
                platformTools: this.platformToolsFor(live.environment, live.placement),
                workingDirectory: this.workingDirectory(live.placement, sessionId),
                tokenRegistrationId: live.tokenRegistrationId,
              },
            );
            send();
            return;
          }
          case "model":
            this.checkModelSwitch(live, operation.modelId);
            checkModel(live.environment, operation.modelId);
            send();
            // Restores select the model the session last had.
            this.recordModel(sessionId, operation.modelId);
            return;
          case "abort":
            send();
            return;
          case "userInput":
            // A person never races the app's onUserInputRequest for the same question.
            if ([...live.attachments.values()].some((attachment) => attachment.peer.kind === "sdk" && attachment.requestUserInput && !attachment.peer.closed)) {
              throw new ManagedCopilotError("conflict", `An app connected to session ${sessionId} answers its questions (onUserInputRequest); answer there.`, { sessionId });
            }
            send();
            return;
          default:
            throw new ManagedCopilotError("invalid_request", `Copilot CLI operation "${String((operation as { kind?: unknown }).kind)}" is not supported`);
        }
      },
      answer: async (method, params) => {
        if (method !== ANSWER_METHODS.permission && method !== ANSWER_METHODS.elicitation) {
          throw new ManagedCopilotError("invalid_request", `An attached Copilot CLI answers permission and elicitation prompts only, not ${method}`);
        }
        owned();
        const actions = this.actions;
        if (actions) {
          // The ledger's decision for the incarnation and generation the CLI attached to; nothing it does not record
          // reaches the runtime.
          const pin = { incarnation: pinned.incarnation, generation: pinned.generation, requireRecorded: true as const };
          const decision = await actions.onClientAnswer({ sessionId, ...pin, connectionId: peer.id, responderKind: "cli", method, params });
          if (decision.kind === "respond") return decision.response;
          throw new ManagedCopilotError("not_found", `No recorded prompt of session ${sessionId} matches this answer, so it is not sent.`, { sessionId });
        }
        owned();
        return pinned.upstream.request(method, { ...params, sessionId });
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (live.attachments.get(peer.id)?.peer === peer) this.detachAttachment(live, peer.id);
      },
    };
  }
}
