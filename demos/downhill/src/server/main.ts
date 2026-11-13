import { createServer } from "node:http";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { DownhillShop } from "./downhill.js";
import { createRequestHandler, type Middleware } from "./http.js";
import { log } from "./log.js";
import { HelpDesk } from "./support.js";
import { createTelemetry } from "./telemetry.js";

const config = loadConfig();
// First, so the startup lines below stream to Incident Commander too.
const telemetry = createTelemetry({ incidentUrl: config.incidentUrl, secret: config.incidentAlertSecret, version: config.version });
const support = new HelpDesk(config.helpDeskUrl, config.helpDeskPublicUrl);
const shop = new DownhillShop(config, { telemetry });

const server = createServer();
let ui: Middleware | undefined;
if (config.dev) {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    configFile: join(config.packageRoot, "vite.config.ts"),
    server: { middlewareMode: true, ws: { server } },
    appType: "spa",
  });
  ui = vite.middlewares as unknown as Middleware;
}
server.on("request", createRequestHandler({ config, support, shop }, ui));

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, config.host, () => resolve());
}).catch((error: NodeJS.ErrnoException) => {
  log.error(error.code === "EADDRINUSE" ? `Port ${config.port} is already in use. Set PORT to use another port.` : `Couldn't start: ${error.message}`);
  process.exit(1);
});

const storefront = shop.storefront.current();
log.info(`Downhill: http://localhost:${config.port}${config.dev ? " (dev)" : ""}`, {
  version: config.version,
  storefront: `v${storefront.version}${storefront.deploy ? ` (deployed from ${storefront.deploy.incident})` : ""}`,
  helpDesk: config.helpDeskUrl ?? "not connected (set HELP_DESK_URL)",
  incidentCommander: config.incidentUrl ?? "not connected (set INCIDENT_URL)",
  telemetry: telemetry.status().endpoint ?? "off",
  data: config.dataDir,
});
shop.logConfiguration();

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log.info("Shutting down", { signal });
  server.closeAllConnections();
  // The last records (this one included) get up to 3 seconds to reach Incident Commander.
  const flushed = Promise.race([telemetry.shutdown(), new Promise((resolve) => setTimeout(resolve, 3_000).unref())]);
  server.close(() => void flushed.finally(() => process.exit(0)));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => shutdown(signal));
