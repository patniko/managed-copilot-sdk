// Owner: promotion/attach workstream. One-way promotion into a sandbox (spec section 9).
import type { PromoteResult } from "@managed-copilot/protocol";
import { notImplemented } from "../connection.js";
import type { ManagedContext } from "../types.js";

export async function promoteSession(_ctx: ManagedContext, _sessionId: string): Promise<PromoteResult> {
  return notImplemented("managed.promote()");
}
