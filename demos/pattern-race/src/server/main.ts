import { createServer } from "node:http";
import { join } from "node:path";
import { JOBS } from "../shared/jobs.js";
import type { AppState } from "../shared/types.js";
import { warmExpectations } from "./checks.js";
import { loadConfig } from "./config.js";
import { createRequestHandler, type Middleware } from "./http.js";
import { StateHub } from "./hub.js";
import { log } from "./log.js";
import { Platform } from "./platform.js";
import { RaceManager } from "./race.js";
import { RaceStore } from "./store.js";

const config = loadConfig();
let races: RaceManager | undefined;
const platform = new Platform(config, () => races?.running ?? false);
races = new RaceManager({ platform, config, store: new RaceStore(config.dataDir) });
const state = (): AppState => {
  const race = races!.snapshot();
  return { platform: platform.status, lanes: platform.lanes, model: platform.model, ...(race ? { race } : {}), serverNow: Date.now() };
};
const hub = new StateHub(state);
races.onChange(() => hub.changed());
let connected = false;
platform.onChange(() => {
  hub.changed();
  // After each new connection, delete sessions a race cut short by a restart left behind.
  const now = platform.status.state === "connected";
  if (now && !connected) void races!.deleteLeftovers();
  connected = now;
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
server.on("request", createRequestHandler({ races, hub, state, config }, ui));

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, config.host, () => resolve());
}).catch((error: NodeJS.ErrnoException) => {
  log.error(error.code === "EADDRINUSE" ? `Port ${config.port} is already in use. Set PORT to use another port.` : `Couldn't start: ${error.message}`);
  process.exit(1);
});

warmExpectations(JOBS);
platform.start();
log.info(`Pattern Race: http://localhost:${config.port}${config.dev ? " (dev)" : ""}`, { model: config.model });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("Shutting down; a running race is stopped and its sessions deleted", { signal });
  await races!.close();
  hub.close();
  await platform.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown(signal));
