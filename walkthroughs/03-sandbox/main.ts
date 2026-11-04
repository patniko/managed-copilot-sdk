// Walkthrough 03: a coding agent in its own sandbox. Steps and output: walkthroughs/03-sandbox/README.md
// Run it with: pnpm walkthrough 03
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const managed = await ManagedCopilot.connect();
const created: string[] = []; // sessions to delete at the end, even if something fails
/** Cleanup that can't finish is reported, never ignored. */
const couldNotDelete = (what: string) => (error: Error) => {
  process.exitCode = 1;
  console.error(`Couldn't delete ${what}: ${error.message}`);
};

try {
  // "coder" is an isolated environment: every session gets its own new sandbox.
  const client = await managed.client("coder");
  console.log("Creating a session. Its sandbox is ready before createSession returns...");
  const session = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
  created.push(session.sessionId);
  const info = await managed.sessions.get(session.sessionId);
  console.log(`Session ${info.id} runs in sandbox ${info.sandbox?.id} (${info.sandbox?.size})`);

  // Files in: upload a local file into the sandbox's /workspace.
  await managed.files(session).upload(join(here, "sales.csv"), "data/sales.csv");

  // Where is it running? Ask the agent to look around.
  const where = await session.sendAndWait({ prompt: "Run `uname -sm && whoami && pwd && ls data` and reply with only its output." });
  console.log(`\nInside the sandbox:\n${where?.data.content}\n`);

  // Real work. Whatever the agent saves under /workspace/outputs is published when the turn completes.
  await session.sendAndWait(
    { prompt: "Read data/sales.csv. Write outputs/report.md with total revenue per region as a Markdown table, then name the best month." },
    10 * 60_000,
  );

  // Files out: wait for this turn's publication, then read or download the artifacts.
  const artifacts = managed.artifacts(session);
  const publication = await artifacts.waitForPublication();
  for (const artifact of publication.artifacts) console.log(`Published outputs/${artifact.path} (version ${artifact.version}, ${artifact.size} bytes)`);
  console.log(`\n${(await artifacts.read("report.md")).trim()}\n`);
  await artifacts.download("report.md", join(here, "..", ".output", "report.md"));
  console.log("Downloaded to walkthroughs/.output/report.md");

  // One client, many sessions: the next session gets a different sandbox.
  const second = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
  created.push(second.sessionId);
  const secondInfo = await managed.sessions.get(second.sessionId);
  console.log(`\nA second session from the same client runs in sandbox ${secondInfo.sandbox?.id}`);
} finally {
  // Deleting a session deletes its sandbox and files. Published artifacts go with it.
  for (const id of created) await managed.sessions.delete(id).catch(couldNotDelete(`session ${id}`));
  await managed.close();
}
