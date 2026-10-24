// The session manager: ownership, placement, upstream residency, request routing, and event fan-out for every
// session the gateway hosts. Client connections attach to sessions; the gateway owns the upstream runtime
// connections, so detaching or disconnecting a client never stops a session or cancels accepted work.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import {
  ManagedCopilotError,
  type NetworkPolicy,
  type PendingAction,
  type Placement,
  type SessionInfo,
  type SessionState,
} from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import type { Principal } from "../../http.js";
import type { Logger } from "../../log.js";
import {
  ACTION_EVENT_TYPES,
  ANSWER_METHOD_SET,
  type ActionsService,
  type AttachedResponder,
  type RuntimeSessionEvent,
} from "../durable/contract.js";
import { admitOptionsUpdate, admitSession, admitToolsSet, checkModel, type AdmissionContext, type AdmittedSession } from "./admission.js";
import { accountInfo, type GitHubAuthenticator } from "./auth.js";
import {
  optionalService,
  type CreateSessionRequest,
  type NetworkPolicyService,
  type PlatformToolRegistry,
  type ResolvedEnvironment,
  type RuntimeRequestRegistry,
  type SandboxPlacement,
  type SandboxRuntimeHandle,
  type SessionEventListener,
  type SessionRecord,
  type SessionRuntime,
  type SessionsService,
} from "./contracts.js";
import type { Environments } from "./environments.js";
import type { PlatformEvents } from "./events.js";
import type { AdmittedConfig, SessionLedger } from "./ledger.js";
import { RpcError, streamTransport, unsupportedMethod, type IncomingRequestContext } from "./rpc.js";
import { RuntimeUpstream, type SharedRuntime, type UpstreamHandlers } from "./runtime.js";

/** The router's view of a connected client (implemented by `ClientConnection`). */
export interface ClientPeer {
  readonly id: string;
  readonly kind: "sdk" | "cli";
  readonly principal: Principal;
  readonly environment: ResolvedEnvironment;
  readonly clientName: string | undefined;
  notify(method: string, params: unknown): void;
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  readonly closed: boolean;
}

interface Attachment {
  readonly peer: ClientPeer;
  readonly attachedAt: number;
  tools: Set<string>;
  requestPermission: boolean;
  requestUserInput: boolean;
  requestElicitation: boolean;
  requestExitPlanMode: boolean;
  requestAutoModeSwitch: boolean;
  hooks: boolean;
  skillProvider: boolean;
}

/** Per-connection wire settings resent when the gateway resumes a session upstream on its own. */
interface WireSettings {
  tools: Record<string, unknown>[];
  flags: Record<string, unknown>;
}

interface LiveSession {
  readonly id: string;
  readonly ownerId: number;
  readonly placement: Placement;
  readonly environment: ResolvedEnvironment;
  readonly tokenRegistrationId: string;
  upstream: RuntimeUpstream | undefined;
  sandbox: SandboxRuntimeHandle | undefined;
  readonly attachments: Map<string, Attachment>;
  creator: string | undefined;
  wire: WireSettings;
  /** Ensures events of one session are processed in order even when routing awaits the actions hook. */
  queue: Promise<void>;
  residency: Promise<RuntimeUpstream> | undefined;
  deleting: boolean;
}

/** Runtime → client requests bound to a session and the attachment flag that answers them. */
const CLIENT_REQUESTS: Record<string, keyof Attachment | undefined> = {
  "userInput.request": "requestUserInput",
  "exitPlanMode.request": "requestExitPlanMode",
  "autoModeSwitch.request": "requestAutoModeSwitch",
  "hooks.invoke": "hooks",
  "skillProvider.list": "skillProvider",
  "skillProvider.read": "skillProvider",
  "systemMessage.transform": undefined,
  "canvas.open": undefined,
  "canvas.close": undefined,
  "canvas.action.invoke": undefined,
};

/** Session-scoped client methods forwarded upstream after the ownership check (supported-operation matrix). */
const FORWARDED_SESSION_METHODS = new Set([
  "session.send",
  "session.sendAndWait",
  "session.abort",
  "session.getMessages",
  "session.log",
  "session.ui.handlePendingUserInput",
  "session.ui.handlePendingExitPlanMode",
  "session.ui.handlePendingAutoModeSwitch",
  "session.ui.elicitation",
  "session.commands.handlePendingCommand",
  "session.mcp.oauth.handlePendingRequest",
  "session.eventLog.registerInterest",
  "session.eventLog.releaseInterest",
  "session.eventLog.read",
  "session.eventLog.tail",
  "session.model.getCurrent",
  "session.model.list",
  "session.model.setReasoningEffort",
  "session.model.getReasoningSummaries",
  "session.mode.get",
  "session.mode.set",
  "session.name.get",
  "session.name.set",
  "session.name.setAuto",
  "session.tools.getCurrentMetadata",
  "session.tools.listPendingRequests",
  "session.permissions.pendingRequests",
  "session.agent.list",
  "session.agent.getCurrent",
  "session.agent.select",
  "session.agent.deselect",
  "session.skills.list",
  "session.usage.getMetrics",
  "session.quota.get",
  "session.plan.read",
  "session.history.compact",
  "session.metadata.isProcessing",
  "session.metadata.snapshot",
  "session.canvas.list",
  "session.canvas.listOpen",
  "session.canvas.open",
  "session.canvas.close",
  "session.canvas.action.invoke",
  "session.tools.handlePendingToolCall",
  "session.permissions.handlePendingPermissionRequest",
  "session.ui.handlePendingElicitation",
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 8 * 60 * 60;

export interface SessionManagerOptions {
  readonly app: GatewayApp;
  readonly log: Logger;
  readonly ledger: SessionLedger;
  readonly environments: Environments;
  readonly events: PlatformEvents;
  readonly platformTools: PlatformToolRegistry;
  readonly runtimeRequests: RuntimeRequestRegistry;
  readonly auth: GitHubAuthenticator;
  readonly sharedRuntime: SharedRuntime | undefined;
}

export class SessionManager implements SessionsService {
  readonly #options: SessionManagerOptions;
  readonly #log: Logger;
  readonly #ledger: SessionLedger;
  readonly #live = new Map<string, LiveSession>();
  readonly #listeners = new Set<SessionEventListener>();
  readonly #sessionListeners = new Map<string, Set<SessionEventListener>>();
  readonly #lifecycle = new Set<(event: { sessionId: string; type: "deleted" | "promoted" | "stopped" }) => void>();
  readonly #upstreamHandlers: UpstreamHandlers;

  constructor(options: SessionManagerOptions) {
    this.#options = options;
    this.#log = options.log;
    this.#ledger = options.ledger;
    this.#upstreamHandlers = {
      onNotification: (upstream, method, params) => this.#onUpstreamNotification(upstream, method, params),
      onRequest: (upstream, method, params, context) => this.#onUpstreamRequest(upstream, method, params, context),
      onClose: (upstream) => this.#onUpstreamClosed(upstream),
    };
  }

  /** Handlers the shared runtime's upstream uses. */
  get upstreamHandlers(): UpstreamHandlers {
    return this.#upstreamHandlers;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Optional services from other workstreams

  get #actions(): ActionsService | undefined {
    return this.#options.app.services.actions;
  }

  get #sandboxes(): SandboxPlacement | undefined {
    return optionalService<SandboxPlacement>(this.#options.app.services, "sandboxes");
  }

  get #policy(): NetworkPolicyService | undefined {
    return optionalService<NetworkPolicyService>(this.#options.app.services, "policy");
  }

  // ------------------------------------------------------------------------------------------------------------
  // SessionsService

  get(sessionId: string): SessionRecord | undefined {
    const record = this.#ledger.get(sessionId);
    return record && record.state !== "deleted" ? record : undefined;
  }

  getOwned(accountId: number, sessionId: string): SessionRecord {
    const record = this.get(sessionId);
    if (!record || record.ownerId !== accountId) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
    return record;
  }

  async info(accountId: number, sessionId: string): Promise<SessionInfo> {
    return this.toInfo(this.getOwned(accountId, sessionId));
  }

  list(accountId: number, query?: { environment?: string; state?: SessionState; limit?: number }): SessionRecord[] {
    return this.#ledger.list(accountId, query);
  }

  async toInfo(record: SessionRecord): Promise<SessionInfo> {
    let sandbox: SessionInfo["sandbox"];
    if (record.placement === "sandbox") {
      try {
        sandbox = await this.#sandboxes?.get(record.id);
      } catch (error) {
        this.#log.warn("Could not read sandbox details", { sessionId: record.id, error: (error as Error).message });
      }
    }
    let pendingActions: readonly PendingAction[] = [];
    try {
      pendingActions = this.#actions?.list(record.id, { open: true }) ?? [];
    } catch (error) {
      this.#log.warn("Could not read pending actions", { sessionId: record.id, error: (error as Error).message });
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
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(sandbox ? { sandbox } : {}),
      pendingActions,
      ...(record.lastTurn ? { lastTurn: record.lastTurn } : {}),
      ...(record.scheduleId ? { scheduleId: record.scheduleId } : {}),
    };
  }

  async create(principal: Principal, request: CreateSessionRequest): Promise<{ sessionId: string; created: boolean }> {
    const sessionId = request.sessionId ?? randomUUID();
    const existing = this.#ledger.get(sessionId);
    if (existing) {
      if (existing.ownerId === principal.accountId && existing.state !== "deleted") return { sessionId, created: false };
      throw new ManagedCopilotError("conflict", `Session ${sessionId} already exists`);
    }
    const environment = this.#options.environments.resolve(request.environment);
    const raw: Record<string, unknown> = {
      sessionId,
      ...(request.model ? { model: request.model } : {}),
      ...(request.agent ? { agent: request.agent } : {}),
      ...(request.systemMessage !== undefined ? { systemMessage: request.systemMessage } : {}),
      streaming: request.streaming ?? true,
      tools: (request.tools ?? []).map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), ...(tool.parameters ? { parameters: tool.parameters } : {}) })),
      requestPermission: true,
      ...(request.clientName ? { clientName: request.clientName } : {}),
    };
    await this.#create({ principal, environment, raw, peer: undefined, scheduleId: request.scheduleId, webhook: request.webhook, clientName: request.clientName });
    return { sessionId, created: true };
  }

  async send(principal: Principal, sessionId: string, input: { prompt: string; source?: string; mode?: string }): Promise<{ messageId: string }> {
    this.getOwned(principal.accountId, sessionId);
    const result = await this.request<{ messageId: string }>(sessionId, "session.send", {
      prompt: input.prompt,
      mode: input.mode ?? "enqueue",
      ...(input.source ? { source: input.source } : {}),
    });
    return { messageId: result.messageId };
  }

  async request<T = unknown>(sessionId: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
    const live = this.#liveFor(sessionId);
    const upstream = await this.#resident(live);
    return upstream.request<T>(method, { ...params, sessionId });
  }

  async abort(sessionId: string): Promise<void> {
    await this.request(sessionId, "session.abort", {});
  }

  async delete(accountId: number, sessionId: string): Promise<void> {
    const record = this.getOwned(accountId, sessionId);
    const live = this.#live.get(sessionId);
    if (live) live.deleting = true;
    this.#ledger.update(sessionId, { state: "deleting" });
    try {
      if (record.placement === "sandbox") {
        const sandboxes = this.#sandboxes;
        if (!sandboxes) throw new ManagedCopilotError("capability_unavailable", "The sandbox service is not available, so the sandbox cannot be deleted yet");
        live?.upstream?.close();
        await sandboxes.delete(sessionId);
      } else {
        const upstream = await this.#options.sharedRuntime?.ready();
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
      await Promise.resolve(this.#policy?.releaseSession?.(sessionId)).catch((error: unknown) => this.#log.warn("Policy release failed", { sessionId, error: (error as Error).message }));
    } catch (error) {
      this.#ledger.update(sessionId, { state: "failed" });
      if (live) live.deleting = false;
      throw error instanceof ManagedCopilotError ? error : new ManagedCopilotError("internal", `Deleting session ${sessionId} failed; it is marked failed and can be deleted again`);
    }
    if (live) {
      for (const attachment of live.attachments.values()) {
        attachment.peer.notify("session.lifecycle", { type: "session.deleted", sessionId });
        this.#actions?.onDetached(attachment.peer.id);
      }
      live.attachments.clear();
      this.#live.delete(sessionId);
    }
    this.#ledger.remove(sessionId);
    this.#options.events.emit("session.deleted", { ownerId: record.ownerId, sessionId, environment: record.environment, data: {} });
    this.#emitLifecycle(sessionId, "deleted");
  }

  subscribe(listener: SessionEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  subscribeSession(sessionId: string, listener: SessionEventListener): () => void {
    let set = this.#sessionListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.#sessionListeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#sessionListeners.delete(sessionId);
    };
  }

  attached(sessionId: string): readonly AttachedResponder[] {
    const live = this.#live.get(sessionId);
    return live ? this.#responders(live) : [];
  }

  async runtime(sessionId: string): Promise<SessionRuntime> {
    const live = this.#liveFor(sessionId);
    const upstream = await this.#resident(live);
    const closed = new Promise<void>((resolve) => upstream.endpoint.transport.onClose(() => resolve()));
    const sandboxes = this.#sandboxes;
    return {
      connectionId: `${upstream.info.id}#${live.placement === "shared" ? this.#options.sharedRuntime?.generation ?? 0 : 0}`,
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
    this.#lifecycle.add(listener);
    return () => {
      this.#lifecycle.delete(listener);
    };
  }

  // ------------------------------------------------------------------------------------------------------------
  // Client operations (called by the /v1/connect router)

  async createForClient(peer: ClientPeer, raw: unknown): Promise<{ result: unknown; after: () => Promise<void> }> {
    if (!raw || typeof raw !== "object") throw new ManagedCopilotError("invalid_request", "session.create params must be an object");
    const params = { ...(raw as Record<string, unknown>) };
    if (params["sessionId"] === undefined) params["sessionId"] = randomUUID();
    const sessionId = params["sessionId"];
    if (typeof sessionId !== "string" || !ID_PATTERN.test(sessionId)) throw new ManagedCopilotError("invalid_request", "sessionId must be a UUID");
    if (this.#ledger.get(sessionId)) throw new ManagedCopilotError("conflict", `Session ${sessionId} already exists; resume it instead`);
    const result = await this.#create({ principal: peer.principal, environment: peer.environment, raw: params, peer, clientName: peer.clientName });
    return { result, after: () => this.#afterAttach(peer, sessionId) };
  }

  async resumeForClient(peer: ClientPeer, raw: unknown): Promise<{ result: unknown; after: () => Promise<void> }> {
    if (!raw || typeof raw !== "object") throw new ManagedCopilotError("invalid_request", "session.resume params must be an object");
    const params = raw as Record<string, unknown>;
    const sessionId = params["sessionId"];
    if (typeof sessionId !== "string") throw new ManagedCopilotError("invalid_request", "session.resume needs a sessionId");
    const record = this.getOwned(peer.principal.accountId, sessionId);
    if (record.environment !== peer.environment.name) {
      throw new ManagedCopilotError("invalid_request", `Session ${sessionId} belongs to environment "${record.environment}"; resume it with a client for that environment`);
    }
    if (record.state === "deleting") throw new ManagedCopilotError("conflict", `Session ${sessionId} is being deleted`);
    const live = this.#liveFor(sessionId);
    const admitted = await this.#admit(live.environment, live.placement, params, "resume", record.network, sessionId, live.tokenRegistrationId, peer.principal);
    await this.#checkRemoteMcp(admitted, sessionId, live.placement, record.network);
    const upstream = await this.#resident(live, { skipResume: true });
    const forwarded = await this.#prepare(live, "session.resume", admitted.params);
    this.#attach(live, peer, admitted, forwarded);
    let result: unknown;
    try {
      result = await upstream.request("session.resume", forwarded);
      await this.#opened(live, upstream, admitted.optionsPatch);
    } catch (error) {
      this.#detach(live, peer.id);
      throw error;
    }
    this.#ledger.update(sessionId, { state: record.state === "failed" || record.state === "stopped" ? "ready" : record.state, ...(admitted.model ? { model: admitted.model } : {}) });
    return { result: this.#sanitizeResponse(live, result), after: () => this.#afterAttach(peer, sessionId) };
  }

  async forwardForClient(peer: ClientPeer, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const sessionId = params["sessionId"];
    if (typeof sessionId !== "string") throw unsupportedMethod(method);
    const live = this.#attachedLive(peer, sessionId, method);
    if (!FORWARDED_SESSION_METHODS.has(method) && method !== "session.options.update" && method !== "session.tools.set" && method !== "session.model.switchTo" && method !== "session.model.switchAutoTier") {
      throw unsupportedMethod(method);
    }
    const record = this.getOwned(peer.principal.accountId, sessionId);
    let forwarded: Record<string, unknown> = params;
    const context = (): AdmissionContext => ({
      environment: live.environment,
      placement: live.placement,
      network: record.network,
      platformTools: this.#platformToolsFor(live.environment, live.placement),
      workingDirectory: this.#workingDirectory(live.placement, sessionId),
      tokenRegistrationId: live.tokenRegistrationId,
    });
    switch (method) {
      case "session.options.update":
        forwarded = { ...admitOptionsUpdate(params, context()), sessionId };
        break;
      case "session.tools.set": {
        const admitted = admitToolsSet(params, context());
        forwarded = { ...admitted.params, sessionId };
        const attachment = live.attachments.get(peer.id);
        if (attachment) attachment.tools = new Set(admitted.names);
        live.wire.tools = (admitted.params["tools"] as Record<string, unknown>[]).filter((tool) => !this.#options.platformTools.has(String(tool["name"])));
        break;
      }
      case "session.model.switchTo":
        checkModel(live.environment, params["modelId"]);
        break;
      case "session.model.switchAutoTier":
        if (live.environment.config.models) throw new ManagedCopilotError("policy_violation", `Environment "${live.environment.name}" restricts models; Auto routing is not available`);
        break;
      default:
        if (ANSWER_METHOD_SET.has(method)) {
          const actions = this.#actions;
          if (actions) {
            const decision = await actions.onClientAnswer({ sessionId, connectionId: peer.id, responderKind: peer.kind, method, params });
            if (decision.kind === "respond") return decision.response;
          }
        }
    }
    const upstream = await this.#resident(live);
    const result = await upstream.request(method, forwarded, { signal });
    if (method === "session.model.switchTo" && typeof params["modelId"] === "string") this.#ledger.update(sessionId, { model: params["modelId"] });
    if (method === "session.getMessages" && live.placement === "shared" && result && typeof result === "object" && Array.isArray((result as { events?: unknown }).events)) {
      const events = (result as { events: RuntimeSessionEvent[] }).events;
      return { ...(result as Record<string, unknown>), events: events.map((event) => this.#sanitizeEvent(live, event)) };
    }
    return result;
  }

  detach(peer: ClientPeer, sessionId: unknown): { success: boolean } {
    if (typeof sessionId !== "string") return { success: true };
    const live = this.#live.get(sessionId);
    if (live?.attachments.has(peer.id)) this.#detach(live, peer.id);
    return { success: true };
  }

  disconnect(peer: ClientPeer): void {
    for (const live of this.#live.values()) {
      if (live.attachments.has(peer.id)) this.#detach(live, peer.id, false);
    }
    this.#actions?.onDetached(peer.id);
  }

  /** `models.list` for the caller: the owner's entitlement, filtered by the environment's `models`. */
  async listModels(peer: ClientPeer): Promise<unknown> {
    const shared = this.#options.sharedRuntime;
    if (!shared) throw new ManagedCopilotError("capability_unavailable", "Model discovery needs the shared runtime, which is disabled on this gateway");
    const upstream = await shared.ready();
    const result = await upstream.request<{ models?: { id?: string }[] }>("models.list", { gitHubToken: peer.principal.token });
    const allowed = peer.environment.config.models;
    const models = (result?.models ?? []).filter((model) => !allowed || (typeof model.id === "string" && allowed.includes(model.id)));
    return { ...result, models };
  }

  /** Called when the gateway stops: closes sandbox upstreams (the shared runtime is stopped separately). */
  close(): void {
    for (const live of this.#live.values()) {
      if (live.placement === "sandbox") {
        live.upstream?.close();
        live.sandbox?.close?.();
      }
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Creation

  async #create(input: {
    principal: Principal;
    environment: ResolvedEnvironment;
    raw: Record<string, unknown>;
    peer: ClientPeer | undefined;
    scheduleId?: string | undefined;
    webhook?: string | undefined;
    clientName?: string | undefined;
  }): Promise<unknown> {
    const { principal, environment } = input;
    const sessionId = input.raw["sessionId"] as string;
    const placement: Placement = environment.type === "isolated" ? "sandbox" : "shared";
    if (placement === "shared" && !this.#options.sharedRuntime) {
      throw new ManagedCopilotError("capability_unavailable", "Shared environments are disabled on this gateway (no shared runtime)");
    }
    if (placement === "sandbox" && !this.#sandboxes) {
      throw new ManagedCopilotError("capability_unavailable", `Environment "${environment.name}" needs isolated sandboxes, which this deployment does not provide yet`);
    }
    if (environment.config.inference?.foundry) {
      // An explicitly selected billing route must never silently fall back to the owner's GitHub entitlement.
      throw new ManagedCopilotError("capability_unavailable", `Environment "${environment.name}" routes inference to Azure AI Foundry ("${environment.config.inference.foundry}"), which this gateway does not support yet`);
    }
    const tokenRegistrationId = `mc-${randomUUID()}`;
    const admitted = await this.#admit(environment, placement, input.raw, "create", environment.network, sessionId, tokenRegistrationId, principal);

    // Bind network policy (validates vaults) before anything is allocated.
    let network: NetworkPolicy = environment.network;
    const policy = this.#policy;
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
    await this.#checkRemoteMcp(admitted, sessionId, placement, network);

    const stored: AdmittedConfig = {
      params: storedParams(admitted.params),
      ...(input.peer ? {} : { tools: (admitted.params["tools"] as Record<string, unknown>[]).filter((tool) => !this.#options.platformTools.has(String(tool["name"]))) }),
      optionsPatch: admitted.optionsPatch,
    };
    const record = this.#ledger.insert({
      id: sessionId,
      owner: accountInfo(principal),
      environment: environment.name,
      type: environment.type,
      placement,
      network,
      environmentRequest: environment.request,
      admitted: stored,
      ...(admitted.model ? { model: admitted.model } : {}),
      ...(admitted.agent ? { agent: admitted.agent } : {}),
      ...(input.clientName ? { clientName: input.clientName } : {}),
      ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
      ...(input.webhook ? { webhook: input.webhook } : {}),
    });
    const live = this.#register(record, environment, tokenRegistrationId);
    live.wire = { tools: stored.tools ? [...stored.tools] : [], flags: {} };
    try {
      let upstream: RuntimeUpstream;
      if (placement === "sandbox") {
        await this.#sandboxes!.create({
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
        });
        upstream = await this.#openSandbox(live);
      } else {
        mkdirSync(this.#workingDirectory("shared", sessionId), { recursive: true });
        upstream = await this.#options.sharedRuntime!.ready();
        live.upstream = upstream;
      }
      const forwarded = await this.#prepare(live, "session.create", admitted.params);
      if (input.peer) this.#attach(live, input.peer, admitted, forwarded);
      const result = await upstream.request("session.create", forwarded);
      await this.#opened(live, upstream, admitted.optionsPatch);
      this.#ledger.update(sessionId, { state: "ready" });
      this.#options.events.emit("session.created", { ownerId: principal.accountId, sessionId, environment: environment.name, data: { placement, type: environment.type } });
      this.#log.info("Session created", { sessionId, owner: principal.login, environment: environment.name, placement });
      return this.#sanitizeResponse(live, result);
    } catch (error) {
      this.#live.delete(sessionId);
      this.#ledger.remove(sessionId);
      for (const attachment of live.attachments.values()) this.#actions?.onDetached(attachment.peer.id);
      live.attachments.clear();
      if (placement === "sandbox") {
        live.upstream?.close();
        await this.#sandboxes?.delete(sessionId).catch((cleanup: unknown) => this.#log.warn("Sandbox cleanup after failed create failed", { sessionId, error: (cleanup as Error).message }));
      }
      await Promise.resolve(this.#policy?.releaseSession?.(sessionId)).catch(() => undefined);
      this.#log.warn("Session creation failed", { sessionId, environment: environment.name, error: (error as Error).message });
      throw error;
    }
  }

  async #admit(
    environment: ResolvedEnvironment,
    placement: Placement,
    raw: Record<string, unknown>,
    mode: "create" | "resume",
    network: NetworkPolicy,
    sessionId: string,
    tokenRegistrationId: string,
    principal: Principal,
  ): Promise<AdmittedSession> {
    const admitted = admitSession(
      raw,
      {
        environment,
        placement,
        network,
        platformTools: this.#platformToolsFor(environment, placement),
        workingDirectory: this.#workingDirectory(placement, sessionId),
        tokenRegistrationId,
      },
      mode,
    );
    if (placement === "sandbox") delete admitted.params["gitHubTokenProviderRegistrationId"];
    if (admitted.callerToken) {
      const owner = await this.#options.auth.authenticate(admitted.callerToken);
      if (owner.accountId !== principal.accountId) {
        throw new ManagedCopilotError("forbidden", "The session's gitHubToken belongs to a different GitHub account; a managed client cannot switch owners");
      }
    }
    return admitted;
  }

  /** Shared sessions have no direct egress: remote MCP servers are rewritten to the gateway MCP adapter. */
  async #checkRemoteMcp(admitted: AdmittedSession, sessionId: string, placement: Placement, _network: NetworkPolicy): Promise<void> {
    if (placement !== "shared" || admitted.remoteMcp.length === 0) return;
    const adapt = this.#policy?.adaptMcpServer?.bind(this.#policy);
    if (!adapt) {
      throw new ManagedCopilotError("capability_unavailable", "Remote MCP servers in shared environments need the gateway MCP adapter, which this deployment does not provide");
    }
    for (const server of admitted.remoteMcp) {
      const container = server.agent
        ? ((admitted.params["customAgents"] as Record<string, unknown>[] | undefined)?.find((agent) => agent["name"] === server.agent)?.["mcpServers"] as Record<string, Record<string, unknown>> | undefined)
        : (admitted.params["mcpServers"] as Record<string, Record<string, unknown>> | undefined);
      const entry = container?.[server.name];
      if (!container || !entry) continue;
      container[server.name] = await adapt(sessionId, server.name, entry);
    }
  }

  #platformToolsFor(environment: ResolvedEnvironment, placement: Placement) {
    return this.#options.platformTools.forSession({ environment: environment.name, type: environment.type, placement });
  }

  #workingDirectory(placement: Placement, sessionId: string): string {
    if (placement === "sandbox") return "/workspace";
    const root = this.#options.sharedRuntime?.workspacesRoot ?? join(this.#options.app.config.dataDir, "runtime", "shared", "workspaces");
    return join(root, sessionId);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Residency

  #register(record: SessionRecord, environment: ResolvedEnvironment, tokenRegistrationId: string): LiveSession {
    const live: LiveSession = {
      id: record.id,
      ownerId: record.ownerId,
      placement: record.placement,
      environment,
      tokenRegistrationId,
      upstream: undefined,
      sandbox: undefined,
      attachments: new Map(),
      creator: undefined,
      wire: { tools: [], flags: {} },
      queue: Promise.resolve(),
      residency: undefined,
      deleting: false,
    };
    this.#live.set(record.id, live);
    return live;
  }

  /** The live state for a ledger session, created lazily (after a gateway restart, sessions start non-resident). */
  #liveFor(sessionId: string): LiveSession {
    const existing = this.#live.get(sessionId);
    if (existing) return existing;
    const record = this.get(sessionId);
    if (!record) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
    const environment = this.#options.environments.forSession(record);
    const live = this.#register(record, environment, `mc-${randomUUID()}`);
    const admitted = this.#ledger.admitted(sessionId);
    live.wire = { tools: admitted?.tools ? [...admitted.tools] : [], flags: {} };
    return live;
  }

  #attachedLive(peer: ClientPeer, sessionId: string, method: string): LiveSession {
    const live = this.#live.get(sessionId);
    if (live?.attachments.has(peer.id)) return live;
    const record = this.get(sessionId);
    if (!record || record.ownerId !== peer.principal.accountId) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
    throw new ManagedCopilotError("invalid_request", `Resume session ${sessionId} on this client before calling ${method}`);
  }

  /**
   * Returns a connected upstream where the session is resident, resuming it with its admitted configuration when the
   * runtime restarted, the sandbox stopped, or the gateway restarted.
   */
  #resident(live: LiveSession, options: { skipResume?: boolean } = {}): Promise<RuntimeUpstream> {
    if (live.upstream && !live.upstream.closed) return Promise.resolve(live.upstream);
    if (live.residency) return live.residency;
    const residency = (async () => {
      let upstream: RuntimeUpstream;
      if (live.placement === "sandbox") {
        const sandboxes = this.#sandboxes;
        if (!sandboxes) throw new ManagedCopilotError("capability_unavailable", "The sandbox service is not available on this gateway");
        await sandboxes.ensureRunning?.(live.id);
        upstream = await this.#openSandbox(live);
      } else {
        const shared = this.#options.sharedRuntime;
        if (!shared) throw new ManagedCopilotError("capability_unavailable", "Shared environments are disabled on this gateway");
        upstream = await shared.ready();
        live.upstream = upstream;
      }
      if (!options.skipResume) {
        const admitted = this.#ledger.admitted(live.id);
        if (!admitted) throw new ManagedCopilotError("state_restore_failed", `Session ${live.id} has no stored configuration to resume with`);
        const params = await this.#prepare(live, "session.resume", {
          ...admitted.params,
          sessionId: live.id,
          tools: [...live.wire.tools, ...this.#platformToolDeclarations(live)],
          ...live.wire.flags,
          ...(live.placement === "shared" ? { gitHubTokenProviderRegistrationId: live.tokenRegistrationId } : {}),
        });
        try {
          await upstream.request("session.resume", params);
          await this.#opened(live, upstream, admitted.optionsPatch);
        } catch (error) {
          live.upstream = undefined;
          throw error instanceof RpcError ? new ManagedCopilotError("state_restore_failed", `Session ${live.id} could not be restored: ${error.message}`) : error;
        }
        this.#log.info("Session resumed upstream", { sessionId: live.id, upstream: upstream.info.id });
      }
      return upstream;
    })();
    live.residency = residency;
    void residency.finally(() => {
      if (live.residency === residency) live.residency = undefined;
    }).catch(() => undefined);
    return residency;
  }

  async #openSandbox(live: LiveSession): Promise<RuntimeUpstream> {
    const sandboxes = this.#sandboxes!;
    const handle = await sandboxes.openRuntime(live.id, { resolveToken: () => this.#ownerToken(live.ownerId).then((credential) => credential.token) });
    const upstream = await RuntimeUpstream.open({ id: `sandbox:${live.id}`, kind: "sandbox", sandboxId: live.id }, streamTransport(handle.stream), {
      token: handle.connectionToken,
      handlers: this.#upstreamHandlers,
      log: this.#log,
    });
    live.sandbox = handle;
    live.upstream = upstream;
    if (handle.initialize) await handle.initialize((method, params) => upstream.request(method, params));
    return upstream;
  }

  async #prepare(live: LiveSession, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return live.sandbox?.prepareSessionParams ? await live.sandbox.prepareSessionParams(method, params) : params;
  }

  async #opened(live: LiveSession, upstream: RuntimeUpstream, optionsPatch: Record<string, unknown>): Promise<void> {
    if (live.sandbox?.sessionOpened) await live.sandbox.sessionOpened(live.id);
    if (Object.keys(optionsPatch).length > 0) {
      const result = await upstream.request<{ success?: boolean; error?: string }>("session.options.update", { ...optionsPatch, sessionId: live.id });
      if (result && result.success === false) throw new ManagedCopilotError("internal", `The runtime rejected the session lockdown: ${result.error ?? "unknown error"}`);
    }
  }

  #platformToolDeclarations(live: LiveSession): Record<string, unknown>[] {
    return this.#platformToolsFor(live.environment, live.placement).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      skipPermission: tool.skipPermission,
      ...(tool.overridesBuiltInTool ? { overridesBuiltInTool: true } : {}),
    }));
  }

  #onUpstreamClosed(upstream: RuntimeUpstream): void {
    for (const live of this.#live.values()) {
      if (live.upstream !== upstream) continue;
      live.upstream = undefined;
      if (live.placement === "sandbox") {
        live.sandbox?.close?.();
        live.sandbox = undefined;
      }
      this.#emitLifecycle(live.id, "stopped");
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Attachments

  #attach(live: LiveSession, peer: ClientPeer, admitted: AdmittedSession, forwarded: Record<string, unknown>): void {
    const flag = (key: string) => forwarded[key] === true;
    live.attachments.delete(peer.id);
    live.attachments.set(peer.id, {
      peer,
      attachedAt: Date.now(),
      tools: new Set(admitted.client.tools),
      requestPermission: admitted.client.requestPermission,
      requestUserInput: admitted.client.requestUserInput,
      requestElicitation: admitted.client.requestElicitation,
      requestExitPlanMode: flag("requestExitPlanMode"),
      requestAutoModeSwitch: flag("requestAutoModeSwitch"),
      hooks: flag("hooks"),
      skillProvider: flag("hasSkillProvider"),
    });
    live.creator ??= peer.id;
    live.wire = {
      tools: (forwarded["tools"] as Record<string, unknown>[] | undefined ?? []).filter((tool) => !this.#options.platformTools.has(String(tool["name"]))),
      flags: Object.fromEntries(
        ["requestPermission", "requestUserInput", "requestElicitation", "requestExitPlanMode", "requestAutoModeSwitch", "hooks", "streaming", "hasSkillProvider"]
          .filter((key) => forwarded[key] !== undefined)
          .map((key) => [key, forwarded[key]]),
      ),
    };
  }

  #detach(live: LiveSession, peerId: string, notifyActions = true): void {
    live.attachments.delete(peerId);
    if (live.creator === peerId) live.creator = live.attachments.keys().next().value;
    if (notifyActions) this.#actions?.onDetached(peerId);
  }

  async #afterAttach(peer: ClientPeer, sessionId: string): Promise<void> {
    const actions = this.#actions;
    const live = this.#live.get(sessionId);
    if (!actions || !live || peer.closed) return;
    const record = this.get(sessionId);
    if (!record) return;
    const responder = this.#responders(live).find((candidate) => candidate.connectionId === peer.id);
    if (!responder) return;
    try {
      const replay = await actions.onAttached({ sessionId, ownerId: record.ownerId, environment: record.environment, generation: record.generation, responder });
      for (const event of replay) peer.notify("session.event", { sessionId, event: this.#sanitizeEvent(live, event) });
    } catch (error) {
      this.#log.warn("Action replay after attach failed", { sessionId, error: (error as Error).message });
    }
  }

  /** Creating connection first, then the others by attach time. */
  #responders(live: LiveSession): AttachedResponder[] {
    const ordered = [...live.attachments.values()].sort((a, b) => (a.peer.id === live.creator ? -1 : b.peer.id === live.creator ? 1 : a.attachedAt - b.attachedAt));
    return ordered.map((attachment) => ({
      connectionId: attachment.peer.id,
      kind: attachment.peer.kind,
      tools: [...attachment.tools],
      requestPermission: attachment.requestPermission,
      requestElicitation: attachment.requestElicitation,
    }));
  }

  // ------------------------------------------------------------------------------------------------------------
  // Upstream traffic

  #onUpstreamNotification(upstream: RuntimeUpstream, method: string, params: unknown): void {
    const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof sessionId !== "string") return;
    const live = this.#live.get(sessionId);
    if (!live || live.upstream !== upstream) return;
    if (method === "session.event") {
      const event = (params as { event?: RuntimeSessionEvent }).event;
      if (!event || typeof event.type !== "string") return;
      live.queue = live.queue.then(() => this.#deliverEvent(live, event)).catch((error: unknown) => {
        this.#log.warn("Session event delivery failed", { sessionId, type: event.type, error: (error as Error).message });
      });
    } else if (method === "session.lifecycle") {
      live.queue = live.queue.then(() => {
        for (const attachment of live.attachments.values()) attachment.peer.notify("session.lifecycle", params);
      });
    }
    // Other notifications (host.event, telemetry) carry runtime-wide or account details and are never relayed.
  }

  async #deliverEvent(live: LiveSession, event: RuntimeSessionEvent): Promise<void> {
    this.#track(live, event);
    for (const listener of this.#listeners) {
      try {
        listener(live.id, event);
      } catch (error) {
        this.#log.warn("Session event listener failed", { error: (error as Error).message });
      }
    }
    for (const listener of this.#sessionListeners.get(live.id) ?? []) {
      try {
        listener(live.id, event);
      } catch (error) {
        this.#log.warn("Session event listener failed", { error: (error as Error).message });
      }
    }
    const sanitized = this.#sanitizeEvent(live, event);
    const notification = { sessionId: live.id, event: sanitized };
    if (!ACTION_EVENT_TYPES.has(event.type)) {
      for (const attachment of live.attachments.values()) attachment.peer.notify("session.event", notification);
      return;
    }
    const decision = await this.#routeAction(live, event);
    for (const attachment of live.attachments.values()) {
      const id = attachment.peer.id;
      if (decision.withhold.includes(id) && decision.owner !== id) continue;
      if (id === decision.owner) {
        if (attachment.peer.closed && decision.actionId && decision.claimToken) {
          this.#actions?.releaseLiveClaim(decision.actionId, decision.claimToken);
          continue;
        }
      }
      attachment.peer.notify("session.event", notification);
    }
  }

  async #routeAction(live: LiveSession, event: RuntimeSessionEvent): Promise<{ owner?: string; withhold: readonly string[]; actionId?: string; claimToken?: string }> {
    const record = this.get(live.id);
    const actions = this.#actions;
    const toolName = event.type === "external_tool.requested" ? (event.data["toolName"] as string | undefined) : undefined;
    const platformTool = toolName ? this.#options.platformTools.get(toolName) : undefined;
    if (actions && record) {
      return actions.onSessionEvent({ sessionId: live.id, ownerId: record.ownerId, environment: record.environment, generation: record.generation, event, attached: this.#responders(live) });
    }
    if (platformTool && record) {
      void this.#runPlatformTool(live, record, event, platformTool.name);
      return { withhold: [...live.attachments.keys()] };
    }
    // Default claim-before-emit: the most recent client able to answer executes; other eligible clients are withheld.
    const attachments = [...live.attachments.values()].sort((a, b) => b.attachedAt - a.attachedAt);
    let eligible: Attachment[] = [];
    if (event.type === "external_tool.requested") eligible = attachments.filter((attachment) => toolName !== undefined && attachment.tools.has(toolName));
    else if (event.type === "permission.requested") eligible = attachments.filter((attachment) => attachment.requestPermission);
    else if (event.type === "elicitation.requested") eligible = attachments.filter((attachment) => attachment.requestElicitation);
    else return { withhold: [] };
    const owner = eligible.find((attachment) => !attachment.peer.closed)?.peer.id;
    return { ...(owner ? { owner } : {}), withhold: eligible.map((attachment) => attachment.peer.id) };
  }

  async #runPlatformTool(live: LiveSession, record: SessionRecord, event: RuntimeSessionEvent, name: string): Promise<void> {
    const tool = this.#options.platformTools.get(name);
    const requestId = event.data["requestId"];
    const toolCallId = String(event.data["toolCallId"] ?? requestId);
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
        signal: AbortSignal.timeout(10 * 60_000),
      });
      answer = { requestId, result };
    } catch (error) {
      answer = { requestId, error: error instanceof ManagedCopilotError ? error.message : `Platform tool ${name} failed` };
      this.#log.warn("Platform tool failed", { sessionId: live.id, tool: name, error: (error as Error).message });
    }
    try {
      await this.request(live.id, "session.tools.handlePendingToolCall", answer);
    } catch (error) {
      this.#log.warn("Could not answer platform tool call", { sessionId: live.id, tool: name, error: (error as Error).message });
    }
  }

  async #onUpstreamRequest(upstream: RuntimeUpstream, method: string, params: unknown, context: IncomingRequestContext): Promise<unknown> {
    const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId;
    const live = typeof sessionId === "string" ? this.#live.get(sessionId) : undefined;
    if (live && live.upstream !== upstream && live.residency === undefined) throw new RpcError(-32000, "Stale runtime connection", { code: "conflict" });
    const sandboxHandler = live?.sandbox?.handlers?.get(method) ?? (upstream.info.kind === "sandbox" ? this.#sandboxHandlerFor(upstream, method) : undefined);
    if (sandboxHandler) return sandboxHandler(params);
    const registered = this.#options.runtimeRequests.resolve(method, upstream.info);
    if (registered) {
      const record = live ? this.get(live.id) : undefined;
      return registered({ method, upstream: upstream.info, ...(record ? { session: record } : {}), params, signal: context.signal });
    }
    if (method in CLIENT_REQUESTS && live) {
      const flag = CLIENT_REQUESTS[method];
      const attachments = [...live.attachments.values()].sort((a, b) => b.attachedAt - a.attachedAt);
      const target = attachments.find((attachment) => !attachment.peer.closed && (flag === undefined || attachment[flag] === true));
      if (!target) throw new ManagedCopilotError("capability_unavailable", `No connected client can answer ${method} for session ${live.id}`);
      return target.peer.request(method, params, context.signal);
    }
    throw unsupportedMethod(method, `The gateway does not answer ${method}`);
  }

  #sandboxHandlerFor(upstream: RuntimeUpstream, method: string): ((params: unknown) => Promise<unknown>) | undefined {
    for (const live of this.#live.values()) {
      if (live.upstream === upstream) return live.sandbox?.handlers?.get(method);
    }
    return undefined;
  }

  /** Answers the runtime's `gitHubToken.getToken` for shared sessions with the owner's freshest credential. */
  async answerTokenRequest(params: unknown): Promise<unknown> {
    const request = params as { registrationId?: string; sessionId?: string; host?: string };
    const live = request.sessionId ? this.#live.get(request.sessionId) : [...this.#live.values()].find((candidate) => candidate.tokenRegistrationId === request.registrationId);
    if (!live || live.tokenRegistrationId !== request.registrationId) {
      this.#log.warn("Refusing a GitHub token request for an unknown registration", { sessionId: request.sessionId });
      return { kind: "cancelled" };
    }
    if (request.host && !/^https:\/\/github\.com\/?$/i.test(request.host)) {
      this.#log.warn("Refusing a GitHub token request for an unsupported host", { sessionId: live.id, host: request.host });
      return { kind: "cancelled" };
    }
    try {
      const credential = await this.#ownerToken(live.ownerId);
      const expiresIn = credential.expiresAt ? Math.floor((credential.expiresAt - Date.now()) / 1000) : DEFAULT_TOKEN_LIFETIME_SECONDS;
      return { kind: "token", accessToken: credential.token, tokenType: "bearer", expiresIn };
    } catch (error) {
      this.#log.warn("No credential available for session owner", { sessionId: live.id, error: (error as Error).message });
      return { kind: "cancelled" };
    }
  }

  /** The owner's freshest token: a recently verified live credential, else the background credential service. */
  async #ownerToken(ownerId: number): Promise<{ token: string; expiresAt?: number }> {
    const live = this.#options.auth.liveCredential(ownerId);
    if (live) return { token: live.token, ...(live.expiresAt ? { expiresAt: live.expiresAt } : {}) };
    const credentials = this.#options.app.services.credentials;
    if (credentials) {
      const principal = await credentials.principalFor(ownerId);
      if (principal.accountId !== ownerId) throw new ManagedCopilotError("authentication_required", "The stored credential belongs to another account");
      return { token: principal.token };
    }
    throw new ManagedCopilotError("authentication_required", "The session owner has no active GitHub credential; reconnect or run `managed-copilot login`");
  }

  // ------------------------------------------------------------------------------------------------------------
  // Ledger tracking and sanitization

  #track(live: LiveSession, event: RuntimeSessionEvent): void {
    const data = event.data ?? {};
    try {
      switch (event.type) {
        case "user.message":
          if (!event.agentId) {
            this.#ledger.update(live.id, { state: "running", lastTurn: { turnId: String(data["messageId"] ?? event.id), status: "running" } });
          }
          break;
        case "session.idle": {
          if (event.agentId) break;
          const record = this.get(live.id);
          const turn = record?.lastTurn;
          const status = data["aborted"] === true ? "cancelled" : turn?.status === "failed" ? "failed" : "completed";
          this.#ledger.update(live.id, { state: "idle", ...(turn ? { lastTurn: { turnId: turn.turnId, status, completedAt: new Date().toISOString() } } : {}) });
          if (record) this.#options.events.emit("session.idle", { ownerId: record.ownerId, sessionId: live.id, environment: record.environment, data: { status } });
          break;
        }
        case "session.error": {
          const record = this.get(live.id);
          if (record?.lastTurn) this.#ledger.update(live.id, { lastTurn: { ...record.lastTurn, status: "failed" } });
          if (record) this.#options.events.emit("session.failed", { ownerId: record.ownerId, sessionId: live.id, environment: record.environment, data: { message: String(data["message"] ?? "Session error") } });
          break;
        }
        case "session.title_changed":
          if (typeof data["title"] === "string") this.#ledger.update(live.id, { title: data["title"] });
          break;
        case "session.model_change":
          if (typeof data["newModel"] === "string") this.#ledger.update(live.id, { model: data["newModel"] });
          break;
      }
    } catch (error) {
      this.#log.warn("Ledger update from session event failed", { sessionId: live.id, type: event.type, error: (error as Error).message });
    }
  }

  /** Shared sessions must not leak platform host paths to clients. */
  #sanitizeEvent(live: LiveSession, event: RuntimeSessionEvent): RuntimeSessionEvent {
    if (live.placement !== "shared") return event;
    if (event.type === "session.start" && event.data && "context" in event.data) {
      const { context: _context, ...data } = event.data;
      return { ...event, data };
    }
    if (event.type === "external_tool.requested" && event.data && "workingDirectory" in event.data) {
      const { workingDirectory: _workingDirectory, ...data } = event.data;
      return { ...event, data };
    }
    return event;
  }

  #sanitizeResponse(live: LiveSession, result: unknown): unknown {
    if (live.placement !== "shared" || !result || typeof result !== "object") return result;
    const { workspacePath: _workspacePath, ...rest } = result as Record<string, unknown>;
    return rest;
  }

  #emitLifecycle(sessionId: string, type: "deleted" | "promoted" | "stopped"): void {
    for (const listener of this.#lifecycle) {
      try {
        listener({ sessionId, type });
      } catch (error) {
        this.#log.warn("Lifecycle listener failed", { error: (error as Error).message });
      }
    }
  }
}

/** Per-connection fields are not stored with the session; they are resent by whichever client resumes it. */
function storedParams(params: Record<string, unknown>): Record<string, unknown> {
  const {
    tools: _tools,
    requestPermission: _requestPermission,
    requestUserInput: _requestUserInput,
    requestElicitation: _requestElicitation,
    requestExitPlanMode: _requestExitPlanMode,
    requestAutoModeSwitch: _requestAutoModeSwitch,
    hooks: _hooks,
    hasSkillProvider: _hasSkillProvider,
    gitHubTokenProviderRegistrationId: _registration,
    traceparent: _traceparent,
    tracestate: _tracestate,
    ...rest
  } = params;
  return rest;
}
