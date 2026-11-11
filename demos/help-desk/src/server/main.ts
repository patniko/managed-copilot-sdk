import { createServer } from "node:http";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { HelpDesk } from "./desk.js";
import { SoftwareFactory } from "./factory.js";
import { createRequestHandler, type Middleware } from "./http.js";
import { EventHub } from "./hub.js";
import { log } from "./log.js";
import { Platform } from "./platform.js";

const config = loadConfig();
const hub = new EventHub();
const platform = new Platform(config);
const factory = new SoftwareFactory(config.factoryUrl, config.factoryPublicUrl);
const desk = new HelpDesk(platform, config, (event) => hub.publish(event), factory);
desk.start();

const server = createServer();
let ui: Middleware | undefined;
if (config.dev) {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    configFile: join(config.packageRoot, "vite.config.ts"),
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  ui = vite.middlewares as unknown as Middleware;
}
server.on("request", createRequestHandler({ desk, hub, config }, ui));

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, config.host, () => resolve());
}).catch((error: NodeJS.ErrnoException) => {
  log.error(error.code === "EADDRINUSE" ? `Port ${config.port} is already in use. Set PORT to use another port.` : `Couldn't start: ${error.message}`);
  process.exit(1);
});

platform.start();
log.info(`Help Desk: http://localhost:${config.port}${config.dev ? " (dev)" : ""}`, { environment: config.environment, softwareFactory: config.factoryUrl ?? "not connected (set SOFTWARE_FACTORY_URL)" });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("Shutting down; the simulation's sessions stay on the platform", { signal });
  hub.close();
  desk.close();
  await platform.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown(signal));
