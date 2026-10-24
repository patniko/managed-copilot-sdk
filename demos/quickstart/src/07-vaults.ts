import { randomBytes } from "node:crypto";
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilotError } from "@managed-copilot/protocol";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { snippet, stableCode } from "./harness.js";

export default snippet(import.meta.url, { title: "Keep secrets out of the sandbox", section: "spec §8", requires: ["isolated", "files", "vaults"], timeoutMs: 15 * 60_000 }, async (t) => {
  const managed = await ManagedCopilot.connect();
  t.cleanup(() => managed.close());
  // A throwaway value in a custom header. postman-echo.com reflects request headers, and the proxy redacts a value it
  // substituted wherever a response echoes it. (Sending something that looks like a real credential to an echo service
  // is a pattern agents rightly decline.)
  const user = { id: managed.account.id, echoValue: `qs-${randomBytes(12).toString("hex")}` };

  // Create per-user vaults in code, for credentials that belong to one end user:
  const vault = await managed.vaults.create({
    name: `echo-${user.id}`,
    credentials: [{ env: "ECHO_VALUE", value: user.echoValue, hosts: ["postman-echo.com"], headers: ["x-echo-value"] }],
  });
  t.cleanup(() => managed.vaults.delete(vault.id));
  const client = await managed.client("coder", { vaults: [vault.id] });

  const session = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
  t.cleanup(() => client.deleteSession(session.sessionId));
  const reply = await session.sendAndWait(
    {
      prompt:
        'Run exactly these two commands: echo "$ECHO_VALUE" > outputs/env.txt and curl -s -H "X-Echo-Value: $ECHO_VALUE" https://postman-echo.com/headers > outputs/echo.json',
    },
    10 * 60_000,
  );

  // Acceptance checks
  const files = managed.files(session);
  // When the agent didn't write a file, say what it did instead.
  const read = (path: string) =>
    files.read(path).catch((error: unknown) => {
      if (stableCode(error) !== "not_found") throw error;
      throw new ManagedCopilotError("not_found", `${(error as Error).message} The agent replied: "${String(reply?.data.content ?? "").trim().slice(0, 400)}"`);
    });
  const placeholder = (await read("outputs/env.txt")).trim();
  const echoed = JSON.parse(await read("outputs/echo.json")) as { headers?: Record<string, string> };
  console.log(`inside the sandbox: ECHO_VALUE=${placeholder.slice(0, 18)}…`);
  t.check(placeholder.length > 0 && !placeholder.includes(user.echoValue), "the sandbox sees a placeholder, never the real value");
  // The proxy only redacts a value it substituted, so the echo coming back as [redacted] proves both directions.
  t.check(echoed.headers?.["x-echo-value"] === "[redacted]", "the egress proxy sent the real value to the allowed host and redacted its echo");
  t.check(!JSON.stringify(await managed.vaults.list()).includes(user.echoValue), "no API returns the vault's value");
});
