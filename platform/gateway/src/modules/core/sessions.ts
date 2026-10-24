// The session manager: ownership, placement, upstream residency, request routing, and event fan-out for every
// session the gateway hosts. Client connections attach to sessions; the gateway owns the upstream runtime
// connections, so detaching or disconnecting a client never stops a session or cancels accepted work.
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { join, resolve as resolvePath } from "node:path";
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
import { admitOptionsUpdate, admitSend, admitSession, admitToolsSet, checkModel, SANDBOX_CUSTOMIZATIONS_DIR, type AdmissionContext, type AdmittedSession } from "./admission.js";
import { accountInfo, type GitHubAuthenticator } from "./auth.js";
import {
  optionalService,
  type CreateSessionRequest,
  type NetworkPolicyService,
  type PlacementCutover,
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
  /** Registered `systemMessage` section transform callbacks. */
  transforms: boolean;
  /** Registered canvases or a canvas renderer/provider. */
  canvases: boolean;
  /** This client's tool declarations (platform tools excluded), for the aggregate upstream registration. */
  declarations: Record<string, unknown>[];
  /** This client's handler flags (`requestPermission`, `hooks`, ...). */
  flags: Record<string, unknown>;
}

/** Handler flags the runtime registers per connection; the gateway sends the union across attached clients. */
const WIRE_FLAGS = ["requestPermission", "requestUserInput", "requestElicitation", "requestExitPlanMode", "requestAutoModeSwitch", "hooks", "hasSkillProvider"] as const;

/** Per-connection wire settings resent when the gateway resumes a session upstream on its own. */
interface WireSettings {
  tools: Record<string, unknown>[];
  flags: Record<string, unknown>;
}

interface LiveSession {
  readonly id: string;
  readonly ownerId: number;
  /** Changes only when a placement cutover commits (shared → sandbox). */
  placement: Placement;
  readonly environment: ResolvedEnvironment;
  readonly tokenRegistrationId: string;
  /** The upstream events are accepted from (set before create/resume is sent). */
  upstream: RuntimeUpstream | undefined;
  /** True once create/resume completed on `upstream`; only then may other requests use it. */
  ready: boolean;
  sandbox: SandboxRuntimeHandle | undefined;
  readonly attachments: Map<string, Attachment>;
  creator: string | undefined;
  wire: WireSettings;
  /** Ensures events of one session are processed in order even when routing awaits the actions hook. */
  queue: Promise<void>;
  /** In-flight create, resume, or restore; concurrent callers wait for it. */
  residency: Promise<RuntimeUpstream> | undefined;
  deleting: boolean;
  /** An open placement cutover (promotion). */
  cutover: CutoverState | undefined;
  /** Clients' `sendAndWait` calls in flight upstream (a cutover fences and seals them). */
  readonly waits: Set<InflightWait>;
  /** `sendAndWait` calls whose reply the source sent as a handoff artifact: completed from the owner's events. */
  readonly held: HeldCompletion[];
  /** Extra params for the next resume upstream (after an aborted cutover closed the session on its source). */
  resumeExtras: Record<string, unknown> | undefined;
  /** Counts fences: a request that started before one may have been admitted for the placement the session left. */
  moves: number;
  /** Event IDs history reads must not return (loaded from the ledger on first use). */
  hidden: Set<string> | undefined;
  /**
   * A source a sealed cutover left (committed, or aborted until the session's next resume there is answered, after
   * its answers to the sealing calls): its output for this session is handoff, hidden from clients and history.
   */
  sealedSource: { readonly upstream: RuntimeUpstream; readonly settled: Promise<void> } | undefined;
}

interface InflightWait {
  fenced: boolean;
  readonly signal: AbortSignal;
  /** Set at the seal: the call completes from the owner's events unless the source's reply shows its turn ended. */
  held: HeldCompletion | undefined;
}

/** A `sendAndWait` that a seal caught in flight, completed like the stock request-owned completion by the owner. */
interface HeldCompletion {
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  /** From the source's handoff reply. */
  messageId: unknown;
  seed: unknown;
  /** The owner's last root `assistant.message` after the seal. */
  latest: unknown;
  /** The owner's first root completion after the seal, kept until the source's reply has arrived. */
  outcome: { readonly aborted: boolean; readonly completionEventId: unknown } | { readonly error: RpcError } | undefined;
  /** The source's reply arrived and was a handoff (aborted, or failed): the outcome completes the call. */
  replied: boolean;
}

interface BufferedNotification {
  readonly method: string;
  readonly params: unknown;
}

interface CutoverState {
  readonly generation: number;
  readonly source: RuntimeUpstream;
  readonly priorState: SessionState;
  fenced: boolean;
  /** Set by the first `session.suspend` / `sessions.close` on the source. */
  sealed: boolean;
  /**
   * A sealing call was answered. Until then the source's output is a handoff only if the suspend caused it (the rest
   * was already on its way); from then on, all of it is.
   */
  settled: boolean;
  /** The sealing calls (an aborted cutover resumes its source only after they settled). */
  readonly sealing: Promise<unknown>[];
  /** Genuine source notifications between the fence and the seal, delivered on commit or abort. */
  readonly buffered: BufferedNotification[];
  /** Destination notifications before commit, delivered after the buffered source ones. */
  readonly destinationBuffer: BufferedNotification[];
  /** `sendAndWait` replies the source sent before the seal, delivered when the fence lifts. */
  readonly replies: { readonly value: unknown; readonly resolve: (value: unknown) => void }[];
  release: (() => void) | undefined;
  /** The residency promise the fence installed (requests wait on it). */
  gate: Promise<RuntimeUpstream> | undefined;
  destination: { readonly upstream: RuntimeUpstream; readonly sandbox: SandboxRuntimeHandle; readonly admitted: AdmittedSession; readonly optionsPatch: Record<string, unknown> } | undefined;
  done: boolean;
  outcome: "committed" | "aborted" | undefined;
  /** Set once commit/abort delivered everything the cutover held back; the cutover then detaches from the session. */
  flushed: boolean;
}

/** Where a notification came from, when it is delivered later than it arrived (flushed after a cutover). */
interface NotificationOrigin {
  readonly generation: number;
  readonly placement: Placement;
  /** Emitted by the source before the seal: it never completes a call the seal caught. */
  readonly beforeSeal?: boolean;
}

/** Thrown inside dispatch when a placement cutover moved the session after the request was admitted. */
const MOVED = Symbol("moved");

/**
 * What a runtime emits because `session.suspend` / `sessions.close` interrupted the session, seen on the wire of runtime
 * 1.0.103 (several are internal types the SDK does not list); an aborted `session.idle` counts too.
 */
const HANDOFF_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent.interrupted",
  "abort",
  "external_tool.completed",
  "model.call_finished",
  "model.telemetry",
  "model.turn_failed",
  "model.turn_ended",
  "assistant.turn_end",
  "session.usage_checkpoint",
  "session.shutdown",
]);

/** Session configuration calls: set again on the new owner when a cutover moved the session while they ran. */
const CONFIG_METHODS: ReadonlySet<string> = new Set([
  "session.options.update",
  "session.tools.set",
  "session.model.switchTo",
  "session.model.switchAutoTier",
  "session.agent.select",
  "session.agent.deselect",
]);

/** Reads of a session's event history (`{ events }`): hidden handoff events are filtered and history origin scrubbed. */
const HISTORY_METHODS: ReadonlySet<string> = new Set(["session.getMessages", "session.eventLog.read"]);

/** Runtime → client requests bound to a session and the attachment flag that answers them. */
const CLIENT_REQUESTS: Record<string, keyof Attachment | undefined> = {
  "userInput.request": "requestUserInput",
  "exitPlanMode.request": "requestExitPlanMode",
  "autoModeSwitch.request": "requestAutoModeSwitch",
  "hooks.invoke": "hooks",
  "skillProvider.list": "skillProvider",
  "skillProvider.read": "skillProvider",
  "systemMessage.transform": "transforms",
  "canvas.open": "canvases",
  "canvas.close": "canvases",
  "canvas.action.invoke": "canvases",
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
  /** Session IDs reserved by in-flight creates. */
  readonly #creating = new Map<string, { ownerId: number; done: Promise<unknown> }>();
  readonly #scrubber: ((value: unknown) => unknown) | undefined;

  constructor(options: SessionManagerOptions) {
    this.#options = options;
    this.#log = options.log;
    this.#ledger = options.ledger;
    this.#scrubber = options.sharedRuntime ? pathScrubber(options.app.config.dataDir) : undefined;
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
    const inflight = this.#creating.get(sessionId);
    if (inflight) {
      if (inflight.ownerId !== principal.accountId) throw new ManagedCopilotError("conflict", `Session ${sessionId} already exists`);
      await inflight.done.catch(() => undefined);
    }
    const existing = this.#ledger.get(sessionId);
    if (existing) {
      if (existing.ownerId === principal.accountId && existing.state !== "deleted" && existing.state !== "deleting") return { sessionId, created: false };
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
    try {
      await this.#create({ principal, environment, raw, peer: undefined, scheduleId: request.scheduleId, webhook: request.webhook, clientName: request.clientName });
    } catch (error) {
      // A concurrent create of the same deterministic ID by the same owner won the race.
      const winner = isManagedCopilotError(error, "conflict") ? this.#ledger.get(sessionId) : undefined;
      if (winner && winner.ownerId === principal.accountId) return { sessionId, created: false };
      throw error;
    }
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
    for (;;) {
      try {
        const result = await this.#onOwner(live, live.placement, (upstream) => upstream.request<T>(method, { ...params, sessionId }));
        return HISTORY_METHODS.has(method) ? this.#withoutHidden(live, result) : result;
      } catch (error) {
        // Service calls carry no placement-specific admission: send them where the session lives now.
        if (error !== MOVED) throw error;
      }
    }
  }

  /**
   * Sends on the session's owning runtime. The owner is checked and the request written in one synchronous step, so
   * nothing reaches a runtime after a placement cutover fenced it. Throws MOVED when the session left `placement`.
   */
  async #onOwner<T>(live: LiveSession, placement: Placement, send: (upstream: RuntimeUpstream) => Promise<T>): Promise<T> {
    for (;;) {
      const upstream = await this.#resident(live);
      if (live.placement !== placement) throw MOVED;
      if (live.upstream === upstream && live.ready && !live.cutover?.fenced && !upstream.closed) return send(upstream);
      if (live.deleting) throw new ManagedCopilotError("not_found", `Session ${live.id} was not found`, { sessionId: live.id });
      await Promise.resolve(live.residency).catch(() => undefined);
    }
  }

  /** History reads never include events a placement cutover hid (the source's handoff after the seal). */
  #withoutHidden<T>(live: LiveSession, result: T): T {
    const events = (result as { events?: unknown } | undefined)?.events;
    if (!Array.isArray(events)) return result;
    live.hidden ??= this.#ledger.hiddenEvents(live.id);
    if (live.hidden.size === 0) return result;
    const hidden = live.hidden;
    return { ...(result as Record<string, unknown>), events: events.filter((event) => !hidden.has(String((event as { id?: unknown })?.id))) } as T;
  }

  async abort(sessionId: string): Promise<void> {
    await this.request(sessionId, "session.abort", {});
  }

  async delete(accountId: number, sessionId: string): Promise<void> {
    const record = this.getOwned(accountId, sessionId);
    if (record.state === "deleting") throw new ManagedCopilotError("conflict", `Session ${sessionId} is already being deleted`);
    const live = this.#live.get(sessionId);
    if (live) live.deleting = true;
    this.#ledger.update(sessionId, { state: "deleting" });
    // A placement cutover in progress ends here (its owner cleans up the candidate sandbox on `deleted`).
    if (live?.cutover) await this.#abortCutover(live, live.cutover, undefined).catch(() => undefined);
    if (live) for (const held of live.held.splice(0)) held.reject(new RpcError(-32000, `Session ${sessionId} was deleted`, { code: "not_found" }));
    // Let an in-flight create/resume settle so it cannot reopen the session after deletion.
    await live?.residency?.catch(() => undefined);
    const placement = (this.get(sessionId) ?? record).placement;
    try {
      if (placement === "sandbox") {
        const sandboxes = this.#sandboxes;
        if (!sandboxes) throw new ManagedCopilotError("capability_unavailable", "The sandbox service is not available, so the sandbox cannot be deleted yet");
        live?.upstream?.close();
        live?.sandbox?.close?.();
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
        this.#actions?.onDetached(attachment.peer.id, sessionId);
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
  // Placement cutover (promotion)

  async cutover(sessionId: string, options: { readonly generation: number }): Promise<PlacementCutover> {
    const notFound = () => new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
    const record = this.get(sessionId);
    if (!record || record.state === "deleting") throw notFound();
    const live = this.#liveFor(sessionId);
    if (live.deleting) throw notFound();
    if (live.cutover) throw new ManagedCopilotError("promotion_busy", `Session ${sessionId} is already moving`, { sessionId });
    if (record.generation !== options.generation) {
      throw new ManagedCopilotError("conflict", `Session ${sessionId} is at placement generation ${record.generation}, not ${options.generation}`, { sessionId, generation: record.generation });
    }
    if (live.placement !== "shared") throw new ManagedCopilotError("invalid_request", `Session ${sessionId} is not on shared placement`, { sessionId });
    const source = await this.#resident(live);
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
      const residency = gate.then(() => this.#resident(live));
      residency.catch(() => undefined);
      state.gate = residency;
      live.residency = residency;
      this.#ledger.update(sessionId, { state: "promoting" });
    };
    return {
      record: current,
      sourceStateDir: this.#options.sharedRuntime?.sessionStateDirectory(sessionId),
      source: async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        if (state.done) throw cutoverClosed(sessionId);
        if (method !== "session.suspend" && method !== "sessions.close") return state.source.request<T>(method, { sessionId, ...params });
        // The seal: the source's output becomes a handoff (what the suspend causes at once, everything once it is
        // answered), and the calls waiting on it continue on the session's next owner.
        fence();
        if (!state.sealed) {
          state.sealed = true;
          for (const wait of live.waits) wait.held ??= this.#hold(live, wait.signal);
        }
        const sent = state.source.request<T>(method, { sessionId, ...params }, { onSettle: () => (state.settled = true) });
        state.sealing.push(sent.catch(() => undefined));
        return sent;
      },
      fence,
      open: (extra = {}) => this.#openDestination(live, state, extra),
      commit: () => this.#commitCutover(live, state),
      abort: (abortOptions = {}) => this.#abortCutover(live, state, abortOptions.resume),
    };
  }

  async #openDestination(live: LiveSession, state: CutoverState, extra: Record<string, unknown>): Promise<{ request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> }> {
    if (state.done) throw cutoverClosed(live.id);
    if (!state.fenced) throw new ManagedCopilotError("invalid_request", "Fence the session before opening its destination", { sessionId: live.id });
    const sandboxes = this.#sandboxes;
    if (!sandboxes) throw new ManagedCopilotError("capability_unavailable", "The sandbox service is not available on this gateway");
    this.#closeDestination(state);
    const record = this.get(live.id);
    const stored = this.#ledger.admitted(live.id);
    if (!record || !stored?.requested) throw new ManagedCopilotError("state_restore_failed", `Session ${live.id} has no stored configuration to move`, { sessionId: live.id });
    // The caller's own configuration, admitted again for sandbox placement, with the session's current model and agent.
    const requested: Record<string, unknown> = { ...stored.requested };
    if (record.model) requested["model"] = record.model;
    if (record.agent) requested["agent"] = record.agent;
    else delete requested["agent"];
    const network = (await this.#policy?.session?.(live.id))?.policy ?? record.network;
    const context: AdmissionContext = {
      environment: live.environment,
      placement: "sandbox",
      network,
      platformTools: this.#platformToolsFor(live.environment, "sandbox"),
      workingDirectory: this.#workingDirectory("sandbox", live.id),
      tokenRegistrationId: live.tokenRegistrationId,
    };
    const admitted = admitSession(requested, context, "resume");
    delete admitted.params["gitHubTokenProviderRegistrationId"];
    // Options the caller changed later, admitted for the sandbox too (the model comes from the ledger).
    const { model: _model, ...callerOptions } = stored.requestedOptions ?? {};
    const optionsPatch = { ...admitted.optionsPatch, ...(Object.keys(callerOptions).length > 0 ? admitOptionsUpdate(callerOptions, context) : {}) };
    const handle = await sandboxes.openRuntime(live.id, { resolveToken: () => this.#ownerToken(live.ownerId).then((credential) => credential.token) });
    let upstream: RuntimeUpstream | undefined;
    try {
      upstream = await RuntimeUpstream.open({ id: `sandbox:${live.id}`, kind: "sandbox", sandboxId: live.id }, streamTransport(handle.stream), {
        token: handle.connectionToken,
        handlers: this.#upstreamHandlers,
        log: this.#log,
      });
      const opened = upstream;
      // Registered first, so the destination's requests (inference, credentials) and events route during the open.
      state.destination = { upstream: opened, sandbox: handle, admitted, optionsPatch };
      if (handle.initialize) await handle.initialize((method, params) => opened.request(method, params));
      const registrations = this.#registrations(live);
      const params = { ...admitted.params, ...registrations.flags, sessionId: live.id, tools: [...registrations.tools, ...this.#platformToolDeclarations(live, "sandbox")], ...extra };
      const prepared = handle.prepareSessionParams ? await handle.prepareSessionParams("session.resume", params) : params;
      await opened.request("session.resume", prepared);
      if (handle.sessionOpened) await handle.sessionOpened(live.id);
      if (Object.keys(optionsPatch).length > 0) await opened.request("session.options.update", { ...optionsPatch, sessionId: live.id });
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
    const stored = this.#ledger.admitted(live.id);
    const generation = state.generation + 1;
    // One update: placement, generation, and the sandbox-admitted configuration move together.
    this.#ledger.update(live.id, {
      placement: "sandbox",
      generation,
      state: record.lastTurn?.status === "running" ? "running" : "idle",
      admitted: {
        params: storedParams(destination.admitted.params),
        ...(stored?.tools ? { tools: stored.tools } : {}),
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
    // What the sealed source still sends for the session is handoff: hidden from history as well.
    if (state.sealed) live.sealedSource = { upstream: state.source, settled: Promise.resolve() };
    // Genuine source events from the fence window first (their placement and generation), then what the destination
    // sent before the commit; the fence stays up until they have been delivered.
    for (const item of state.buffered.splice(0)) this.#dispatchNotification(live, item.method, item.params, { generation: state.generation, placement: source, beforeSeal: true });
    for (const item of state.destinationBuffer.splice(0)) this.#dispatchNotification(live, item.method, item.params, { generation, placement: "sandbox" });
    await this.#finishCutover(live, state, () => live.upstream === destination.upstream && !destination.upstream.closed);
    this.#log.info("Session moved to its sandbox", { sessionId: live.id, generation });
    // Last: listeners (CLI attach, promotion's action carry-over) see the sandbox, a settled state, and every action.
    if (!live.deleting) this.#emitLifecycle(live.id, "promoted");
    return this.get(live.id) ?? record;
  }

  async #abortCutover(live: LiveSession, state: CutoverState, resume: Record<string, unknown> | undefined): Promise<void> {
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
    if (!live.deleting && state.fenced) this.#ledger.update(live.id, { state: state.priorState === "promoting" ? "idle" : state.priorState });
    for (const item of state.buffered.splice(0)) this.#dispatchNotification(live, item.method, item.params, { generation: state.generation, placement: live.placement, beforeSeal: true });
    await this.#finishCutover(live, state, () => !state.sealed && live.upstream === state.source && !state.source.closed);
    this.#log.info("Session move aborted; it stays on its source", { sessionId: live.id });
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
    if (state.fenced) live.ready = ready();
    if (state.gate && live.residency === state.gate) live.residency = undefined;
    state.release?.();
    // Held completions continue from the session's owner; one that is not running is resumed for them.
    this.#driveHeld(live);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Client operations (called by the /v1/connect router)

  async createForClient(peer: ClientPeer, raw: unknown): Promise<{ result: unknown; after: () => Promise<void> }> {
    if (!raw || typeof raw !== "object") throw new ManagedCopilotError("invalid_request", "session.create params must be an object");
    const params = { ...(raw as Record<string, unknown>) };
    if (params["sessionId"] === undefined) params["sessionId"] = randomUUID();
    const sessionId = params["sessionId"];
    if (typeof sessionId !== "string" || !ID_PATTERN.test(sessionId)) throw new ManagedCopilotError("invalid_request", "sessionId must be a UUID");
    if (this.#ledger.get(sessionId) || this.#creating.has(sessionId)) throw new ManagedCopilotError("conflict", `Session ${sessionId} already exists; resume it instead`);
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
    // Taken before admission, which rewrites nested values (remote MCP servers point at the gateway adapter).
    const requested = requestedParams(params);
    for (;;) {
      // An open placement cutover decides where the session lives next, and so which admission rules apply.
      if (live.cutover?.fenced) await live.residency?.catch(() => undefined);
      const placement = live.placement;
      const moves = live.moves;
      const binding = await this.#policy?.session?.(sessionId);
      const network = binding?.policy ?? record.network;
      const admitted = await this.#admit(live.environment, placement, params, "resume", network, sessionId, live.tokenRegistrationId, peer.principal);
      await this.#checkRemoteMcp(admitted, sessionId, placement, network);
      if (live.moves !== moves) continue;
      // The session's option changes this resume does not set again stay in effect (as a restore applies them).
      const optionsPatch = { ...withoutKeys(this.#ledger.admitted(sessionId)?.optionsPatch, requested), ...admitted.optionsPatch };
      const outcome = await this.#resumeClient(live, peer, admitted, moves, optionsPatch);
      // A cutover fenced the session during this resume: admit it again and resume where the session lives after it.
      if (outcome === MOVED) continue;
      this.#persist(sessionId, (stored) => {
        const stable = storedParams(admitted.params);
        // A resume without `agent` keeps the session's current agent (stock runtime behavior), while it still resolves.
        const kept = stored.params["agent"];
        if (stable["agent"] === undefined && typeof kept === "string" && agentResolves(live.environment, kept, stable)) stable["agent"] = kept;
        // A resume configures the session again: what it sets replaces earlier option changes, and it is the caller's
        // configuration from now on (restores and placement changes apply the same thing; model and agent come from
        // the ledger).
        const requestedOptions = withoutKeys(stored.requestedOptions, requested);
        return {
          params: stable,
          ...(stored.tools ? { tools: stored.tools } : {}),
          optionsPatch: { ...withoutKeys(stored.optionsPatch, requested), ...admitted.optionsPatch },
          requested,
          ...(requestedOptions && Object.keys(requestedOptions).length > 0 ? { requestedOptions } : {}),
        };
      });
      const current = this.get(sessionId) ?? record;
      this.#ledger.update(sessionId, {
        state: current.state === "failed" || current.state === "stopped" ? "ready" : current.state,
        ...(admitted.model ? { model: admitted.model } : {}),
        ...(admitted.agent ? { agent: admitted.agent } : {}),
      });
      return { result: this.#scrub(live, this.#sanitizeResponse(live, outcome.result, placement), placement), after: () => this.#afterAttach(peer, sessionId) };
    }
  }

  /**
   * Resumes a client's attachment on the session's owner (restoring the session there if it is not running). Returns
   * MOVED when a placement cutover fenced the session meanwhile; nothing is sent to a runtime after a fence.
   */
  async #resumeClient(live: LiveSession, peer: ClientPeer, admitted: AdmittedSession, moves: number, optionsPatch: Record<string, unknown>): Promise<{ result: unknown } | typeof MOVED> {
    const run = async (upstream: RuntimeUpstream): Promise<{ result: unknown } | typeof MOVED> => {
      const extras = live.resumeExtras;
      const prepared = await this.#prepare(live, "session.resume", { ...admitted.params, ...extras });
      await this.#sealSettled(live, upstream);
      // Checked and sent in one synchronous step.
      if (live.moves !== moves || live.cutover?.fenced || upstream.closed) return MOVED;
      const previous = live.attachments.get(peer.id);
      this.#attach(live, peer, admitted, prepared);
      const forwarded = this.#withRegistrations(live, prepared);
      let result: unknown;
      try {
        result = await this.#resumeUpstream(live, upstream, forwarded);
        await this.#opened(live, upstream, optionsPatch);
      } catch (error) {
        this.#unattach(live, peer.id, previous);
        if (live.moves !== moves) return MOVED;
        throw error;
      }
      if (live.resumeExtras === extras) live.resumeExtras = undefined;
      if (live.moves !== moves) {
        // Fenced during the resume: the client attaches where the session lives after the cutover, with what it had.
        this.#unattach(live, peer.id, previous);
        return MOVED;
      }
      live.ready = true;
      return { result };
    };
    await live.residency?.catch(() => undefined);
    if (live.moves !== moves) return MOVED;
    // Resident already: the runtime re-registers this client's tools and handler flags.
    if (live.upstream && !live.upstream.closed && live.ready) return run(live.upstream);
    // Not resident: the client's own resume restores it, and concurrent callers wait for it.
    let outcome: { result: unknown } | typeof MOVED = MOVED;
    await this.#serialize(live, async () => {
      const upstream = await this.#connect(live, moves);
      outcome = await run(upstream);
      return upstream;
    });
    return outcome;
  }

  async forwardForClient(peer: ClientPeer, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const sessionId = params["sessionId"];
    if (typeof sessionId !== "string") throw unsupportedMethod(method);
    const live = this.#attachedLive(peer, sessionId, method);
    if (!FORWARDED_SESSION_METHODS.has(method) && method !== "session.options.update" && method !== "session.tools.set" && method !== "session.model.switchTo" && method !== "session.model.switchAutoTier") {
      throw unsupportedMethod(method);
    }
    for (;;) {
      // An open placement cutover decides where the session lives next, and so which admission rules apply.
      if (live.cutover?.fenced) await live.residency?.catch(() => undefined);
      const placement = live.placement;
      const moves = live.moves;
      const record = this.getOwned(peer.principal.accountId, sessionId);
      let forwarded: Record<string, unknown> = params;
      let patch: Record<string, unknown> | undefined;
      const context = (): AdmissionContext => ({
        environment: live.environment,
        placement,
        network: record.network,
        platformTools: this.#platformToolsFor(live.environment, placement),
        workingDirectory: this.#workingDirectory(placement, sessionId),
        tokenRegistrationId: live.tokenRegistrationId,
        allowMcp: hasRemoteMcp(this.#ledger.admitted(sessionId)?.params),
      });
      switch (method) {
        case "session.send":
        case "session.sendAndWait":
          forwarded = { ...admitSend(params, context()), sessionId };
          break;
        case "session.options.update":
          patch = admitOptionsUpdate(params, context());
          forwarded = { ...patch, sessionId };
          break;
        case "session.tools.set": {
          const admitted = admitToolsSet(params, context());
          const attachment = live.attachments.get(peer.id);
          if (attachment) {
            attachment.tools = new Set(admitted.names);
            attachment.declarations = (admitted.params["tools"] as Record<string, unknown>[]).filter((tool) => !this.#options.platformTools.has(String(tool["name"])));
          }
          live.wire = this.#registrations(live);
          forwarded = { ...admitted.params, tools: [...live.wire.tools, ...this.#platformToolDeclarations(live, placement)], sessionId };
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
      let result: unknown;
      try {
        result = await this.#onOwner(live, placement, (upstream) =>
          method === "session.sendAndWait" ? this.#sendAndWait(live, upstream, forwarded, signal, placement) : upstream.request(method, forwarded, { signal }),
        );
      } catch (error) {
        // A cutover moved the session after this call was admitted: admit it again where the session lives now.
        if (error === MOVED) continue;
        // Configuration a cutover interrupted (the source closed the session meanwhile) is set on its owner instead.
        if (live.moves !== moves && CONFIG_METHODS.has(method) && error instanceof RpcError && !signal.aborted) {
          await this.#fenceLifted(live);
          continue;
        }
        throw error;
      }
      if (method === "session.sendAndWait") return result;
      // A fence went up while configuration was being set: the session's owner after it (the destination, or a source
      // resumed from stored configuration) may not have it, so it is set again there (an idempotent repeat otherwise).
      if (live.moves !== moves && CONFIG_METHODS.has(method)) {
        await this.#fenceLifted(live);
        continue;
      }
      if (patch && Object.keys(patch).length > 0) {
        const requested = withoutSessionId(params);
        this.#persist(sessionId, (stored) => ({ ...stored, optionsPatch: { ...stored.optionsPatch, ...patch }, requestedOptions: { ...stored.requestedOptions, ...requested } }));
        if (typeof patch["model"] === "string") this.#ledger.update(sessionId, { model: patch["model"] });
      }
      if (method === "session.model.switchTo" && typeof params["modelId"] === "string") {
        const model = params["modelId"];
        this.#ledger.update(sessionId, { model });
        this.#persist(sessionId, (stored) => ({ ...stored, params: { ...stored.params, model } }));
      }
      // Restores re-select the agent the session last had, not the one it was created with.
      if (method === "session.agent.select" && typeof params["name"] === "string" && params["name"]) {
        const agent = params["name"];
        this.#ledger.update(sessionId, { agent });
        this.#persist(sessionId, (stored) => ({ ...stored, params: { ...stored.params, agent } }));
      } else if (method === "session.agent.deselect") {
        this.#ledger.update(sessionId, { agent: "" });
        this.#persist(sessionId, (stored) => {
          const { agent: _agent, ...rest } = stored.params;
          return { ...stored, params: rest };
        });
      }
      // Scrubbed for where the history comes from: a promoted session's earlier events are from shared placement.
      if (HISTORY_METHODS.has(method) && result && typeof result === "object" && Array.isArray((result as { events?: unknown }).events)) {
        const origin = placement === "shared" ? placement : this.#historyPlacement(live);
        const visible = this.#withoutHidden(live, result as { events: RuntimeSessionEvent[] });
        return this.#scrub(live, { ...visible, events: visible.events.map((event) => this.#sanitizeEvent(live, event, origin)) }, origin);
      }
      return this.#scrub(live, result, placement);
    }
  }

  /**
   * A client's `sendAndWait`. During a placement cutover, a reply the source sends between the fence and the seal is
   * genuine and is delivered when the fence lifts. For a call the seal caught, an aborted reply or a failure is the
   * suspend's handoff, so the call completes from the owning runtime's events instead; a completed reply means the turn
   * ended on the source first, and is delivered as is. Replies are scrubbed for the placement that sent them.
   */
  async #sendAndWait(live: LiveSession, upstream: RuntimeUpstream, params: Record<string, unknown>, signal: AbortSignal, placement: Placement): Promise<unknown> {
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
        const handoff = failure ? undefined : (this.#scrub(live, reply, placement) as Record<string, unknown> | undefined);
        held.messageId = handoff?.["messageId"];
        held.seed = handoff?.["response"];
        held.replied = true;
        this.#settleHeld(live, held);
        this.#driveHeld(live);
        return held.promise;
      }
      this.#unhold(live, held);
    }
    if (failure) throw failure.error;
    const clean = this.#scrub(live, reply, placement);
    const cutover = live.cutover;
    if (wait.fenced && cutover && !cutover.flushed) return new Promise((resolve) => cutover.replies.push({ value: clean, resolve }));
    return clean;
  }

  /** Starts holding a `sendAndWait` the seal caught: owner events after the seal record its outcome. */
  #hold(live: LiveSession, signal: AbortSignal): HeldCompletion {
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
  #driveHeld(live: LiveSession): void {
    if (live.held.length === 0 || live.cutover) return;
    if (live.deleting || this.#live.get(live.id) !== live) {
      for (const held of live.held.splice(0)) held.reject(new RpcError(-32000, `Session ${live.id} was deleted`, { code: "not_found" }));
      return;
    }
    if (live.ready && live.upstream && !live.upstream.closed) return;
    void this.#resident(live).catch((error: unknown) => {
      this.#log.warn("Resuming a session with held completions failed", { sessionId: live.id, error: (error as Error).message });
      for (const held of live.held.splice(0)) held.reject(new RpcError(-32000, `The session could not be resumed: ${(error as Error).message}`, { code: "state_restore_failed" }));
    });
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
    const sessionId = input.raw["sessionId"] as string;
    // Reserve the ID synchronously so concurrent creates of the same ID cannot both proceed.
    if (this.#creating.has(sessionId) || this.#ledger.get(sessionId)) throw new ManagedCopilotError("conflict", `Session ${sessionId} already exists`);
    const done = this.#createReserved(input, sessionId);
    this.#creating.set(sessionId, { ownerId: input.principal.accountId, done });
    try {
      return await done;
    } finally {
      this.#creating.delete(sessionId);
    }
  }

  async #createReserved(
    input: { principal: Principal; environment: ResolvedEnvironment; raw: Record<string, unknown>; peer: ClientPeer | undefined; scheduleId?: string | undefined; webhook?: string | undefined; clientName?: string | undefined },
    sessionId: string,
  ): Promise<unknown> {
    const { principal, environment } = input;
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
    // Taken before admission, which rewrites nested values (remote MCP servers point at the gateway adapter).
    const requested = requestedParams(input.raw);
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
    let live: LiveSession | undefined;
    try {
      await this.#checkRemoteMcp(admitted, sessionId, placement, network);
      const stored: AdmittedConfig = {
        params: storedParams(admitted.params),
        ...(input.peer ? {} : { tools: (admitted.params["tools"] as Record<string, unknown>[]).filter((tool) => !this.#options.platformTools.has(String(tool["name"]))) }),
        optionsPatch: admitted.optionsPatch,
        requested,
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
      const created = this.#register(record, environment, tokenRegistrationId);
      live = created;
      created.wire = { tools: stored.tools ? [...stored.tools] : [], flags: {} };
      let result: unknown;
      await this.#serialize(created, async () => {
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
          upstream = await this.#openSandbox(created);
        } else {
          mkdirSync(this.#workingDirectory("shared", sessionId), { recursive: true });
          upstream = await this.#options.sharedRuntime!.ready();
          created.upstream = upstream;
        }
        const forwarded = await this.#prepare(created, "session.create", admitted.params);
        if (input.peer) this.#attach(created, input.peer, admitted, forwarded);
        result = await upstream.request("session.create", forwarded);
        await this.#opened(created, upstream, admitted.optionsPatch);
        created.ready = true;
        return upstream;
      });
      this.#ledger.update(sessionId, { state: "ready" });
      this.#options.events.emit("session.created", { ownerId: principal.accountId, sessionId, environment: environment.name, data: { placement, type: environment.type } });
      this.#log.info("Session created", { sessionId, owner: principal.login, environment: environment.name, placement });
      return this.#scrub(created, this.#sanitizeResponse(created, result));
    } catch (error) {
      if (live) {
        this.#live.delete(sessionId);
        for (const attachment of live.attachments.values()) this.#actions?.onDetached(attachment.peer.id, sessionId);
        live.attachments.clear();
      }
      this.#ledger.remove(sessionId);
      if (placement === "sandbox" && live) {
        live.upstream?.close();
        live.sandbox?.close?.();
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
      // Copy on write: the caller's own objects (which `requested` snapshots) keep the original endpoints.
      if (server.agent) {
        const agents = admitted.params["customAgents"] as Record<string, unknown>[] | undefined;
        const index = agents?.findIndex((agent) => agent["name"] === server.agent) ?? -1;
        const agent = index >= 0 ? agents![index]! : undefined;
        const servers = agent?.["mcpServers"] as Record<string, Record<string, unknown>> | undefined;
        const entry = servers?.[server.name];
        if (!agents || !agent || !servers || !entry) continue;
        const copy = [...agents];
        copy[index] = { ...agent, mcpServers: { ...servers, [server.name]: await adapt(sessionId, server.name, entry) } };
        admitted.params["customAgents"] = copy;
      } else {
        const servers = admitted.params["mcpServers"] as Record<string, Record<string, unknown>> | undefined;
        const entry = servers?.[server.name];
        if (!servers || !entry) continue;
        admitted.params["mcpServers"] = { ...servers, [server.name]: await adapt(sessionId, server.name, entry) };
      }
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
      ready: false,
      sandbox: undefined,
      attachments: new Map(),
      creator: undefined,
      wire: { tools: [], flags: {} },
      queue: Promise.resolve(),
      residency: undefined,
      deleting: false,
      cutover: undefined,
      waits: new Set(),
      held: [],
      resumeExtras: undefined,
      moves: 0,
      hidden: undefined,
      sealedSource: undefined,
    };
    this.#live.set(record.id, live);
    return live;
  }

  /** The live state for a ledger session, created lazily (after a gateway restart, sessions start non-resident). */
  #liveFor(sessionId: string): LiveSession {
    const existing = this.#live.get(sessionId);
    if (existing) {
      if (existing.deleting) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
      return existing;
    }
    const record = this.get(sessionId);
    if (!record || record.state === "deleting") throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
    const environment = this.#options.environments.forSession(record);
    const live = this.#register(record, environment, `mc-${randomUUID()}`);
    const admitted = this.#ledger.admitted(sessionId);
    live.wire = { tools: admitted?.tools ? [...admitted.tools] : [], flags: {} };
    return live;
  }

  #attachedLive(peer: ClientPeer, sessionId: string, method: string): LiveSession {
    const live = this.#live.get(sessionId);
    if (live?.attachments.has(peer.id) && !live.deleting) return live;
    const record = this.get(sessionId);
    if (!record || record.ownerId !== peer.principal.accountId || record.state === "deleting") throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
    throw new ManagedCopilotError("invalid_request", `Resume session ${sessionId} on this client before calling ${method}`);
  }

  /**
   * Runs one create/resume/restore for a session at a time. Concurrent callers wait for it instead of using an
   * upstream on which the session is not open yet.
   */
  #serialize(live: LiveSession, work: () => Promise<RuntimeUpstream>): Promise<RuntimeUpstream> {
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
  async #connect(live: LiveSession, moves = live.moves): Promise<RuntimeUpstream> {
    live.ready = false;
    if (live.placement === "sandbox") {
      const sandboxes = this.#sandboxes;
      if (!sandboxes) throw new ManagedCopilotError("capability_unavailable", "The sandbox service is not available on this gateway");
      await sandboxes.ensureRunning?.(live.id);
      return this.#openSandbox(live);
    }
    const shared = this.#options.sharedRuntime;
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
  #resident(live: LiveSession): Promise<RuntimeUpstream> {
    if (live.deleting) return Promise.reject(new ManagedCopilotError("not_found", `Session ${live.id} was not found`, { sessionId: live.id }));
    if (live.upstream && !live.upstream.closed && live.ready) return Promise.resolve(live.upstream);
    const moves = live.moves;
    const residency = live.residency ?? this.#restore(live);
    return residency.then((upstream) => (live.moves !== moves || live.cutover?.fenced ? this.#resident(live) : upstream));
  }

  #restore(live: LiveSession): Promise<RuntimeUpstream> {
    const moves = live.moves;
    return this.#serialize(live, async () => {
      const upstream = await this.#connect(live, moves);
      if (live.moves !== moves) return upstream;
      const admitted = this.#ledger.admitted(live.id);
      if (!admitted) throw new ManagedCopilotError("state_restore_failed", `Session ${live.id} has no stored configuration to resume with`);
      const extras = live.resumeExtras;
      const prepared = await this.#prepare(live, "session.resume", {
        ...admitted.params,
        sessionId: live.id,
        tools: [...live.wire.tools, ...this.#platformToolDeclarations(live)],
        ...live.wire.flags,
        ...(live.placement === "shared" ? { gitHubTokenProviderRegistrationId: live.tokenRegistrationId } : {}),
        ...extras,
      });
      await this.#sealSettled(live, upstream);
      // A fence that went up during the restore wins (even one whose cutover has ended since): nothing is sent to a
      // runtime after it, and callers find the session's owner afresh.
      if (live.moves !== moves || live.cutover?.fenced) return upstream;
      try {
        await this.#resumeUpstream(live, upstream, prepared);
        await this.#opened(live, upstream, admitted.optionsPatch);
      } catch (error) {
        throw error instanceof RpcError ? new ManagedCopilotError("state_restore_failed", `Session ${live.id} could not be restored: ${error.message}`) : error;
      }
      if (live.resumeExtras === extras) live.resumeExtras = undefined;
      // A cutover fenced while this restore ran keeps the session fenced.
      if (live.moves === moves && !live.cutover?.fenced) live.ready = true;
      this.#log.info("Session resumed upstream", { sessionId: live.id, upstream: upstream.info.id });
      return upstream;
    });
  }

  /** Updates the stored admitted configuration used to restore the session. */
  #persist(sessionId: string, update: (stored: AdmittedConfig) => AdmittedConfig): void {
    const stored = this.#ledger.admitted(sessionId);
    if (stored) this.#ledger.update(sessionId, { admitted: update(stored) });
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

  /**
   * Resumes the session on `upstream`. The stock runtime persists a session with its first turn, so a session that
   * never ran one is unknown to a restarted runtime (shared runtime restart, sandbox idle stop): it is created again
   * with the same ID and configuration. A session whose history the runtime lost still fails.
   */
  async #resumeUpstream(live: LiveSession, upstream: RuntimeUpstream, params: Record<string, unknown>): Promise<unknown> {
    // On a source an aborted cutover sealed, what arrives before this resume is answered is still the suspend's
    // handoff; the resumed session's own output follows the answer (verified on runtime 1.0.103).
    const sealed = live.sealedSource?.upstream === upstream ? live.sealedSource : undefined;
    const reopened = () => {
      if (sealed && live.sealedSource === sealed) live.sealedSource = undefined;
    };
    try {
      return await upstream.request("session.resume", params, { onSettle: reopened });
    } catch (error) {
      if (!(error instanceof RpcError) || !UNKNOWN_SESSION.test(error.message) || this.get(live.id)?.lastTurn) throw error;
      this.#log.info("The runtime has no state for a session that never ran a turn; creating it again", { sessionId: live.id });
      return upstream.request("session.create", params);
    }
  }

  async #prepare(live: LiveSession, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return live.sandbox?.prepareSessionParams ? await live.sandbox.prepareSessionParams(method, params) : params;
  }

  /** Before resuming on a source an aborted cutover sealed: its answers to the sealing calls come first. */
  async #sealSettled(live: LiveSession, upstream: RuntimeUpstream): Promise<void> {
    const sealed = live.sealedSource;
    if (sealed?.upstream === upstream) await sealed.settled;
  }

  /** Waits for an open cutover's fence to lift (the session then has its next owner). */
  async #fenceLifted(live: LiveSession): Promise<void> {
    if (live.cutover?.fenced) await live.residency?.catch(() => undefined);
  }

  /** Where a session's history comes from: a promotable session started on shared placement, wherever it runs now. */
  #historyPlacement(live: LiveSession): Placement {
    return live.environment.type === "promotable" ? "shared" : live.placement;
  }

  async #opened(live: LiveSession, upstream: RuntimeUpstream, optionsPatch: Record<string, unknown>): Promise<void> {
    // Sandboxes install the owner's credential here, then select a requested agent (the runtime resolves agents only
    // for authenticated sessions, so the sandbox module defers `agent` out of create/resume params).
    if (live.sandbox?.sessionOpened) await live.sandbox.sessionOpened(live.id);
    if (Object.keys(optionsPatch).length > 0) {
      const result = await upstream.request<{ success?: boolean; error?: string }>("session.options.update", { ...optionsPatch, sessionId: live.id });
      if (result && result.success === false) throw new ManagedCopilotError("internal", `The runtime rejected the session lockdown: ${result.error ?? "unknown error"}`);
    }
  }

  #platformToolDeclarations(live: LiveSession, placement: Placement = live.placement): Record<string, unknown>[] {
    return this.#platformToolsFor(live.environment, placement).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      skipPermission: tool.skipPermission,
      ...(tool.overridesBuiltInTool ? { overridesBuiltInTool: true } : {}),
    }));
  }

  #onUpstreamClosed(upstream: RuntimeUpstream): void {
    for (const live of this.#live.values()) {
      const cutover = live.cutover;
      if (cutover && !cutover.done && cutover.destination?.upstream === upstream) {
        this.#log.warn("A promotion destination closed before commit", { sessionId: live.id });
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
      this.#emitLifecycle(live.id, "stopped");
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Attachments

  #attach(live: LiveSession, peer: ClientPeer, admitted: AdmittedSession, forwarded: Record<string, unknown>): void {
    const flag = (key: string) => forwarded[key] === true;
    const sections = (forwarded["systemMessage"] as { sections?: Record<string, { action?: unknown }> } | undefined)?.sections ?? {};
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
      transforms: Object.values(sections).some((section) => section?.action === "transform"),
      canvases: (Array.isArray(forwarded["canvases"]) && forwarded["canvases"].length > 0) || forwarded["requestCanvasRenderer"] !== undefined || forwarded["canvasProvider"] !== undefined,
      declarations: ((forwarded["tools"] as Record<string, unknown>[] | undefined) ?? []).filter((tool) => !this.#options.platformTools.has(String(tool["name"]))),
      flags: Object.fromEntries([...WIRE_FLAGS, "streaming"].filter((key) => forwarded[key] !== undefined).map((key) => [key, forwarded[key]])),
    });
    live.creator ??= peer.id;
    live.wire = this.#registrations(live);
  }

  /**
   * The runtime scopes tool and handler registrations to the calling connection, and every attached client shares
   * the gateway's one upstream connection. Upstream registrations are therefore the union across attached clients
   * (plus stored server-side declarations), so one client's resume never removes another's tools or hooks.
   */
  #registrations(live: LiveSession): WireSettings {
    const byName = new Map<string, Record<string, unknown>>();
    for (const tool of this.#ledger.admitted(live.id)?.tools ?? []) byName.set(String(tool["name"]), tool);
    const ordered = [...live.attachments.values()].sort((a, b) => a.attachedAt - b.attachedAt);
    for (const attachment of ordered) for (const tool of attachment.declarations) byName.set(String(tool["name"]), tool);
    const flags: Record<string, unknown> = {};
    for (const key of WIRE_FLAGS) if (ordered.some((attachment) => attachment.flags[key] === true)) flags[key] = true;
    const streaming = ordered.at(-1)?.flags["streaming"];
    if (streaming !== undefined) flags["streaming"] = streaming;
    return { tools: [...byName.values()], flags };
  }

  /** Upstream create/resume/tools params: the aggregate registrations plus the environment's platform tools. */
  #withRegistrations(live: LiveSession, params: Record<string, unknown>): Record<string, unknown> {
    const registrations = this.#registrations(live);
    return { ...params, ...registrations.flags, tools: [...registrations.tools, ...this.#platformToolDeclarations(live)] };
  }

  /** Detaches one connection from one session; durable releases only that session's live claims of the connection. */
  #detach(live: LiveSession, peerId: string, notifyActions = true): void {
    live.attachments.delete(peerId);
    if (live.creator === peerId) live.creator = live.attachments.keys().next().value;
    if (notifyActions) this.#actions?.onDetached(peerId, live.id);
  }

  /** Undoes an attach whose resume did not complete: the client keeps the attachment it had before, if any. */
  #unattach(live: LiveSession, peerId: string, previous: Attachment | undefined): void {
    if (previous) live.attachments.set(peerId, previous);
    else this.#detach(live, peerId);
    live.wire = this.#registrations(live);
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
      // Pending actions can predate a placement change, like history.
      const origin = this.#historyPlacement(live);
      for (const event of replay) peer.notify("session.event", { sessionId, event: this.#scrub(live, this.#sanitizeEvent(live, event, origin), origin) });
    } catch (error) {
      this.#log.warn("Action replay after attach failed", { sessionId, error: (error as Error).message });
    }
  }

  /** Responder preference: the creating connection first, then the others by attach time. */
  #preferred(live: LiveSession): Attachment[] {
    return [...live.attachments.values()].sort((a, b) => (a.peer.id === live.creator ? -1 : b.peer.id === live.creator ? 1 : a.attachedAt - b.attachedAt));
  }

  #responders(live: LiveSession): AttachedResponder[] {
    return this.#preferred(live).map((attachment) => ({
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
    this.#dispatchNotification(live, method, params);
  }

  #hide(live: LiveSession, eventId: unknown): void {
    if (typeof eventId !== "string" || !eventId) return;
    live.hidden ??= this.#ledger.hiddenEvents(live.id);
    live.hidden.add(eventId);
    this.#ledger.hideEvents(live.id, [eventId]);
  }

  #dispatchNotification(live: LiveSession, method: string, params: unknown, origin?: NotificationOrigin): void {
    if (method === "session.event") {
      const event = (params as { event?: RuntimeSessionEvent }).event;
      if (!event || typeof event.type !== "string") return;
      live.queue = live.queue.then(() => this.#deliverEvent(live, event, origin)).catch((error: unknown) => {
        this.#log.warn("Session event delivery failed", { sessionId: live.id, type: event.type, error: (error as Error).message });
      });
    } else if (method === "session.lifecycle") {
      live.queue = live.queue
        .then(() => {
          const scrubbed = this.#scrub(live, params, origin?.placement);
          for (const attachment of live.attachments.values()) attachment.peer.notify("session.lifecycle", scrubbed);
        })
        .catch((error: unknown) => this.#log.warn("Session lifecycle delivery failed", { sessionId: live.id, error: (error as Error).message }));
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

  async #deliverEvent(live: LiveSession, event: RuntimeSessionEvent, origin?: NotificationOrigin): Promise<void> {
    this.#track(live, event);
    // Sanitized for the placement that emitted it, which a cutover may have changed since.
    const sanitized = this.#scrub(live, this.#sanitizeEvent(live, event, origin?.placement), origin?.placement);
    // Only the owner's events after a seal complete the calls it caught; what the source said before it cannot.
    if (!event.agentId && live.held.length > 0 && !origin?.beforeSeal) this.#advanceHeld(live, sanitized);
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
          this.#actions?.releaseLiveClaim(decision.actionId, decision.claimToken);
          continue;
        }
      }
      attachment.peer.notify("session.event", notification);
    }
  }

  async #routeAction(live: LiveSession, event: RuntimeSessionEvent, generation?: number): Promise<{ owner?: string; withhold: readonly string[]; actionId?: string; claimToken?: string }> {
    const record = this.get(live.id);
    const actions = this.#actions;
    const toolName = event.type === "external_tool.requested" ? (event.data["toolName"] as string | undefined) : undefined;
    const platformTool = toolName ? this.#options.platformTools.get(toolName) : undefined;
    if (actions && record) {
      // Events flushed after a cutover belong to the placement generation whose runtime emitted them.
      return actions.onSessionEvent({ sessionId: live.id, ownerId: record.ownerId, environment: record.environment, generation: generation ?? record.generation, event, attached: this.#responders(live) });
    }
    if (platformTool && record) {
      void this.#runPlatformTool(live, record, event, platformTool.name);
      return { withhold: [...live.attachments.keys()] };
    }
    // Default claim-before-emit (no durable module): the first eligible client in the same preference order durable
    // uses executes; other eligible clients are withheld.
    const attachments = this.#preferred(live);
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
    const destination = live?.cutover?.destination?.upstream === upstream ? live.cutover.destination : undefined;
    if (live && live.upstream !== upstream && live.residency === undefined && !destination) throw new RpcError(-32000, "Stale runtime connection", { code: "conflict" });
    const sandboxHandler =
      (destination ? destination.sandbox.handlers?.get(method) : live?.sandbox?.handlers?.get(method)) ?? (upstream.info.kind === "sandbox" ? this.#sandboxHandlerFor(upstream, method) : undefined);
    if (sandboxHandler) return sandboxHandler(params);
    const registered = this.#options.runtimeRequests.resolve(method, upstream.info);
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
      if (!target) throw new ManagedCopilotError("capability_unavailable", `No connected client can answer ${method} for session ${live.id}`);
      return target.peer.request(method, this.#scrub(live, params), context.signal);
    }
    throw unsupportedMethod(method, `The gateway does not answer ${method}`);
  }

  /** Sandbox handlers by connection: inference body chunks carry no session ID, and a cutover's destination counts. */
  #sandboxHandlerFor(upstream: RuntimeUpstream, method: string): ((params: unknown) => Promise<unknown>) | undefined {
    for (const live of this.#live.values()) {
      if (live.upstream === upstream) return live.sandbox?.handlers?.get(method);
      const destination = live.cutover?.destination;
      if (destination?.upstream === upstream) return destination.sandbox.handlers?.get(method);
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
  #sanitizeEvent(live: LiveSession, event: RuntimeSessionEvent, placement: Placement = live.placement): RuntimeSessionEvent {
    if (placement !== "shared") return event;
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

  #sanitizeResponse(live: LiveSession, result: unknown, placement: Placement = live.placement): unknown {
    if (placement !== "shared" || !result || typeof result !== "object") return result;
    const { workspacePath: _workspacePath, ...rest } = result as Record<string, unknown>;
    return rest;
  }

  /**
   * Replaces platform host paths in anything a shared session sends to clients (events, responses, and runtime
   * requests): the session's private directory becomes `/workspace`, any other runtime path `/platform`.
   */
  /** `placement`: where the value came from (a cutover may have moved the session since). */
  #scrub<T>(live: LiveSession, value: T, placement: Placement = live.placement): T {
    if (placement !== "shared") return value;
    const scrubber = this.#scrubber;
    return scrubber ? (scrubber(value) as T) : value;
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

/** How the stock runtime reports a session it has no persisted state for. */
const UNKNOWN_SESSION = /session not found|failed to load session events/i;

/** Whether an event is something `session.suspend` / `sessions.close` caused, rather than output already under way. */
function isHandoffEvent(event: RuntimeSessionEvent): boolean {
  if (typeof event.type !== "string") return true;
  return HANDOFF_EVENT_TYPES.has(event.type) || (event.type === "session.idle" && event.data?.["aborted"] === true);
}

/** `patch` without the keys `replacing` sets (a later resume's configuration replaces earlier option changes). */
function withoutKeys(patch: Record<string, unknown> | undefined, replacing: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!patch) return undefined;
  return Object.fromEntries(Object.entries(patch).filter(([key]) => !(key in replacing)));
}

function cutoverClosed(sessionId: string): ManagedCopilotError {
  return new ManagedCopilotError("conflict", `The cutover of session ${sessionId} is already closed`, { sessionId });
}

/** Whether an agent name resolves in a session's configuration: deployed with its environment, or declared inline. */
function agentResolves(environment: ResolvedEnvironment, name: string, params: Record<string, unknown>): boolean {
  if (environment.customizations?.agents.some((agent) => agent.name === name)) return true;
  const inline = params["customAgents"];
  return Array.isArray(inline) && inline.some((agent) => agent && typeof agent === "object" && (agent as { name?: unknown }).name === name);
}

/** Whether stored admitted params include remote MCP servers (top-level or in custom agents). */
function hasRemoteMcp(params: Record<string, unknown> | undefined): boolean {
  if (!params) return false;
  const servers = params["mcpServers"];
  if (servers && typeof servers === "object" && Object.keys(servers).length > 0) return true;
  const agents = params["customAgents"];
  return Array.isArray(agents) && agents.some((agent) => agent && typeof agent === "object" && (agent as { mcpServers?: object }).mcpServers && Object.keys((agent as { mcpServers: object }).mcpServers).length > 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a deep string replacer for platform host paths under the gateway's data directory, tolerant of slash
 * direction, case on Windows, and the directory's resolved form (8.3 names, symlinks): a shared session's directory
 * becomes `/workspace`, a pinned customizations bundle the path sandboxes mount it at, anything else `/platform`.
 */
export function pathScrubber(dataDir: string): (value: unknown) => unknown {
  const separators = String.raw`[\\/]+`;
  // Session IDs, environment names, and bundle digests: identifier characters only, so punctuation after a path stays.
  const segment = String.raw`[A-Za-z0-9_-]+`;
  // The rest of the path (segments without spaces), rewritten with POSIX separators.
  const tail = String.raw`((?:[\\/]+[^\\/\s"'\`]+)*)`;
  // The directory itself, not part of a longer name: `/data` is neither `/mnt/data` nor `/database` (`/data.` ends one).
  const before = String.raw`(?<![A-Za-z0-9_.~-])`;
  const after = String.raw`(?![A-Za-z0-9_~-]|\.[A-Za-z0-9_~-])`;
  const flags = process.platform === "win32" ? "gi" : "g";
  const variants = new Set([resolvePath(dataDir)]);
  try {
    variants.add(realpathSync.native(dataDir));
  } catch {
    // Not created yet: the configured form is the one the runtime sees.
  }
  const rules: [RegExp, string][] = [];
  for (const variant of variants) {
    const root = before + variant.replace(/[\\/]+$/, "").split(/[\\/]+/).map(escapeRegExp).join(separators);
    rules.push(
      [new RegExp(`${root}${separators}runtime${separators}shared${separators}workspaces${separators}${segment}${tail}`, flags), "/workspace"],
      [new RegExp(`${root}${separators}customizations${separators}${segment}${separators}${segment}${tail}`, flags), SANDBOX_CUSTOMIZATIONS_DIR],
      [new RegExp(`${root}${separators}runtime${separators}shared${tail}`, flags), "/platform"],
      [new RegExp(`${root}${after}${tail}`, flags), "/platform"],
    );
  }
  const shortest = Math.min(...[...variants].map((variant) => variant.length));
  const replaceString = (text: string) =>
    text.length < shortest ? text : rules.reduce((out, [pattern, base]) => out.replace(pattern, (_match, rest: string) => `${base}${rest.replace(/[\\/]+/g, "/")}`), text);
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return replaceString(value);
    if (depth > 12 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = walk(item, depth + 1);
    return out;
  };
  return (value) => walk(value, 0);
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

/** The caller's configuration as requested (no credentials, no per-connection fields), for admission elsewhere. */
function requestedParams(raw: Record<string, unknown>): Record<string, unknown> {
  const { gitHubToken: _token, sessionId: _sessionId, ...rest } = structuredClone(raw);
  return storedParams(rest);
}

function withoutSessionId(params: Record<string, unknown>): Record<string, unknown> {
  const { sessionId: _sessionId, ...rest } = structuredClone(params);
  return rest;
}
