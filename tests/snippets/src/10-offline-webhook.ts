import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { eventually, snippet } from "./harness.js";
import { lookupOrder, lookups } from "./orders.js";
import { startWebhookReceiver } from "./webhook-receiver.js";

export default snippet(import.meta.url, { title: "Keep working while your app is offline: webhook", section: "spec §12", requires: ["actions", "webhooks"], timeoutMs: 6 * 60_000 }, async (t) => {
  const secret = process.env.COPILOT_WEBHOOK_SECRET;
  if (!secret) return t.skip("Needs the AppHost's snippets webhook secret: start snippets from the Aspire dashboard, or set COPILOT_WEBHOOK_SECRET.");
  const receiver = await startWebhookReceiver(secret);
  t.cleanup(() => receiver.close());

  const managed = await ManagedCopilot.connect();
  const client = await managed.client("webhook-examples");
  const session = await client.createSession({ model: "claude-sonnet-5", tools: [lookupOrder], onPermissionRequest: approveAll });
  const sessionId = session.sessionId;
  lookups.length = 0;

  await session.send({ prompt: "Look up order 1234 and tell me its status" }); // durable admission before acknowledgment
  await managed.close(); // detach; accepted work belongs to the service

  // Acceptance checks, from a fresh connection: the webhook answered the tool call while this app was away.
  const observer = await ManagedCopilot.connect();
  t.cleanup(() => observer.close());
  t.cleanup(() => observer.sessions.delete(sessionId));
  const done = await eventually(
    async () => {
      const info = await observer.sessions.get(sessionId);
      return info.lastTurn?.status === "completed" && info.pendingActions.length === 0 ? info : undefined;
    },
    { timeoutMs: 4 * 60_000, what: "the detached turn to complete" },
  );
  t.check(receiver.deliveries.includes("session.action_required"), "the platform delivered a signed session.action_required webhook");
  t.check(lookups.includes("1234"), "the webhook handler answered lookup_order with your tool");
  t.check(done.lastTurn?.status === "completed", "the turn finished while the app was disconnected");
});
