import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { eventually, snippet } from "./harness.js";
import { lookupOrder, lookups } from "./orders.js";

export default snippet(import.meta.url, { title: "Keep working while your app is offline: polling", section: "spec §12", requires: ["actions"], timeoutMs: 6 * 60_000 }, async (t) => {
  // An app starts work, then goes away before its tool is called.
  const app = await ManagedCopilot.connect();
  const started = await app.createSession({ environment: "chat", model: "claude-sonnet-5", tools: [lookupOrder], onPermissionRequest: approveAll });
  const sessionId = started.sessionId;
  await started.send({ prompt: "Look up order 1234 and tell me its status" });
  await app.close();
  lookups.length = 0;

  const managed = await ManagedCopilot.connect();
  t.cleanup(() => managed.close());
  t.cleanup(() => managed.sessions.delete(sessionId));
  await eventually(async () => (await managed.sessions.get(sessionId)).pendingActions.some((action) => action.tool === "lookup_order"), {
    what: "the lookup_order action to wait for a responder",
  });

  const { pendingActions } = await managed.sessions.get(sessionId);
  console.log(pendingActions.map(({ id, kind, tool, state, arguments: args }) => ({ id, kind, tool, state, arguments: args })));
  // [{ id: "...", kind: "tool", tool: "lookup_order", state: "pending", arguments: { id: "1234" } }]
  await managed.sessions.handleActions(sessionId, {
    tools: [lookupOrder],
    onPermissionRequest: approveAll,
  });

  // Acceptance checks
  t.check(lookups.includes("1234"), "handleActions claimed the action and ran lookup_order in this process");
  const done = await eventually(async () => {
    const info = await managed.sessions.get(sessionId);
    return info.lastTurn?.status === "completed" ? info : undefined;
  }, { what: "the turn to complete" });
  t.check(done.pendingActions.length === 0, "nothing is left waiting");
  const again = await managed.sessions.handleActions(sessionId, { tools: [lookupOrder], onPermissionRequest: approveAll });
  t.check(again.length === 0 && lookups.filter((id) => id === "1234").length === 1, "polling again never executes the tool a second time");
});
