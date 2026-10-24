// The sandbox relay: the only path from the host gateway to each sandbox's sandboxd. It runs in a container connected
// to a published bridge network and to every sandbox network, accepts `/relay/<sandboxId>/<sandboxd route>` with the
// platform key, and forwards HTTP and upgrades (WebSocket) unchanged to `sbx-<id>:7781`. sandboxd still checks its own
// per-sandbox key, which the gateway sends as the bearer token.
import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { PLATFORM_KEY_HEADER, SANDBOX_ID_PATTERN, SANDBOX_RELAY_PORT, SANDBOXD_PORT, sandboxHostname } from "../shared/constants.js";
import { createLog } from "../shared/log.js";

const log = createLog("relay");
const key = process.env.RELAY_PLATFORM_KEY;
if (!key) {
  log.error("RELAY_PLATFORM_KEY is required; the relay is started by the Managed Copilot gateway.");
  process.exit(1);
}
delete process.env.RELAY_PLATFORM_KEY;
const expectedKey = Buffer.from(key);

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", PLATFORM_KEY_HEADER, "host"]);

function authorized(req: IncomingMessage): boolean {
  const presented = req.headers[PLATFORM_KEY_HEADER];
  if (typeof presented !== "string") return false;
  const buffer = Buffer.from(presented);
  return buffer.length === expectedKey.length && timingSafeEqual(buffer, expectedKey);
}

/** Splits `/relay/<sandboxId>/<rest>` into a target host and the sandboxd path. */
function target(rawUrl: string | undefined): { host: string; path: string } | undefined {
  const url = new URL(rawUrl ?? "/", "http://relay.local");
  const match = /^\/relay\/([^/]+)(\/.*)$/.exec(url.pathname);
  if (!match || !SANDBOX_ID_PATTERN.test(match[1]!)) return undefined;
  return { host: sandboxHostname(match[1]!), path: `${match[2]}${url.search}` };
}

function forwardHeaders(headers: IncomingHttpHeaders, keepUpgrade: boolean): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name) && !(keepUpgrade && (name === "connection" || name === "upgrade"))) continue;
    out[name] = value;
  }
  return out;
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
    return;
  }
  if (!authorized(req)) return fail(res, 403, "forbidden", "Platform credential required.");
  const destination = target(req.url);
  if (!destination) return fail(res, 404, "not_found", "Expected /relay/<sandboxId>/<path>.");
  const upstream = httpRequest(
    { host: destination.host, port: SANDBOXD_PORT, method: req.method, path: destination.path, headers: forwardHeaders(req.headers, false) },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, forwardHeaders(upstreamRes.headers, false));
      upstreamRes.pipe(res);
      upstreamRes.on("error", () => res.destroy());
    },
  );
  upstream.on("error", (error: NodeJS.ErrnoException) => {
    const unreachable = error.code === "ENOTFOUND" || error.code === "EAI_AGAIN" || error.code === "ECONNREFUSED" || error.code === "EHOSTUNREACH";
    fail(res, unreachable ? 503 : 502, "unavailable", unreachable ? "The sandbox is not reachable." : "The sandbox connection failed.");
  });
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
});

server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const reject = (status: number, message: string) => socket.end(`HTTP/1.1 ${status} Error\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(message)}\r\nconnection: close\r\n\r\n${message}`);
  if (!authorized(req)) return reject(403, "Platform credential required.");
  const destination = target(req.url);
  if (!destination) return reject(404, "Expected /relay/<sandboxId>/<path>.");
  let connected = false;
  const upstream = connect(SANDBOXD_PORT, destination.host, () => {
    connected = true;
    const lines = [`${req.method} ${destination.path} HTTP/1.1`, `host: ${destination.host}:${SANDBOXD_PORT}`];
    for (const [name, value] of Object.entries(forwardHeaders(req.headers, true))) {
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.setNoDelay(true);
  upstream.on("error", () => (connected ? socket.destroy() : reject(503, "The sandbox is not reachable.")));
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
});

server.requestTimeout = 0;
server.keepAliveTimeout = 65_000;
server.listen(SANDBOX_RELAY_PORT, "0.0.0.0", () => log.info("relay listening", { port: SANDBOX_RELAY_PORT }));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
}
