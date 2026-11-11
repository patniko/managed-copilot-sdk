import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { isManagedCopilotError } from "@managed-copilot/sdk";
import type { ApiErrorBody, CreateAnalysisRequest, MoveAnswer, SendMessageRequest, SendToFactoryRequest } from "../shared/types.js";
import { isValidSessionId, launchAttach } from "./attach.js";
import type { DeskConfig } from "./config.js";
import { DeskError } from "./errors.js";
import type { EventHub } from "./hub.js";
import { log } from "./log.js";
import type { AnalysisManager } from "./manager.js";

export interface ApiContext {
  readonly analyses: AnalysisManager;
  readonly hub: EventHub;
  readonly config: DeskConfig;
}

type Next = () => void;
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;
type Params = Record<string, string>;
type Handler = (req: IncomingMessage, res: ServerResponse, params: Params, url: URL) => Promise<void> | void;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  const body: ApiErrorBody = { error: { code, message } };
  sendJson(res, status, body);
}

function handleError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof DeskError) return sendError(res, error.status, error.code, error.message);
  if (isManagedCopilotError(error)) return sendError(res, error.status, error.code, error.message);
  log.error("Request failed", { error: (error as Error).message });
  sendError(res, 500, "internal", "Something went wrong in the Data Desk server. Check its log for details.");
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new DeskError("payload_too_large", "The request body is too large.", 413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage, limit = 64 * 1024): Promise<T> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    throw new DeskError("unsupported_media_type", "Send the request body as application/json.", 415);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readBody(req, limit)).toString("utf8") || "{}");
  } catch (error) {
    if (error instanceof DeskError) throw error;
    throw new DeskError("invalid_request", "The request body isn't valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new DeskError("invalid_request", "The request body must be a JSON object.");
  return parsed as T;
}

/**
 * Blocks DNS rebinding: only loopback names may address this local server. `*.localhost` names (as Aspire can assign)
 * always resolve to loopback (RFC 6761); `DATA_DESK_ALLOWED_HOSTS` adds more for deliberate remote setups.
 */
export function hostAllowed(host: string | undefined, extraHosts = process.env.DATA_DESK_ALLOWED_HOSTS): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  const extra = (extraHosts ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return ["localhost", "127.0.0.1", "::1"].includes(name) || name.endsWith(".localhost") || extra.includes(name);
}

/** Cross-site requests can't drive Data Desk: a present Origin must match the Host. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * Data Desk's address as the person's browser sees it, for links back to it: the request's Origin (checked to match
 * the Host above), else its Host.
 */
export function appOrigin(req: Pick<IncomingMessage, "headers">): string {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // Not a URL ("null" from a sandboxed page): use the Host.
    }
  }
  return `http://${req.headers.host ?? "localhost"}`;
}

class Router {
  readonly #routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];

  add(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/\//g, "\\/").replace(/:([a-zA-Z]+)/g, (_, key: string) => {
        keys.push(key);
        return "([^/]+)";
      })}$`,
    );
    this.#routes.push({ method, pattern, keys, handler });
  }

  match(method: string, pathname: string): { handler: Handler; params: Params } | "method_not_allowed" | undefined {
    let pathMatched = false;
    for (const route of this.#routes) {
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Params = {};
      for (const [index, key] of route.keys.entries()) {
        const value = safeDecode(match[index + 1]!);
        if (value === undefined) return undefined;
        params[key] = value;
      }
      return { handler: route.handler, params };
    }
    return pathMatched ? "method_not_allowed" : undefined;
  }
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** A file name for `content-disposition`: plain characters only. */
const dispositionName = (path: string): string => (path.split("/").at(-1) ?? "output").replace(/[^A-Za-z0-9._-]+/g, "_");

function buildRouter(ctx: ApiContext): Router {
  const router = new Router();
  const { analyses } = ctx;

  router.add("GET", "/api/health", (_req, res) => sendJson(res, 200, { status: "ok", platform: analyses.platform.status.state }));
  router.add("GET", "/api/state", (_req, res) => sendJson(res, 200, analyses.state()));
  router.add("GET", "/api/events", (req, res) => ctx.hub.attach(req, res, analyses.initialEvents()));
  router.add("GET", "/api/datasets/:id/rows", (_req, res, params, url) => {
    sendJson(res, 200, analyses.rows(params.id!, Number(url.searchParams.get("offset") ?? 0), Number(url.searchParams.get("limit") ?? 200)));
  });
  router.add("POST", "/api/datasets", async (req, res) => {
    const name = safeDecode(String(req.headers["x-file-name"] ?? "")) ?? "";
    if (!/\.(csv|tsv|txt)$/i.test(name)) throw new DeskError("invalid_request", "Upload a CSV file (.csv).");
    const bytes = await readBody(req, analyses.datasets.maxBytes + 1);
    sendJson(res, 201, analyses.upload(name, bytes));
  });
  router.add("POST", "/api/analyses", async (req, res) => {
    const body = await readJson<Partial<CreateAnalysisRequest>>(req);
    if (typeof body.datasetId !== "string" || !body.datasetId) throw new DeskError("invalid_request", "Pick a dataset first.");
    sendJson(res, 201, await analyses.create(body.datasetId));
  });
  router.add("GET", "/api/analyses/:id", async (_req, res, params) => sendJson(res, 200, await analyses.view(params.id!)));
  router.add("DELETE", "/api/analyses/:id", async (_req, res, params) => {
    await analyses.delete(params.id!);
    res.writeHead(204).end();
  });
  router.add("POST", "/api/analyses/:id/messages", async (req, res, params) => {
    const body = await readJson<Partial<SendMessageRequest>>(req);
    await analyses.send(params.id!, body.prompt);
    res.writeHead(202).end();
  });
  router.add("POST", "/api/analyses/:id/move", async (req, res, params) => {
    const body = await readJson<Partial<MoveAnswer>>(req);
    if (typeof body.approve !== "boolean") throw new DeskError("invalid_request", "Pass approve: true or false.");
    sendJson(res, 200, analyses.answerMove(params.id!, body.approve));
  });
  router.add("POST", "/api/analyses/:id/stop", async (_req, res, params) => {
    await analyses.stop(params.id!);
    res.writeHead(202).end();
  });
  router.add("GET", "/api/analyses/:id/output", async (_req, res, params, url) => {
    const path = url.searchParams.get("path");
    if (!path) throw new DeskError("invalid_request", "Pass the file's path.");
    const { file, bytes } = await analyses.readOutput(params.id!, path);
    const image = file.kind === "chart" && url.searchParams.get("download") !== "1";
    res.writeHead(200, {
      "content-type": MIME[extname(file.path).toLowerCase()] ?? "application/octet-stream",
      "content-length": bytes.byteLength,
      "content-disposition": `${image ? "inline" : "attachment"}; filename="${dispositionName(file.path)}"`,
      // Files come from the sandbox: shown as images, never run as this app's pages.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=3600",
    });
    res.end(Buffer.from(bytes));
  });
  router.add("POST", "/api/analyses/:id/attach", async (_req, res, params) => {
    const id = params.id!;
    if (!isValidSessionId(id) || !analyses.owns(id)) throw new DeskError("not_found", "That session isn't one of Data Desk's analyses.", 404);
    sendJson(res, 200, await launchAttach(id, ctx.config.repoRoot, analyses.platform.status.url, ctx.config.attachUrl));
  });
  router.add("POST", "/api/analyses/:id/factory", async (req, res, params) => {
    analyses.requireFactory();
    // Selected rows are sent as their positions: up to 10,000 of them per table.
    const body = await readJson<Partial<SendToFactoryRequest>>(req, 256 * 1024);
    sendJson(res, 201, await analyses.sendToFactory(params.id!, body, appOrigin(req)));
  });
  return router;
}

function serveStatic(webRoot: string, pathname: string, res: ServerResponse): boolean {
  const root = resolve(webRoot);
  const decoded = safeDecode(pathname);
  if (decoded === undefined) return false;
  let file = resolve(join(root, decoded));
  if (file !== root && !file.startsWith(root + sep)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(pathname)) return false;
    file = join(root, "index.html");
    if (!existsSync(file)) return false;
  }
  const immutable = pathname.startsWith("/assets/");
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  createReadStream(file).pipe(res);
  return true;
}

// Self-contained (it can't load the UI's theme): GitHub's light and dark colors, the GitHub mark, and a blankslate.
const GITHUB_MARK =
  "M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943";
const NOT_BUILT_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Data Desk · Managed Copilot</title>
<style>
:root{--fg:#1f2328;--muted:#59636e;--canvas:#ffffff;--inset:#f6f8fa;--border:#d1d9e0;--code:#818b981f}
@media (prefers-color-scheme:dark){:root{--fg:#f0f6fc;--muted:#9198a1;--canvas:#0d1117;--inset:#010409;--border:#3d444d;--code:#656c7633}}
body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;color:var(--fg);background:var(--canvas)}
header{display:flex;align-items:center;gap:12px;min-height:64px;padding:0 16px;background:var(--inset);box-shadow:inset 0 -1px 0 var(--border)}
header svg{fill:currentColor}header strong{font-weight:600}.sep{color:var(--muted)}main{max-width:44rem;margin:64px auto;padding:0 16px}
.box{padding:80px 40px;text-align:center;border:1px solid var(--border);border-radius:6px}
h1{margin:0 0 4px;font-size:20px;font-weight:600}p{margin:0;color:var(--muted)}
code{padding:.2em .4em;font:85% ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;color:var(--fg);background:var(--code);border-radius:6px}
</style>
<header><svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true"><path d="${GITHUB_MARK}"/></svg>
<span>Managed Copilot</span><span class="sep">/</span><strong>Data Desk</strong></header>
<main><div class="box"><h1>Data Desk's UI isn't built yet</h1>
<p>Run <code>pnpm build</code> in <code>demos/data-desk</code>, or start it with <code>pnpm dev</code>.</p></div></main></html>`;

/** Returns the server's request handler. `ui` serves everything outside `/api` (Vite middleware in dev). */
export function createRequestHandler(ctx: ApiContext, ui?: Middleware): (req: IncomingMessage, res: ServerResponse) => void {
  const router = buildRouter(ctx);
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostAllowed(req.headers.host)) {
      sendError(res, 403, "forbidden", "This host name isn't allowed. Open Data Desk at http://localhost.");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (url.pathname.startsWith("/api/")) {
      if (safeDecode(url.pathname) === undefined) return sendError(res, 400, "invalid_request", "The request path is malformed.");
      if (method !== "GET" && method !== "HEAD" && !originAllowed(req)) {
        sendError(res, 403, "forbidden", "Cross-site requests aren't allowed.");
        return;
      }
      const match = router.match(method, url.pathname);
      if (match === "method_not_allowed") return sendError(res, 405, "method_not_allowed", "That method isn't supported here.");
      if (!match) return sendError(res, 404, "not_found", "No such API route.");
      Promise.resolve()
        .then(() => match.handler(req, res, match.params, url))
        .catch((error: unknown) => handleError(res, error));
      return;
    }
    if (ui) {
      ui(req, res, () => sendError(res, 404, "not_found", "Not found."));
      return;
    }
    if (method === "GET" && serveStatic(ctx.config.webRoot, url.pathname, res)) return;
    if (method === "GET" && !extname(url.pathname)) {
      res.writeHead(503, { "content-type": "text/html; charset=utf-8" }).end(NOT_BUILT_PAGE);
      return;
    }
    sendError(res, 404, "not_found", "Not found.");
  };
  return (req, res) => {
    try {
      handle(req, res);
    } catch (error) {
      handleError(res, error);
    }
  };
}
