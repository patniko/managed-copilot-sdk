import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { snippet } from "./harness.js";
import { lookupOrder, lookups } from "./orders.js";

export default snippet(import.meta.url, { title: "Come back later", section: "spec §11", requires: ["shared"], timeoutMs: 6 * 60_000 }, async (t) => {
  // Earlier, in another process: start a session and leave.
  const earlier = await ManagedCopilot.connect();
  const started = await earlier.createSession({ environment: "chat", model: "claude-sonnet-5", tools: [lookupOrder], onPermissionRequest: approveAll });
  await started.sendAndWait({ prompt: "I'll ask about order 5678 later. Just reply: noted." }, 5 * 60_000);
  const sessionId = started.sessionId;
  await earlier.close(); // detaches this process; it does not delete sessions or cancel accepted work
  lookups.length = 0;

  const managed = await ManagedCopilot.connect();
  t.cleanup(() => managed.close());
  t.cleanup(() => managed.sessions.delete(sessionId));

  // The platform resolves placement and restores the supported state for this owner.
  const session = await managed.resumeSession(sessionId, { tools: [lookupOrder], onPermissionRequest: approveAll });

  for (const s of await managed.sessions.list()) {
    console.log(s.id, s.environment, s.placement, s.updatedAt); // placement is "shared" or "sandbox"
  }

  // Acceptance checks
  const listed = (await managed.sessions.list()).find((s) => s.id === sessionId);
  t.check(listed?.environment === "chat", "sessions.list() shows the earlier session");
  const reply = await session.sendAndWait({ prompt: "Which order did I mention earlier? Look it up and tell me its status." }, 5 * 60_000);
  t.check(session.sessionId === sessionId, "resumeSession() returns the same session");
  t.check(lookups.includes("5678"), "the re-registered tool ran in this process after resume");
  t.check(/processing/i.test(reply?.data.content ?? ""), "the resumed session remembered the conversation");
});
