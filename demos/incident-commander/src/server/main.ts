import { createServer } from "node:http";
import { join } from "node:path";
import { Commander } from "./commander.js";
import { loadConfig, type AppConfig } from "./config.js";
import { errorText } from "./errors.js";
import { createRequestHandler, type Middleware } from "./http.js";
import { EventHub } from "./hub.js";
import { log } from "./log.js";
import { Platform } from "./platform.js";
import { ServiceCatalog } from "./services.js";
import { Store } from "./store.js";

let config: AppConfig;
try {
  config = loadConfig();
} catch (error) {
  log.error(`Incident Commander can't start: ${errorText(error)}`);
  process.exit(1);
}
const store = new Store(config.dataDir);
const hub = new EventHub();
const platform = new Platform(config);
const catalog = new ServiceCatalog(config.demoServicesDir, config.servicesDir, { remote: config.remoteServices ?? [] });
const commander = new Commander(config, platform, store, catalog, hub);
commander.start();

const server = createServer();
let ui: Middleware | undefined;
if (config.dev) {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({ configFile: join(config.packageRoot, "vite.config.ts"), server: { middlewareMode: true, hmr: { server } }, appType: "spa" });
  ui = vite.middlewares as unknown as Middleware;
}
server.on("request", createRequestHandler({ commander, hub }, config.webRoot, ui));

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, config.host, () => resolve());
}).catch((error: NodeJS.ErrnoException) => {
  log.error(error.code === "EADDRINUSE" ? `Port ${config.port} is already in use. Set PORT to use another port.` : `Couldn't start: ${error.message}`);
  process.exit(1);
});

platform.start();
log.info(`Incident Commander: http://localhost:${config.port}${config.dev ? " (dev)" : ""}`, {
  environment: config.environment,
  alerts: config.alertSecret ? "on" : "off (set INCIDENT_ALERT_SECRET)",
  webhook: config.webhookSecret ? "on" : "off (set INCIDENT_WEBHOOK_SECRET)",
  deploys: config.deploy ? "your pipeline" : "demo only",
  services: config.remoteServices?.map((service) => service.name).join(", ") || "none over HTTP (set INCIDENT_SERVICE_URLS)",
  factory: config.factory ? config.factory.url : "off (set SOFTWARE_FACTORY_URL)",
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("Shutting down; incidents keep going on the platform", { signal });
  hub.close();
  await commander.close();
  await platform.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown(signal));
