import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { ApiErrorBody, SupportStatus, SupportTicketResponse } from "../shared/support.js";
import type { DownhillConfig } from "./config.js";
import { MAX_DEPLOY_BYTES, SIGNATURE_HEADER } from "./deploys.js";
import type { DownhillShop } from "./downhill.js";
import { DownhillError } from "./errors.js";
import { log } from "./log.js";
import { MAX_EVENT_BYTES } from "./shop-events.js";
import { LIMITS, parseSupportRequest, playerTicket, type SupportDesk } from "./support.js";

export interface ApiContext {
  readonly config: DownhillConfig;
  readonly support: SupportDesk;
  readonly shop: DownhillShop;
}

type Next = () => void;
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
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
  if (error instanceof DownhillError) return sendError(res, error.status, error.code, error.message);
  log.error("Request failed", { error: (error as Error).message });
  sendError(res, 500, "internal", "Something went wrong in the Downhill server. Check its log for details.");
}

async function readText(req: IncomingMessage, limit: number): Promise<string> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    throw new DownhillError("unsupported_media_type", "Send the request body as application/json.", 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new DownhillError("payload_too_large", "The request body is too large.", 413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const text = await readText(req, limit);
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new DownhillError("invalid_request", "The request body isn't valid JSON.");
  }
}

/** A JSON body when one was sent; nothing otherwise (an empty body is no options, whatever its content type). */
async function readOptionalJson(req: IncomingMessage, limit: number): Promise<unknown> {
  if (!Number(req.headers["content-length"] ?? 0) && !req.headers["transfer-encoding"]) return {};
  return readJson(req, limit);
}

/**
 * Blocks DNS rebinding: only loopback names may address this local server. `*.localhost` names (as Aspire can assign)
 * always resolve to loopback (RFC 6761); `DOWNHILL_ALLOWED_HOSTS` adds the deployed app's host names.
 */
export function hostAllowed(host: string | undefined, extraHosts = process.env.DOWNHILL_ALLOWED_HOSTS): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  const extra = (extraHosts ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return ["localhost", "127.0.0.1", "::1"].includes(name) || name.endsWith(".localhost") || extra.includes(name);
}

/** Cross-site requests can't change anything: a present Origin must match the Host. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function buildRoutes(ctx: ApiContext): Record<string, Partial<Record<string, Handler>>> {
  const { config, support, shop } = ctx;
  return {
    "/api/health": { GET: (_req, res) => sendJson(res, 200, { status: "ok" }) },
    "/api/support": { GET: (_req, res) => sendJson(res, 200, { connected: support.connected } satisfies SupportStatus) },
    // Support: the player's ticket in Help Desk (opened, or reopened with what's new at checkout), and its chat.
    "/api/support/tickets": {
      POST: async (req, res) => {
        const request = parseSupportRequest(await readJson(req, LIMITS.body));
        const ticket = playerTicket(request, { version: config.version, userAgent: req.headers["user-agent"] });
        const { ticketId, chatUrl } = await support.openTicket(ticket);
        const reopened = ticket.ticketId === ticketId;
        log.info(reopened ? "Reopened a support ticket in Help Desk" : "Opened a support ticket in Help Desk", { ticket: ticketId, rider: ticket.player.rider, opener: ticket.opener, code: ticket.checkout?.code, order: ticket.checkout?.order?.id });
        sendJson(res, 201, { ticketId, chatUrl } satisfies SupportTicketResponse);
      },
    },
    // What's connected and what checkout runs, for people and scripts.
    "/api/status": { GET: (_req, res) => sendJson(res, 200, { support: { connected: support.connected }, ...shop.status() }) },
    // The storefront code checkout runs now, and where the browser imports it from.
    "/api/storefront": { GET: (_req, res) => sendJson(res, 200, shop.storefront.info()) },
    // Checkout outcomes, from the shop in players' browsers.
    "/api/shop/events": {
      POST: async (req, res) => {
        shop.record(await readJson(req, MAX_EVENT_BYTES));
        res.writeHead(204, { "cache-control": "no-store" }).end();
      },
    },
    // Contract A: sales for Data Desk, server to server.
    "/api/sales": { GET: (_req, res) => sendJson(res, 200, { rows: shop.sales() }) },
    "/api/sales.csv": {
      GET: (_req, res) => {
        const csv = shop.salesCsv();
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'inline; filename="downhill-sales.csv"',
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(csv),
        });
        res.end(csv);
      },
    },
    // Contract B: the service Incident Commander investigates.
    "/api/incident/service": { GET: (_req, res) => sendJson(res, 200, shop.service()) },
    // Contract D: Incident Commander's deploy pipeline webhook.
    "/api/deploys": {
      POST: async (req, res) => {
        const body = await readText(req, MAX_DEPLOY_BYTES);
        const signature = req.headers[SIGNATURE_HEADER];
        const key = req.headers["idempotency-key"];
        sendJson(res, 200, shop.deploy(body, Array.isArray(signature) ? signature[0] : signature, Array.isArray(key) ? key[0] : key));
      },
    },
    // For rehearsals: clears live sales, deployed fixes, and the alert.
    "/api/demo/reset": {
      POST: async (req, res) => {
        const body = (await readOptionalJson(req, 1024)) as { timeline?: unknown } | null;
        sendJson(res, 200, await shop.reset({ restartTimeline: body?.timeline === "restart" }));
      },
    },
  };
}

/** `/storefront/<release>/src/….js`: a checkout module, as text. Its URL names its content, so it's cached for good. */
function serveStorefront(shop: DownhillShop, pathname: string, res: ServerResponse): void {
  const match = /^\/storefront\/([^/]+)\/(.+)$/.exec(pathname);
  const content = match ? shop.storefront.module(match[1]!, match[2]!) : undefined;
  if (content === undefined) return sendError(res, 404, "not_found", "No such storefront module.");
  res.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(content),
  });
  res.end(content);
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

// Self-contained, in the game's own colours: the panel style of its menus.
const NOT_BUILT_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Downhill · Managed Copilot</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 "Segoe UI",system-ui,-apple-system,sans-serif;color:#14204a;background:radial-gradient(ellipse at 50% 120%,#9ccf3d 0%,#4f8fd8 45%,#2f62cc 100%)}
.panel{max-width:34rem;margin:24px;padding:28px 34px 32px;background:rgba(255,246,224,.96);border:4px solid #14204a;border-radius:26px;box-shadow:0 10px 0 #14204a}
h1{margin:0 0 8px;font:900 32px/1.15 "Segoe UI Black","Arial Black","Segoe UI",sans-serif}p{margin:0}
code{padding:.15em .4em;border-radius:6px;background:#14204a14;font:90% ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
</style>
<div class="panel"><h1>Downhill isn't built yet</h1>
<p>Run <code>pnpm build</code> in <code>demos/downhill</code>, or start it with <code>pnpm dev</code>.</p></div></html>`;

/** Returns the server's request handler. `ui` serves everything outside `/api` (Vite middleware in dev). */
export function createRequestHandler(ctx: ApiContext, ui?: Middleware): (req: IncomingMessage, res: ServerResponse) => void {
  const routes = buildRoutes(ctx);
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostAllowed(req.headers.host)) {
      sendError(res, 403, "forbidden", "This host name isn't allowed. Open Downhill at http://localhost.");
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
      const route = routes[url.pathname];
      if (!route) return sendError(res, 404, "not_found", "No such API route.");
      const handler = route[method];
      if (!handler) return sendError(res, 405, "method_not_allowed", "That method isn't supported here.");
      Promise.resolve()
        .then(() => handler(req, res))
        .catch((error: unknown) => handleError(res, error));
      return;
    }
    // Checkout's storefront modules: served as files (never run here), in dev and in the build alike.
    if (url.pathname.startsWith("/storefront/")) {
      if (method !== "GET" && method !== "HEAD") return sendError(res, 405, "method_not_allowed", "That method isn't supported here.");
      return serveStorefront(ctx.shop, url.pathname, res);
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
