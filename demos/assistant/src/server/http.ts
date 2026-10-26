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
  /** Extra host names (any port), or `name:port` for one port only. */
  readonly extraHosts?: readonly string[];
}

export class Router {
  readonly #routes: Route[] = [];
  readonly #allowedHosts: Set<string>;
  readonly #allowedOrigins: Set<string>;

  constructor(security: SecurityOptions) {
    const publicUrl = new URL(security.publicUrl);
    const extraHosts = (security.extraHosts ?? []).map((host) => host.toLowerCase());
    this.#allowedHosts = new Set([`localhost:${security.port}`, `127.0.0.1:${security.port}`, `[::1]:${security.port}`, publicUrl.host, ...extraHosts]);
    this.#allowedOrigins = new Set([publicUrl.origin, `http://localhost:${security.port}`, `http://127.0.0.1:${security.port}`, ...security.extraOrigins]);
  }

  /**
   * DNS-rebinding protection: only answer requests addressed to this server's own names. `*.localhost` always resolves
   * to loopback (RFC 6761); configured extra names match on any port.
   */
  #hostAllowed(header: string | undefined): boolean {
    const host = (header ?? "").toLowerCase();
    if (!host) return false;
    if (this.#allowedHosts.has(host)) return true;
    const name = host.replace(/:\d+$/, "");
    return name.endsWith(".localhost") || this.#allowedHosts.has(name);
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
      if (!this.#hostAllowed(req.headers.host)) throw new HttpError(421, "misdirected", "Unexpected Host header.");
      if (match.route.sameOrigin) {
        const origin = req.headers.origin;
        if (origin !== undefined && !this.#allowedOrigins.has(origin)) throw new HttpError(403, "forbidden_origin", "Cross-origin requests are not allowed.");
        // Browsers label cross-site requests, including ones that send no Origin (images, some navigations).
        const site = req.headers["sec-fetch-site"];
        if (site !== undefined && site !== "same-origin" && site !== "none") throw new HttpError(403, "forbidden_origin", "Cross-site requests are not allowed.");
        // A cross-site form can't send JSON, and a cross-site fetch can't without a CORS preflight this server never grants.
        if (req.method === "POST" && !(req.headers["content-type"] ?? "").includes("application/json")) throw new HttpError(415, "unsupported_media_type", "Send JSON.");
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

/** Shown when the built UI is missing. It can't load the GitHub theme, so it carries GitHub's light and dark colors inline. */
const NOT_BUILT = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Web UI not built · Assistant · Managed Copilot</title>
<style>
:root{--fg:#1f2328;--muted:#59636e;--canvas:#ffffff;--inset:#f6f8fa;--border:#d1d9e0;--accent:#0969da;--attention:#9a6700;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--fg:#f0f6fc;--muted:#9198a1;--canvas:#0d1117;--inset:#010409;--border:#3d444d;--accent:#4493f8;--attention:#d29922;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;color:var(--fg);background:var(--canvas)}
header{display:flex;align-items:center;gap:12px;min-height:64px;padding:16px;background:var(--inset);box-shadow:inset 0 -1px 0 var(--border)}
svg{fill:currentColor;flex-shrink:0}
nav{display:flex;align-items:center;gap:4px}
nav span{padding:4px 6px}
nav .divider{padding:0;color:var(--muted)}
nav [aria-current]{font-weight:600}
main{max-width:640px;margin:64px auto;padding:0 16px}
.box{padding:32px;text-align:center;border:1px solid var(--border);border-radius:6px}
.icon{color:var(--attention)}
h1{margin:8px 0 4px;font-size:20px;font-weight:600;line-height:1.5}
p{margin:0;color:var(--muted)}
pre{margin:8px 0 0;padding:12px 16px;overflow-x:auto;text-align:left;font:12px/1.5 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;color:var(--fg);background:var(--inset);border:1px solid var(--border);border-radius:6px}
.step{margin-top:24px;text-align:left}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
</style>
</head>
<body>
<header>
<svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943"/></svg>
<nav aria-label="Breadcrumb"><span>Managed Copilot</span><span class="divider" aria-hidden="true">/</span><span aria-current="page">Assistant</span></nav>
</header>
<main>
<div class="box">
<svg class="icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 17.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm-.25-8.25a.75.75 0 0 0-1.5 0v4.5a.75.75 0 0 0 1.5 0v-4.5Z"/><path d="M9.836 3.244c.963-1.665 3.365-1.665 4.328 0l8.967 15.504c.963 1.667-.24 3.752-2.165 3.752H3.034c-1.926 0-3.128-2.085-2.165-3.752Zm3.03.751a1.002 1.002 0 0 0-1.732 0L2.168 19.499A1.002 1.002 0 0 0 3.034 21h17.932a1.002 1.002 0 0 0 .866-1.5L12.866 3.994Z"/></svg>
<h1>The assistant's web UI isn't built yet</h1>
<p>The server is running, but there's no web UI to serve.</p>
<div class="step"><p>Build it, then reload this page:</p><pre>pnpm --filter @managed-copilot/demo-assistant build</pre></div>
<div class="step"><p>Or start the UI dev server and open <a href="http://localhost:7491">http://localhost:7491</a>:</p><pre>pnpm --filter @managed-copilot/demo-assistant dev:web</pre></div>
</div>
</main>
</body>
</html>`;

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
