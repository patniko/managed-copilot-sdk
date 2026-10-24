/** Minimal HTTP plumbing: routing, JSON bodies, server-sent events, static files, and local-only request checks. */
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { ServerEvent } from "../shared/protocol.js";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  json<T>(): Promise<T>;
  raw(limit?: number): Promise<Buffer>;
}

export type Handler = (ctx: RequestContext) => unknown | Promise<unknown>;

interface Route {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: Handler;
  /** Browser-originated state changes must come from this app's own origin (CSRF protection). */
  readonly sameOrigin: boolean;
}

const MAX_JSON = 256 * 1024;

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "payload_too_large", "The request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

export interface SecurityOptions {
  readonly port: number;
  readonly publicUrl: string;
  readonly extraOrigins: readonly string[];
}

export class Router {
  readonly #routes: Route[] = [];
  readonly #allowedHosts: Set<string>;
  readonly #allowedOrigins: Set<string>;

  constructor(security: SecurityOptions) {
    const publicUrl = new URL(security.publicUrl);
    this.#allowedHosts = new Set([`localhost:${security.port}`, `127.0.0.1:${security.port}`, `[::1]:${security.port}`, publicUrl.host]);
    this.#allowedOrigins = new Set([publicUrl.origin, `http://localhost:${security.port}`, `http://127.0.0.1:${security.port}`, ...security.extraOrigins]);
  }

  add(method: string, path: string, handler: Handler, options: { sameOrigin?: boolean } = {}): void {
    this.#routes.push({ method, segments: path.split("/").filter(Boolean), handler, sameOrigin: options.sameOrigin ?? method !== "GET" });
  }

  #match(method: string, pathname: string): { route: Route; params: Record<string, string> } | undefined {
    const actual = pathname.split("/").filter(Boolean);
    for (const route of this.#routes) {
      if (route.method !== method || route.segments.length !== actual.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      route.segments.forEach((segment, i) => {
        if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(actual[i]!);
        else if (segment !== actual[i]) ok = false;
      });
      if (ok) return { route, params };
    }
    return undefined;
  }

  /** Returns false when no route matched (so the caller can serve static files). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = this.#match(req.method ?? "GET", url.pathname);
    if (!match) return false;
    try {
      // DNS-rebinding protection: only answer requests addressed to this server's own host names.
      if (!this.#allowedHosts.has((req.headers.host ?? "").toLowerCase())) throw new HttpError(421, "misdirected", "Unexpected Host header.");
      if (match.route.sameOrigin) {
        const origin = req.headers.origin;
        if (origin !== undefined && !this.#allowedOrigins.has(origin)) throw new HttpError(403, "forbidden_origin", "Cross-origin requests are not allowed.");
      }
      const ctx: RequestContext = {
        req,
        res,
        url,
        params: match.params,
        raw: (limit = MAX_JSON) => readBody(req, limit),
        json: async <T>() => {
          if (!(req.headers["content-type"] ?? "").includes("application/json")) throw new HttpError(415, "unsupported_media_type", "Send JSON.");
          const body = await readBody(req, MAX_JSON);
          if (body.length === 0) return {} as T;
          try {
            return JSON.parse(body.toString("utf8")) as T;
          } catch {
            throw new HttpError(400, "invalid_json", "The request body isn't valid JSON.");
          }
        },
      };
      const result = await match.route.handler(ctx);
      if (!res.headersSent && !res.writableEnded) sendJson(res, 200, result ?? { ok: true });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
      const code = (error as { code?: unknown }).code;
      const message = error instanceof Error ? error.message : "Unexpected error";
      sendJson(res, status, { error: { code: typeof code === "string" ? code : "internal", message: status === 500 && !(error instanceof HttpError) && !code ? "Something went wrong on the assistant server." : message } });
    }
    return true;
  }
}

/** Server-sent events to every open browser tab. */
export class EventHub {
  readonly #clients = new Set<ServerResponse>();
  readonly #heartbeat: NodeJS.Timeout;

  constructor() {
    this.#heartbeat = setInterval(() => {
      for (const res of this.#clients) res.write(": keep-alive\n\n");
    }, 20_000);
    this.#heartbeat.unref();
  }

  get size(): number {
    return this.#clients.size;
  }

  open(res: ServerResponse, onClose: () => void): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    this.#clients.add(res);
    res.on("close", () => {
      if (this.#clients.delete(res)) onClose();
    });
  }

  send(res: ServerResponse, event: ServerEvent): void {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  broadcast(event: ServerEvent): void {
    if (this.#clients.size === 0) return;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.#clients) res.write(frame);
  }

  close(): void {
    clearInterval(this.#heartbeat);
    for (const res of this.#clients) res.end();
    this.#clients.clear();
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const NOT_BUILT = `<!doctype html><html><head><meta charset="utf-8"><title>Assistant</title></head>
<body style="font-family:system-ui;margin:4rem auto;max-width:36rem;color:#1d1d1f">
<h1>The assistant's web UI isn't built yet</h1>
<p>Run <code>pnpm --filter @managed-copilot/demo-assistant build</code>, or start the UI dev server with
<code>pnpm --filter @managed-copilot/demo-assistant dev:web</code> and open <a href="http://localhost:7491">http://localhost:7491</a>.</p>
</body></html>`;

/** Serves the built single-page app; unknown paths without a file extension get `index.html`. */
export function serveStatic(webDir: string, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const root = resolve(webDir);
  const indexFile = join(root, "index.html");
  const security = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": CSP, "x-frame-options": "DENY" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed." } });
    return;
  }
  if (!existsSync(indexFile)) {
    res.writeHead(503, { "content-type": "text/html; charset=utf-8", ...security });
    res.end(NOT_BUILT);
    return;
  }
  let file = resolve(join(root, normalize(decodeURIComponent(url.pathname))));
  if (file !== root && !file.startsWith(root + sep)) file = indexFile;
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (extname(url.pathname)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...security });
      res.end("Not found");
      return;
    }
    file = indexFile;
  }
  const ext = extname(file);
  const immutable = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    ...security,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}
