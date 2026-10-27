// Walkthrough 07: network rules and secrets. Steps and output: samples/07-network-and-secrets/README.md
// Run it with: pnpm sample 07
import { randomBytes } from "node:crypto";
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";

const managed = await ManagedCopilot.connect();
managed.on("network.blocked", ({ data }) => console.log(`  [platform] network.blocked: ${data["host"]}:${data["port"]} (${data["reason"]})`));

// A throwaway value stands in for an API key. postman-echo.com sends request headers back, so you can see what
// really left the sandbox. Never send a real credential to an echo service.
const secret = `demo-${randomBytes(8).toString("hex")}`;

// A vault: the platform seals the value. Sandboxes only ever see a placeholder.
const vault = await managed.vaults.create({
  name: `walkthrough-07-${randomBytes(3).toString("hex")}`,
  credentials: [{ env: "ECHO_KEY", value: secret, hosts: ["postman-echo.com"], headers: ["x-echo-key"] }],
});

try {
  // "coder" may reach any host. This client narrows its sessions to one host and gives them the vault.
  const client = await managed.client("coder", { network: ["postman-echo.com"], vaults: [vault.id] });
  const session = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });

  try {
    const reply = await session.sendAndWait(
      {
        prompt: [
          "Run these commands exactly, then reply with just: done",
          "mkdir -p outputs",
          'echo "$ECHO_KEY" > outputs/sandbox-sees.txt',
          'curl -s -H "X-Echo-Key: $ECHO_KEY" https://postman-echo.com/headers > outputs/allowed.json',
          "curl -sS -o /dev/null https://example.com 2> outputs/blocked.txt",
        ].join("\n"),
      },
      10 * 60_000,
    );

    const read = (path: string) =>
      managed.files(session).read(path).catch(() => {
        throw new Error(`The agent didn't write ${path}. It replied: ${reply?.data.content}`);
      });
    const seen = (await read("outputs/sandbox-sees.txt")).trim();
    const echoed = JSON.parse(await read("outputs/allowed.json")) as { headers?: Record<string, string> };
    const blocked = (await read("outputs/blocked.txt")).trim();

    console.log(`\nThe real value:                ${secret}`);
    console.log(`$ECHO_KEY inside the sandbox:  ${seen}`);
    console.log(`postman-echo.com received the real value. Its echo came back as: ${echoed.headers?.["x-echo-key"]}`);
    console.log(`example.com is not allowed:    ${blocked}`);
  } finally {
    await client.deleteSession(session.sessionId);
  }
} finally {
  await managed.vaults.delete(vault.id);
  await managed.close();
}
