import { randomBytes } from "node:crypto";
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { snippet } from "./harness.js";

export default snippet(import.meta.url, { title: "Keep secrets out of the sandbox", section: "spec §8", requires: ["isolated", "files", "vaults"], timeoutMs: 15 * 60_000 }, async (t) => {
  const managed = await ManagedCopilot.connect();
  t.cleanup(() => managed.close());
  // A throwaway value: postman-echo.com reflects request headers, which proves substitution happened at the proxy.
  const user = { id: managed.account.id, echoToken: `qs-${randomBytes(12).toString("hex")}` };

  // Create per-user vaults in code, for credentials that belong to one end user:
  const vault = await managed.vaults.create({
    name: `echo-${user.id}`,
    credentials: [{ env: "ECHO_TOKEN", value: user.echoToken, hosts: ["postman-echo.com"] }],
  });
  t.cleanup(() => managed.vaults.delete(vault.id));
  const client = await managed.client("coder", { vaults: [vault.id] });

  const session = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
  t.cleanup(() => client.deleteSession(session.sessionId));
  await session.sendAndWait(
    {
      prompt:
        'Run exactly these two commands: echo "$ECHO_TOKEN" > outputs/env.txt and curl -s -H "Authorization: Bearer $ECHO_TOKEN" https://postman-echo.com/headers > outputs/echo.json',
    },
    10 * 60_000,
  );

  // Acceptance checks
  const files = managed.files(session);
  const placeholder = (await files.read("outputs/env.txt")).trim();
  const echoed = JSON.parse(await files.read("outputs/echo.json")) as { headers?: Record<string, string> };
  console.log(`inside the sandbox: ECHO_TOKEN=${placeholder.slice(0, 18)}…`);
  t.check(placeholder.length > 0 && !placeholder.includes(user.echoToken), "the sandbox sees a placeholder, never the real value");
  const sent = echoed.headers?.authorization ?? "";
  t.check(sent.length > 0 && sent !== `Bearer ${placeholder}`, "the egress proxy substituted the credential for the allowed HTTPS host");
  t.check(!JSON.stringify(await managed.vaults.list()).includes(user.echoToken), "no API returns the vault's value");
});
