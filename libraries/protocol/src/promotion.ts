/**
 * Promotion (spec section 9): a promotable session moves once, from shared placement into its own sandbox, keeping
 * its session ID and history. `managed.promote(session)` (`POST ROUTES.promote`) returns a `PromoteResult`; the agent
 * can ask for the same move with the `request_sandbox` platform tool; both publish `session.promoted`.
 */
import type { NetworkPolicy } from "./network.js";

/** What started a promotion: `managed.promote()` / REST (`api`), or the agent's `request_sandbox` tool (`tool`). */
export type PromotionTrigger = "api" | "tool";

/**
 * `data` of the `session.promoted` platform event. The event's top-level `sessionId` and `sandboxId` identify the
 * session and its new sandbox (`managed.on("session.promoted", (e) => console.log(e.sessionId, e.sandboxId))`).
 */
export interface SessionPromotedData {
  /** The placement generation the session runs under now. The previous owner is fenced. */
  readonly generation: number;
  readonly placement: "sandbox";
  /** The isolated environment that supplied the sandbox (the promotable environment's `promoteTo`). */
  readonly target: string;
  readonly trigger: PromotionTrigger;
  /** Agent-initiated promotions: the `request_sandbox` tool call whose turn continues in the sandbox. */
  readonly toolCallId?: string;
  /** The sandbox's effective network policy: the session's policy narrowed by the target, never broader. */
  readonly network: NetworkPolicy;
  readonly durationMs: number;
}
