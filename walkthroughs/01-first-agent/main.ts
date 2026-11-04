// Walkthrough 01: your first agent. Steps and output: walkthroughs/01-first-agent/README.md
// Run it with: pnpm walkthrough 01
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";

// Connect to your platform: the local `aspire run`, or the deployment named by MANAGED_COPILOT_URL.
// You sign in as your GitHub account (GH_TOKEN, or the GitHub CLI's `gh auth login`).
const managed = await ManagedCopilot.connect();
console.log(`Connected to ${managed.url} (${managed.info.mode}) as @${managed.account.login}`);

// A stock CopilotClient for the "chat" environment. From here on it is the ordinary Copilot SDK.
const client = await managed.client("chat");
const session = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });

const reply = await session.sendAndWait({ prompt: "In two short sentences, what could an AI agent do for a small software team?" });
console.log(`\nCopilot: ${reply?.data.content}\n`);

// The platform keeps a record of every session you own.
const info = await managed.sessions.get(session.sessionId);
console.log(`Session ${info.id}`);
console.log(`  environment: ${info.environment} (${info.type})`);
console.log(`  placement:   ${info.placement}`);
console.log(`  state:       ${info.state}`);

// Detach. The session keeps running on the platform, so you can pick it up again from Copilot CLI.
console.log(`\nOpen it in Copilot CLI:  npx managed-copilot attach ${info.id.slice(0, 8)}`);
await managed.close();
