import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Assistant } from "./assistant.js";
import { loadConfig } from "./config.js";
import { Router, serveStatic } from "./http.js";
import { createLogger, errorMessage } from "./log.js";

const log = createLogger("assistant");

process.on("unhandledRejection", (reason) => log.error("Unhandled rejection", { error: errorMessage(reason) }));

async function main(): Promise<void> {
  const config = loadConfig();
  const assistant = new Assistant(config, log);
  const router = new Router({ port: config.port, publicUrl: config.publicUrl, extraOrigins: config.devOrigins, extraHosts: config.allowedHosts });
  assistant.routes(router);

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    void router.handle(req, res).then((handled) => {
      if (!handled) serveStatic(config.webDir, req, res);
    });
  };

  const servers: Server[] = [];
  for (const host of config.hosts) {
    const server = createServer(handler);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, host, () => resolve());
      });
      servers.push(server);
    } catch (error) {
      // IPv6 loopback may be unavailable; IPv4 loopback is required.
      if (servers.length === 0 && host === config.hosts[config.hosts.length - 1]) throw error;
      log.debug("Not listening on host", { host, error: errorMessage(error) });
    }
  }
  if (servers.length === 0) throw new Error(`Couldn't listen on port ${config.port}`);

  assistant.start();
  log.info("Assistant is running", {
    url: config.publicUrl,
    environment: config.environment,
    model: config.model,
    google: config.google ? "configured" : "demo data only",
    webhook: config.webhookSecret ? "configured" : "not configured (polling only)",
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("Shutting down", { signal });
    for (const server of servers) server.close();
    for (const server of servers) server.closeAllConnections();
    await assistant.stop().catch((error) => log.warn("Shutdown error", { error: errorMessage(error) }));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  log.error("The assistant failed to start", { error: errorMessage(error) });
  process.exit(1);
});
