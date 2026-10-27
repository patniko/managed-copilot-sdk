// Walkthrough 05: choose an environment from code. Steps and output: samples/05-choose-environments/README.md
// Run it with: pnpm sample 05
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot, isManagedCopilotError, type SessionInfo } from "@managed-copilot/sdk";

const managed = await ManagedCopilot.connect();
const describe = (info: SessionInfo) =>
  `environment "${info.environment}", ${info.sandbox ? `sandbox ${info.sandbox.id} (${info.sandbox.size})` : info.placement}`;

// 1. A name the AppHost declared: exactly that template.
const named = await managed.createSession({ environment: "coder", model: "claude-sonnet-5", onPermissionRequest: approveAll });
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
console.log(`2. "coder" + additions  -> ${describe(await managed.sessions.get(added.sessionId))}`);

// 3. Inline: a type and a size with no name, within what the deployment's `inline` setting allows.
console.log(`   This deployment allows inline: ${JSON.stringify(managed.info.inline)}`);
const inline = await managed.createSession({ environment: { type: "isolated", size: "small" }, model: "claude-sonnet-5", onPermissionRequest: approveAll });
console.log(`3. { isolated, small }  -> ${describe(await managed.sessions.get(inline.sessionId))}`);

// Anything else is refused before a sandbox is created. Changing the menu means editing the AppHost and redeploying.
try {
  await managed.createSession({ environment: { type: "isolated", size: "large" }, onPermissionRequest: approveAll });
} catch (error) {
  const code = isManagedCopilotError(error) ? ` [${error.code}]` : "";
  console.log(`4. { isolated, large }  -> refused${code}: ${(error as Error).message}`);
}

// The additions were set up before the agent's first turn.
const check = await added.sendAndWait({
  prompt: "Run `cat notes/brief.md; echo TEAM=$TEAM; python3 -c 'import tabulate; print(\"tabulate\", tabulate.__version__)'` and reply with only its output.",
});
console.log(`\nInside session 2's sandbox:\n${check?.data.content}`);

for (const session of [named, added, inline]) await managed.sessions.delete(session.sessionId);
await managed.close();
