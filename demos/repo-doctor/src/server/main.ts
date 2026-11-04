import { createServer } from "node:http";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createRequestHandler, type Middleware } from "./http.js";
import { EventHub } from "./hub.js";
import { log } from "./log.js";
import { Platform } from "./platform.js";
import { RunManager } from "./runs.js";
import { loadSample } from "./sample.js";
import { RunStore } from "./store.js";

const config = loadConfig();
const hub = new EventHub();
const platform = new Platform(config);
const runs = new RunManager(platform, config, new RunStore(config.dataDir), hub, loadSample(config.sampleDir));
runs.start();

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
server.on("request", createRequestHandler({ runs, hub, config }, ui));

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, config.host, () => resolve());
}).catch((error: NodeJS.ErrnoException) => {
  log.error(error.code === "EADDRINUSE" ? `Port ${config.port} is already in use. Set PORT to use another port.` : `Couldn't start: ${error.message}`);
  process.exit(1);
});

platform.start();
log.info(`Repo Doctor: http://localhost:${config.port}${config.dev ? " (dev)" : ""}`, { environment: config.environment, model: config.model });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("Shutting down; runs in progress are stopped and their sandboxes deleted", { signal });
  await runs.close();
  hub.close();
  await platform.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown(signal));
