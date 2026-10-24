// sandboxd: the platform agent inside each sandbox. Runs as root (never as the workload identity), starts the stock
// Copilot runtime as uid 10001 on loopback, and serves the gateway (through the relay) with a per-sandbox key.
import { PATHS, SANDBOXD_PORT } from "../shared/constants.js";
import { createLog } from "../shared/log.js";
import { SandboxAgent } from "./agent.js";
import { createSandboxdServer } from "./server.js";

const log = createLog("sandboxd");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    log.error(`${name} is required; sandboxd is started by the Managed Copilot gateway.`);
    process.exit(1);
  }
  return value;
}

if (typeof process.getuid === "function" && process.getuid() !== 0) {
  log.error("sandboxd must run as root so it can start the runtime and workload as uid 10001; the platform starts it with --user 0.");
  process.exit(1);
}

const sandboxId = required("SANDBOX_ID");
const key = required("SANDBOXD_KEY");
const runtimeToken = required("SANDBOXD_RUNTIME_TOKEN");
const runtimeBinary = process.env.SANDBOXD_RUNTIME_BINARY ?? "/usr/local/bin/copilot-runtime";
const version = process.env.SANDBOXD_VERSION ?? "0.1.0";
for (const name of Object.keys(process.env)) {
  if (name.startsWith("SANDBOXD_") || name === "SANDBOX_ID") delete process.env[name];
}

const agent = new SandboxAgent({ sandboxId, version, runtimeToken, runtimeBinary, stateDir: `${PATHS.state}/sandboxd` }, log);
await agent.load();
const server = createSandboxdServer({ key, agent, log });
await new Promise<void>((resolve) => server.listen(SANDBOXD_PORT, "0.0.0.0", resolve));
log.info("sandboxd listening", { sandboxId, port: SANDBOXD_PORT, version });

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Stopping", { signal });
    server.close();
    server.closeAllConnections();
    void agent
      .shutdown()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}
