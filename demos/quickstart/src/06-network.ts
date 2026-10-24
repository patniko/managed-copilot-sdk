import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { snippet } from "./harness.js";

const PROBE =
  "Run `curl -sS -m 15 -o /dev/null -w '%{http_code}' https://example.com` and save exactly what it prints (or its error message) to outputs/status.txt. Do not retry or work around failures.";

export default snippet(import.meta.url, { title: "Control network access", section: "spec §7", requires: ["isolated", "files"], timeoutMs: 20 * 60_000 }, async (t) => {
  const managed = await ManagedCopilot.connect();
  t.cleanup(() => managed.close());

  // Code can turn it off for the sessions one client creates:
  const client = await managed.client({ name: "coder", network: false });
  const offline = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
  t.cleanup(() => client.deleteSession(offline.sessionId));
  await offline.sendAndWait({ prompt: PROBE }, 10 * 60_000);

  // The environment default (network on) for comparison:
  const open = await managed.createSession({ environment: "coder", model: "claude-sonnet-5", onPermissionRequest: approveAll });
  t.cleanup(() => managed.sessions.delete(open.sessionId));
  await open.sendAndWait({ prompt: PROBE }, 10 * 60_000);

  // Acceptance checks
  const blocked = (await managed.files(offline).read("outputs/status.txt")).trim();
  const allowed = (await managed.files(open).read("outputs/status.txt")).trim();
  console.log(`network: false -> ${blocked}`);
  console.log(`network default -> ${allowed}`);
  const offlineInfo = await managed.sessions.get(offline.sessionId);
  t.check(offlineInfo.sandbox?.network.access === "disabled", "the client's sessions carry network: disabled");
  t.check(!/\b200\b/.test(blocked), "with network: false the sandbox cannot reach example.com");
  t.check(/\b200\b/.test(allowed), "with the default the sandbox reaches example.com");
});
