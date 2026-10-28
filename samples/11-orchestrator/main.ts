// Walkthrough 11: a coordinator that splits a job across workers, each in its own sandbox.
// Steps and output: samples/11-orchestrator/README.md
// Run it with: pnpm sample 11
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";

const managed = await ManagedCopilot.connect();
managed.on("worker.started", (event) => console.log(`  [platform] worker.started: ${String(event.data.name)} in ${String(event.data.environment)}`));
managed.on("worker.idle", (event) => console.log(`  [platform] worker.idle: ${String(event.data.name)} finished`));

// "team" is an orchestrator: its sessions coordinate workers, and each worker is a session of "coder" in its own sandbox.
const client = await managed.client("team");
const session = await client.createSession({
  model: "claude-sonnet-5",
  // Starting a worker is a tool call (start_worker), so it comes to your approval handler. Approving it approves what
  // that worker does in its sandbox; the platform answers the worker's own prompts within that approval.
  onPermissionRequest: (request, invocation) => {
    const what = request.kind === "custom-tool" ? request.toolName : request.kind;
    console.log(`  [your app] approve ${what}? yes`);
    return approveAll(request, invocation);
  },
});
/** Cleanup that can't finish is reported, never ignored. */
const couldNotDelete = (what: string) => (error: Error) => {
  process.exitCode = 1;
  console.error(`Couldn't delete ${what}: ${error.message}`);
};

try {
  // One call covers the whole job: the coordinator starts the workers, waits for their reports (no polling, no model
  // time while it waits), and answers. Sandboxes start inside this call, so give it more than the 60-second default.
  const reply = await session.sendAndWait(
    {
      prompt:
        "In parallel, use one worker to count the prime numbers below 100,000 with Python and another to find how many digits the 1,000th Fibonacci number has, also with Python. Then report both answers.",
    },
    20 * 60_000,
  );
  console.log(`\nCopilot: ${reply?.data.content}`);

  // Workers are sessions of their own: each has a sandbox, files, and artifacts, and you can attach Copilot CLI to one.
  console.log("\nWorkers:");
  for (const worker of await managed.workers(session).list()) {
    const info = await managed.sessions.get(worker.id);
    console.log(`  ${worker.name}: ${worker.state} in ${info.sandbox ? `sandbox ${info.sandbox.id}` : worker.environment}, worker of ${info.parentSessionId}`);
  }
} finally {
  // Deleting the coordinator deletes its workers and their sandboxes too.
  await client.deleteSession(session.sessionId).catch(couldNotDelete(`session ${session.sessionId}`));
  await managed.close();
}
