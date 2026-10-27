// Walkthrough 04: start cheap, move into a sandbox when needed. Steps and output: samples/04-promotion/README.md
// Run it with: pnpm sample 04
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";

const managed = await ManagedCopilot.connect();
managed.on("session.promoted", (event) => console.log(`\n  [platform] session.promoted: ${event.sessionId} moved to sandbox ${event.sandboxId}`));

// "helper" is promotable: its sessions start on the shared runtime and can move once into their own sandbox.
const client = await managed.client("helper");
const session = await client.createSession({
  model: "claude-sonnet-5",
  // The move is a tool call (request_sandbox), so it goes through your approval handler like any other.
  onPermissionRequest: (request, invocation) => {
    const what = request.kind === "custom-tool" ? request.toolName : request.kind;
    console.log(`\n  [your app] approve ${what}? yes`);
    return approveAll(request, invocation);
  },
});

const where = async () => {
  const info = await managed.sessions.get(session.sessionId);
  return info.placement === "sandbox" ? `sandbox ${info.sandbox?.id}` : "shared runtime";
};

// No shell needed, so the session stays on the shared runtime.
const first = await session.sendAndWait({ prompt: "In one sentence: what does a CSV header row contain?" });
console.log(`Copilot: ${first?.data.content}`);
console.log(`Now on: ${await where()}`);

// This needs a shell. The agent asks for a sandbox, you approve, the platform moves the same session
// (history included) into a new sandbox, and the turn continues there.
const second = await session.sendAndWait({ prompt: "Use Python to add 10, 20, and 30, and save the result to outputs/sum.json." }, 15 * 60_000);
console.log(`\nCopilot: ${second?.data.content}`);
console.log(`Now on: ${await where()}`);

// Same session ID, same conversation.
const third = await session.sendAndWait({ prompt: "What was my first question? Answer in one sentence." });
console.log(`\nCopilot: ${third?.data.content}`);

await client.deleteSession(session.sessionId);
await managed.close();
