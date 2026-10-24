import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { snippet } from "./harness.js";

export default snippet(import.meta.url, { title: "Promotable: start cheap, move when needed", section: "spec §9", requires: ["promotion", "artifacts"], timeoutMs: 20 * 60_000 }, async (t) => {
  const managed = await ManagedCopilot.connect();
  t.cleanup(() => managed.close());
  const promoted: string[] = [];

  managed.on("session.promoted", (e) => console.log(`${e.sessionId} moved to sandbox ${String(e.data.sandboxId)}`));
  managed.on("session.promoted", (e) => void promoted.push(e.sessionId ?? ""));

  const client = await managed.client("helper");
  const session = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
  t.cleanup(() => client.deleteSession(session.sessionId));

  // Starts on shared placement.
  await session.sendAndWait({ prompt: "What does a CSV header row usually contain?" }, 5 * 60_000);
  const before = await managed.sessions.get(session.sessionId);

  // Needs a shell: promotion goes through the session's permission policy before allocation.
  await session.sendAndWait({ prompt: "Use Python to calculate the sum of 10, 20, and 30 and save outputs/summary.json" }, 15 * 60_000);

  // Acceptance checks
  const after = await managed.sessions.get(session.sessionId);
  t.check(before.placement === "shared", "the session started on shared placement");
  t.check(after.placement === "sandbox" && after.id === session.sessionId, `the same session moved into sandbox ${after.sandbox?.id}`);
  t.check(promoted.includes(session.sessionId), "managed.on('session.promoted') fired");
  const summary = await managed.artifacts(session).read("summary.json");
  t.check(summary.includes("60"), "the continued work wrote outputs/summary.json with 60");
});
