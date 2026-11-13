// Client operations called by the /v1/connect router: create, resume, forwarded requests, and detach.
import { randomUUID } from "node:crypto";
import { ManagedCopilotError, type Placement } from "@managed-copilot/protocol";
import { isGitHubPrincipal, type Principal } from "../../../http.js";
import { ANSWER_METHOD_SET, type RuntimeSessionEvent } from "../../durable/contract.js";
import {
  admitOptionsUpdate,
  admitSend,
  admitToolsSet,
  checkModel,
  type AdmissionContext,
  type AdmittedSession,
} from "../admission.js";
import type { SessionRecord } from "../contracts.js";
import { RpcError, unsupportedMethod } from "../rpc.js";
import { RuntimeUpstream } from "../runtime.js";
import type { ClientPeer, ToolsRegistration, LiveSession } from "./types.js";
import {
  describeRoute,
  MOVED,
  CONFIG_METHODS,
  HISTORY_METHODS,
  FORWARDED_SESSION_METHODS,
  ID_PATTERN,
  withoutKeys,
  registrationOf,
  clientDeclarations,
  agentResolves,
  hasRemoteMcp,
  hasAppMemory,
  storedParams,
  requestedParams,
  withoutSessionId,
} from "./support.js";
import { SessionCreation } from "./creation.js";

export abstract class SessionClients extends SessionCreation {
  // Implemented by later layers of SessionManager.
  protected abstract interrupted(record: SessionRecord): boolean;
  protected abstract discardInterrupted(record: SessionRecord): Promise<void>;
  abstract assertAppScope(principal: Principal, sessionId: string): void;
  protected abstract onOwner<T>(live: LiveSession, placement: Placement, send: (upstream: RuntimeUpstream) => Promise<T>): Promise<T>;
  protected abstract withoutHidden<T>(live: LiveSession, result: T): T;

  // ------------------------------------------------------------------------------------------------------------
  // Client operations (called by the /v1/connect router)

  async createForClient(peer: ClientPeer, raw: unknown): Promise<{ result: unknown; after: () => Promise<void> }> {
    if (!raw || typeof raw !== "object") throw new ManagedCopilotError("invalid_request", "session.create params must be an object");
    const params = { ...(raw as Record<string, unknown>) };
    if (params["sessionId"] === undefined) params["sessionId"] = randomUUID();
    const sessionId = params["sessionId"];
    if (typeof sessionId !== "string" || !ID_PATTERN.test(sessionId)) throw new ManagedCopilotError("invalid_request", "sessionId must be a UUID");
    // A create of the same ID the gateway stopped in the middle of is cleaned up first, as for service creates.
    const interrupted = this.ledger.get(sessionId);
    if (interrupted && this.interrupted(interrupted) && interrupted.ownerId === peer.principal.accountId) await this.discardInterrupted(interrupted);
    if (this.ledger.get(sessionId) || this.creating.has(sessionId)) throw new ManagedCopilotError("conflict", `Session ${sessionId} already exists; resume it instead`);
    const result = await this.reserveAndCreate({ principal: peer.principal, environment: peer.environment, raw: params, peer, clientName: peer.clientName });
    return { result, after: () => this.afterAttach(peer, sessionId) };
  }

  async resumeForClient(peer: ClientPeer, raw: unknown): Promise<{ result: unknown; after: () => Promise<void> }> {
    if (!raw || typeof raw !== "object") throw new ManagedCopilotError("invalid_request", "session.resume params must be an object");
    const params = raw as Record<string, unknown>;
    const sessionId = params["sessionId"];
    if (typeof sessionId !== "string") throw new ManagedCopilotError("invalid_request", "session.resume needs a sessionId");
    const record = this.getOwned(peer.principal.accountId, sessionId);
    this.assertAppScope(peer.principal, sessionId);
    if (record.environment !== peer.environment.name) {
      throw new ManagedCopilotError("invalid_request", `Session ${sessionId} belongs to environment "${record.environment}"; resume it with a client for that environment`);
    }
    if (record.state === "deleting") throw new ManagedCopilotError("conflict", `Session ${sessionId} is being deleted`);
    const live = this.liveFor(sessionId);
    // Taken before admission, which rewrites nested values (remote MCP servers point at the gateway adapter).
    const requested = requestedParams(params);
    return this.registering(live, () => this.#resumeRegistered(peer, params, record, live, requested));
  }

  /** A client resume, as the session's only registration change in progress. */
  async #resumeRegistered(peer: ClientPeer, params: Record<string, unknown>, record: SessionRecord, live: LiveSession, requested: Record<string, unknown>): Promise<{ result: unknown; after: () => Promise<void> }> {
    const sessionId = record.id;
    for (;;) {
      // It may have waited behind other registrations: never for a session deleted (or created again) meanwhile.
      if (live.deleting || this.live.get(sessionId) !== live || this.get(sessionId)?.incarnation !== record.incarnation) {
        throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
      }
      // An open placement cutover decides where the session lives next, and so which admission rules apply.
      if (live.cutover?.fenced) await live.residency?.catch(() => undefined);
      const placement = live.placement;
      const moves = live.moves;
      const binding = await this.policy?.session?.(sessionId);
      const network = binding?.policy ?? record.network;
      const admitted = await this.admit(live.environment, placement, params, "resume", network, sessionId, live.tokenRegistrationId, peer.principal);
      // A Foundry or OpenAI-compatible session keeps its model: a resume that names another one fails rather than being rewritten.
      if (params["model"] !== undefined) this.checkModelSwitch(live, params["model"]);
      const routed = this.inferenceRoute(sessionId);
      await this.checkRemoteMcp(admitted, sessionId, placement, network);
      if (live.moves !== moves) continue;
      // The session's option changes this resume does not set again stay in effect (as a restore applies them).
      const optionsPatch = { ...withoutKeys(this.ledger.admitted(sessionId)?.optionsPatch, requested), ...admitted.optionsPatch };
      const outcome = await this.#resumeClient(live, peer, admitted, moves, optionsPatch);
      // A cutover fenced the session during this resume: admit it again and resume where the session lives after it.
      if (outcome === MOVED) continue;
      // Stored only for the session it resumed (deletes wait for registrations, so this holds; checked anyway).
      if (this.get(sessionId)?.incarnation !== record.incarnation) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
      this.persist(sessionId, (stored) => {
        const stable = storedParams(admitted.params);
        // A resume without `agent` keeps the session's current agent (stock runtime behavior), while it still resolves.
        const kept = stored.params["agent"];
        if (stable["agent"] === undefined && typeof kept === "string" && agentResolves(live.environment, kept, stable)) stable["agent"] = kept;
        // Likewise its model: restores select the model the session last had (a Foundry session, its deployment).
        if (stable["model"] === undefined && typeof stored.params["model"] === "string") stable["model"] = stored.params["model"];
        if (routed) stable["model"] = routed.model;
        // A resume configures the session again: what it sets replaces earlier option changes, and it is the caller's
        // configuration from now on (restores and placement changes apply the same thing; model and agent come from
        // the ledger).
        const requestedOptions = withoutKeys(stored.requestedOptions, requested);
        return {
          params: stable,
          ...(stored.tools ? { tools: stored.tools } : {}),
          ...(stored.callbacks ? { callbacks: stored.callbacks } : {}),
          optionsPatch: { ...withoutKeys(stored.optionsPatch, requested), ...admitted.optionsPatch },
          requested,
          ...(requestedOptions && Object.keys(requestedOptions).length > 0 ? { requestedOptions } : {}),
        };
      });
      const current = this.get(sessionId) ?? record;
      this.ledger.update(sessionId, {
        state: current.state === "failed" || current.state === "stopped" ? "ready" : current.state,
        ...(routed ? { model: routed.model } : admitted.model ? { model: admitted.model } : {}),
        ...(admitted.agent ? { agent: admitted.agent } : {}),
      });
      return { result: this.scrub(live, this.sanitizeResponse(live, outcome.result, placement), placement), after: () => this.afterAttach(peer, sessionId) };
    }
  }

  /**
   * Resumes a client's attachment on the session's owner (restoring the session there if it is not running). Returns
   * MOVED when a placement cutover fenced the session meanwhile; nothing is sent to a runtime after a fence.
   */
  async #resumeClient(live: LiveSession, peer: ClientPeer, admitted: AdmittedSession, moves: number, optionsPatch: Record<string, unknown>): Promise<{ result: unknown } | typeof MOVED> {
    const run = async (upstream: RuntimeUpstream, restored: boolean): Promise<{ result: unknown } | typeof MOVED> => {
      const extras = live.resumeExtras;
      const resumeParams = await this.withVaultHeaders(live.id, { ...admitted.params, ...this.resumeExtras(live, admitted.params) }, live.placement);
      const prepared = await this.prepare(live, "session.resume", resumeParams);
      await this.sealSettled(live, upstream);
      // Checked and sent in one synchronous step.
      if (live.deleting || this.live.get(live.id) !== live) throw new ManagedCopilotError("not_found", `Session ${live.id} was not found`, { sessionId: live.id });
      if (live.moves !== moves || live.cutover?.fenced || upstream.closed) return MOVED;
      // A client that disconnected meanwhile is not attached (its disconnect has run): the session is resumed with the
      // registrations it has without that client.
      const present = !peer.closed;
      if (present) this.checkHooksRegistration(live, peer, prepared);
      const previous = live.attachments.get(peer.id);
      const change = present ? this.inventoryChange(live, peer.id, previous, registrationOf(prepared, this.options.platformTools, live.environment.name)) : undefined;
      if (present) this.attach(live, peer, admitted, prepared);
      const forwarded = this.withRegistrations(live, prepared, change);
      let result: unknown;
      live.inflight = upstream;
      try {
        result = await this.resumeUpstream(live, upstream, forwarded);
        await this.opened(live, upstream, optionsPatch);
        // Restored by this resume: a turn the lost connection cut ends before the session takes new work (checked
        // before the move check below, so a cutover that committed meanwhile still takes the MOVED path).
        if (restored && live.moves === moves) await this.settleTurn(live, upstream);
      } catch (error) {
        this.unattach(live, peer.id, previous);
        // The runtime may have applied what this resume registered before failing (or being overtaken by a move).
        this.unreconciled(live, upstream);
        if (live.moves !== moves) return MOVED;
        throw error;
      } finally {
        if (live.inflight === upstream) live.inflight = undefined;
      }
      if (live.resumeExtras === extras) live.resumeExtras = undefined;
      if (live.moves !== moves) {
        // Fenced during the resume: the client attaches where the session lives after the cutover, with what it had,
        // and a source it leaves keeps what this resume registered only once it is resumed with what is in effect.
        this.unattach(live, peer.id, previous);
        this.unreconciled(live, upstream);
        return MOVED;
      }
      if (change) this.persistInventory(live, peer.id, change);
      // It sent the session's whole registration, now in effect.
      live.unreconciled = false;
      live.ready = true;
      return { result };
    };
    await live.residency?.catch(() => undefined);
    if (live.moves !== moves) return MOVED;
    // Resident already: the runtime re-registers this client's tools and handler flags.
    if (live.upstream && !live.upstream.closed && live.ready) {
      try {
        return await run(live.upstream, false);
      } catch (error) {
        await this.reconcile(live);
        throw error;
      }
    }
    // Not resident: the client's own resume restores it, and concurrent callers wait for it.
    let outcome: { result: unknown } | typeof MOVED = MOVED;
    await this.serialize(live, async () => {
      const upstream = await this.connect(live, moves);
      outcome = await run(upstream, true);
      return upstream;
    });
    return outcome;
  }

  forwardForClient(peer: ClientPeer, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const registration: ToolsRegistration = { stored: false };
    const forward = () =>
      this.#forwardForClient(peer, method, params, signal, registration).finally(async () => {
        const { live, attachment, before, change, upstream } = registration;
        if (registration.stored || !live || !change) return;
        // A `tools.set` that did not apply leaves the client's registration as it was (unless it registered again
        // since), and the runtime, which may have applied it, gets the registrations in effect again.
        if (attachment && before && attachment.declarations === registration.set) {
          attachment.tools = before.tools;
          attachment.declarations = before.declarations;
        }
        if (upstream) {
          this.unreconciled(live, upstream);
          await this.reconcile(live);
        }
      });
    // A tools update is a registration change: one at a time per session, like client resumes.
    const sessionId = params["sessionId"];
    const live = method === "session.tools.set" && typeof sessionId === "string" ? this.live.get(sessionId) : undefined;
    return live ? this.registering(live, forward) : forward();
  }

  async #forwardForClient(peer: ClientPeer, method: string, params: Record<string, unknown>, signal: AbortSignal, registration: ToolsRegistration): Promise<unknown> {
    const sessionId = params["sessionId"];
    if (typeof sessionId !== "string") throw unsupportedMethod(method);
    const live = this.attachedLive(peer, sessionId, method);
    if (!FORWARDED_SESSION_METHODS.has(method) && method !== "session.options.update" && method !== "session.tools.set" && method !== "session.model.switchTo" && method !== "session.model.switchAutoTier") {
      throw unsupportedMethod(method);
    }
    registration.live = live;
    for (;;) {
      // An open placement cutover decides where the session lives next, and so which admission rules apply.
      if (live.cutover?.fenced) await live.residency?.catch(() => undefined);
      const placement = live.placement;
      const moves = live.moves;
      const record = this.getOwned(peer.principal.accountId, sessionId);
      let forwarded: Record<string, unknown> = params;
      // Built in the step that writes it (a registration): it then carries every registration made meanwhile.
      let build: (() => Record<string, unknown>) | undefined;
      let patch: Record<string, unknown> | undefined;
      const context = (): AdmissionContext => ({
        environment: live.environment,
        placement,
        network: record.network,
        platformTools: this.platformToolsFor(live.environment, placement),
        workingDirectory: this.workingDirectory(placement, sessionId),
        tokenRegistrationId: live.tokenRegistrationId,
        allowMcp: hasRemoteMcp(this.ledger.admitted(sessionId)?.params),
        appMemory: hasAppMemory(this.ledger.admitted(sessionId)?.params),
      });
      switch (method) {
        case "session.send":
        case "session.sendAndWait":
          // A turn without the client that answers the session's hooks would run unguarded: refuse it.
          this.assertHooks(live);
          forwarded = { ...admitSend(params, context()), sessionId };
          break;
        case "session.options.update":
          patch = admitOptionsUpdate(params, context());
          if (patch["model"] !== undefined) this.checkModelSwitch(live, patch["model"]);
          forwarded = { ...patch, sessionId };
          break;
        case "session.tools.set": {
          const admitted = admitToolsSet(params, context());
          const declarations = clientDeclarations(admitted.params["tools"], this.options.platformTools, live.environment.name);
          // The client's registration changes in the step that writes it: what runs while this call waits (a restore,
          // a cutover's destination) registers what is in effect, and a call that never reaches a runtime changes
          // nothing. What it withdraws is decided against the registration before this call (also on a retry).
          build = () => {
            registration.change = undefined;
            const attachment = live.attachments.get(peer.id);
            if (attachment) {
              if (registration.attachment !== attachment) {
                registration.attachment = attachment;
                registration.before = { tools: attachment.tools, declarations: attachment.declarations };
              }
              registration.change = this.inventoryChange(live, peer.id, { ...attachment, declarations: registration.before!.declarations }, { tools: declarations, flags: {} }, "tools");
              registration.set = declarations;
              attachment.tools = new Set(admitted.names);
              attachment.declarations = declarations;
            }
            return { ...admitted.params, tools: [...this.registrations(live, registration.change).tools, ...this.platformToolDeclarations(live, placement)], sessionId };
          };
          break;
        }
        case "session.model.switchTo":
          this.checkModelSwitch(live, params["modelId"]);
          checkModel(live.environment, params["modelId"]);
          break;
        case "session.model.switchAutoTier":
          {
            const routed = this.inferenceRoute(live.id);
            if (routed) throw new ManagedCopilotError("capability_unavailable", `Session ${live.id} sends model calls ${describeRoute(routed)}; Auto model routing is a GitHub Copilot feature`, { sessionId });
          }
          if (live.environment.config.models) throw new ManagedCopilotError("policy_violation", `Environment "${live.environment.name}" restricts models; Auto routing is not available`);
          break;
        default:
          if (ANSWER_METHOD_SET.has(method)) {
            const actions = this.actions;
            if (actions) {
              const decision = await actions.onClientAnswer({ sessionId, ...this.incarnationOf(sessionId), connectionId: peer.id, responderKind: peer.kind, method, params });
              if (decision.kind === "respond") return decision.response;
            }
          }
      }
      let result: unknown;
      // The runtime this attempt wrote a tools update to (set in the write step).
      let written: RuntimeUpstream | undefined;
      try {
        result = await this.onOwner(live, placement, (upstream) => {
          if (build) {
            registration.upstream = upstream;
            written = upstream;
            live.inflight = upstream;
          }
          if (method === "session.sendAndWait") return this.sendAndWait(live, upstream, forwarded, signal, placement);
          // A tools update is a step of the session's registration path: bounded like a resume, so one the runtime
          // never answers cannot hold the session's later registrations.
          if (build) return this.bounded(live, upstream, method, () => upstream.request(method, build(), { signal }));
          return upstream.request(method, forwarded, { signal });
        });
      } catch (error) {
        // A cutover moved the session after this call was admitted: admit it again where the session lives now.
        if (error === MOVED) continue;
        // Configuration a cutover interrupted (the source closed the session meanwhile) is set on its owner instead.
        if (live.moves !== moves && CONFIG_METHODS.has(method) && error instanceof RpcError && !signal.aborted) {
          // A tools update the source may have applied before the move does not stay there uncommitted.
          if (written) this.unreconciled(live, written);
          await this.fenceLifted(live);
          continue;
        }
        throw error;
      } finally {
        if (written && live.inflight === written) live.inflight = undefined;
      }
      if (method === "session.sendAndWait") return result;
      // A fence went up while configuration was being set: the session's owner after it (the destination, or a source
      // resumed from stored configuration) may not have it, so it is set again there (an idempotent repeat otherwise).
      if (live.moves !== moves && CONFIG_METHODS.has(method)) {
        if (written) this.unreconciled(live, written);
        await this.fenceLifted(live);
        continue;
      }
      if (patch && Object.keys(patch).length > 0) {
        const requested = withoutSessionId(params);
        this.persist(sessionId, (stored) => ({ ...stored, optionsPatch: { ...stored.optionsPatch, ...patch }, requestedOptions: { ...stored.requestedOptions, ...requested } }));
        if (typeof patch["model"] === "string") this.ledger.update(sessionId, { model: patch["model"] });
      }
      if (registration.change) {
        this.persistInventory(live, peer.id, registration.change);
        registration.stored = true;
      }
      // Restores select the model the session last had.
      if (method === "session.model.switchTo" && typeof params["modelId"] === "string") this.recordModel(sessionId, params["modelId"]);
      // Restores re-select the agent the session last had, not the one it was created with.
      if (method === "session.agent.select" && typeof params["name"] === "string" && params["name"]) {
        const agent = params["name"];
        this.ledger.update(sessionId, { agent });
        this.persist(sessionId, (stored) => ({ ...stored, params: { ...stored.params, agent } }));
      } else if (method === "session.agent.deselect") {
        this.ledger.update(sessionId, { agent: "" });
        this.persist(sessionId, (stored) => {
          const { agent: _agent, ...rest } = stored.params;
          return { ...stored, params: rest };
        });
      }
      // Scrubbed for where the history comes from: a promoted session's earlier events are from shared placement.
      if (HISTORY_METHODS.has(method) && result && typeof result === "object" && Array.isArray((result as { events?: unknown }).events)) {
        const origin = placement === "shared" ? placement : this.historyPlacement(live);
        const visible = this.withoutHidden(live, result as { events: RuntimeSessionEvent[] });
        return this.scrub(live, { ...visible, events: visible.events.map((event) => this.sanitizeEvent(live, event, origin)) }, origin);
      }
      return this.scrub(live, result, placement);
    }
  }

  detach(peer: ClientPeer, sessionId: unknown): { success: boolean } {
    if (typeof sessionId !== "string") return { success: true };
    const live = this.live.get(sessionId);
    if (live?.attachments.has(peer.id)) this.detachAttachment(live, peer.id);
    return { success: true };
  }

  disconnect(peer: ClientPeer): void {
    // Connections the gateway closed while stopping: their sessions' state is no longer in use.
    if (this.stopped) return;
    for (const live of this.live.values()) {
      if (live.attachments.has(peer.id)) this.detachAttachment(live, peer.id, false);
    }
    this.actions?.onDetached(peer.id);
  }

  /**
   * `models.list` for the caller: the owner's entitlement, filtered by the environment's `models`. A Foundry
   * environment lists its deployments instead (an OpenAI-compatible one, its endpoint's models), whoever asks; nobody's
   * Copilot plan is consulted.
   */
  async listModels(peer: ClientPeer): Promise<unknown> {
    const foundry = peer.environment.config.inference?.foundry;
    if (foundry) return { models: this.foundry().models(foundry, peer.environment.config.models) };
    const openai = peer.environment.config.inference?.openai;
    if (openai) return { models: this.openai().modelList(openai, peer.environment.config.models) };
    if (!isGitHubPrincipal(peer.principal)) {
      throw new ManagedCopilotError("inference_unavailable", `Environment "${peer.environment.name}" uses each user's GitHub Copilot plan, and ${peer.principal.login} has none`);
    }
    const shared = this.options.sharedRuntime;
    if (!shared) throw new ManagedCopilotError("capability_unavailable", "Model discovery needs the shared runtime, which is disabled on this gateway");
    const upstream = await shared.ready();
    const result = await upstream.request<{ models?: { id?: string }[] }>("models.list", { gitHubToken: peer.principal.token });
    const allowed = peer.environment.config.models;
    const models = (result?.models ?? []).filter((model) => !allowed || (typeof model.id === "string" && allowed.includes(model.id)));
    return { ...result, models };
  }

  /** Called when the gateway stops: closes sandbox upstreams (the shared runtime is stopped separately). */
  close(): void {
    this.stopped = true;
    for (const live of this.live.values()) {
      live.ending.abort(new ManagedCopilotError("capability_unavailable", "The gateway is shutting down; try again shortly"));
      if (live.placement === "sandbox") {
        live.upstream?.close();
        live.sandbox?.close?.();
      }
    }
  }
}
