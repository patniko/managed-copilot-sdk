// Walkthrough 06: bring your own harness. Steps and output: samples/06-harness/README.md
// Run it with: pnpm sample 06            (add --attach to open the last session in Copilot CLI)
import { approveAll, defineTool, type CopilotSession } from "@github/copilot-sdk";
import { ManagedCopilot, type ManagedSessionConfig } from "@managed-copilot/sdk";
import { z } from "zod";

// Your data and your tool. The handler runs here, in this process, wherever the session runs.
const tickets: Record<string, { title: string; status: string; owner: string }> = {
  "42": { title: "Checkout button does nothing on Safari", status: "in progress", owner: "web team" },
};
let cliOpen = false;
let callsWhileCliOpen = 0;
const lookupTicket = defineTool("lookup_ticket", {
  description: "Look up a support ticket by id",
  parameters: z.object({ id: z.string() }),
  skipPermission: true, // read-only, so no approval prompt
  handler: async ({ id }) => {
    if (cliOpen) callsWhileCliOpen++; // stay quiet while Copilot CLI owns the terminal
    else console.log(`  [your app, pid ${process.pid}] lookup_ticket ${id}`);
    return tickets[id] ?? { error: `No ticket ${id}` };
  },
});

// The harness: how the stock Copilot runtime is configured for a session. Ordinary SDK options, defined once.
const harness = {
  model: "claude-sonnet-5",
  systemMessage: { content: "You work on Contoso's support desk. Answer in at most two sentences." },
  customAgents: [
    {
      name: "ticket-desk",
      description: "Answers questions about Contoso support tickets",
      prompt: "Look up the ticket first. Give its status and owner, then one next step.",
      tools: ["lookup_ticket"],
    },
  ],
  agent: "ticket-desk",
  tools: [lookupTicket],
  onPermissionRequest: approveAll,
} satisfies Omit<ManagedSessionConfig, "environment">;

const managed = await ManagedCopilot.connect();
const sessions: CopilotSession[] = [];

try {
  // The same harness in three placements: the shared runtime, its own sandbox, and promotable.
  for (const environment of ["chat", "coder", "helper"]) {
    const session = await managed.createSession({ environment, ...harness });
    sessions.push(session);
    const info = await managed.sessions.get(session.sessionId);
    console.log(`\n${environment}: ${info.placement}${info.sandbox ? ` (${info.sandbox.id})` : ""}, agent ${info.agent ?? "none"}`);
    const reply = await session.sendAndWait({ prompt: "What's the status of ticket 42?" });
    console.log(`  Copilot: ${reply?.data.content}`);
  }

  // --attach: open the last session in Copilot CLI. This process keeps running while you use the CLI,
  // so the CLI's turns can still call lookup_ticket here.
  if (process.argv.includes("--attach")) {
    console.log("\nAsk Copilot CLI about ticket 42, then type /exit to come back.");
    cliOpen = true;
    await managed.openCli(sessions.at(-1)!);
    cliOpen = false;
    console.log(`\nWhile Copilot CLI was attached, lookup_ticket ran ${callsWhileCliOpen} ${callsWhileCliOpen === 1 ? "time" : "times"} here, in pid ${process.pid}.`);
  }
} finally {
  await Promise.allSettled(sessions.map((session) => managed.sessions.delete(session.sessionId)));
  await managed.close();
}
