// Owner: durable workstream. Claim-then-answer for pending actions (spec section 12, "One owner for each action").
import type { HandleActionResult } from "@managed-copilot/protocol";
import { notImplemented } from "../connection.js";
import type { ActionHandlers, ManagedContext } from "../types.js";

export async function handleSessionActions(_ctx: ManagedContext, _sessionId: string, _handlers: ActionHandlers): Promise<HandleActionResult[]> {
  return notImplemented("managed.sessions.handleActions()");
}
