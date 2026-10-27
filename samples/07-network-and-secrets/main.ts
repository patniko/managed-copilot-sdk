// Walkthrough 07: network rules and secrets. Steps and output: samples/07-network-and-secrets/README.md
// Run it with: pnpm sample 07
import { randomBytes } from "node:crypto";
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";

const managed = await ManagedCopilot.connect();
managed.on("network.blocked", ({ data }) => console.log(`  [platform] network.blocked: ${data["host"]}:${data["port"]} (${data["reason"]})`));
/** Cleanup that can't finish is reported, never ignored. */
const couldNotDelete = (what: string) => (error: Error) => {
  process.exitCode = 1;
  console.error(`Couldn't delete ${what}: ${error.message}`);
};

// A throwaway value stands in for an API key. postman-echo.com sends request headers back, so you can see what
// really left the sandbox. Never send a real credential to an echo service.
const secret = `demo-${randomBytes(8).toString("hex")}`;

// A vault: the platform seals the value. The sandbox gets a placeholder instead.
const vault = await managed.vaults.create({
  name: `walkthrough-07-${randomBytes(3).toString("hex")}`,
  credentials: [{ env: "ECHO_VALUE", value: secret, hosts: ["postman-echo.com"], headers: ["x-echo-value"] }],
});
let sessionId: string | undefined;

// What runs in the sandbox: your own script, uploaded below. The agent only runs it.
const script = [
  "#!/bin/sh",
  "# Checks the sandbox's network rules with the throwaway test value in ECHO_VALUE.",
  "mkdir -p outputs",
  'echo "$ECHO_VALUE" > outputs/sandbox-sees.txt',
  'curl -s -H "X-Echo-Value: $ECHO_VALUE" https://postman-echo.com/headers > outputs/allowed.json',
  "curl -sS -o /dev/null https://example.com 2> outputs/blocked.txt",
  "echo checked",
].join("\n");

try {
  // "coder" may reach any host. This client narrows its sessions to one host and gives them the vault.
  const client = await managed.client("coder", { network: ["postman-echo.com"], vaults: [vault.id] });
  const session = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
  sessionId = session.sessionId;

  await managed.files(session).write("check-network.sh", `${script}\n`);
  const reply = await session.sendAndWait({ prompt: "Run my test script with `sh check-network.sh` and reply with just its output." }, 10 * 60_000);

  const read = (path: string) =>
    managed.files(session).read(path).catch(() => {
      throw new Error(`The script didn't write ${path}. The agent replied: ${reply?.data.content}`);
    });
  const seen = (await read("outputs/sandbox-sees.txt")).trim();
  const echoed = JSON.parse(await read("outputs/allowed.json")) as { headers?: Record<string, string> };
  const blocked = (await read("outputs/blocked.txt")).trim();

  console.log(`\nThe real value:                ${secret}`);
  console.log(`$ECHO_VALUE in the sandbox:    ${seen}`);
  console.log(`postman-echo.com received the real value. Its echo came back as: ${echoed.headers?.["x-echo-value"]}`);
  console.log(`example.com is not allowed:    ${blocked}`);
} finally {
  if (sessionId) await managed.sessions.delete(sessionId).catch(couldNotDelete(`session ${sessionId}`));
  await managed.vaults.delete(vault.id).catch(couldNotDelete(`vault ${vault.id}`));
  await managed.close();
}
