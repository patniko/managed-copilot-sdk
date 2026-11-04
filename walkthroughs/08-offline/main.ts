// Walkthrough 08: keep working while your app is offline. Steps and output: walkthroughs/08-offline/README.md
// Run it with: pnpm walkthrough 08
// Once per deployment first: npx managed-copilot login   (work that continues without you runs as you)
import { setTimeout as sleep } from "node:timers/promises";
import { approveAll, defineTool } from "@github/copilot-sdk";
import { ManagedCopilot, type PendingAction } from "@managed-copilot/sdk";
import { z } from "zod";

const lookupOrder = defineTool("lookup_order", {
  description: "Look up an order by its id",
  parameters: z.object({ id: z.string() }),
  handler: async ({ id }) => {
    console.log(`   [your app] lookup_order ${id} ran in this process`);
    return { id, status: "shipped", carrier: "UPS", eta: "Friday" };
  },
});
// Your handlers. Live sessions, polling, and webhooks all take the same ones.
const handlers = { tools: [lookupOrder], onPermissionRequest: approveAll };
const describe = (action: PendingAction) =>
  action.kind === "tool" ? `call to ${action.tool} ${JSON.stringify(action.arguments)}` : `${action.kind} request for ${action.tool}`;

// 1. Your app starts the work, then goes away before the agent needs its tool.
const app = await ManagedCopilot.connect();
const session = await app.createSession({ environment: "chat", model: "claude-sonnet-5", ...handlers });
let later: ManagedCopilot | undefined;

try {
  await session.send({ prompt: "Look up order 1234 and tell me when it arrives." });
  await app.close();
  console.log(`1. Sent a prompt to session ${session.sessionId}, then disconnected.`);

  // 2. The agent keeps going. When it needs lookup_order, the request waits on the platform for an answer.
  //    Later, any process signed in as you can answer it. Here: polling, until the turn is over.
  later = await ManagedCopilot.connect();
  console.log("2. Reconnected. Answering whatever waits for this app:");
  for (const deadline = Date.now() + 4 * 60_000; ; await sleep(1_000)) {
    if (Date.now() > deadline) throw new Error("The turn did not finish within 4 minutes.");
    const { pendingActions, lastTurn } = await later.sessions.get(session.sessionId);
    if (pendingActions.length > 0) {
      for (const action of pendingActions) console.log(`   waiting: ${describe(action)}`);
      await later.sessions.handleActions(session.sessionId, handlers);
      continue;
    }
    if (lastTurn?.status === "completed") break;
    if (lastTurn?.status === "failed" || lastTurn?.status === "cancelled") throw new Error(`The turn ended as ${lastTurn.status}.`);
  }

  // 3. Resume the session to read the reply, as you would after any restart.
  const resumed = await later.resumeSession(session.sessionId, handlers);
  const reply = (await resumed.getEvents()).filter((event) => event.type === "assistant.message").at(-1);
  console.log(`3. Copilot: ${reply?.data.content}`);
} finally {
  // Either connection can delete the session: closing only detaches a connection's clients.
  await (later ?? app).sessions.delete(session.sessionId).catch((error: Error) => {
    process.exitCode = 1;
    console.error(`Couldn't delete session ${session.sessionId}: ${error.message}`);
  });
  await later?.close();
  await app.close();
}
