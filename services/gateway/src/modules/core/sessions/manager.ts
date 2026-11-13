// The session manager: ownership, placement, upstream residency, request routing, and event fan-out for every
// session the gateway hosts. Client connections attach to sessions; the gateway owns the upstream runtime
// connections, so detaching or disconnecting a client never stops a session or cancels accepted work.
import { randomUUID } from "node:crypto";
import { connect as connectTcp } from "node:net";
import type { Duplex } from "node:stream";
import {
  isManagedCopilotError,
  ManagedCopilotError,
  type NetworkPolicy,
  type PendingAction,
  type Placement,
  type SessionInfo,
  type SessionState,
} from "@managed-copilot/protocol";
import type { Principal } from "../../../http.js";
import type { AttachedResponder } from "../../durable/contract.js";
import { appAllows, assertAppEnvironment } from "../apps.js";
import { accountInfo } from "../auth.js";
import type {
  CreateSessionRequest,
  CreateWorkspaceRequest,
  ResolvedEnvironment,
  SessionCallOptions,
  SessionEventListener,
  SessionRecord,
  SessionRuntime,
  SessionSendOptions,
  SessionsService,
} from "../contracts.js";
import type { AdmittedConfig, SessionLedger } from "../ledger.js";
import { RpcError } from "../rpc.js";
import { RuntimeUpstream } from "../runtime.js";
import type { LiveSessionSnapshot, LiveSession } from "./types.js";
import {
  attachmentCallbacks,
  MOVED,
  unfinished,
  HISTORY_METHODS,
  ID_PATTERN,
  workspaceOnly,
  pinned,
} from "./support.js";
import { SessionClients } from "./client.js";

export class SessionManager extends SessionClients implements SessionsService {
  // ------------------------------------------------------------------------------------------------------------
  // SessionsService

  get(sessionId: string): SessionRecord | undefined {
    const record = this.ledger.get(sessionId);
    return record && record.state !== "deleted" && !this.interrupted(record) ? record : undefined;
  }

  /** A create the gateway stopped in the middle of: the session never existed for its owner, and is discarded. */
  protected interrupted(record: SessionRecord): boolean {
    return record.state === "creating" && !this.creating.has(record.id);
  }

  getOwned(accountId: number, sessionId: string): SessionRecord {
    const record = this.get(sessionId);
    if (!record || record.ownerId !== accountId) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
    return record;
  }

  /** The host working directory of a shared session whose environment has `unsafeHostTools`, if it is one. */
  hostWorkspace(record: SessionRecord): string | undefined {
    if (record.placement !== "shared" || this.options.environments.forSession(record).config.unsafeHostTools !== true) return undefined;
    return this.workingDirectory("shared", record.id);
  }

  /**
   * Whether a session is within the app a request came through (spec section 2): one of the app's environments, or an
   * orchestrator's worker whose coordinator is. Requests without an app see all of their own sessions.
   */
  inAppScope(principal: Principal, record: SessionRecord): boolean {
    if (!principal.app) return true;
    const apps = this.options.app.services.apps;
    if (appAllows(apps, principal, record.environment)) return true;
    // A worker belongs to the incarnation of its coordinator that started it, never to a session that reused its ID.
    const parent = record.parentSessionId ? this.get(record.parentSessionId) : undefined;
    return parent !== undefined && parent.ownerId === record.ownerId && parent.incarnation === record.parentIncarnation && appAllows(apps, principal, parent.environment);
  }

  /** A principal's sessions, limited (before the listing's own limit) to its app's scope when it came through one. */
  listFor(principal: Principal, query: { environment?: string; state?: SessionState; limit?: number } = {}): SessionRecord[] {
    if (!principal.app) return this.list(principal.accountId, query);
    const environments = this.options.app.services.apps?.get(principal.app)?.environments ?? [];
    return this.list(principal.accountId, { ...query, environments }).filter((record) => this.inAppScope(principal, record));
  }

  /** Answers `not_found` for the caller's own session outside the app its request came through, as for anyone else's. */
  assertAppScope(principal: Principal, sessionId: string): void {
    if (!principal.app) return;
    const record = this.get(sessionId);
    if (record && record.ownerId === principal.accountId && !this.inAppScope(principal, record)) {
      throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
    }
  }

  async info(accountId: number, sessionId: string): Promise<SessionInfo> {
    return this.toInfo(this.getOwned(accountId, sessionId));
  }

  list(accountId: number, query?: { environment?: string; state?: SessionState; limit?: number; environments?: readonly string[] }): SessionRecord[] {
    return this.ledger.list(accountId, query).filter((record) => !this.interrupted(record));
  }

  /** `SessionInfo` of one session incarnation; `not_found` once the ID was deleted (and maybe reused) meanwhile. */
  async toInfo(record: SessionRecord): Promise<SessionInfo> {
    let sandbox: SessionInfo["sandbox"];
    if (record.placement === "sandbox") {
      try {
        sandbox = await this.sandboxes?.get(record.id);
      } catch (error) {
        this.log.warn("Could not read sandbox details", { sessionId: record.id, error: (error as Error).message });
      }
    }
    // Only this incarnation's actions: another owner's session may have reused the ID during the read above.
    if (this.get(record.id)?.incarnation !== record.incarnation) throw new ManagedCopilotError("not_found", `Session ${record.id} was not found`, { sessionId: record.id });
    let pendingActions: readonly PendingAction[] = [];
    try {
      pendingActions = this.actions?.list(record.id, { open: true, ...pinned(record) }) ?? [];
    } catch (error) {
      this.log.warn("Could not read pending actions", { sessionId: record.id, error: (error as Error).message });
    }
    return {
      id: record.id,
      environment: record.environment,
      type: record.type,
      placement: record.placement,
      state: record.state,
      owner: record.owner,
      ...(record.title ? { title: record.title } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(record.agent ? { agent: record.agent } : {}),
      // Workspace-only sessions make no model calls.
      ...(record.kind === "workspace" ? {} : { inference: record.inference ?? { route: "copilot" as const } }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(sandbox ? { sandbox } : {}),
      pendingActions,
      ...(record.lastTurn ? { lastTurn: record.lastTurn } : {}),
      ...(record.scheduleId ? { scheduleId: record.scheduleId } : {}),
      ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
      ...(record.kind === "workspace" ? { kind: "workspace" as const } : {}),
    };
  }

  async create(principal: Principal, request: CreateSessionRequest): Promise<{ sessionId: string; created: boolean; incarnation?: string }> {
    const sessionId = request.sessionId ?? randomUUID();
    const inflight = this.creating.get(sessionId);
    if (inflight) {
      if (inflight.ownerId !== principal.accountId) throw new ManagedCopilotError("conflict", `Session ${sessionId} already exists`);
      await inflight.done.catch(() => undefined);
    }
    const existing = this.ledger.get(sessionId);
    if (existing) {
      // A create the gateway stopped in the middle of left only its reservation: clean it up and create afresh.
      if (this.interrupted(existing) && existing.ownerId === principal.accountId) {
        await this.discardInterrupted(existing);
      } else {
        if (existing.kind === "workspace" && existing.ownerId === principal.accountId) throw workspaceOnly(sessionId);
        if (existing.ownerId === principal.accountId && existing.state !== "deleted" && existing.state !== "deleting") return { sessionId, created: false, incarnation: existing.incarnation };
        throw new ManagedCopilotError("conflict", `Session ${sessionId} already exists`);
      }
    }
    const environment = this.options.environments.resolve(request.environment);
    if (request.parentSessionId === undefined) assertAppEnvironment(this.options.app.services.apps, principal, environment.name);
    // A worker's coordinator: the same owner's live session, pinned to the incarnation that starts it.
    let parent: { readonly id: string; readonly incarnation: string } | undefined;
    if (request.parentSessionId !== undefined) {
      const record = this.getOwned(principal.accountId, request.parentSessionId);
      if (record.state === "deleting") throw new ManagedCopilotError("not_found", `Session ${record.id} was not found`, { sessionId: record.id });
      parent = { id: record.id, incarnation: record.incarnation };
    }
    const raw: Record<string, unknown> = {
      sessionId,
      ...(request.model ? { model: request.model } : {}),
      ...(request.agent ? { agent: request.agent } : {}),
      ...(request.systemMessage !== undefined ? { systemMessage: request.systemMessage } : {}),
      streaming: request.streaming ?? true,
      tools: (request.tools ?? []).map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.parameters ? { parameters: tool.parameters } : {}),
        ...(tool.skipPermission !== undefined ? { skipPermission: tool.skipPermission } : {}),
        ...(tool.overridesBuiltInTool !== undefined ? { overridesBuiltInTool: tool.overridesBuiltInTool } : {}),
      })),
      requestPermission: true,
      ...(request.clientName ? { clientName: request.clientName } : {}),
    };
    try {
      await this.reserveAndCreate({ principal, environment, raw, peer: undefined, scheduleId: request.scheduleId, webhook: request.webhook, clientName: request.clientName, parent });
    } catch (error) {
      // A concurrent create of the same deterministic ID by the same owner won the race.
      const winner = isManagedCopilotError(error, "conflict") ? this.ledger.get(sessionId) : undefined;
      if (winner && winner.ownerId === principal.accountId) return { sessionId, created: false, incarnation: winner.incarnation };
      throw error;
    }
    const created = this.ledger.get(sessionId)?.incarnation;
    return { sessionId, created: true, ...(created ? { incarnation: created } : {}) };
  }

  async createWorkspace(principal: Principal, request: CreateWorkspaceRequest): Promise<{ sessionId: string; created: boolean; incarnation?: string }> {
    const sessionId = request.sessionId ?? randomUUID();
    if (typeof sessionId !== "string" || !ID_PATTERN.test(sessionId)) throw new ManagedCopilotError("invalid_request", "sessionId must be 1 to 128 letters, digits, hyphens, or underscores");
    const inflight = this.creating.get(sessionId);
    if (inflight) {
      if (inflight.ownerId !== principal.accountId) throw new ManagedCopilotError("conflict", `Session ${sessionId} already exists`);
      await inflight.done.catch(() => undefined);
    }
    const existing = this.ledger.get(sessionId);
    if (existing) {
      if (this.interrupted(existing) && existing.ownerId === principal.accountId) {
        await this.discardInterrupted(existing);
      } else {
        if (existing.ownerId === principal.accountId && existing.kind === "workspace" && existing.state !== "deleted" && existing.state !== "deleting") {
          return { sessionId, created: false, incarnation: existing.incarnation };
        }
        throw new ManagedCopilotError("conflict", `Session ${sessionId} already exists`);
      }
    }
    const environment = this.options.environments.resolve(request.environment);
    if (request.parentSessionId === undefined) assertAppEnvironment(this.options.app.services.apps, principal, environment.name);
    if (environment.type !== "isolated") {
      throw new ManagedCopilotError("invalid_request", `Environment "${environment.name}" is ${environment.type}; workspace-only sandboxes need an isolated environment.`, { environment: environment.name });
    }
    if (!this.sandboxes) throw new ManagedCopilotError("capability_unavailable", `Environment "${environment.name}" needs isolated sandboxes, which this deployment does not provide yet`);
    let parent: { readonly id: string; readonly incarnation: string } | undefined;
    if (request.parentSessionId !== undefined) {
      const record = this.getOwned(principal.accountId, request.parentSessionId);
      if (record.state === "deleting") throw new ManagedCopilotError("not_found", `Session ${record.id} was not found`, { sessionId: record.id });
      parent = { id: record.id, incarnation: record.incarnation };
    }
    if (this.creating.has(sessionId) || this.ledger.get(sessionId)) throw new ManagedCopilotError("conflict", `Session ${sessionId} already exists`);
    const done = this.#createWorkspaceReserved(principal, environment, sessionId, parent, request.clientName);
    this.creating.set(sessionId, { ownerId: principal.accountId, done });
    try {
      await done;
    } finally {
      this.creating.delete(sessionId);
    }
    const created = this.ledger.get(sessionId)?.incarnation;
    return { sessionId, created: true, ...(created ? { incarnation: created } : {}) };
  }

  /** Records the session, binds its network policy, and creates its sandbox without a runtime. Nothing is left on failure. */
  async #createWorkspaceReserved(
    principal: Principal,
    environment: ResolvedEnvironment,
    sessionId: string,
    parent: { readonly id: string; readonly incarnation: string } | undefined,
    clientName: string | undefined,
  ): Promise<void> {
    let network: NetworkPolicy = environment.network;
    const policy = this.policy;
    if (policy) {
      const bound = await policy.bindSession({
        sessionId,
        owner: principal.accountId,
        environment: environment.inline ? undefined : environment.name,
        type: environment.type,
        requested: environment.request.network,
        vaults: environment.request.vaults,
      });
      if (bound) network = bound;
    }
    let inserted = false;
    try {
      const record = this.ledger.insert({
        id: sessionId,
        owner: accountInfo(principal),
        environment: environment.name,
        type: environment.type,
        placement: "sandbox",
        network,
        environmentRequest: environment.request,
        admitted: { params: {}, optionsPatch: {} },
        kind: "workspace",
        ...(clientName ? { clientName } : {}),
        ...(parent ? { parentSessionId: parent.id, parentIncarnation: parent.incarnation } : {}),
      });
      inserted = true;
      await this.sandboxes!.create({
        sessionId,
        ownerId: principal.accountId,
        environment: environment.name,
        size: environment.config.size ?? "small",
        network,
        ...(environment.request.vaults ? { vaults: environment.request.vaults } : {}),
        additions: {
          ...(environment.request.files ? { files: environment.request.files } : {}),
          ...(environment.request.packages ? { packages: environment.request.packages } : {}),
          ...(environment.request.env ? { env: environment.request.env } : {}),
        },
        resolved: environment,
        runtime: false,
      });
      this.ledger.update(sessionId, { state: "ready" });
      this.options.events.emit("session.created", {
        ownerId: principal.accountId,
        sessionId,
        environment: environment.name,
        data: { placement: "sandbox", type: environment.type, kind: "workspace", incarnation: record.incarnation },
      });
      this.log.info("Workspace-only session created", { sessionId, owner: principal.login, environment: environment.name });
    } catch (error) {
      if (inserted) {
        this.ledger.remove(sessionId);
        await this.sandboxes?.delete(sessionId).catch((cleanup: unknown) => this.log.warn("Sandbox cleanup after failed create failed", { sessionId, error: (cleanup as Error).message }));
      }
      await Promise.resolve(this.policy?.releaseSession?.(sessionId)).catch(() => undefined);
      this.log.warn("Workspace-only session creation failed", { sessionId, environment: environment.name, error: (error as Error).message });
      throw error;
    }
  }

  /** A workspace-only session's busy accounting: `running` while commands run in its sandbox, `idle` once none do. */
  execActivity(sessionId: string, running: number): void {
    const record = this.get(sessionId);
    if (!record || record.kind !== "workspace") return;
    if (record.state !== "ready" && record.state !== "idle" && record.state !== "running") return;
    const state = running > 0 ? "running" : "idle";
    if (record.state !== state) this.ledger.update(sessionId, { state });
  }

  async send(principal: Principal, sessionId: string, input: { prompt: string; source?: string; mode?: string }, options: SessionSendOptions = {}): Promise<{ messageId: string }> {
    this.getOwned(principal.accountId, sessionId);
    this.#checkIncarnation(sessionId, options.incarnation);
    // The caller's verified credential serves the session while this call runs (a restore it triggers, for example),
    // unless the caller only borrowed it from another session's connection.
    const release = options.lendCredential === false ? undefined : this.presence(sessionId, principal);
    try {
      const result = await this.request<{ messageId: string }>(
        sessionId,
        "session.send",
        {
          prompt: input.prompt,
          mode: input.mode ?? "enqueue",
          ...(input.source ? { source: input.source } : {}),
        },
        { ...(options.incarnation !== undefined ? { incarnation: options.incarnation } : {}) },
      );
      return { messageId: result.messageId };
    } finally {
      release?.();
    }
  }

  async request<T = unknown>(sessionId: string, method: string, params: Record<string, unknown> = {}, options: SessionCallOptions = {}): Promise<T> {
    this.#checkIncarnation(sessionId, options.incarnation);
    const live = this.liveFor(sessionId);
    // A turn started without the client that answers the session's hooks would run unguarded: refuse it.
    if (method === "session.send" || method === "session.sendAndWait") this.assertHooks(live);
    for (;;) {
      try {
        const result = await this.onOwner(live, live.placement, (upstream) => {
          // In the step that writes it: a call for one incarnation never reaches a session that reused its ID.
          this.#checkIncarnation(sessionId, options.incarnation);
          return upstream.request<T>(method, { ...params, sessionId });
        });
        return HISTORY_METHODS.has(method) ? this.withoutHidden(live, result) : result;
      } catch (error) {
        // Service calls carry no placement-specific admission: send them where the session lives now.
        if (error !== MOVED) throw error;
      }
    }
  }

  /** Refuses a call meant for another incarnation of the session ID (`incarnation` unset: any). */
  #checkIncarnation(sessionId: string, incarnation: string | undefined): void {
    if (incarnation !== undefined && this.get(sessionId)?.incarnation !== incarnation) {
      throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found (it was deleted, and its ID may have been reused)`, { sessionId });
    }
  }

  /**
   * Sends on the session's owning runtime. The owner is checked and the request written in one synchronous step, so
   * nothing reaches a runtime after a placement cutover fenced it. Throws MOVED when the session left `placement`.
   */
  protected async onOwner<T>(live: LiveSession, placement: Placement, send: (upstream: RuntimeUpstream) => Promise<T>): Promise<T> {
    for (;;) {
      const upstream = await this.resident(live);
      if (live.placement !== placement) throw MOVED;
      // A sandbox stop destroys the runtime's stream before its transport reports the close: close the connection now,
      // so this call waits for the stop and the restore instead of writing to a stream that is gone.
      if (live.upstream === upstream && live.placement === "sandbox" && live.sandbox?.stream.destroyed && !upstream.closed) upstream.close();
      if (live.upstream === upstream && live.ready && !live.cutover?.fenced && !upstream.closed) return this.#counted(live, () => send(upstream));
      if (live.deleting) throw new ManagedCopilotError("not_found", `Session ${live.id} was not found`, { sessionId: live.id });
      await Promise.resolve(live.residency).catch(() => undefined);
    }
  }

  /** Counts a call to the session's runtime until it settles. `send` runs synchronously, in the caller's turn. */
  async #counted<T>(live: LiveSession, send: () => Promise<T>): Promise<T> {
    live.requests++;
    live.lastRequestAt = Date.now();
    try {
      return await send();
    } finally {
      live.requests--;
      live.lastRequestAt = Date.now();
    }
  }

  /**
   * How core is using a session's runtime, for an operator's sandbox stop: `busy` names work in progress, and
   * `lastRequestAt` is when a call to the runtime last started or settled. Synchronous: a caller that checks it and
   * closes the runtime in the same turn cannot miss a call written in between.
   */
  runtimeActivity(sessionId: string): { readonly busy?: string; readonly lastRequestAt?: number } | undefined {
    const live = this.live.get(sessionId);
    if (!live) return undefined;
    const busy =
      live.requests > 0
        ? "a call to its runtime is in progress"
        : live.residency !== undefined
          ? "its runtime is being opened"
          : live.cutover !== undefined
            ? "it is moving to another placement"
            : live.deleting
              ? "it is being deleted"
              : live.presences.size > 0
                ? "a Copilot CLI is attached to it"
                : undefined;
    return { ...(busy ? { busy } : {}), ...(live.lastRequestAt !== undefined ? { lastRequestAt: live.lastRequestAt } : {}) };
  }

  /** History reads never include events a placement cutover hid (the source's handoff after the seal). */
  protected withoutHidden<T>(live: LiveSession, result: T): T {
    const events = (result as { events?: unknown } | undefined)?.events;
    if (!Array.isArray(events)) return result;
    live.hidden ??= this.ledger.hiddenEvents(live.id);
    if (live.hidden.size === 0) return result;
    const hidden = live.hidden;
    return { ...(result as Record<string, unknown>), events: events.filter((event) => !hidden.has(String((event as { id?: unknown })?.id))) } as T;
  }

  async abort(sessionId: string): Promise<void> {
    await this.request(sessionId, "session.abort", {});
  }

  async delete(accountId: number, sessionId: string): Promise<void> {
    const record = this.getOwned(accountId, sessionId);
    // A deletion the gateway stopped in the middle of is finished by the next request (or by startup recovery).
    if (record.state === "deleting" && this.deletions.has(sessionId)) throw new ManagedCopilotError("conflict", `Session ${sessionId} is already being deleted`);
    await this.#deleteRecord(record);
  }

  async #deleteRecord(record: SessionRecord): Promise<void> {
    const sessionId = record.id;
    if (this.deletions.has(sessionId)) throw new ManagedCopilotError("conflict", `Session ${sessionId} is already being deleted`);
    this.deletions.add(sessionId);
    try {
      // Only the incarnation this deletion is for: an ID deleted and created again since belongs to a new session.
      const current = this.ledger.get(sessionId);
      if (!current || current.incarnation !== record.incarnation) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
      await this.#deleteOwned(current);
    } finally {
      this.deletions.delete(sessionId);
    }
  }

  async #deleteOwned(record: SessionRecord): Promise<void> {
    const sessionId = record.id;
    const live = this.live.get(sessionId);
    if (live) {
      live.deleting = true;
      // A registration step still waiting on the session's sandbox runtime ends now (its connection is closed), so the
      // drain below cannot wait on it forever.
      live.ending.abort(new ManagedCopilotError("not_found", `Session ${sessionId} was deleted`, { sessionId }));
    }
    this.ledger.update(sessionId, { state: "deleting" });
    // A placement cutover in progress ends here (its owner cleans up the candidate sandbox on `deleted`).
    if (live?.cutover) await this.abortCutover(live, live.cutover, undefined).catch(() => undefined);
    if (live) for (const held of live.held.splice(0)) held.reject(new RpcError(-32000, `Session ${sessionId} was deleted`, { code: "not_found" }));
    // Let an in-flight create/resume (and registrations waiting their turn) settle so none reopens the session after
    // deletion; they see it is being deleted.
    await live?.residency?.catch(() => undefined);
    await live?.registrations;
    const placement = (this.get(sessionId) ?? record).placement;
    try {
      if (placement === "sandbox") {
        const sandboxes = this.sandboxes;
        if (!sandboxes) throw new ManagedCopilotError("capability_unavailable", "The sandbox service is not available, so the sandbox cannot be deleted yet");
        live?.upstream?.close();
        live?.sandbox?.close?.();
        await sandboxes.delete(sessionId);
      } else {
        const upstream = await this.options.sharedRuntime?.ready();
        if (upstream) {
          type DeleteResult = { success?: boolean; error?: string };
          const result = await upstream.request<DeleteResult>("session.delete", { sessionId }).catch((error: unknown): DeleteResult => {
            if (error instanceof RpcError && /not found|does not exist/i.test(error.message)) return { success: true };
            throw error;
          });
          if (result && result.success === false && result.error && !/not found|does not exist/i.test(result.error)) {
            throw new ManagedCopilotError("internal", `The runtime could not delete session ${sessionId}: ${result.error}`);
          }
        }
      }
      await Promise.resolve(this.policy?.releaseSession?.(sessionId)).catch((error: unknown) => this.log.warn("Policy release failed", { sessionId, error: (error as Error).message }));
    } catch (error) {
      this.ledger.update(sessionId, { state: "failed" });
      if (live) {
        live.deleting = false;
        // The session stays (failed, and deletable again), so steps on its runtime are no longer ended.
        if (!this.stopped) live.ending = new AbortController();
        // Its runtime connection, which the deletion closed (or saw close), is lost like any other now that the session
        // stays: observers learn its runtime stopped, and a turn the connection cut ends unless durable carries it (as
        // `#onUpstreamClosed` does; also a turn an earlier failed deletion left, whose ending this one preempted). The
        // session stays failed.
        const closed = live.closedWhileDeleting;
        live.closedWhileDeleting = false;
        if (!live.upstream && !live.residency) {
          if (closed) this.emitLifecycle(sessionId, "stopped");
          if (!live.cutover && !this.stopped) this.endLostTurn(live);
        }
      }
      throw error instanceof ManagedCopilotError ? error : new ManagedCopilotError("internal", `Deleting session ${sessionId} failed; it is marked failed and can be deleted again`);
    }
    if (live) {
      for (const attachment of live.attachments.values()) {
        attachment.peer.notify("session.lifecycle", { type: "session.deleted", sessionId });
        this.actions?.onDetached(attachment.peer.id, sessionId);
      }
      live.attachments.clear();
      this.live.delete(sessionId);
    }
    this.ledger.remove(sessionId);
    this.options.events.emit("session.deleted", { ownerId: record.ownerId, sessionId, environment: record.environment, data: { incarnation: record.incarnation } });
    this.emitLifecycle(sessionId, "deleted");
  }

  /**
   * Finishes what a stopped gateway left half done: deletions it was running finish, and the reservations of creates
   * it was running are cleaned up (so a retry with the same session ID creates the session).
   */
  async recover(): Promise<void> {
    for (const record of this.ledger.byState("deleting")) {
      // A snapshot: each row is checked again under its reservation, so a session deleted and created since is safe.
      if (this.deletions.has(record.id) || this.ledger.get(record.id)?.incarnation !== record.incarnation) continue;
      this.log.info("Finishing a session deletion the gateway stopped in the middle of", { sessionId: record.id });
      await this.#deleteRecord(record).catch((error: unknown) => this.log.warn("Finishing an interrupted deletion failed; delete the session again", { sessionId: record.id, error: (error as Error).message }));
    }
    for (const record of this.ledger.byState("creating")) {
      await this.discardInterrupted(record).catch((error: unknown) => this.log.warn("Cleaning up an interrupted create failed", { sessionId: record.id, error: (error as Error).message }));
    }
    // Turns the stopped gateway was running were cut with its runtime connections (its shared runtime stopped with it,
    // and a sandbox runtime cannot serve a new gateway's inference): they end, unless durable carries their pending
    // work. So does a turn a failed deletion cut (the session stays `failed`), including one just finished above. A
    // session a client restored meanwhile has its turn checked by that restore instead.
    for (const record of [...this.ledger.byState("running"), ...this.ledger.byState("failed")]) {
      const turnId = unfinished(record.lastTurn) ? record.lastTurn.turnId : undefined;
      if (!turnId) continue;
      let live: LiveSession;
      try {
        live = this.liveFor(record.id);
      } catch {
        continue;
      }
      if (live.upstream || live.residency) continue;
      this.endLostTurn(live, turnId);
    }
  }

  /** Removes what a create the gateway stopped in the middle of allocated; the session never existed for its owner. */
  protected discardInterrupted(record: SessionRecord): Promise<void> {
    // Concurrent callers (startup recovery, a retried create) share one cleanup.
    const running = this.discards.get(record.id);
    if (running) return running;
    const done = this.#discard(record).finally(() => {
      if (this.discards.get(record.id) === done) this.discards.delete(record.id);
    });
    this.discards.set(record.id, done);
    return done;
  }

  async #discard(record: SessionRecord): Promise<void> {
    const sessionId = record.id;
    // Only that reservation, still interrupted: never a session that was created or deleted since.
    const current = this.ledger.get(sessionId);
    if (!current || current.incarnation !== record.incarnation || current.state !== "creating" || this.creating.has(sessionId) || this.deletions.has(sessionId)) return;
    this.deletions.add(sessionId);
    try {
      this.log.warn("Cleaning up a session whose creation was interrupted", { sessionId, environment: record.environment });
      if (record.placement === "sandbox") {
        const sandboxes = this.sandboxes;
        if (!sandboxes) {
          this.ledger.update(sessionId, { state: "failed" });
          throw new ManagedCopilotError("capability_unavailable", "The sandbox service is not available, so the interrupted session's sandbox cannot be removed yet");
        }
        // While the row exists no other session can hold the ID, so its sandbox is the interrupted one's.
        await sandboxes.delete(sessionId);
      }
      await Promise.resolve(this.policy?.releaseSession?.(sessionId)).catch((error: unknown) => this.log.warn("Policy release failed", { sessionId, error: (error as Error).message }));
      if (this.ledger.get(sessionId)?.incarnation === record.incarnation) this.ledger.remove(sessionId);
    } finally {
      this.deletions.delete(sessionId);
    }
  }

  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeSession(sessionId: string, listener: SessionEventListener): () => void {
    let set = this.sessionListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionListeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.sessionListeners.delete(sessionId);
    };
  }

  attached(sessionId: string): readonly AttachedResponder[] {
    const live = this.live.get(sessionId);
    return live ? this.responders(live) : [];
  }

  async runtime(sessionId: string): Promise<SessionRuntime> {
    const live = this.liveFor(sessionId);
    const upstream = await this.resident(live);
    const closed = new Promise<void>((resolve) => upstream.endpoint.transport.onClose(() => resolve()));
    const sandboxes = this.sandboxes;
    return {
      connectionId: `${upstream.info.id}#${live.placement === "shared" ? this.options.sharedRuntime?.generation ?? 0 : 0}`,
      request: <T>(method: string, params?: unknown) => upstream.request<T>(method, params),
      connect: (port: number) => {
        if (live.placement === "shared") {
          return new Promise<Duplex>((resolve, reject) => {
            const socket = connectTcp({ host: "127.0.0.1", port }, () => {
              socket.off("error", reject);
              resolve(socket);
            });
            socket.once("error", reject);
          });
        }
        if (!sandboxes?.connect) throw new ManagedCopilotError("capability_unavailable", "Attaching to sandbox sessions needs the sandbox port tunnel");
        return sandboxes.connect(sessionId, port);
      },
      closed,
    };
  }

  onLifecycle(listener: (event: { sessionId: string; type: "deleted" | "promoted" | "stopped" }) => void): () => void {
    this.lifecycle.add(listener);
    return () => {
      this.lifecycle.delete(listener);
    };
  }

  // ------------------------------------------------------------------------------------------------------------
  // Operator views: read-only snapshots for the operator console (no credentials, no conversation). Reading them
  // never makes a session resident.

  /** Ledger records of every owner, newest first (interrupted creates left out, as everywhere else). */
  operatorRecords(query: Parameters<SessionLedger["listAll"]>[0] = {}): SessionRecord[] {
    return this.ledger.listAll(query).filter((record) => !this.interrupted(record));
  }

  /** The session's stored admitted configuration (credential-free by construction). */
  operatorAdmitted(sessionId: string): AdmittedConfig | undefined {
    return this.ledger.admitted(sessionId);
  }

  /** What the gateway holds in memory for sessions it has touched since it started (all, or one). */
  operatorLive(sessionId?: string): LiveSessionSnapshot[] {
    const lives = sessionId === undefined ? [...this.live.values()] : [this.live.get(sessionId)].filter((live): live is LiveSession => live !== undefined);
    return lives.map((live) => {
      const upstream = live.upstream && !live.upstream.closed ? live.upstream : undefined;
      return {
        id: live.id,
        ownerId: live.ownerId,
        environment: live.environment.name,
        placement: live.placement,
        resident: Boolean(upstream && live.ready),
        ready: live.ready,
        ...(upstream ? { upstream: upstream.info.id, upstreamVersion: upstream.version } : {}),
        restoring: live.residency !== undefined,
        cutover: live.cutover !== undefined && !live.cutover.flushed,
        deleting: live.deleting,
        waits: live.waits.size,
        presences: live.presences.size,
        attachments: [...live.attachments.values()].map((attachment) => ({
          connectionId: attachment.peer.id,
          kind: attachment.peer.kind,
          account: accountInfo(attachment.peer.principal),
          ...(attachment.peer.clientName ? { clientName: attachment.peer.clientName } : {}),
          attachedAt: new Date(attachment.attachedAt).toISOString(),
          tools: [...attachment.tools].sort(),
          callbacks: attachmentCallbacks(attachment),
        })),
      };
    });
  }
}
