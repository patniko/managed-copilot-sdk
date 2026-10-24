#!/usr/bin/env node
// Development helper: runs a local Managed Copilot gateway with the software factory's environments, without Aspire.
// The supported way to run everything is `aspire run` from the repository root; this is for iterating on the demo.
//
//   node scripts/dev-platform.mjs            # gateway on http://localhost:7410
//   GATEWAY_PORT=7491 node scripts/dev-platform.mjs
//
// Discovery goes to demos/software-factory/.data/home so it never collides with another local platform. Start the
// factory with the same MANAGED_COPILOT_HOME (or MANAGED_COPILOT_URL) to connect to this gateway.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { softwareFactory } from "../apphost.mts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "..", "..");
const gateway = join(repo, "platform", "gateway", "dist", "main.js");
if (!existsSync(gateway)) {
  console.error("The gateway isn't built. Run `pnpm build` from the repository root first.");
  process.exit(1);
}

const port = Number(process.env.GATEWAY_PORT ?? 7410);
const home = resolve(process.env.MANAGED_COPILOT_HOME ?? join(root, ".data", "home"));
const data = resolve(process.env.MANAGED_COPILOT_DATA_DIR ?? join(root, ".data", "platform"));
mkdirSync(home, { recursive: true });
const { environments } = softwareFactory();

const child = spawn(process.execPath, [gateway], {
  cwd: repo,
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: String(port),
    MANAGED_COPILOT_CONFIG: JSON.stringify({ name: "copilot", environments }),
    MANAGED_COPILOT_DATA_DIR: data,
    MANAGED_COPILOT_HOME: home,
  },
});
console.log(`[dev-platform] gateway http://localhost:${port} · discovery ${home}`);
console.log(`[dev-platform] start the factory with MANAGED_COPILOT_HOME=${home}`);

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
