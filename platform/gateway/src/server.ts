import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { discoveryFile, type DiscoveryRecord } from "@managed-copilot/protocol";
import { GatewayApp } from "./app.js";
import type { GatewayConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createLogger } from "./log.js";
import { modules } from "./modules/index.js";

export async function createGateway(config: GatewayConfig): Promise<GatewayApp> {
  const log = createLogger("gateway");
  const db = openDatabase(join(config.dataDir, "gateway.db"));
  const app = new GatewayApp(config, db, log);
  for (const module of modules) {
    await module.register(app);
    log.debug("Registered module", { module: module.name });
  }
  return app;
}

export interface RunningGateway {
  readonly app: GatewayApp;
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

export async function startGateway(config: GatewayConfig): Promise<RunningGateway> {
  const app = await createGateway(config);
  const server = createServer((req, res) => void app.routes.handle(app, req, res));
  server.on("upgrade", (req, socket, head) => void app.upgrades.handle(app, req, socket, head));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
  await app.start();

  const discovery = discoveryFile();
  if (config.writeDiscovery) {
    const record: DiscoveryRecord = { name: config.deployment.name, url: config.publicUrl, pid: process.pid, startedAt: new Date().toISOString(), version: config.version };
    mkdirSync(dirname(discovery), { recursive: true });
    writeFileSync(discovery, JSON.stringify(record, null, 2));
  }
  app.log.info("Managed Copilot gateway listening", { url: config.publicUrl, mode: config.mode, environments: Object.keys(config.deployment.environments) });

  let closed = false;
  return {
    app,
    server,
    url: config.publicUrl,
    close: async () => {
      if (closed) return;
      closed = true;
      if (config.writeDiscovery) rmSync(discovery, { force: true });
      await app.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      app.db.close();
    },
  };
}
