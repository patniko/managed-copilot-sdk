import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { discoveryFile, ManagedCopilotError, type DiscoveryRecord } from "@managed-copilot/protocol";
import { GatewayApp } from "./app.js";
import type { GatewayConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { sendJson } from "./http.js";
import { createLogger } from "./log.js";
import { modules } from "./modules/index.js";

export async function createGateway(config: GatewayConfig): Promise<GatewayApp> {
  const log = createLogger("gateway", config.env.LOG_LEVEL ?? "info");
  const db = openDatabase(join(config.dataDir, "gateway.db"));
  const app = new GatewayApp(config, db, log);
  try {
    for (const module of modules) {
      await module.register(app);
      app.modules.push(module.name);
      log.debug("Registered module", { module: module.name });
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return app;
}

export interface RunningGateway {
  readonly app: GatewayApp;
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

const SHUTDOWN_DEADLINE_MS = 10_000;

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** The URL clients use: the explicit public URL, or the actual listening address (so `PORT=0` works). */
function resolvePublicUrl(config: GatewayConfig, port: number): string {
  if (config.publicUrlExplicit) return config.publicUrl;
  const host = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host.includes(":") ? `[${config.host}]` : config.host;
  return `http://${host}:${port}`;
}

export async function startGateway(config: GatewayConfig): Promise<RunningGateway> {
  let app: GatewayApp | undefined;
  let accepting = true;
  const server = createServer((req, res) => {
    if (!app || !accepting) {
      sendJson(res, 503, new ManagedCopilotError("capability_unavailable", accepting ? "The gateway is starting" : "The gateway is shutting down").toBody());
      return;
    }
    app.routes.handle(app, req, res).catch((error: unknown) => {
      app?.log.error("Request handling failed", { error: (error as Error)?.stack ?? String(error) });
      if (!res.headersSent) sendJson(res, 500, new ManagedCopilotError("internal", "Internal error").toBody());
      else res.destroy();
    });
  });
  server.on("upgrade", (req, socket, head) => {
    if (!app || !accepting) {
      socket.destroy();
      return;
    }
    app.upgrades.handle(app, req, socket, head).catch((error: unknown) => {
      app?.log.error("Upgrade handling failed", { error: (error as Error)?.stack ?? String(error) });
      socket.destroy();
    });
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
    else socket.destroy();
  });

  await listen(server, config.port, config.host);
  const port = (server.address() as AddressInfo).port;
  const resolved: GatewayConfig = { ...config, port, publicUrl: resolvePublicUrl(config, port) };
  try {
    app = await createGateway(resolved);
    await app.start();
  } catch (error) {
    accepting = false;
    await app?.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app?.db.close();
    throw error;
  }
  const running = app;

  const discovery = discoveryFile();
  if (resolved.writeDiscovery) {
    const record: DiscoveryRecord = { name: resolved.deployment.name, url: resolved.publicUrl, pid: process.pid, startedAt: new Date().toISOString(), version: resolved.version };
    mkdirSync(dirname(discovery), { recursive: true });
    writeFileSync(discovery, JSON.stringify(record, null, 2));
  }
  running.log.info("Managed Copilot gateway listening", { url: resolved.publicUrl, mode: resolved.mode, environments: Object.keys(resolved.deployment.environments) });

  let closing: Promise<void> | undefined;
  return {
    app: running,
    server,
    url: resolved.publicUrl,
    close: () => {
      closing ??= (async () => {
        accepting = false;
        if (resolved.writeDiscovery) removeDiscovery(discovery);
        const stopped = running.stop();
        await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DEADLINE_MS).unref())]);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await stopped.catch(() => undefined);
        running.db.close();
      })();
      return closing;
    },
  };
}

/** Deletes the discovery record only if this process wrote it. */
function removeDiscovery(file: string): void {
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as Partial<DiscoveryRecord>;
    if (record.pid === process.pid) rmSync(file, { force: true });
  } catch {
    // Missing or unreadable: nothing of ours to remove.
  }
}
