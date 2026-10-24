import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { SandboxStartEvent, SandboxStartRequest } from "@managed-copilot/protocol";
import { LIMITS, PATHS, ROUTES, SANDBOX_RUNTIME_PORT, SANDBOXD_PORT } from "../shared/constants.js";
import type { Log } from "../shared/log.js";
import { normalizeWorkspacePath, PathError } from "../shared/paths.js";
import { AgentError, type SandboxAgent } from "./agent.js";
import { LoopbackBridge } from "./bridge.js";
import { listEntries, openRegularFile, outputsManifest } from "./fsops.js";

const STATUS: Record<string, number> = { invalid_request: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503, internal: 500, authentication_required: 401 };

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res: ServerResponse, error: unknown, log: Log): void {
  let code = "internal";
  let message = "Internal error";
  if (error instanceof PathError || error instanceof AgentError) {
    code = error.code;
    message = error.message;
  } else {
    log.error("Request failed", { error: (error as Error)?.message ?? String(error) });
  }
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, STATUS[code] ?? 500, { error: { code, message } });
}

async function readJson<T>(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new AgentError("invalid_request", "Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new AgentError("invalid_request", "Request body is not valid JSON.");
  }
}

export interface ServerOptions {
  readonly key: string;
  readonly agent: SandboxAgent;
  readonly log: Log;
}

/** sandboxd's HTTP API. Every route requires the per-sandbox bearer key. */
export function createSandboxdServer(options: ServerOptions): Server {
  const { agent, log } = options;
  const expected = Buffer.from(`Bearer ${options.key}`);
  const bridge = new LoopbackBridge(log);
  agent.runtime.onExit(() => bridge.closeAll("runtime"));

  const authorized = (req: IncomingMessage): boolean => {
    const header = Buffer.from(req.headers.authorization ?? "");
    return header.length === expected.length && timingSafeEqual(header, expected);
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => sendError(res, error, log));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://sandboxd.local");
    if (!authorized(req)) {
      sendJson(res, 401, { error: { code: "authentication_required", message: "A valid sandbox key is required." } });
      return;
    }
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case `GET ${ROUTES.health}`:
      case `GET ${ROUTES.status}`:
        sendJson(res, 200, agent.status());
        return;
      case `POST ${ROUTES.start}`: {
        const request = await readJson<SandboxStartRequest>(req);
        if (request.mode !== "create" && request.mode !== "resume") throw new AgentError("invalid_request", 'mode must be "create" or "resume".');
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
        const emit = (event: SandboxStartEvent) => {
          if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
        };
        await agent.start(request, emit);
        res.end();
        return;
      }
      case `GET ${ROUTES.files}`: {
        const relative = normalizeWorkspacePath(url.searchParams.get("path") ?? "", { allowRoot: true });
        const entries = await listEntries(PATHS.workspace, relative, { recursive: url.searchParams.get("recursive") === "true", limit: LIMITS.listEntries });
        sendJson(res, 200, entries);
        return;
      }
      case `GET ${ROUTES.fileContent}`:
        await streamFile(res, PATHS.workspace, normalizeWorkspacePath(url.searchParams.get("path")));
        return;
      case `PUT ${ROUTES.fileContent}`: {
        const relative = normalizeWorkspacePath(url.searchParams.get("path"));
        const length = req.headers["content-length"] === undefined ? undefined : Number(req.headers["content-length"]);
        if (length !== undefined && (!Number.isFinite(length) || length < 0)) throw new AgentError("invalid_request", "Invalid Content-Length.");
        if (length !== undefined && length > LIMITS.uploadBytes) throw new AgentError("invalid_request", `Uploads are limited to ${LIMITS.uploadBytes} bytes.`);
        const controller = new AbortController();
        req.on("aborted", () => controller.abort());
        const entry = await agent.writeFile(relative, req, { overwrite: url.searchParams.get("overwrite") !== "false", ...(length !== undefined ? { expectedBytes: length } : {}), signal: controller.signal });
        sendJson(res, 201, entry);
        return;
      }
      case `POST ${ROUTES.outputsManifest}`:
        sendJson(res, 200, await outputsManifest(PATHS.outputs, LIMITS.artifacts));
        return;
      case `GET ${ROUTES.outputsContent}`:
        await streamFile(res, PATHS.outputs, normalizeWorkspacePath(url.searchParams.get("path"), { root: PATHS.outputs }));
        return;
      default:
        sendJson(res, 404, { error: { code: "not_found", message: `No route for ${req.method} ${url.pathname}` } });
    }
  }

  async function streamFile(res: ServerResponse, root: string, relative: string): Promise<void> {
    const opened = await openRegularFile(root, relative);
    try {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": opened.stat.size,
        "x-file-modified-at": opened.stat.mtime.toISOString(),
      });
      if (opened.stat.size === 0) {
        res.end();
        return;
      }
      const stream = opened.handle.createReadStream({ start: 0, end: opened.stat.size - 1, autoClose: false });
      await new Promise<void>((resolve, reject) => {
        stream.on("error", reject);
        res.on("close", resolve);
        stream.pipe(res);
      });
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (status: number, message: string) => {
      const body = JSON.stringify({ error: { code: status === 401 ? "authentication_required" : status === 503 ? "unavailable" : "invalid_request", message } });
      socket.end(`HTTP/1.1 ${status} Error\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
    };
    const url = new URL(req.url ?? "/", "http://sandboxd.local");
    if (!authorized(req)) return reject(401, "A valid sandbox key is required.");
    if (url.pathname === ROUTES.runtime) {
      if (agent.runtime.state !== "running") return reject(503, `The Copilot runtime is ${agent.runtime.state}.`);
      bridge.accept(req, socket, head, SANDBOX_RUNTIME_PORT, "runtime");
      return;
    }
    if (url.pathname === ROUTES.tunnel) {
      const port = Number(url.searchParams.get("port"));
      if (!Number.isInteger(port) || port < 1 || port > 65535 || port === SANDBOXD_PORT) return reject(400, "A loopback port between 1 and 65535 is required.");
      bridge.accept(req, socket, head, port, "tunnel");
      return;
    }
    reject(404, `No upgrade route for ${url.pathname}`);
  });

  server.keepAliveTimeout = 65_000;
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  return server;
}
