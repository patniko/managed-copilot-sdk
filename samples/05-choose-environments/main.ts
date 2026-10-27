// Walkthrough 05: choose an environment from code. Steps and output: samples/05-choose-environments/README.md
// Run it with: pnpm sample 05
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot, isManagedCopilotError, type SessionInfo } from "@managed-copilot/sdk";

const managed = await ManagedCopilot.connect();
const describe = (info: SessionInfo) =>
  `environment "${info.environment}", ${info.sandbox ? `sandbox ${info.sandbox.id} (${info.sandbox.size})` : info.placement}`;
const created: string[] = []; // sessions to delete at the end, even if something fails
/** Cleanup that can't finish is reported, never ignored. */
const couldNotDelete = (what: string) => (error: Error) => {
  process.exitCode = 1;
  console.error(`Couldn't delete ${what}: ${error.message}`);
};

try {
  // 1. A name the AppHost declared: exactly that template.
  const named = await managed.createSession({ environment: "coder", model: "claude-sonnet-5", onPermissionRequest: approveAll });
  created.push(named.sessionId);
  console.log(`1. "coder"              -> ${describe(await managed.sessions.get(named.sessionId))}`);

  // 2. A name plus additions for this one session: files, Python or npm packages, and environment variables.
  //    (Vaults and a narrower network work the same way; see walkthrough 07.)
  const added = await managed.createSession({
    environment: {
      name: "coder",
      files: { "notes/brief.md": "Ship the billing fix first.\n" },
      packages: { python: ["tabulate"] },
      env: { TEAM: "contoso-platform" },
    },
    model: "claude-sonnet-5",
    onPermissionRequest: approveAll,
  });
  created.push(added.sessionId);
  console.log(`2. "coder" + additions  -> ${describe(await managed.sessions.get(added.sessionId))}`);

  // 3. Inline: a type and a size with no name, within what the deployment's `inline` setting allows.
  console.log(`   This deployment allows inline: ${JSON.stringify(managed.info.inline)}`);
  const inline = await managed.createSession({ environment: { type: "isolated", size: "small" }, model: "claude-sonnet-5", onPermissionRequest: approveAll });
  created.push(inline.sessionId);
  console.log(`3. { isolated, small }  -> ${describe(await managed.sessions.get(inline.sessionId))}`);

  // A type or size the deployment doesn't offer is refused before a sandbox is created.
  // Changing the menu means editing the AppHost and deploying again.
  try {
    const refused = await managed.createSession({ environment: { type: "isolated", size: "large" }, onPermissionRequest: approveAll });
    created.push(refused.sessionId);
  } catch (error) {
    const code = isManagedCopilotError(error) ? ` [${error.code}]` : "";
    console.log(`4. { isolated, large }  -> refused${code}: ${(error as Error).message}`);
  }

  // The additions were set up before the agent's first turn.
  const check = await added.sendAndWait({
    prompt: "Run `cat notes/brief.md; echo TEAM=$TEAM; python3 -c 'import tabulate; print(\"tabulate\", tabulate.__version__)'` and reply with only its output.",
  });
  console.log(`\nInside session 2's sandbox:\n${check?.data.content}`);
} finally {
  for (const id of created) await managed.sessions.delete(id).catch(couldNotDelete(`session ${id}`));
  await managed.close();
}
