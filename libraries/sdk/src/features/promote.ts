// Owner: promotion workstream. One-way promotion into a sandbox (spec section 9).
import { ROUTES, type PromoteResult } from "@managed-copilot/protocol";
import type { ManagedContext } from "../types.js";

/** The gateway answers once the sandbox is ready, which includes preparing its image and setup on first use. */
const PROMOTE_TIMEOUT_MS = 10 * 60_000;

/**
 * Moves an idle promotable session from shared placement into its own sandbox, keeping the session ID, history, and
 * every attached `CopilotSession` object. Idempotent: an already promoted session returns its sandbox. Fails with
 * `session_busy` while a turn runs and `promotion_busy` while another move of the session is in progress.
 */
export async function promoteSession(ctx: ManagedContext, sessionId: string): Promise<PromoteResult> {
  return ctx.httpFor(sessionId).post<PromoteResult>(ROUTES.promote(sessionId), undefined, { timeoutMs: PROMOTE_TIMEOUT_MS });
}
