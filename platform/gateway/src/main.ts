import { loadConfig } from "./config.js";
import { startGateway } from "./server.js";

const gateway = await startGateway(loadConfig());

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    gateway.app.log.info("Shutting down", { signal });
    void gateway.close().finally(() => process.exit(0));
  });
}
