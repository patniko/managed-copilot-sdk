import { approveAll, CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { snippet } from "./harness.js";

export default snippet(import.meta.url, { title: "The idea in one snippet", section: "spec: The idea in one snippet", requires: ["shared"], timeoutMs: 12 * 60_000 }, async (t) => {
  const managed = await ManagedCopilot.connect(); // your local `aspire run`, or your Azure deployment
  t.cleanup(() => managed.close());
  const client = await managed.client("chat"); // a CopilotClient for the "chat" environment

  const session = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
  const reply = await session.sendAndWait({ prompt: "Summarize what changed in Aspire 13" }, 10 * 60_000);
  console.log(reply?.data.content);

  // For a one-off session, a single call picks the environment and creates the session:
  const oneOff = await managed.createSession({ environment: "chat", model: "claude-sonnet-5", onPermissionRequest: approveAll });

  // Acceptance checks
  t.cleanup(() => client.deleteSession(session.sessionId));
  t.cleanup(() => client.deleteSession(oneOff.sessionId));
  t.check(client instanceof CopilotClient, "managed.client() returns a genuine CopilotClient");
  t.check(session instanceof CopilotSession, "client.createSession() returns a genuine CopilotSession");
  t.check(Boolean(reply?.data.content?.trim()), "the agent answered from the managed runtime");
  t.check(oneOff instanceof CopilotSession && oneOff.sessionId !== session.sessionId, "managed.createSession() creates its own session in one call");
  const info = await managed.sessions.get(session.sessionId);
  t.check(info.environment === "chat" && info.placement === "shared" && info.owner.id === managed.account.id, `the session is owned by @${managed.account.login} on shared placement`);
});
