// Walkthrough 02: give the agent your own tools. Steps and output: walkthroughs/02-your-own-tools/README.md
// Run it with: pnpm walkthrough 02
import { approveAll, defineTool } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { z } from "zod";

// Your app's data. The agent never sees this table, only what your tools return.
const orders: Record<string, { status: string; carrier: string; eta: string }> = {
  "1234": { status: "shipped", carrier: "UPS", eta: "Friday" },
  "5678": { status: "processing", carrier: "not assigned yet", eta: "next week" },
};

// A read-only tool. skipPermission lets it run without asking first.
const lookupOrder = defineTool("lookup_order", {
  description: "Look up an order by its id",
  parameters: z.object({ id: z.string() }),
  skipPermission: true,
  handler: async ({ id }) => {
    console.log(`\n  [your app, pid ${process.pid}] lookup_order ${id}`);
    return orders[id] ?? { error: `No order ${id}` };
  },
});

// A tool with a side effect. Without skipPermission, every call waits for an approval first.
const cancelOrder = defineTool("cancel_order", {
  description: "Cancel an order that has not shipped yet",
  parameters: z.object({ id: z.string() }),
  handler: async ({ id }) => {
    console.log(`\n  [your app, pid ${process.pid}] cancel_order ${id}`);
    const order = orders[id];
    if (!order) return { error: `No order ${id}` };
    if (order.status === "shipped") return { error: "Already shipped; it can't be cancelled" };
    order.status = "cancelled";
    return { id, status: "cancelled" };
  },
});

const managed = await ManagedCopilot.connect();
const client = await managed.client("chat");
/** Cleanup that can't finish is reported, never ignored. */
const couldNotDelete = (what: string) => (error: Error) => {
  process.exitCode = 1;
  console.error(`Couldn't delete ${what}: ${error.message}`);
};
const session = await client.createSession({
  model: "claude-sonnet-5",
  systemMessage: { content: "You are Contoso's order assistant. Be brief." },
  tools: [lookupOrder, cancelOrder],
  streaming: true,
  // Approval requests come to your app. This handler prints each one and approves it once.
  onPermissionRequest: (request, invocation) => {
    if (request.kind === "custom-tool") console.log(`\n  [your app] approve ${request.toolName} ${JSON.stringify(request.args)}? yes`);
    return approveAll(request, invocation);
  },
});

try {
  // Stream the reply as it is written.
  session.on("assistant.message_delta", (event) => process.stdout.write(event.data.deltaContent));

  console.log("You: Where is order 1234?");
  await session.sendAndWait({ prompt: "Where is order 1234?" });

  console.log("\n\nYou: Please cancel order 5678.");
  await session.sendAndWait({ prompt: "Please cancel order 5678." });
  console.log();
} finally {
  await client.deleteSession(session.sessionId).catch(couldNotDelete(`session ${session.sessionId}`));
  await managed.close();
}
