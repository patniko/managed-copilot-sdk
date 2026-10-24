import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { snippet } from "./harness.js";

export default snippet(import.meta.url, { title: "Isolated: a coding agent in its own sandbox", section: "spec §4", requires: ["isolated", "artifacts"], timeoutMs: 25 * 60_000 }, async (t) => {
  const managed = await ManagedCopilot.connect();
  t.cleanup(() => managed.close());

  const client = await managed.client("coder");

  // Each session gets its own fresh sandbox.
  const session = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
  t.cleanup(() => client.deleteSession(session.sessionId));
  await session.sendAndWait(
    { prompt: "Clone https://github.com/microsoft/aspire, count the *.cs files per top-level folder, and save outputs/report.md" },
    20 * 60_000,
  );

  const artifacts = managed.artifacts(session);
  await artifacts.waitForPublication(); // the completed turn's outputs, not just runtime idleness
  const report = await artifacts.read("report.md");
  console.log(report);

  const info = await managed.sessions.get(session.sessionId);
  console.log(info.sandbox); // { id: "sbx_7f3a…", size: "medium", state: "running" }

  // Acceptance checks
  t.check(info.placement === "sandbox" && Boolean(info.sandbox?.id), `the session runs in sandbox ${info.sandbox?.id}`);
  t.check(/\d/.test(report) && report.length > 20, "outputs/report.md was published with per-folder counts");
  const second = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
  t.cleanup(() => client.deleteSession(second.sessionId));
  const secondInfo = await managed.sessions.get(second.sessionId);
  t.check(secondInfo.sandbox?.id !== undefined && secondInfo.sandbox.id !== info.sandbox?.id, "one client's next session gets a different sandbox");
});
