import { isManagedCopilotError } from "@managed-copilot/protocol";
import { loadConfig } from "./config.js";
import { startGateway, type RunningGateway } from "./server.js";

let gateway: RunningGateway;
try {
  gateway = await startGateway(loadConfig());
} catch (error) {
  // A configuration the gateway refuses is explained, not dumped as a stack trace.
  if (!isManagedCopilotError(error)) throw error;
  console.error(`The Managed Copilot gateway could not start: ${error.message}`);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    gateway.app.log.info("Shutting down", { signal });
    void gateway.close().finally(() => process.exit(0));
  });
}
