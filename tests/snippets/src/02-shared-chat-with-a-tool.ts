import { approveAll, defineTool } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { z } from "zod";
import { snippet } from "./harness.js";
import { lookups, orders } from "./orders.js";

export default snippet(import.meta.url, { title: "Shared: a chat agent with your own tools", section: "spec §3", requires: ["shared"] }, async (t) => {
  const managed = await ManagedCopilot.connect();
  t.cleanup(() => managed.close());

  const lookupOrder = defineTool("lookup_order", {
    description: "Look up an order by id",
    parameters: z.object({ id: z.string() }),
    handler: async ({ id }) => orders.get(id), // runs in YOUR process; your database credentials never leave it
  });

  const client = await managed.client("chat");
  const session = await client.createSession({
    model: "claude-sonnet-5",
    systemMessage: { content: "You are Contoso's order assistant. Be brief." },
    tools: [lookupOrder],
    streaming: true,
    onPermissionRequest: approveAll,
  });

  session.on("assistant.message_delta", (e) => process.stdout.write(e.data.deltaContent));
  let deltas = 0;
  session.on("assistant.message_delta", () => deltas++);
  const reply = await session.sendAndWait({ prompt: "Where is order 1234?" });

  // Acceptance checks
  t.cleanup(() => client.deleteSession(session.sessionId));
  t.check(lookups.includes("1234"), "lookup_order ran in this process with id 1234");
  t.check(deltas > 0, `streaming delivered ${deltas} assistant.message_delta events`);
  t.check(/shipped|UPS|Friday/i.test(reply?.data.content ?? ""), "the answer uses the tool result (shipped with UPS)");
});
