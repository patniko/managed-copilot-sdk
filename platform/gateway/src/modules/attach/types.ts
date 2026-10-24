import type { Duplex } from "node:stream";
import type { SessionInfo } from "@managed-copilot/protocol";

/**
 * The members of core's `sessions` service that attach uses (recorded in docs/architecture.md). Declared locally so
 * this module type-checks against any `sessions` provider that has at least these members.
 */
export interface AttachSessions {
  /** Owner-scoped lookup; throws `not_found` unless `accountId` owns the session. */
  info(accountId: number, sessionId: string): Promise<SessionInfo>;
  /** The upstream runtime the session is resident on now (shared runtime or its sandbox). */
  runtime(sessionId: string): Promise<SessionRuntime>;
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
