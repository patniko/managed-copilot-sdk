// Walkthrough 08: keep working while your app is offline. Steps and output: samples/08-offline/README.md
// Run it with: pnpm sample 08
import { setTimeout as sleep } from "node:timers/promises";
import { approveAll, defineTool } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
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

// 1. Your app starts the work, then goes away before the agent needs its tool.
const app = await ManagedCopilot.connect();
const session = await app.createSession({ environment: "chat", model: "claude-sonnet-5", ...handlers });
await session.send({ prompt: "Look up order 1234 and tell me when it arrives." });
await app.close();
console.log(`1. Sent a prompt to session ${session.sessionId}, then disconnected.`);

// 2. The agent keeps going. When it needs lookup_order, the request waits on the platform for an answer.
//    Later, any process signed in as you can answer it. Here: polling.
const later = await ManagedCopilot.connect();
console.log("2. Reconnected. Answering whatever waits for this app:");
let answered = false;
for (const deadline = Date.now() + 4 * 60_000; !answered; await sleep(1_000)) {
  if (Date.now() > deadline) throw new Error("Nothing came to answer within 4 minutes.");
  const { pendingActions } = await later.sessions.get(session.sessionId);
  for (const action of pendingActions) {
    const what = action.kind === "tool" ? `call to ${action.tool} ${JSON.stringify(action.arguments)}` : `${action.kind} request for ${action.tool}`;
    console.log(`   waiting: ${what}`);
  }
  const results = await later.sessions.handleActions(session.sessionId, handlers);
  answered = pendingActions.some((action) => action.kind === "tool") && results.some((result) => result.state === "completed");
}

// 3. The turn finishes on the platform. Resume the session to read the reply, as you would after any restart.
let turn;
for (const deadline = Date.now() + 4 * 60_000; turn !== "completed"; await sleep(1_000)) {
  if (Date.now() > deadline) throw new Error("The turn did not finish within 4 minutes.");
  turn = (await later.sessions.get(session.sessionId)).lastTurn?.status;
}
const resumed = await later.resumeSession(session.sessionId, handlers);
const reply = (await resumed.getEvents()).filter((event) => event.type === "assistant.message").at(-1);
console.log(`3. Copilot: ${reply?.data.content}`);

await later.sessions.delete(session.sessionId);
await later.close();
