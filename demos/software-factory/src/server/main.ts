import { createServer } from "node:http";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createRequestHandler, type Middleware } from "./http.js";
import { EventHub } from "./hub.js";
import { log } from "./log.js";
import { Factory } from "./pipeline/factory.js";
import { Platform } from "./platform.js";
import { FactoryStore } from "./store.js";

const config = loadConfig();
const store = new FactoryStore(join(config.dataDir, "factory.db"));
const hub = new EventHub();
const platform = new Platform(config);
const factory = new Factory({
  store,
  hub,
  platform,
  readiness: () => ({ ready: platform.status.features.runs, ...(platform.status.message ? { reason: platform.status.message } : {}) }),
  account: () => {
    const account = platform.status.account;
    return account ? { login: account.login, ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}) } : undefined;
  },
  config,
  ...(process.env.FACTORY_SKILLS_ROOT ? { skillsRoot: process.env.FACTORY_SKILLS_ROOT } : {}),
});

let wasReady = false;
platform.onStatus((status) => {
  hub.publish({ type: "platform", platform: status });
  const ready = status.features.runs;
  if (ready && !wasReady) factory.resumeInterrupted();
  if (status.state === "connected" || status.state === "misconfigured") void factory.reconcileSessions();
  wasReady = ready;
});

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
server.on("request", createRequestHandler({ factory, platform, hub, config }, ui));

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, config.host, () => resolve());
}).catch((error: NodeJS.ErrnoException) => {
  log.error(error.code === "EADDRINUSE" ? `Port ${config.port} is already in use. Set PORT to use another port.` : `Couldn't start: ${error.message}`);
  process.exit(1);
});

platform.start();
log.info(`Software factory floor: http://localhost:${config.port}${config.dev ? " (dev)" : ""}`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("Shutting down; accepted work keeps running on the platform", { signal });
  hub.close();
  await factory.stop();
  await platform.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown(signal));
