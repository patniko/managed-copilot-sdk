/**
 * A second listener for the egress proxy where Docker runs natively on this machine (Docker Engine on Linux). There,
 * `host.docker.internal:host-gateway` is a bridge address rather than the host's loopback, so a gateway listening only
 * on 127.0.0.1 is unreachable from the egress container. The supervisor asks this listener to bind the egress
 * network's bridge address, which serves the egress routes (`EGRESS_ROUTES`, all of which need the egress key) and
 * nothing else. Docker Desktop and other VM-based engines route `host-gateway` to the host's loopback and never use it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EGRESS_ROUTES, ManagedCopilotError } from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import { sendJson } from "../../http.js";
import type { Logger } from "../../log.js";

const EGRESS_PATHS = new Set<string>(Object.values(EGRESS_ROUTES));

/** Whether a listen host accepts loopback connections only. */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
}

function listen(server: Server, port: number, address: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, address, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

export class EgressListener {
  readonly #app: GatewayApp;
  readonly #log: Logger;
  #server: Server | undefined;
  #address: string | undefined;
  #port = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(app: GatewayApp, log: Logger) {
    this.#app = app;
    this.#log = log;
  }

  /**
   * Serves the egress routes on `address`, on the gateway's port when it is free, moving the listener when the address
   * changed. Returns the port, or undefined when the address is not this machine's (the Docker engine runs elsewhere,
   * such as in Docker Desktop's VM). Binding decides that: a fresh bridge with no containers yet has no carrier, and
   * `os.networkInterfaces()` omits such interfaces.
   */
  listen(address: string): Promise<number | undefined> {
    const next = this.#queue.then(() => this.#listen(address));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #listen(address: string): Promise<number | undefined> {
    if (this.#server && this.#address === address) return this.#port;
    if (this.#server) await this.#close();
    const server = this.#create();
    try {
      await listen(server, this.#app.config.port, address);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRNOTAVAIL") return undefined;
      if (code !== "EADDRINUSE") throw error;
      this.#log.warn("The gateway's port is taken on the egress bridge address; the egress proxy uses another port", { address, port: this.#app.config.port });
      await listen(server, 0, address);
    }
    this.#server = server;
    this.#address = address;
    this.#port = (server.address() as AddressInfo).port;
    this.#log.info("Listening for the egress proxy on its Docker bridge", { address, port: this.#port });
    return this.#port;
  }

  #create(): Server {
    const app = this.#app;
    const server = createServer((req, res) => {
      let path = "";
      try {
        path = new URL(req.url ?? "/", "http://gateway.local").pathname;
      } catch {
        // Malformed: refused below.
      }
      if (!EGRESS_PATHS.has(path)) {
        sendJson(res, 404, new ManagedCopilotError("not_found", "This address serves only the egress proxy").toBody());
        return;
      }
      app.routes.handle(app, req, res).catch((error: unknown) => {
        app.log.error("Request handling failed", { error: (error as Error)?.stack ?? String(error) });
        if (!res.headersSent) sendJson(res, 500, new ManagedCopilotError("internal", "Internal error").toBody());
        else res.destroy();
      });
    });
    server.on("upgrade", (_req, socket) => socket.destroy());
    server.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
      else socket.destroy();
    });
    return server;
  }

  async #close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#address = undefined;
    if (server) await close(server);
  }

  close(): Promise<void> {
    const next = this.#queue.then(() => this.#close());
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
