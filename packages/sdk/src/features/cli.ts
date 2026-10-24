// Owner: devloop workstream. Runs Copilot CLI attached to the live session (spec section 14).
import { notImplemented } from "../connection.js";
import type { ManagedContext, OpenCliOptions } from "../types.js";

/** Resolves with the CLI's exit code. */
export async function openCli(_ctx: ManagedContext, _sessionId: string, _options?: OpenCliOptions): Promise<number> {
  return notImplemented("managed.openCli()");
}
