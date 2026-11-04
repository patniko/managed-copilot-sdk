import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { snippet } from "./harness.js";

const salesCsv = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "sales.csv");

export default snippet(import.meta.url, { title: "Set up the sandbox", section: "spec §5", requires: ["isolated", "files"], timeoutMs: 20 * 60_000 }, async (t) => {
  const managed = await ManagedCopilot.connect();
  t.cleanup(() => managed.close());

  const session = await managed.createSession({
    environment: {
      name: "coder",
      files: { "data/sales.csv": await readFile(salesCsv) },
      packages: { python: ["matplotlib"] },
      env: { REPORT_TITLE: "Q3 sales" },
    },
    model: "claude-sonnet-5",
    onPermissionRequest: approveAll,
  });
  t.cleanup(() => managed.sessions.delete(session.sessionId));

  // Or reuse one client and upload separately before sending work:
  const client = await managed.client("coder");
  const uploaded = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
  t.cleanup(() => client.deleteSession(uploaded.sessionId));
  await managed.files(uploaded).upload(salesCsv, "data/sales.csv");
  await uploaded.sendAndWait({ prompt: "Summarize data/sales.csv into outputs/summary.md" }, 10 * 60_000);

  // Acceptance checks
  const seeded = await managed.files(session).list("data");
  t.check(seeded.some((entry) => entry.path.endsWith("sales.csv")), "the one-call descriptor wrote data/sales.csv before the agent started");
  await session.sendAndWait(
    { prompt: `Run python3 -c "import os, matplotlib; print(os.environ['REPORT_TITLE'], matplotlib.__version__)" and save its output to outputs/setup-check.txt` },
    10 * 60_000,
  );
  const setupCheck = await managed.files(session).read("outputs/setup-check.txt");
  console.log(setupCheck.trim());
  t.check(setupCheck.includes("Q3 sales"), "the session's env and python packages were installed before the first turn");
  const summary = await managed.files(uploaded).read("outputs/summary.md");
  t.check(/North|South|revenue/i.test(summary), "the uploaded file was summarized into outputs/summary.md");
});
