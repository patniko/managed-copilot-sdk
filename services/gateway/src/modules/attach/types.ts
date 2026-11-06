import type { Duplex } from "node:stream";
import type { PendingAction, SessionInfo } from "@managed-copilot/protocol";
import type { Principal } from "../../http.js";
import type { CliAttachment, CliAttachOptions } from "../core/contracts.js";
import type { AttachedResponder } from "../durable/contract.js";

export type { CliAttachment, CliAttachOptions, CliOperation } from "../core/contracts.js";

/** The fields of core's session record attach checks (`SessionRecord`). */
export interface AttachSessionRecord {
  readonly incarnation: string;
  readonly type: string;
  readonly placement: string;
  readonly state: string;
  readonly generation: number;
}

/**
 * The members of core's `sessions` service that attach uses (recorded in docs/architecture.md). Declared locally so
 * this module type-checks against any `sessions` provider that has at least these members.
 */
export interface AttachSessions {
  /** Owner-scoped lookup; throws `not_found` unless `accountId` owns the session. */
  info(accountId: number, sessionId: string): Promise<SessionInfo>;
  /** The upstream runtime the session is resident on now (shared runtime or its sandbox). */
  runtime(sessionId: string): Promise<SessionRuntime>;
  get?(sessionId: string): AttachSessionRecord | undefined;
  /** Set for a shared session with `unsafeHostTools`, whose frames keep raw host paths (core). */
  hostWorkspace?(record: AttachSessionRecord): string | undefined;
  /** Registers an attached Copilot CLI as a `cli` responder and gates its writes and answers (core). */
  attachCli?(accountId: number, sessionId: string, options: CliAttachOptions): Promise<CliAttachment>;
  /** Keeps the owner's verified `principal` serving the session's credential until the returned release (core). */
  presence?(sessionId: string, principal: Principal): () => void;
  onLifecycle?(listener: (event: SessionLifecycleEvent) => void): () => void;
}

export interface SessionLifecycleEvent {
  readonly sessionId: string;
  readonly type: "deleted" | "promoted" | "stopped";
}

export interface SessionRuntime {
  /** Changes whenever the upstream connection is replaced (runtime restart, promotion). */
  readonly connectionId: string;
  /** Connection-level JSON-RPC request on the upstream connection that owns the session. */
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  /** TCP stream to `127.0.0.1:<port>` in the runtime's network namespace. */
  connect(port: number): Promise<Duplex>;
  /** Resolves when the upstream connection closes; AHP hosts end with it. */
  readonly closed: Promise<void>;
}

/** Durable's answer to whether an attached CLI may act on a prompt it was shown (`actions.promptVisibility`). */
export type PromptVisibility =
  | { readonly status: "actionable"; readonly actionId: string }
  | { readonly status: "observe"; readonly actionId: string; readonly state: string; readonly claimedBy?: string }
  | { readonly status: "hidden"; readonly reason: string };

export interface PromptVisibilityInput {
  readonly sessionId: string;
  readonly incarnation: string;
  readonly generation: number;
  readonly responder: AttachedResponder;
  readonly kind: "permission" | "elicitation";
  readonly requestId: string;
  readonly waitMs?: number;
}

/** The actions ledger as attach uses it (durable's `actions`). */
export interface AttachActions {
  list(sessionId: string, options?: { readonly open?: boolean }): readonly PendingAction[];
  /** Claims a waiting prompt for the CLI, or says who holds it; resolves once the ledger has recorded the request. */
  promptVisibility?(input: PromptVisibilityInput): Promise<PromptVisibility>;
}
