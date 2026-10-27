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
  ANSWER_METHODS,
  PENDING_LIST_METHODS,
  type ActionsService,
  type AttachedResponder,
  type RuntimeSessionEvent,
} from "../durable/contract.js";
import { admitOptionsUpdate, admitSend, admitSession, admitToolsSet, checkModel, isRecord, isRemoteMcp, SANDBOX_CUSTOMIZATIONS_DIR, type AdmissionContext, type AdmittedSession } from "./admission.js";
import { accountInfo, type GitHubAuthenticator } from "./auth.js";
import {
  optionalService,
  type CliAttachment,
  type CliAttachOptions,
  type CreateSessionRequest,
  type NetworkPolicyService,
  type PlacementCutover,
  type PlatformToolRegistry,
  type ResolvedEnvironment,
  type RuntimeRequestRegistry,
  type SandboxPlacement,
  type SandboxRuntimeHandle,
  type SessionCallOptions,
  type SessionEventListener,
  type SessionRecord,
  type SessionRuntime,
  type SessionSendOptions,
  type SessionsService,
  type VaultHeaderSource,
} from "./contracts.js";
import type { Environments } from "./environments.js";
import type { PlatformEvents } from "./events.js";
import type { AdmittedConfig, CallbackInventory, SessionLedger } from "./ledger.js";
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
  /** The inventory revisions this connection's stored registrations got (what it may withdraw). */
  readonly registered: { readonly tools: Record<string, number>; readonly flags: Record<string, number> };
}

/** Handler flags the runtime registers per connection; the gateway sends the union across attached clients. */
const WIRE_FLAGS = ["requestPermission", "requestUserInput", "requestElicitation", "requestExitPlanMode", "requestAutoModeSwitch", "hooks", "hasSkillProvider"] as const;

/** An attached client as the operator console shows it (never its credential). */
export interface LiveAttachmentSnapshot {
  readonly connectionId: string;
  readonly kind: "sdk" | "cli";
  readonly account: { readonly id: number; readonly login: string; readonly name?: string; readonly avatarUrl?: string };
  readonly clientName?: string;
  readonly attachedAt: string;
  readonly tools: readonly string[];
  readonly callbacks: readonly string[];
}

/** A session's in-memory state as the operator console shows it. */
export interface LiveSessionSnapshot {
  readonly id: string;
  readonly ownerId: number;
  readonly environment: string;
  readonly placement: Placement;
  /** Open on a connected runtime now. */
  readonly resident: boolean;
  readonly ready: boolean;
  readonly upstream?: string;
  readonly upstreamVersion?: string;
  readonly restoring: boolean;
  readonly cutover: boolean;
  readonly deleting: boolean;
  readonly waits: number;
  readonly presences: number;
  readonly attachments: readonly LiveAttachmentSnapshot[];
}

/** The callback kinds an attached client registered. */
function attachmentCallbacks(attachment: Attachment): string[] {
  const kinds: [boolean, string][] = [
    [attachment.requestPermission, "requestPermission"],
    [attachment.requestUserInput, "requestUserInput"],
    [attachment.requestElicitation, "requestElicitation"],
    [attachment.requestExitPlanMode, "requestExitPlanMode"],
    [attachment.requestAutoModeSwitch, "requestAutoModeSwitch"],
    [attachment.hooks, "hooks"],
    [attachment.skillProvider, "skillProvider"],
    [attachment.transforms, "systemMessageTransforms"],
    [attachment.canvases, "canvases"],
  ];
  return kinds.filter(([on]) => on).map(([, name]) => name);
}

/** A client's `session.tools.set` in progress: its registration before the call, and what the call set. */
interface ToolsRegistration {
  live?: LiveSession;
  attachment?: Attachment;
  before?: { readonly tools: Set<string>; readonly declarations: Record<string, unknown>[] };
  set?: Record<string, unknown>[];
  change?: InventoryChange;
  /** The runtime it was last written to. */
  upstream?: RuntimeUpstream;
  /** The runtime applied it and the inventory stored it. */
  stored: boolean;
}

/** Upstream registrations: tool declarations and handler flags, resent when the gateway resumes a session itself. */
interface WireSettings {
  tools: Record<string, unknown>[];
  flags: Record<string, unknown>;
}

/** What one registration (create, resume, `tools.set`) changes in a session's persisted callback inventory. */
interface InventoryChange {
  readonly tools: readonly Record<string, unknown>[];
  readonly flags: Readonly<Record<string, unknown>>;
  /**
   * What the registering connection itself had registered and now withdraws (no other attached client has it), with
   * the revision its registration got: a registration made since by anyone else is not withdrawn.
   */
  readonly removeTools: readonly { readonly name: string; readonly revision: number }[];
  readonly removeFlags: readonly { readonly key: string; readonly revision: number }[];
  /**
   * What the registering connection withdraws while other attached clients still register it: when the stored
   * registration is this connection's (`revision`), it passes to them, so the last of them can withdraw it.
   */
  readonly handover?: { readonly tools: readonly { readonly name: string; readonly revision: number }[]; readonly flags: readonly { readonly key: string; readonly revision: number }[] };
}

/** How long past the runtime's one-hour refresh threshold a GitHub token answer stays valid (the gateway decides again after). */
const TOKEN_LEASE_SECONDS = 3600 + 300;

/**
 * Hook types whose answer can stop the dependent operation, and how they fail closed without their handler (each
 * verified on runtime 1.0.103): a denied tool call, a blocked prompt, and a withheld tool result (`postToolUse` hooks
 * review results, for example to redact them, so the model never sees one they did not review).
 */
const FAIL_CLOSED_HOOKS: Readonly<Record<string, (reason: string) => Record<string, unknown>>> = {
  preToolUse: (reason) => ({ permissionDecision: "deny", permissionDecisionReason: reason }),
  userPromptSubmitted: (reason) => ({ decision: "block", reason }),
  postToolUse: (reason) => ({ modifiedResult: { textResultForLlm: `The tool ran, but its result is withheld because the session's hooks could not review it. ${reason}`, resultType: "denied" } }),
};

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
  /** Owner principals present without a `/v1/connect` attachment (an attached Copilot CLI). */
  readonly presences: Map<symbol, Principal>;
  /**
   * The session's registration changes (client resumes, tools updates) run one at a time: each starts from the one
   * committed before it, so a change that fails never leaks into another's registration upstream.
   */
  registrations: Promise<void>;
  /**
   * A registration that did not commit may have reached the runtime: the session is not routable until it was resumed
   * with the registrations in effect (`#reconcile`).
   */
  unreconciled: boolean;
  /** The runtime a registration was written to and has not answered yet (a cutover's end does not route there before). */
  inflight: RuntimeUpstream | undefined;
  /** Calls written to the session's runtime that have not settled (an operator's sandbox stop waits for none). */
  requests: number;
  /** When a call to the session's runtime last started or settled. */
  lastRequestAt: number | undefined;
  /** Ensures events of one session are processed in order even when routing awaits the actions hook. */
  queue: Promise<void>;
  /**
   * Aborted (with the reason) when the session is deleted or the gateway stops: a registration step waiting on the
   * session's sandbox runtime then closes that connection, which only this session uses (`#bounded`). A deletion that
   * fails leaves the session in place with a new one.
   */
  ending: AbortController;
  /** In-flight create, resume, or restore; concurrent callers wait for it. */
  residency: Promise<RuntimeUpstream> | undefined;
  deleting: boolean;
  /**
   * Its runtime connection closed while it was being deleted, which reports and ends nothing then (it ends with
   * `deleted`). A deletion that fails leaves the session in place and handles that close then (`#deleteOwned`).
   */
  closedWhileDeleting: boolean;
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

/** How many times a sandbox runtime is opened again after its sandbox restarted it (`details.reopen`). */
const MAX_REOPENS = 2;

/**
 * How long a session's registration path (create, resume, restore, a tools update) waits for each answer of its
 * runtime, and then for a `ping` that shows whether its connection still answers at all (`#bounded`). Mutable for tests.
 */
export const upstreamTimings = { answerMs: 60_000, probeMs: 10_000 };

/** What a bound that expired resolves to (never surfaced). */
const EXPIRED = Symbol("expired");

/** The ending a turn gets when the platform lost the runtime connection it needed (a standard `session.error`). */
const INTERRUPTED_TURN =
  "This turn was interrupted because the platform lost the connection to the session's runtime (for example, during an update or restart). Send your message again to continue.";

/**
 * Whether a turn has not ended yet: it ends with its root `session.idle`. Its status alone does not say so: a root
 * `session.error` marks it `failed` before it ends (also an error the turn goes on from, and a subagent's).
 */
function unfinished(turn: SessionRecord["lastTurn"]): turn is NonNullable<SessionRecord["lastTurn"]> {
  return turn !== undefined && turn.completedAt === undefined;
}

/**
 * What a `sendAndWait` the runtime connection was lost under learns. Which turn was its own is not known here (only its
 * answer may have been lost, or another turn was the one cut), so it says what is known; the session's last turn tells
 * the rest, and the turn core ended gets its own `session.error`.
 */
const LOST_ANSWER =
  "The platform lost the connection to the session's runtime before this message's answer arrived (for example, during an update or restart). The turn may not have finished: check the session before sending the message again.";

/**
 * How core ends a running turn whose runtime cannot (`#endTurn`): interrupted by a lost connection, or as a runtime
 * that ran it unseen recorded it (completed, cancelled, or its own `session.error`).
 */
type TurnEnding = "interrupted" | "completed" | "cancelled" | { readonly error: RuntimeSessionEvent };

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
  /** Session IDs whose deletion (or interrupted-create cleanup) is running in this process. */
  readonly #deletions = new Set<string>();
  /** Interrupted-create cleanups in flight, by session ID. */
  readonly #discards = new Map<string, Promise<void>>();
  /** Set once the gateway stops. */
  #stopped = false;
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
    return record && record.state !== "deleted" && !this.#interrupted(record) ? record : undefined;
  }

  /** A create the gateway stopped in the middle of: the session never existed for its owner, and is discarded. */
  #interrupted(record: SessionRecord): boolean {
    return record.state === "creating" && !this.#creating.has(record.id);
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
    return this.#ledger.list(accountId, query).filter((record) => !this.#interrupted(record));
  }

  /** `SessionInfo` of one session incarnation; `not_found` once the ID was deleted (and maybe reused) meanwhile. */
  async toInfo(record: SessionRecord): Promise<SessionInfo> {
    let sandbox: SessionInfo["sandbox"];
    if (record.placement === "sandbox") {
      try {
        sandbox = await this.#sandboxes?.get(record.id);
      } catch (error) {
        this.#log.warn("Could not read sandbox details", { sessionId: record.id, error: (error as Error).message });
      }
    }
    // Only this incarnation's actions: another owner's session may have reused the ID during the read above.
    if (this.get(record.id)?.incarnation !== record.incarnation) throw new ManagedCopilotError("not_found", `Session ${record.id} was not found`, { sessionId: record.id });
    let pendingActions: readonly PendingAction[] = [];
    try {
      pendingActions = this.#actions?.list(record.id, { open: true, ...pinned(record) }) ?? [];
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
      ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
    };
  }

  async create(principal: Principal, request: CreateSessionRequest): Promise<{ sessionId: string; created: boolean; incarnation?: string }> {
    const sessionId = request.sessionId ?? randomUUID();
    const inflight = this.#creating.get(sessionId);
    if (inflight) {
      if (inflight.ownerId !== principal.accountId) throw new ManagedCopilotError("conflict", `Session ${sessionId} already exists`);
      await inflight.done.catch(() => undefined);
    }
    const existing = this.#ledger.get(sessionId);
    if (existing) {
      // A create the gateway stopped in the middle of left only its reservation: clean it up and create afresh.
      if (this.#interrupted(existing) && existing.ownerId === principal.accountId) {
        await this.#discardInterrupted(existing);
      } else {
        if (existing.ownerId === principal.accountId && existing.state !== "deleted" && existing.state !== "deleting") return { sessionId, created: false, incarnation: existing.incarnation };
        throw new ManagedCopilotError("conflict", `Session ${sessionId} already exists`);
      }
    }
    const environment = this.#options.environments.resolve(request.environment);
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
      await this.#create({ principal, environment, raw, peer: undefined, scheduleId: request.scheduleId, webhook: request.webhook, clientName: request.clientName, parent });
    } catch (error) {
      // A concurrent create of the same deterministic ID by the same owner won the race.
      const winner = isManagedCopilotError(error, "conflict") ? this.#ledger.get(sessionId) : undefined;
      if (winner && winner.ownerId === principal.accountId) return { sessionId, created: false, incarnation: winner.incarnation };
      throw error;
    }
    const created = this.#ledger.get(sessionId)?.incarnation;
    return { sessionId, created: true, ...(created ? { incarnation: created } : {}) };
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
    const live = this.#liveFor(sessionId);
    // A turn started without the client that answers the session's hooks would run unguarded: refuse it.
    if (method === "session.send" || method === "session.sendAndWait") this.#assertHooks(live);
    for (;;) {
      try {
        const result = await this.#onOwner(live, live.placement, (upstream) => {
          // In the step that writes it: a call for one incarnation never reaches a session that reused its ID.
          this.#checkIncarnation(sessionId, options.incarnation);
          return upstream.request<T>(method, { ...params, sessionId });
        });
        return HISTORY_METHODS.has(method) ? this.#withoutHidden(live, result) : result;
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
  async #onOwner<T>(live: LiveSession, placement: Placement, send: (upstream: RuntimeUpstream) => Promise<T>): Promise<T> {
    for (;;) {
      const upstream = await this.#resident(live);
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
    const live = this.#live.get(sessionId);
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
    // A deletion the gateway stopped in the middle of is finished by the next request (or by startup recovery).
    if (record.state === "deleting" && this.#deletions.has(sessionId)) throw new ManagedCopilotError("conflict", `Session ${sessionId} is already being deleted`);
    await this.#deleteRecord(record);
  }

  async #deleteRecord(record: SessionRecord): Promise<void> {
    const sessionId = record.id;
    if (this.#deletions.has(sessionId)) throw new ManagedCopilotError("conflict", `Session ${sessionId} is already being deleted`);
    this.#deletions.add(sessionId);
    try {
      // Only the incarnation this deletion is for: an ID deleted and created again since belongs to a new session.
      const current = this.#ledger.get(sessionId);
      if (!current || current.incarnation !== record.incarnation) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
      await this.#deleteOwned(current);
    } finally {
      this.#deletions.delete(sessionId);
    }
  }

  async #deleteOwned(record: SessionRecord): Promise<void> {
    const sessionId = record.id;
    const live = this.#live.get(sessionId);
    if (live) {
      live.deleting = true;
      // A registration step still waiting on the session's sandbox runtime ends now (its connection is closed), so the
      // drain below cannot wait on it forever.
      live.ending.abort(new ManagedCopilotError("not_found", `Session ${sessionId} was deleted`, { sessionId }));
    }
    this.#ledger.update(sessionId, { state: "deleting" });
    // A placement cutover in progress ends here (its owner cleans up the candidate sandbox on `deleted`).
    if (live?.cutover) await this.#abortCutover(live, live.cutover, undefined).catch(() => undefined);
    if (live) for (const held of live.held.splice(0)) held.reject(new RpcError(-32000, `Session ${sessionId} was deleted`, { code: "not_found" }));
    // Let an in-flight create/resume (and registrations waiting their turn) settle so none reopens the session after
    // deletion; they see it is being deleted.
    await live?.residency?.catch(() => undefined);
    await live?.registrations;
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
      if (live) {
        live.deleting = false;
        // The session stays (failed, and deletable again), so steps on its runtime are no longer ended.
        if (!this.#stopped) live.ending = new AbortController();
        // Its runtime connection, which the deletion closed (or saw close), is lost like any other now that the session
        // stays: observers learn its runtime stopped, and a turn the connection cut ends unless durable carries it (as
        // `#onUpstreamClosed` does; also a turn an earlier failed deletion left, whose ending this one preempted). The
        // session stays failed.
        const closed = live.closedWhileDeleting;
        live.closedWhileDeleting = false;
        if (!live.upstream && !live.residency) {
          if (closed) this.#emitLifecycle(sessionId, "stopped");
          if (!live.cutover && !this.#stopped) this.#endLostTurn(live);
        }
      }
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
    this.#options.events.emit("session.deleted", { ownerId: record.ownerId, sessionId, environment: record.environment, data: { incarnation: record.incarnation } });
    this.#emitLifecycle(sessionId, "deleted");
  }

  /**
   * Finishes what a stopped gateway left half done: deletions it was running finish, and the reservations of creates
   * it was running are cleaned up (so a retry with the same session ID creates the session).
   */
  async recover(): Promise<void> {
    for (const record of this.#ledger.byState("deleting")) {
      // A snapshot: each row is checked again under its reservation, so a session deleted and created since is safe.
      if (this.#deletions.has(record.id) || this.#ledger.get(record.id)?.incarnation !== record.incarnation) continue;
      this.#log.info("Finishing a session deletion the gateway stopped in the middle of", { sessionId: record.id });
      await this.#deleteRecord(record).catch((error: unknown) => this.#log.warn("Finishing an interrupted deletion failed; delete the session again", { sessionId: record.id, error: (error as Error).message }));
    }
    for (const record of this.#ledger.byState("creating")) {
      await this.#discardInterrupted(record).catch((error: unknown) => this.#log.warn("Cleaning up an interrupted create failed", { sessionId: record.id, error: (error as Error).message }));
    }
    // Turns the stopped gateway was running were cut with its runtime connections (its shared runtime stopped with it,
    // and a sandbox runtime cannot serve a new gateway's inference): they end, unless durable carries their pending
    // work. So does a turn a failed deletion cut (the session stays `failed`), including one just finished above. A
    // session a client restored meanwhile has its turn checked by that restore instead.
    for (const record of [...this.#ledger.byState("running"), ...this.#ledger.byState("failed")]) {
      const turnId = unfinished(record.lastTurn) ? record.lastTurn.turnId : undefined;
      if (!turnId) continue;
      let live: LiveSession;
      try {
        live = this.#liveFor(record.id);
      } catch {
        continue;
      }
      if (live.upstream || live.residency) continue;
      this.#endLostTurn(live, turnId);
    }
  }

  /** Removes what a create the gateway stopped in the middle of allocated; the session never existed for its owner. */
  #discardInterrupted(record: SessionRecord): Promise<void> {
    // Concurrent callers (startup recovery, a retried create) share one cleanup.
    const running = this.#discards.get(record.id);
    if (running) return running;
    const done = this.#discard(record).finally(() => {
      if (this.#discards.get(record.id) === done) this.#discards.delete(record.id);
    });
    this.#discards.set(record.id, done);
    return done;
  }

  async #discard(record: SessionRecord): Promise<void> {
    const sessionId = record.id;
    // Only that reservation, still interrupted: never a session that was created or deleted since.
    const current = this.#ledger.get(sessionId);
    if (!current || current.incarnation !== record.incarnation || current.state !== "creating" || this.#creating.has(sessionId) || this.#deletions.has(sessionId)) return;
    this.#deletions.add(sessionId);
    try {
      this.#log.warn("Cleaning up a session whose creation was interrupted", { sessionId, environment: record.environment });
      if (record.placement === "sandbox") {
        const sandboxes = this.#sandboxes;
        if (!sandboxes) {
          this.#ledger.update(sessionId, { state: "failed" });
          throw new ManagedCopilotError("capability_unavailable", "The sandbox service is not available, so the interrupted session's sandbox cannot be removed yet");
        }
        // While the row exists no other session can hold the ID, so its sandbox is the interrupted one's.
        await sandboxes.delete(sessionId);
      }
      await Promise.resolve(this.#policy?.releaseSession?.(sessionId)).catch((error: unknown) => this.#log.warn("Policy release failed", { sessionId, error: (error as Error).message }));
      if (this.#ledger.get(sessionId)?.incarnation === record.incarnation) this.#ledger.remove(sessionId);
    } finally {
      this.#deletions.delete(sessionId);
    }
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
    let handle!: SandboxRuntimeHandle;
    let upstream: RuntimeUpstream | undefined;
    for (let reopen = 0; ; reopen++) {
      handle = await sandboxes.openRuntime(live.id, { resolveToken: () => this.#ownerToken(live).then((credential) => credential.token) });
      upstream = undefined;
      try {
        // A cutover that closed while this opened found no destination to close: this one is never installed.
        if (state.done) throw cutoverClosed(live.id);
        upstream = await RuntimeUpstream.open({ id: `sandbox:${live.id}`, kind: "sandbox", sandboxId: live.id }, streamTransport(handle.stream), {
          token: handle.connectionToken,
          handlers: this.#upstreamHandlers,
          log: this.#log,
        });
        if (state.done) throw cutoverClosed(live.id);
        const opened = upstream;
        // Registered first, so the destination's requests (inference, credentials) and events route during the open.
        state.destination = { upstream: opened, sandbox: handle, admitted, optionsPatch };
        if (handle.initialize) await this.#bounded(live, opened, "the sandbox runtime's setup", () => handle.initialize!((method, params) => opened.request(method, params)));
        break;
      } catch (error) {
        if (state.destination?.sandbox === handle) {
          state.destination = undefined;
          state.destinationBuffer.length = 0;
        }
        upstream?.close();
        handle.close?.();
        if (reopen < MAX_REOPENS && wantsReopen(error) && !state.done) {
          this.#log.info("The sandbox restarted its runtime; opening the destination again", { sessionId: live.id });
          continue;
        }
        throw error;
      }
    }
    const opened = upstream!;
    try {
      const registrations = this.#registrations(live, undefined, true);
      const params = await this.#withVaultHeaders(live.id, { ...admitted.params, ...registrations.flags, sessionId: live.id, tools: [...registrations.tools, ...this.#platformToolDeclarations(live, "sandbox")], ...extra }, "sandbox");
      const prepared = handle.prepareSessionParams ? await handle.prepareSessionParams("session.resume", params) : params;
      await this.#bounded(live, opened, "session.resume", () => opened.request("session.resume", prepared));
      if (handle.sessionOpened) await this.#bounded(live, opened, "the session's credential setup", () => handle.sessionOpened!(live.id));
      if (Object.keys(optionsPatch).length > 0) await this.#bounded(live, opened, "session.options.update", () => opened.request("session.options.update", { ...optionsPatch, sessionId: live.id }));
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
    if (state.fenced) live.ready = ready() && !live.unreconciled && live.inflight !== live.upstream;
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
    // A create of the same ID the gateway stopped in the middle of is cleaned up first, as for service creates.
    const interrupted = this.#ledger.get(sessionId);
    if (interrupted && this.#interrupted(interrupted) && interrupted.ownerId === peer.principal.accountId) await this.#discardInterrupted(interrupted);
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
    return this.#registering(live, () => this.#resumeRegistered(peer, params, record, live, requested));
  }

  /** A client resume, as the session's only registration change in progress. */
  async #resumeRegistered(peer: ClientPeer, params: Record<string, unknown>, record: SessionRecord, live: LiveSession, requested: Record<string, unknown>): Promise<{ result: unknown; after: () => Promise<void> }> {
    const sessionId = record.id;
    for (;;) {
      // It may have waited behind other registrations: never for a session deleted (or created again) meanwhile.
      if (live.deleting || this.#live.get(sessionId) !== live || this.get(sessionId)?.incarnation !== record.incarnation) {
        throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
      }
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
      // Stored only for the session it resumed (deletes wait for registrations, so this holds; checked anyway).
      if (this.get(sessionId)?.incarnation !== record.incarnation) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
      this.#persist(sessionId, (stored) => {
        const stable = storedParams(admitted.params);
        // A resume without `agent` keeps the session's current agent (stock runtime behavior), while it still resolves.
        const kept = stored.params["agent"];
        if (stable["agent"] === undefined && typeof kept === "string" && agentResolves(live.environment, kept, stable)) stable["agent"] = kept;
        // Likewise its model: restores select the model the session last had.
        if (stable["model"] === undefined && typeof stored.params["model"] === "string") stable["model"] = stored.params["model"];
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
    const run = async (upstream: RuntimeUpstream, restored: boolean): Promise<{ result: unknown } | typeof MOVED> => {
      const extras = live.resumeExtras;
      const resumeParams = await this.#withVaultHeaders(live.id, { ...admitted.params, ...this.#resumeExtras(live, admitted.params) }, live.placement);
      const prepared = await this.#prepare(live, "session.resume", resumeParams);
      await this.#sealSettled(live, upstream);
      // Checked and sent in one synchronous step.
      if (live.deleting || this.#live.get(live.id) !== live) throw new ManagedCopilotError("not_found", `Session ${live.id} was not found`, { sessionId: live.id });
      if (live.moves !== moves || live.cutover?.fenced || upstream.closed) return MOVED;
      // A client that disconnected meanwhile is not attached (its disconnect has run): the session is resumed with the
      // registrations it has without that client.
      const present = !peer.closed;
      if (present) this.#checkHooksRegistration(live, peer, prepared);
      const previous = live.attachments.get(peer.id);
      const change = present ? this.#inventoryChange(live, peer.id, previous, registrationOf(prepared, this.#options.platformTools)) : undefined;
      if (present) this.#attach(live, peer, admitted, prepared);
      const forwarded = this.#withRegistrations(live, prepared, change);
      let result: unknown;
      live.inflight = upstream;
      try {
        result = await this.#resumeUpstream(live, upstream, forwarded);
        await this.#opened(live, upstream, optionsPatch);
        // Restored by this resume: a turn the lost connection cut ends before the session takes new work (checked
        // before the move check below, so a cutover that committed meanwhile still takes the MOVED path).
        if (restored && live.moves === moves) await this.#settleTurn(live, upstream);
      } catch (error) {
        this.#unattach(live, peer.id, previous);
        // The runtime may have applied what this resume registered before failing (or being overtaken by a move).
        this.#unreconciled(live, upstream);
        if (live.moves !== moves) return MOVED;
        throw error;
      } finally {
        if (live.inflight === upstream) live.inflight = undefined;
      }
      if (live.resumeExtras === extras) live.resumeExtras = undefined;
      if (live.moves !== moves) {
        // Fenced during the resume: the client attaches where the session lives after the cutover, with what it had,
        // and a source it leaves keeps what this resume registered only once it is resumed with what is in effect.
        this.#unattach(live, peer.id, previous);
        this.#unreconciled(live, upstream);
        return MOVED;
      }
      if (change) this.#persistInventory(live, peer.id, change);
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
        await this.#reconcile(live);
        throw error;
      }
    }
    // Not resident: the client's own resume restores it, and concurrent callers wait for it.
    let outcome: { result: unknown } | typeof MOVED = MOVED;
    await this.#serialize(live, async () => {
      const upstream = await this.#connect(live, moves);
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
          this.#unreconciled(live, upstream);
          await this.#reconcile(live);
        }
      });
    // A tools update is a registration change: one at a time per session, like client resumes.
    const sessionId = params["sessionId"];
    const live = method === "session.tools.set" && typeof sessionId === "string" ? this.#live.get(sessionId) : undefined;
    return live ? this.#registering(live, forward) : forward();
  }

  async #forwardForClient(peer: ClientPeer, method: string, params: Record<string, unknown>, signal: AbortSignal, registration: ToolsRegistration): Promise<unknown> {
    const sessionId = params["sessionId"];
    if (typeof sessionId !== "string") throw unsupportedMethod(method);
    const live = this.#attachedLive(peer, sessionId, method);
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
        platformTools: this.#platformToolsFor(live.environment, placement),
        workingDirectory: this.#workingDirectory(placement, sessionId),
        tokenRegistrationId: live.tokenRegistrationId,
        allowMcp: hasRemoteMcp(this.#ledger.admitted(sessionId)?.params),
      });
      switch (method) {
        case "session.send":
        case "session.sendAndWait":
          // A turn without the client that answers the session's hooks would run unguarded: refuse it.
          this.#assertHooks(live);
          forwarded = { ...admitSend(params, context()), sessionId };
          break;
        case "session.options.update":
          patch = admitOptionsUpdate(params, context());
          forwarded = { ...patch, sessionId };
          break;
        case "session.tools.set": {
          const admitted = admitToolsSet(params, context());
          const declarations = clientDeclarations(admitted.params["tools"], this.#options.platformTools);
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
              registration.change = this.#inventoryChange(live, peer.id, { ...attachment, declarations: registration.before!.declarations }, { tools: declarations, flags: {} }, "tools");
              registration.set = declarations;
              attachment.tools = new Set(admitted.names);
              attachment.declarations = declarations;
            }
            return { ...admitted.params, tools: [...this.#registrations(live, registration.change).tools, ...this.#platformToolDeclarations(live, placement)], sessionId };
          };
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
              const decision = await actions.onClientAnswer({ sessionId, ...this.#incarnationOf(sessionId), connectionId: peer.id, responderKind: peer.kind, method, params });
              if (decision.kind === "respond") return decision.response;
            }
          }
      }
      let result: unknown;
      // The runtime this attempt wrote a tools update to (set in the write step).
      let written: RuntimeUpstream | undefined;
      try {
        result = await this.#onOwner(live, placement, (upstream) => {
          if (build) {
            registration.upstream = upstream;
            written = upstream;
            live.inflight = upstream;
          }
          if (method === "session.sendAndWait") return this.#sendAndWait(live, upstream, forwarded, signal, placement);
          // A tools update is a step of the session's registration path: bounded like a resume, so one the runtime
          // never answers cannot hold the session's later registrations.
          if (build) return this.#bounded(live, upstream, method, () => upstream.request(method, build(), { signal }));
          return upstream.request(method, forwarded, { signal });
        });
      } catch (error) {
        // A cutover moved the session after this call was admitted: admit it again where the session lives now.
        if (error === MOVED) continue;
        // Configuration a cutover interrupted (the source closed the session meanwhile) is set on its owner instead.
        if (live.moves !== moves && CONFIG_METHODS.has(method) && error instanceof RpcError && !signal.aborted) {
          // A tools update the source may have applied before the move does not stay there uncommitted.
          if (written) this.#unreconciled(live, written);
          await this.#fenceLifted(live);
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
        if (written) this.#unreconciled(live, written);
        await this.#fenceLifted(live);
        continue;
      }
      if (patch && Object.keys(patch).length > 0) {
        const requested = withoutSessionId(params);
        this.#persist(sessionId, (stored) => ({ ...stored, optionsPatch: { ...stored.optionsPatch, ...patch }, requestedOptions: { ...stored.requestedOptions, ...requested } }));
        if (typeof patch["model"] === "string") this.#ledger.update(sessionId, { model: patch["model"] });
      }
      if (registration.change) {
        this.#persistInventory(live, peer.id, registration.change);
        registration.stored = true;
      }
      // Restores select the model the session last had.
      if (method === "session.model.switchTo" && typeof params["modelId"] === "string") this.#recordModel(sessionId, params["modelId"]);
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
    if (failure) {
      // The runtime connection was lost under this call: the caller learns that, in plain words, rather than that some
      // internal connection closed (see LOST_ANSWER; a turn the loss cut also ends with its own `session.error`).
      const lost = failure.error instanceof RpcError && (failure.error.data as { code?: unknown } | undefined)?.code === "capability_unavailable";
      if (lost && upstream.closed && !signal.aborted && !wait.fenced) throw new RpcError(-32000, LOST_ANSWER, { code: "capability_unavailable" });
      throw failure.error;
    }
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
    // Connections the gateway closed while stopping: their sessions' state is no longer in use.
    if (this.#stopped) return;
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
    this.#stopped = true;
    for (const live of this.#live.values()) {
      live.ending.abort(new ManagedCopilotError("capability_unavailable", "The gateway is shutting down; try again shortly"));
      if (live.placement === "sandbox") {
        live.upstream?.close();
        live.sandbox?.close?.();
      }
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Operator views: read-only snapshots for the operator console (no credentials, no conversation). Reading them
  // never makes a session resident.

  /** Ledger records of every owner, newest first (interrupted creates left out, as everywhere else). */
  operatorRecords(query: Parameters<SessionLedger["listAll"]>[0] = {}): SessionRecord[] {
    return this.#ledger.listAll(query).filter((record) => !this.#interrupted(record));
  }

  /** The session's stored admitted configuration (credential-free by construction). */
  operatorAdmitted(sessionId: string): AdmittedConfig | undefined {
    return this.#ledger.admitted(sessionId);
  }

  /** What the gateway holds in memory for sessions it has touched since it started (all, or one). */
  operatorLive(sessionId?: string): LiveSessionSnapshot[] {
    const lives = sessionId === undefined ? [...this.#live.values()] : [this.#live.get(sessionId)].filter((live): live is LiveSession => live !== undefined);
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
    parent?: { readonly id: string; readonly incarnation: string } | undefined;
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
    input: {
      principal: Principal;
      environment: ResolvedEnvironment;
      raw: Record<string, unknown>;
      peer: ClientPeer | undefined;
      scheduleId?: string | undefined;
      webhook?: string | undefined;
      clientName?: string | undefined;
      parent?: { readonly id: string; readonly incarnation: string } | undefined;
    },
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
      const registration = registrationOf(admitted.params, this.#options.platformTools);
      const stored: AdmittedConfig = {
        params: storedParams(admitted.params),
        // Without a client, the declarations are the service's own; a client's are its callback registrations.
        ...(input.peer ? {} : { tools: registration.tools }),
        callbacks: applyInventory(undefined, { tools: input.peer ? registration.tools : [], flags: registration.flags, removeTools: [], removeFlags: [] }),
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
        ...(input.parent ? { parentSessionId: input.parent.id, parentIncarnation: input.parent.incarnation } : {}),
      });
      const created = this.#register(record, environment, tokenRegistrationId);
      live = created;
      // The creating principal's verified credential serves the session while it is created (without a client, the
      // runtime asks for one during `session.create`). A session another one starts (an orchestrator's worker) is
      // served by its parent's connected clients instead, checked at every request, so a credential borrowed from a
      // connection never outlives it.
      const presence = Symbol(sessionId);
      if (!input.peer && !input.parent) created.presences.set(presence, principal);
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
        const forwarded = await this.#prepare(created, "session.create", await this.#withVaultHeaders(sessionId, admitted.params, placement));
        // A creating client that disconnected meanwhile is not attached; what it registered stays in the inventory.
        if (input.peer && !input.peer.closed) {
          this.#attach(created, input.peer, admitted, forwarded);
          // The creating client may later withdraw what it registered at create (and only that).
          const attachment = created.attachments.get(input.peer.id)!;
          const revisions = stored.callbacks?.revisions;
          for (const tool of attachment.declarations) {
            const revision = revisions?.tools[String(tool["name"])];
            if (revision !== undefined) attachment.registered.tools[String(tool["name"])] = revision;
          }
          for (const key of WIRE_FLAGS) {
            const revision = revisions?.flags[key];
            if (attachment.flags[key] === true && revision !== undefined) attachment.registered.flags[key] = revision;
          }
        }
        const opened = upstream;
        result = await this.#bounded(created, opened, "session.create", () => opened.request("session.create", forwarded));
        await this.#opened(created, upstream, admitted.optionsPatch);
        created.ready = true;
        return upstream;
      });
      created.presences.delete(presence);
      this.#ledger.update(sessionId, { state: "ready" });
      this.#options.events.emit("session.created", { ownerId: principal.accountId, sessionId, environment: environment.name, data: { placement, type: environment.type, incarnation: record.incarnation } });
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

  /**
   * Sandbox runtimes reach remote MCP servers through the egress proxy, which swaps a vault credential's placeholder
   * for the secret: each admitted server (custom agents' too) gets the placeholder header of a vault credential
   * granted for its URL, replacing a caller header of the same name. Applied whenever params go to a sandbox
   * runtime, so a revoked credential's header disappears; never stored.
   */
  async #withVaultHeaders(sessionId: string, params: Record<string, unknown>, placement: Placement): Promise<Record<string, unknown>> {
    if (placement !== "sandbox") return params;
    const vaults = optionalService<VaultHeaderSource>(this.#options.app.services, "vaults");
    const headersFor = vaults?.mcpHeaders?.bind(vaults);
    if (!headersFor) return params;
    const withHeaders = async (servers: unknown): Promise<unknown> => {
      if (!isRecord(servers)) return servers;
      let changed = false;
      const out: Record<string, unknown> = { ...servers };
      for (const [name, server] of Object.entries(servers)) {
        if (!isRecord(server) || !isRemoteMcp(server)) continue;
        const headers = await headersFor(sessionId, server["url"] as string, "sandbox");
        if (!headers || Object.keys(headers).length === 0) continue;
        const replaced = new Set(Object.keys(headers).map((header) => header.toLowerCase()));
        const own = isRecord(server["headers"]) ? Object.entries(server["headers"]).filter(([header]) => !replaced.has(header.toLowerCase())) : [];
        out[name] = { ...server, headers: { ...Object.fromEntries(own), ...headers } };
        changed = true;
      }
      return changed ? out : servers;
    };
    let result = params;
    const top = await withHeaders(params["mcpServers"]);
    if (top !== params["mcpServers"]) result = { ...result, mcpServers: top };
    const agents = params["customAgents"];
    if (Array.isArray(agents)) {
      const updated = await Promise.all(
        agents.map(async (agent: unknown) => {
          if (!isRecord(agent)) return agent;
          const servers = await withHeaders(agent["mcpServers"]);
          return servers === agent["mcpServers"] ? agent : { ...agent, mcpServers: servers };
        }),
      );
      if (updated.some((agent, index) => agent !== agents[index])) result = { ...result, customAgents: updated };
    }
    return result;
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
    return this.#register(record, environment, `mc-${randomUUID()}`);
  }

  #attachedLive(peer: ClientPeer, sessionId: string, method: string): LiveSession {
    const live = this.#live.get(sessionId);
    if (live?.attachments.has(peer.id) && !live.deleting) return live;
    const record = this.get(sessionId);
    if (!record || record.ownerId !== peer.principal.accountId || record.state === "deleting") throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
    throw new ManagedCopilotError("invalid_request", `Resume session ${sessionId} on this client before calling ${method}`);
  }

  /**
   * Runs one registration change of a session (a client resume, a tools update) at a time. Taken before residency
   * (`#serialize`), never inside it, so it cannot deadlock with a restore.
   */
  async #registering<T>(live: LiveSession, work: () => Promise<T>): Promise<T> {
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
  async #reconcile(live: LiveSession): Promise<void> {
    if (!live.unreconciled || live.deleting || live.cutover?.fenced || this.#live.get(live.id) !== live) return;
    try {
      await this.#resident(live);
    } catch (error) {
      this.#log.warn("Resuming a session again after a failed registration failed; its next request retries", { sessionId: live.id, error: (error as Error).message });
    }
  }

  /** Marks the session as possibly holding a registration that did not commit on `upstream` (see `#reconcile`). */
  #unreconciled(live: LiveSession, upstream: RuntimeUpstream): void {
    if (live.upstream !== upstream) return;
    live.unreconciled = true;
    live.ready = false;
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
    // Still connected (the session needs resuming there, e.g. after a registration that did not commit): reuse it.
    if (live.upstream && !live.upstream.closed) return live.upstream;
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

  /** Resumes the session upstream with its stored configuration and registrations. */
  #restore(live: LiveSession): Promise<RuntimeUpstream> {
    const moves = live.moves;
    return this.#serialize(live, async () => {
      const upstream = await this.#connect(live, moves);
      if (live.moves !== moves) return upstream;
      const admitted = this.#ledger.admitted(live.id);
      if (!admitted) throw new ManagedCopilotError("state_restore_failed", `Session ${live.id} has no stored configuration to resume with`);
      const extras = live.resumeExtras;
      // The session's committed registrations as the gateway owns them, so callbacks stay required with no client
      // attached (a registration still on its way, or one that failed, never reaches a restored runtime).
      const wire = this.#registrations(live, undefined, true);
      const params = await this.#withVaultHeaders(
        live.id,
        {
          ...admitted.params,
          sessionId: live.id,
          tools: [...wire.tools, ...this.#platformToolDeclarations(live)],
          ...wire.flags,
          ...(live.placement === "shared" ? { gitHubTokenProviderRegistrationId: live.tokenRegistrationId } : {}),
          ...this.#resumeExtras(live, admitted.params),
        },
        live.placement,
      );
      const prepared = await this.#prepare(live, "session.resume", params);
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
      // The runtime has the registrations in effect again.
      live.unreconciled = false;
      // A turn the lost connection cut ends before the session takes new work.
      if (live.moves === moves && !live.cutover?.fenced) await this.#settleTurn(live, upstream);
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

  /**
   * Records a model selection: restores and placement changes select it, and a model an earlier option change set no
   * longer overrides it (restores apply option changes after the session's params).
   */
  #recordModel(sessionId: string, model: string): void {
    this.#ledger.update(sessionId, { model });
    this.#persist(sessionId, (stored) => {
      const { model: _patched, ...optionsPatch } = stored.optionsPatch;
      const { model: _requested, ...requestedOptions } = stored.requestedOptions ?? {};
      const { requestedOptions: _previous, ...rest } = stored;
      return { ...rest, params: { ...stored.params, model }, optionsPatch, ...(Object.keys(requestedOptions).length > 0 ? { requestedOptions } : {}) };
    });
  }

  async #openSandbox(live: LiveSession): Promise<RuntimeUpstream> {
    const sandboxes = this.#sandboxes!;
    for (let reopen = 0; ; reopen++) {
      const handle = await sandboxes.openRuntime(live.id, { resolveToken: () => this.#ownerToken(live).then((credential) => credential.token) });
      let upstream: RuntimeUpstream | undefined;
      try {
        upstream = await RuntimeUpstream.open({ id: `sandbox:${live.id}`, kind: "sandbox", sandboxId: live.id }, streamTransport(handle.stream), {
          token: handle.connectionToken,
          handlers: this.#upstreamHandlers,
          log: this.#log,
        });
        const opened = upstream;
        if (handle.initialize) await this.#bounded(live, opened, "the sandbox runtime's setup", () => handle.initialize!((method, params) => opened.request(method, params)));
      } catch (error) {
        upstream?.close();
        handle.close?.();
        if (reopen < MAX_REOPENS && wantsReopen(error)) {
          this.#log.info("The sandbox restarted its runtime; opening it again", { sessionId: live.id });
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
  async #resumeUpstream(live: LiveSession, upstream: RuntimeUpstream, params: Record<string, unknown>): Promise<unknown> {
    // On a source an aborted cutover sealed, what arrives before this resume is answered is still the suspend's
    // handoff; the resumed session's own output follows the answer (verified on runtime 1.0.103).
    const sealed = live.sealedSource?.upstream === upstream ? live.sealedSource : undefined;
    const reopened = () => {
      if (sealed && live.sealedSource === sealed) live.sealedSource = undefined;
    };
    try {
      return await this.#bounded(live, upstream, "session.resume", () => upstream.request("session.resume", params, { onSettle: reopened }));
    } catch (error) {
      // Only for a session that still exists: never one deleted meanwhile (its runtime state is gone on purpose).
      const current = this.get(live.id);
      if (!(error instanceof RpcError) || !UNKNOWN_SESSION.test(error.message) || !current || live.deleting || current.lastTurn) throw error;
      this.#log.info("The runtime has no state for a session that never ran a turn; creating it again", { sessionId: live.id });
      // With the session's model when this resume names none (the runtime would pick its default otherwise).
      const create = params["model"] === undefined && current.model ? { ...params, model: current.model } : params;
      return this.#bounded(live, upstream, "session.create", () => upstream.request("session.create", create));
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
  async #bounded<T>(live: LiveSession, upstream: RuntimeUpstream, step: string, run: () => Promise<T>): Promise<T> {
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
        this.#log.warn("A session's runtime is still working on a step; waiting for its answer", { sessionId: live.id, step, waitedMs: waited });
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
      this.#log.warn("A session's runtime connection stopped responding; closing it so the session connects again", { sessionId: live.id, upstream: upstream.info.id });
      upstream.close();
    }
    return true;
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

  /**
   * Extra params for a resume: an aborted cutover's, and `continuePendingWork` while durable still owns something the
   * runtime may await (otherwise the runtime drops its pending tool calls on resume). A caller's own choice stands.
   */
  #resumeExtras(live: LiveSession, params: Record<string, unknown>): Record<string, unknown> | undefined {
    const extras = live.resumeExtras;
    if (params["continuePendingWork"] !== undefined || extras?.["continuePendingWork"] !== undefined || !this.#hasOpenActions(live.id)) return extras;
    return { ...extras, continuePendingWork: true };
  }

  #hasOpenActions(sessionId: string): boolean {
    const actions = this.#actions as (ActionsService & { hasOpenActions?(sessionId: string, options?: { readonly incarnation?: string }): boolean }) | undefined;
    if (!actions) return false;
    try {
      // This incarnation's: actions an earlier session with the same ID left behind are not this session's work.
      return actions.hasOpenActions ? actions.hasOpenActions(sessionId, this.#incarnationOf(sessionId)) : actions.list(sessionId, { open: true, ...this.#incarnationOf(sessionId) }).length > 0;
    } catch (error) {
      // Continuing pending work that turns out not to exist is harmless; dropping it is not.
      this.#log.warn("Could not check the session's open actions; continuing its pending work", { sessionId, error: (error as Error).message });
      return true;
    }
  }

  #incarnationOf(sessionId: string): { readonly incarnation?: string } {
    const incarnation = this.get(sessionId)?.incarnation;
    return incarnation ? { incarnation } : {};
  }

  // ------------------------------------------------------------------------------------------------------------
  // SDK hooks: one connected client answers them; without it they fail closed

  /** The one attached, connected client that registered the session's hooks. */
  #hooksProvider(live: LiveSession): Attachment | undefined {
    const providers = [...live.attachments.values()].filter((attachment) => attachment.hooks && !attachment.peer.closed);
    return providers.length === 1 ? providers[0] : undefined;
  }

  /** Whether the session has hooks registered (by a connected client, or by one that is away). */
  #hooksRequired(live: LiveSession): boolean {
    return this.#inventory(live).flags["hooks"] === true || [...live.attachments.values()].some((attachment) => attachment.hooks && !attachment.peer.closed);
  }

  /** Refuses work that would run without the session's required hooks, rather than skipping them. */
  #assertHooks(live: LiveSession): void {
    if (this.#hooksRequired(live) && !this.#hooksProvider(live)) throw new ManagedCopilotError("background_callback_unsupported", hooksUnavailable(live.id));
  }

  /**
   * A session has one hooks handler: another connected client cannot register hooks too (its answers would compete),
   * and a client that resumes without hooks needs the handler connected, unless it is the handler withdrawing them.
   */
  #checkHooksRegistration(live: LiveSession, peer: ClientPeer, params: Record<string, unknown>): void {
    const provider = this.#hooksProvider(live);
    if (params["hooks"] === true) {
      if (provider && provider.peer.id !== peer.id) {
        throw new ManagedCopilotError("conflict", `Session ${live.id} already has SDK hooks from another connected client, and a session has one hooks handler. Resume without hooks, or close the other client first.`);
      }
      return;
    }
    if (provider?.peer.id === peer.id) return;
    if (!provider && this.#hooksRequired(live)) throw new ManagedCopilotError("background_callback_unsupported", `${hooksUnavailable(live.id)} A client that resumes with hooks takes them over, and can withdraw them by resuming again without.`);
  }

  /** `hooks.invoke` goes to the session's hooks handler only; without one (or without an answer) it fails closed. */
  async #invokeHook(live: LiveSession, params: Record<string, unknown>, context: IncomingRequestContext): Promise<unknown> {
    const provider = this.#hooksProvider(live);
    if (provider) {
      try {
        return await provider.peer.request("hooks.invoke", this.#scrub(live, params), context.signal);
      } catch (error) {
        this.#log.warn("The session's hooks handler did not answer; the hook fails closed", { sessionId: live.id, hookType: params["hookType"], error: (error as Error).message });
      }
    } else {
      this.#log.warn("No connected client answers the session's hooks; the hook fails closed", { sessionId: live.id, hookType: params["hookType"] });
    }
    return this.#hookClosed(live.id, params, hooksUnavailable(live.id));
  }

  /**
   * The runtime treats an error from `hooks.invoke` as "no output" and carries on (verified on 1.0.103), so a gating
   * hook fails closed with an explicit answer: a denied tool call, a blocked prompt, a withheld tool result. Other
   * hooks have no closing answer; turns that would need them are refused before they start (`#assertHooks`).
   */
  #hookClosed(sessionId: string, params: Record<string, unknown>, reason: string): unknown {
    const hookType = String(params["hookType"] ?? "");
    const closed = FAIL_CLOSED_HOOKS[hookType];
    if (closed) return { output: closed(reason) };
    throw new ManagedCopilotError("background_callback_unsupported", `No connected client answers the ${hookType || "requested"} hook for session ${sessionId}.`);
  }

  async #opened(live: LiveSession, upstream: RuntimeUpstream, optionsPatch: Record<string, unknown>): Promise<void> {
    // Sandboxes install the owner's credential here, then select a requested agent (the runtime resolves agents only
    // for authenticated sessions, so the sandbox module defers `agent` out of create/resume params).
    const sandbox = live.sandbox;
    if (sandbox?.sessionOpened) await this.#bounded(live, upstream, "the session's credential setup", () => sandbox.sessionOpened!(live.id));
    if (Object.keys(optionsPatch).length > 0) {
      const result = await this.#bounded(live, upstream, "session.options.update", () =>
        upstream.request<{ success?: boolean; error?: string }>("session.options.update", { ...optionsPatch, sessionId: live.id }),
      );
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
      // A session being deleted ends with `deleted`, not `stopped`; if its deletion fails, the close is handled then.
      if (live.deleting) live.closedWhileDeleting = true;
      else this.#emitLifecycle(live.id, "stopped");
      // Its running turn cannot finish without this connection (on stock 1.0.103 a sandbox's inference provider goes
      // with it, and a runtime that restarts loses its turns): it ends now, for the clients still waiting on it.
      if (!live.deleting && !live.cutover && !this.#stopped) this.#endLostTurn(live);
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
  #endLostTurn(live: LiveSession, turnId?: string): void {
    void this.#endTurn(live, (record) => (turnId === undefined || record.lastTurn?.turnId === turnId) && this.#lostTurnEnds(live));
  }

  /** Whether a turn whose runtime connection was lost ends: nothing carries it (durable's pending work, an external runtime). */
  #lostTurnEnds(live: LiveSession): boolean {
    if (live.placement === "shared" && this.#options.sharedRuntime?.external) return false;
    return !this.#hasOpenActions(live.id);
  }

  /**
   * After a restore, a turn the ledger has not seen end is checked against the runtime that now owns the session:
   * one it still processes, or whose pending work durable owns and the runtime still awaits, continues; any other ended
   * while the connection was lost. Only answers decide: a check the runtime cannot answer leaves the turn as it is, and
   * a connection that is gone or stopped answering fails the restore (the session's next request tries again). The end
   * applies only while that runtime still owns the session (no cutover moved it meanwhile).
   */
  async #settleTurn(live: LiveSession, upstream: RuntimeUpstream): Promise<void> {
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
    if (live.placement === "shared" && this.#options.sharedRuntime?.external === true) {
      const outcome = await this.#unseenOutcome(live, upstream, turn.turnId);
      if (outcome) await this.#endTurn(live, owned, outcome);
      return;
    }
    await this.#endTurn(live, owned, "interrupted");
  }

  /** A runtime's answer to a check: undefined when it answered with an error; throws when its connection is gone or silent. */
  async #check<T>(live: LiveSession, upstream: RuntimeUpstream, method: string, params: Record<string, unknown> = {}): Promise<T | undefined> {
    try {
      return await this.#bounded(live, upstream, method, () => upstream.request<T>(method, { ...params, sessionId: live.id }));
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
      if (!record || !unfinished(turn) || live.deleting || this.#live.get(live.id) !== live || !applies(record)) return;
      const now = new Date().toISOString();
      if (outcome === "interrupted") {
        this.#log.warn("Ending a turn whose runtime connection was lost", { sessionId: live.id, turnId: turn.turnId });
        const error: RuntimeSessionEvent = { id: randomUUID(), timestamp: now, parentId: null, ephemeral: true, type: "session.error", data: { errorType: "interrupted", message: INTERRUPTED_TURN, originatingMessageId: turn.turnId } };
        await this.#deliverEvent(live, error);
      } else if (typeof outcome === "object") {
        await this.#deliverEvent(live, outcome.error);
      }
      await this.#deliverEvent(live, { id: randomUUID(), timestamp: now, parentId: null, ephemeral: true, type: "session.idle", data: outcome === "cancelled" ? { aborted: true } : {} });
    };
    const ended = live.queue.then(end);
    live.queue = ended.catch((error: unknown) => this.#log.warn("Ending a lost turn failed", { sessionId: live.id, error: (error as Error).message }));
    return live.queue;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Attachments

  #attach(live: LiveSession, peer: ClientPeer, admitted: AdmittedSession, forwarded: Record<string, unknown>): void {
    const flag = (key: string) => forwarded[key] === true;
    const sections = (forwarded["systemMessage"] as { sections?: Record<string, { action?: unknown }> } | undefined)?.sections ?? {};
    const before = live.attachments.get(peer.id);
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
      registered: { tools: { ...before?.registered.tools }, flags: { ...before?.registered.flags } },
    });
    live.creator ??= peer.id;
  }

  /**
   * The runtime scopes tool and handler registrations to the calling connection, and every attached client shares
   * the gateway's one upstream connection. Upstream registrations are therefore the union of the session's callback
   * inventory (what clients registered, kept while they are away), stored server-side declarations, and attached
   * clients, so one client's resume or disconnect never removes another's tools or handlers. `pending` is a
   * registration being made now (applied before it is stored). `committed` leaves attached clients out: every
   * registration that committed is in the inventory, so restores and placement changes register exactly that.
   */
  #registrations(live: LiveSession, pending?: InventoryChange, committed = false): WireSettings {
    const stored = this.#ledger.admitted(live.id);
    const inventory = this.#inventory(live, pending);
    const byName = new Map<string, Record<string, unknown>>();
    for (const tool of stored?.tools ?? []) byName.set(String(tool["name"]), tool);
    for (const tool of inventory.tools) byName.set(String(tool["name"]), tool);
    const ordered = committed ? [] : [...live.attachments.values()].filter((attachment) => !attachment.peer.closed).sort((a, b) => a.attachedAt - b.attachedAt);
    for (const attachment of ordered) for (const tool of attachment.declarations) byName.set(String(tool["name"]), tool);
    // Every handler flag, set or not: one nobody registers any more is turned off on the runtime, not left as it was.
    const flags: Record<string, unknown> = {};
    for (const key of WIRE_FLAGS) flags[key] = inventory.flags[key] === true || ordered.some((attachment) => attachment.flags[key] === true);
    const streaming = ordered.at(-1)?.flags["streaming"];
    if (streaming !== undefined) flags["streaming"] = streaming;
    return { tools: [...byName.values()], flags };
  }

  /** The session's callback inventory: stored, plus `pending` (a registration being made now). */
  #inventory(live: LiveSession, pending?: InventoryChange): CallbackInventory {
    const stored = this.#ledger.admitted(live.id);
    return applyInventory(stored ? inventoryOf(stored) : undefined, pending);
  }

  /** Upstream create/resume/tools params: the aggregate registrations plus the environment's platform tools. */
  #withRegistrations(live: LiveSession, params: Record<string, unknown>, pending?: InventoryChange): Record<string, unknown> {
    const registrations = this.#registrations(live, pending);
    return { ...params, ...registrations.flags, tools: [...registrations.tools, ...this.#platformToolDeclarations(live)] };
  }

  /**
   * What a client's registration changes in the inventory: it adds what the client registers, and withdraws only what
   * this connection itself had registered before and no other attached client registers. What others still register
   * is handed over to them once the change is stored (registration changes of a session run one at a time).
   */
  #inventoryChange(live: LiveSession, peerId: string, previous: Attachment | undefined, next: { readonly tools: readonly Record<string, unknown>[]; readonly flags: Readonly<Record<string, unknown>> }, scope: "all" | "tools" = "all"): InventoryChange {
    const others = [...live.attachments.values()].filter((attachment) => attachment.peer.id !== peerId && !attachment.peer.closed);
    const named = new Set(next.tools.map((tool) => String(tool["name"])));
    const withdrawnTools = (previous?.declarations ?? []).map((tool) => String(tool["name"])).filter((name) => !named.has(name));
    const otherTool = (name: string) => others.some((attachment) => attachment.declarations.some((tool) => tool["name"] === name));
    const toolRevisions = (names: readonly string[]) =>
      names.flatMap((name) => {
        const revision = previous?.registered.tools[name];
        return revision === undefined ? [] : [{ name, revision }];
      });
    const withdrawnFlags = scope === "all" && previous ? WIRE_FLAGS.filter((key) => previous.flags[key] === true && next.flags[key] !== true) : [];
    const otherFlag = (key: string) => others.some((attachment) => attachment.flags[key] === true);
    const flagRevisions = (keys: readonly string[]) =>
      keys.flatMap((key) => {
        const revision = previous?.registered.flags[key];
        return revision === undefined ? [] : [{ key, revision }];
      });
    const handover = { tools: toolRevisions(withdrawnTools.filter(otherTool)), flags: flagRevisions(withdrawnFlags.filter(otherFlag)) };
    return {
      tools: next.tools,
      flags: scope === "all" ? next.flags : {},
      removeTools: toolRevisions(withdrawnTools.filter((name) => !otherTool(name))),
      removeFlags: flagRevisions(withdrawnFlags.filter((key) => !otherFlag(key))),
      ...(handover.tools.length > 0 || handover.flags.length > 0 ? { handover } : {}),
    };
  }

  /**
   * Stores a registration that succeeded. Withdrawals apply only to the registrations they saw (a newer registration of
   * the same tool or flag by another client stays), and the registering attachment learns its revisions. A withdrawn
   * registration other attached clients still make passes to them when it is the stored one.
   */
  #persistInventory(live: LiveSession, peerId: string | undefined, change: InventoryChange): void {
    let applied: CallbackInventory | undefined;
    this.#persist(live.id, (stored) => {
      applied = applyInventory(inventoryOf(stored), change);
      return { ...stored, callbacks: applied };
    });
    if (!applied) return;
    const revisions = applied.revisions;
    for (const { name, revision } of change.handover?.tools ?? []) {
      if (revisions?.tools[name] !== revision) continue;
      for (const other of live.attachments.values()) {
        if (other.peer.id !== peerId && other.declarations.some((tool) => tool["name"] === name)) other.registered.tools[name] = revision;
      }
    }
    for (const { key, revision } of change.handover?.flags ?? []) {
      if (revisions?.flags[key] !== revision) continue;
      for (const other of live.attachments.values()) {
        if (other.peer.id !== peerId && other.flags[key] === true) other.registered.flags[key] = revision;
      }
    }
    const attachment = peerId === undefined ? undefined : live.attachments.get(peerId);
    if (!attachment) return;
    for (const { name } of [...change.removeTools, ...(change.handover?.tools ?? [])]) delete attachment.registered.tools[name];
    for (const { key } of [...change.removeFlags, ...(change.handover?.flags ?? [])]) delete attachment.registered.flags[key];
    for (const tool of change.tools) {
      const revision = revisions?.tools[String(tool["name"])];
      if (revision !== undefined) attachment.registered.tools[String(tool["name"])] = revision;
    }
    for (const key of Object.keys(trueFlags(change.flags))) {
      const revision = revisions?.flags[key];
      if (revision !== undefined) attachment.registered.flags[key] = revision;
    }
  }

  /** Detaches one connection from one session; durable releases only that session's live claims of the connection. */
  #detach(live: LiveSession, peerId: string, notifyActions = true): void {
    live.attachments.delete(peerId);
    // The creating connection's preference passes to an SDK client before an attached CLI.
    if (live.creator === peerId) {
      const remaining = [...live.attachments.values()];
      live.creator = (remaining.find((attachment) => attachment.peer.kind === "sdk") ?? remaining[0])?.peer.id;
    }
    if (notifyActions) this.#actions?.onDetached(peerId, live.id);
  }

  /** Undoes an attach whose resume did not complete: the client keeps the attachment it had before, while connected. */
  #unattach(live: LiveSession, peerId: string, previous: Attachment | undefined): void {
    if (previous && !previous.peer.closed) live.attachments.set(peerId, previous);
    else if (live.attachments.has(peerId)) this.#detach(live, peerId);
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
      const replay = await actions.onAttached({ sessionId, ...this.#incarnationOf(sessionId), ownerId: record.ownerId, environment: record.environment, generation: record.generation, responder });
      // Pending actions can predate a placement change, like history.
      const origin = this.#historyPlacement(live);
      for (const event of replay) peer.notify("session.event", { sessionId, event: this.#scrub(live, this.#sanitizeEvent(live, event, origin), origin) });
    } catch (error) {
      this.#log.warn("Action replay after attach failed", { sessionId, error: (error as Error).message });
    }
  }

  /** Responder preference among connected attachments: the creating connection first, then the others by attach time. */
  #preferred(live: LiveSession): Attachment[] {
    return [...live.attachments.values()]
      .filter((attachment) => !attachment.peer.closed)
      .sort((a, b) => (a.peer.id === live.creator ? -1 : b.peer.id === live.creator ? 1 : a.attachedAt - b.attachedAt));
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
      return actions.onSessionEvent({ sessionId: live.id, ...this.#incarnationOf(live.id), ownerId: record.ownerId, environment: record.environment, generation: generation ?? record.generation, event, attached: this.#responders(live) });
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
      await this.request(live.id, "session.tools.handlePendingToolCall", answer, pinned(record));
    } catch (error) {
      this.#log.warn("Could not answer platform tool call", { sessionId: live.id, tool: name, error: (error as Error).message });
    }
  }

  async #onUpstreamRequest(upstream: RuntimeUpstream, method: string, params: unknown, context: IncomingRequestContext): Promise<unknown> {
    const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId;
    const live = typeof sessionId === "string" ? this.#live.get(sessionId) : undefined;
    const destination = live?.cutover?.destination?.upstream === upstream ? live.cutover.destination : undefined;
    const stale = live !== undefined && live.upstream !== upstream && live.residency === undefined && !destination;
    // The runtime carries on after an error from hooks.invoke, so a hook nobody may answer gets the closed answer.
    if (method === "hooks.invoke") {
      const body = (params ?? {}) as Record<string, unknown>;
      const id = typeof sessionId === "string" ? sessionId : "(unknown)";
      if (!live) return this.#hookClosed(id, body, `Session ${id} is not running on this runtime.`);
      if (stale || (live.cutover?.fenced && upstream === live.cutover.source) || live.sealedSource?.upstream === upstream) {
        return this.#hookClosed(id, body, `Session ${id} is moving to another runtime.`);
      }
      return this.#invokeHook(live, body, context);
    }
    if (stale) throw new RpcError(-32000, "Stale runtime connection", { code: "conflict" });
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
      if (!target) throw new ManagedCopilotError("background_callback_unsupported", `No connected client can answer ${method} for session ${live.id}`);
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
    // Only for a shared session the runtime still hosts: not one that moved into its sandbox or is being deleted.
    if (live.placement !== "shared" || live.deleting) {
      this.#log.warn("Refusing a GitHub token request for a session the shared runtime no longer hosts", { sessionId: live.id });
      return { kind: "cancelled" };
    }
    if (request.host && !/^https:\/\/github\.com\/?$/i.test(request.host)) {
      this.#log.warn("Refusing a GitHub token request for an unsupported host", { sessionId: live.id, host: request.host });
      return { kind: "cancelled" };
    }
    try {
      const credential = await this.#ownerToken(live);
      const remaining = credential.expiresAt ? Math.floor((credential.expiresAt - Date.now()) / 1000) : TOKEN_LEASE_SECONDS;
      // The runtime asks again only once a token is within an hour of expiry (a cancelled refresh fails its next model
      // call, verified on 1.0.103), so answers stay short and the gateway decides again every few minutes.
      return { kind: "token", accessToken: credential.token, tokenType: "bearer", expiresIn: Math.min(remaining, TOKEN_LEASE_SECONDS) };
    } catch (error) {
      this.#log.warn("No credential available for session owner", { sessionId: live.id, error: (error as Error).message });
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
  async #ownerToken(live: LiveSession): Promise<{ token: string; expiresAt?: number }> {
    const auth = this.#options.auth;
    const parent = this.#credentialParent(live);
    // Each candidate must still be connected (or present) once its verification finishes.
    const present: { readonly principal: Principal; readonly current: () => boolean; readonly background: boolean }[] = [];
    for (const source of parent ? [live, parent] : [live]) {
      const usable = () => !source.deleting && (source === live || this.#credentialParent(live) === source);
      present.push(
        ...this.#preferred(source).map((attachment) => ({ principal: attachment.peer.principal, current: () => usable() && source.attachments.get(attachment.peer.id) === attachment && !attachment.peer.closed, background: false })),
        ...[...source.presences.entries()].map(([key, principal]) => ({ principal, current: () => usable() && source.presences.get(key) === principal, background: true })),
      );
    }
    for (const { principal, current, background } of present) {
      if (principal.accountId !== live.ownerId) continue;
      try {
        const verified = await auth.authenticate(principal.token, { background });
        if (verified.accountId !== live.ownerId || !current() || live.deleting) continue;
        const expiresAt = auth.tokenExpiration(principal.token);
        return { token: principal.token, ...(expiresAt !== undefined ? { expiresAt } : {}) };
      } catch (error) {
        this.#log.debug("A connected client's credential could not be used for the session", { sessionId: live.id, error: (error as Error).message });
      }
    }
    const credentials = this.#options.app.services.credentials;
    if (credentials) {
      const principal = await credentials.principalFor(live.ownerId);
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
    const record = this.#ledger.get(live.id);
    if (!record?.parentSessionId) return undefined;
    const parent = this.#live.get(record.parentSessionId);
    if (!parent || parent === live || parent.deleting || parent.ownerId !== live.ownerId) return undefined;
    if (this.get(record.parentSessionId)?.incarnation !== record.parentIncarnation) return undefined;
    return parent;
  }

  presence(sessionId: string, principal: Principal): () => void {
    this.getOwned(principal.accountId, sessionId);
    const live = this.#liveFor(sessionId);
    const key = Symbol(sessionId);
    live.presences.set(key, principal);
    return () => {
      live.presences.delete(key);
    };
  }

  async ownerPrincipal(sessionId: string): Promise<Principal> {
    const live = this.#liveFor(sessionId);
    const credential = await this.#ownerToken(live);
    // Background: work the platform does for the owner never becomes the account's live credential.
    const principal = await this.#options.auth.authenticate(credential.token, { background: true });
    if (principal.accountId !== live.ownerId) throw new ManagedCopilotError("authentication_required", "The session's credential belongs to another account");
    return principal;
  }

  async attachCli(accountId: number, sessionId: string, options: CliAttachOptions): Promise<CliAttachment> {
    const record = this.getOwned(accountId, sessionId);
    if (options.principal && options.principal.accountId !== accountId) throw new ManagedCopilotError("forbidden", "The attached CLI's credential belongs to another account");
    const live = this.#liveFor(sessionId);
    const busy = () => new ManagedCopilotError("session_busy", `Session ${sessionId} is moving into a sandbox. Attach again when the move finishes.`, { sessionId });
    if (live.cutover?.fenced) throw busy();
    // The CLI's own credential serves a restore this attach needs (a stopped sandbox gets the owner's credential).
    const release = options.principal ? this.presence(sessionId, options.principal) : undefined;
    let upstream: RuntimeUpstream;
    try {
      upstream = await this.#resident(live);
    } finally {
      release?.();
    }
    const current = this.get(sessionId);
    if (!current || current.incarnation !== record.incarnation || live.deleting || this.#live.get(sessionId) !== live) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
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
      transforms: false,
      canvases: false,
      declarations: [],
      flags: {},
      registered: { tools: {}, flags: {} },
    });
    // The CLI's operations apply only to what it attached to: never queued into another runtime or incarnation.
    const owned = (): void => {
      if (closed) throw new ManagedCopilotError("conflict", "This Copilot CLI attachment was closed. Attach again.");
      if (live.deleting || this.#live.get(sessionId) !== live || this.get(sessionId)?.incarnation !== pinned.incarnation) {
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
            this.#assertHooks(live);
            const latest = this.get(sessionId)!;
            admitSend(
              { prompt: operation.text },
              {
                environment: live.environment,
                placement: live.placement,
                network: latest.network,
                platformTools: this.#platformToolsFor(live.environment, live.placement),
                workingDirectory: this.#workingDirectory(live.placement, sessionId),
                tokenRegistrationId: live.tokenRegistrationId,
              },
            );
            send();
            return;
          }
          case "model":
            checkModel(live.environment, operation.modelId);
            send();
            // Restores select the model the session last had.
            this.#recordModel(sessionId, operation.modelId);
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
        const actions = this.#actions;
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
        if (live.attachments.get(peer.id)?.peer === peer) this.#detach(live, peer.id);
      },
    };
  }

  // ------------------------------------------------------------------------------------------------------------
  // Ledger tracking and sanitization

  #track(live: LiveSession, event: RuntimeSessionEvent): void {
    const data = event.data ?? {};
    try {
      // A session being deleted keeps that state (startup recovery finishes deletions by it), whatever events still
      // arrive for it, such as those a cutover the deletion aborted flushes.
      const state = (next: "running" | "idle") => (live.deleting ? {} : { state: next });
      switch (event.type) {
        case "user.message":
          if (!event.agentId) {
            this.#ledger.update(live.id, { ...state("running"), lastTurn: { turnId: String(data["messageId"] ?? event.id), status: "running" } });
          }
          break;
        case "session.idle": {
          if (event.agentId) break;
          const record = this.get(live.id);
          const turn = record?.lastTurn;
          const status = data["aborted"] === true ? "cancelled" : turn?.status === "failed" ? "failed" : "completed";
          // A session whose deletion failed stays failed (deletable again) when a turn ends, until it runs another.
          const next = record?.state === "failed" ? {} : state("idle");
          this.#ledger.update(live.id, { ...next, ...(turn ? { lastTurn: { turnId: turn.turnId, status, completedAt: new Date().toISOString() } } : {}) });
          if (record) this.#options.events.emit("session.idle", { ownerId: record.ownerId, sessionId: live.id, environment: record.environment, data: { status, incarnation: record.incarnation } });
          break;
        }
        case "session.error": {
          const record = this.get(live.id);
          if (record?.lastTurn) this.#ledger.update(live.id, { lastTurn: { ...record.lastTurn, status: "failed" } });
          if (record) this.#options.events.emit("session.failed", { ownerId: record.ownerId, sessionId: live.id, environment: record.environment, data: { message: String(data["message"] ?? "Session error"), incarnation: record.incarnation } });
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

function hooksUnavailable(sessionId: string): string {
  return `Session ${sessionId} has SDK hooks (such as onPreToolUse) that no connected client answers right now, so it does not run work that would skip them. Resume it from the client that registers its hooks.`;
}

/** A record's incarnation, for durable inputs that are scoped to it. */
function pinned(record: SessionRecord): { readonly incarnation?: string } {
  return record.incarnation ? { incarnation: record.incarnation } : {};
}

/**
 * The sandbox restarted its runtime and asks for it to be opened again (`details.reopen`): stock 1.0.103 keeps the
 * inference-provider registration of a closed connection forever, so a runtime a lost connection served can only
 * serve a new one after a restart.
 */
function wantsReopen(error: unknown): boolean {
  return isManagedCopilotError(error) && error.details?.["reopen"] === true;
}

/** `60 s`, `0.3 s`. */
function duration(ms: number): string {
  return `${ms % 1000 === 0 ? ms / 1000 : (ms / 1000).toFixed(1)} s`;
}

/** A session's callback inventory; sessions stored before it existed always asked for permission decisions. */
function inventoryOf(stored: AdmittedConfig): CallbackInventory {
  return stored.callbacks ?? { tools: [], flags: { requestPermission: true } };
}

function applyInventory(base: CallbackInventory | undefined, change: InventoryChange | undefined): CallbackInventory {
  const tools = new Map((base?.tools ?? []).map((tool) => [String(tool["name"]), tool] as const));
  const flags: Record<string, true> = { ...base?.flags };
  const revisions = { tools: { ...base?.revisions?.tools }, flags: { ...base?.revisions?.flags } };
  let revision = base?.revision ?? 0;
  if (change) {
    for (const { name, revision: seen } of change.removeTools) {
      if (revisions.tools[name] !== seen) continue;
      tools.delete(name);
      delete revisions.tools[name];
    }
    for (const { key, revision: seen } of change.removeFlags) {
      if (revisions.flags[key] !== seen) continue;
      delete flags[key];
      delete revisions.flags[key];
    }
    const added = trueFlags(change.flags);
    if (change.tools.length > 0 || Object.keys(added).length > 0) {
      revision += 1;
      for (const tool of change.tools) {
        tools.set(String(tool["name"]), tool);
        revisions.tools[String(tool["name"])] = revision;
      }
      for (const key of Object.keys(added)) {
        flags[key] = true;
        revisions.flags[key] = revision;
      }
    }
  }
  return { tools: [...tools.values()], flags, revisions, revision };
}

/** The registration in create/resume params: the client's tool declarations (no platform tools) and handler flags. */
function registrationOf(params: Record<string, unknown>, platformTools: PlatformToolRegistry): { tools: Record<string, unknown>[]; flags: Record<string, unknown> } {
  return { tools: clientDeclarations(params["tools"], platformTools), flags: Object.fromEntries(WIRE_FLAGS.filter((key) => params[key] !== undefined).map((key) => [key, params[key]])) };
}

function clientDeclarations(tools: unknown, platformTools: PlatformToolRegistry): Record<string, unknown>[] {
  return ((Array.isArray(tools) ? tools : []) as Record<string, unknown>[]).filter((tool) => !platformTools.has(String(tool["name"])));
}

function trueFlags(flags: Readonly<Record<string, unknown>>): Record<string, true> {
  const out: Record<string, true> = {};
  for (const key of WIRE_FLAGS) if (flags[key] === true) out[key] = true;
  return out;
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
