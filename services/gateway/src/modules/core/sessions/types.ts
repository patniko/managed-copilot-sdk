// The session manager's types: client peers and attachments, live session state, and operator snapshots.
import type { Placement, SessionState } from "@managed-copilot/protocol";
import type { GatewayApp } from "../../../app.js";
import type { Principal } from "../../../http.js";
import type { Logger } from "../../../log.js";
import type { RuntimeSessionEvent } from "../../durable/contract.js";
import type { AdmittedSession } from "../admission.js";
import type { GitHubAuthenticator } from "../auth.js";
import type {
  PlatformToolRegistry,
  ResolvedEnvironment,
  RuntimeRequestRegistry,
  SandboxRuntimeHandle,
} from "../contracts.js";
import type { Environments } from "../environments.js";
import type { PlatformEvents } from "../events.js";
import type { SessionLedger } from "../ledger.js";
import { RpcError } from "../rpc.js";
import { RuntimeUpstream, type SharedRuntime } from "../runtime.js";

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

export interface Attachment {
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
  /** Stores the session's memories (`memory.storeMemory`): the runtime's `memoryStore.store` goes to this client. */
  memoryStore: boolean;
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

/** A client's `session.tools.set` in progress: its registration before the call, and what the call set. */
export interface ToolsRegistration {
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
export interface WireSettings {
  tools: Record<string, unknown>[];
  flags: Record<string, unknown>;
}

/** What one registration (create, resume, `tools.set`) changes in a session's persisted callback inventory. */
export interface InventoryChange {
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

/** Where a session's model calls go instead of its owner's Copilot plan: a Foundry account's deployment, or an endpoint's model. */
export interface InferenceRoute {
  readonly kind: "foundry" | "openai";
  /** The Foundry account or the OpenAI-compatible endpoint. */
  readonly name: string;
  /** The Foundry deployment or the endpoint's model. */
  readonly model: string;
}

export interface LiveSession {
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
  /** Platform tool calls core runs itself (no actions ledger), by runtime request ID: aborted when the runtime stops waiting. */
  readonly platformCalls: Map<string, AbortController>;
}

export interface InflightWait {
  fenced: boolean;
  readonly signal: AbortSignal;
  /** Set at the seal: the call completes from the owner's events unless the source's reply shows its turn ended. */
  held: HeldCompletion | undefined;
}

/** A `sendAndWait` that a seal caught in flight, completed like the stock request-owned completion by the owner. */
export interface HeldCompletion {
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

export interface CutoverState {
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
export interface NotificationOrigin {
  readonly generation: number;
  readonly placement: Placement;
  /** Emitted by the source before the seal: it never completes a call the seal caught. */
  readonly beforeSeal?: boolean;
}

/**
 * How core ends a running turn whose runtime cannot (`#endTurn`): interrupted by a lost connection, or as a runtime
 * that ran it unseen recorded it (completed, cancelled, or its own `session.error`).
 */
export type TurnEnding = "interrupted" | "completed" | "cancelled" | { readonly error: RuntimeSessionEvent };

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
