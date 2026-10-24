import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { snippet } from "./harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, "..", ".output");

export default snippet(import.meta.url, { title: "Get results out", section: "spec §6", requires: ["isolated", "artifacts"], timeoutMs: 20 * 60_000 }, async (t) => {
  const managed = await ManagedCopilot.connect();
  t.cleanup(() => managed.close());
  const session = await managed.createSession({
    environment: { name: "coder", files: { "data/sales.csv": await readFile(join(here, "..", "data", "sales.csv")) } },
    model: "claude-sonnet-5",
    onPermissionRequest: approveAll,
  });
  t.cleanup(() => managed.sessions.delete(session.sessionId));

  // Continuing that session:
  await session.sendAndWait({ prompt: "Chart monthly revenue from data/sales.csv and save outputs/revenue.png" }, 15 * 60_000);

  const artifacts = managed.artifacts(session);
  await artifacts.waitForPublication();
  for (const artifact of await artifacts.list()) {
    console.log(artifact.path, artifact.size, artifact.publishedAt); // revenue.png 48213 2026-10-23T21:04:11Z
  }
  await mkdir(output, { recursive: true });
  await artifacts.download("revenue.png", join(output, "revenue.png"));

  // Acceptance checks
  const published = (await artifacts.list()).find((artifact) => artifact.path === "revenue.png");
  t.check(published?.state === "published" && published.size > 0, `revenue.png was published (${published?.size} bytes, version ${published?.version})`);
  const png = await readFile(join(output, "revenue.png"));
  t.check(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `the download is a real PNG (${join(output, "revenue.png")})`);
});
