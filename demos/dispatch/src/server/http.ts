import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { isManagedCopilotError } from "@managed-copilot/sdk";
import type { ApiErrorBody, ApprovalAnswer, CreateConversationRequest, SendMessageRequest, SendMessageResponse, SettingsRequest } from "../shared/types.js";
import { isValidSessionId, launchAttach } from "./attach.js";
import type { DispatchConfig } from "./config.js";
import { isStyle } from "./config.js";
import { DispatchError } from "./errors.js";
import type { EventHub } from "./hub.js";
import { log } from "./log.js";
import type { ConversationManager } from "./manager.js";

export interface ApiContext {
  readonly conversations: ConversationManager;
  readonly hub: EventHub;
  readonly config: DispatchConfig;
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
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
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
  if (error instanceof DispatchError) return sendError(res, error.status, error.code, error.message);
  if (isManagedCopilotError(error)) return sendError(res, error.status, error.code, error.message);
  log.error("Request failed", { error: (error as Error).message });
  sendError(res, 500, "internal", "Something went wrong in the Dispatch server. Check its log for details.");
}

async function readJson<T>(req: IncomingMessage, limit = 64 * 1024): Promise<T> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    throw new DispatchError("unsupported_media_type", "Send the request body as application/json.", 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new DispatchError("payload_too_large", "The request body is too large.", 413);
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new DispatchError("invalid_request", "The request body isn't valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new DispatchError("invalid_request", "The request body must be a JSON object.");
  return parsed as T;
}

/**
 * Blocks DNS rebinding: only loopback names may address this local server. `*.localhost` names (as Aspire can assign)
 * always resolve to loopback (RFC 6761); `DISPATCH_ALLOWED_HOSTS` adds more for deliberate remote setups.
 */
export function hostAllowed(host: string | undefined, extraHosts = process.env.DISPATCH_ALLOWED_HOSTS): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  const extra = (extraHosts ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return ["localhost", "127.0.0.1", "::1"].includes(name) || name.endsWith(".localhost") || extra.includes(name);
}

/** Cross-site requests can't drive Dispatch: a present Origin must match the Host. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
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

const approvalMode = (value: unknown) => (value === "ask" || value === "auto" ? value : undefined);

function buildRouter(ctx: ApiContext): Router {
  const router = new Router();
  const { conversations } = ctx;

  router.add("GET", "/api/health", (_req, res) => sendJson(res, 200, { status: "ok", platform: conversations.platform.status.state }));
  router.add("GET", "/api/state", (_req, res) => sendJson(res, 200, conversations.state()));
  router.add("GET", "/api/events", (req, res) => ctx.hub.attach(req, res, conversations.initialEvents()));
  router.add("POST", "/api/conversations", async (req, res) => {
    const body = await readJson<Partial<CreateConversationRequest>>(req);
    if (body.approvals !== undefined && !approvalMode(body.approvals)) throw new DispatchError("invalid_request", 'approvals must be "ask" or "auto".');
    if (body.style !== undefined && !isStyle(body.style)) throw new DispatchError("invalid_request", 'style must be "delegate", "direct", or "mixed".');
    sendJson(res, 201, await conversations.create(String(body.prompt ?? ""), approvalMode(body.approvals), body.style));
  });
  router.add("GET", "/api/conversations/:id", async (_req, res, params) => sendJson(res, 200, await conversations.view(params.id!)));
  router.add("DELETE", "/api/conversations/:id", async (_req, res, params) => {
    await conversations.delete(params.id!);
    res.writeHead(204).end();
  });
  router.add("POST", "/api/conversations/:id/messages", async (req, res, params) => {
    const body = await readJson<Partial<SendMessageRequest>>(req);
    const messageId = await conversations.send(params.id!, String(body.prompt ?? ""));
    const answer: SendMessageResponse = messageId ? { messageId } : {};
    sendJson(res, 202, answer);
  });
  router.add("POST", "/api/conversations/:id/approvals/:approvalId", async (req, res, params) => {
    const body = await readJson<Partial<ApprovalAnswer>>(req);
    if (typeof body.approve !== "boolean") throw new DispatchError("invalid_request", "Pass approve: true or false.");
    if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 1_000)) throw new DispatchError("invalid_request", "Keep the reason under 1,000 characters.");
    if (body.rest !== undefined && typeof body.rest !== "boolean") throw new DispatchError("invalid_request", "Pass rest: true or false.");
    conversations.answer(params.id!, params.approvalId!, body.approve, body.reason, body.rest);
    res.writeHead(204).end();
  });
  router.add("PUT", "/api/conversations/:id/settings", async (req, res, params) => {
    const body = await readJson<Partial<SettingsRequest>>(req);
    const approvals = approvalMode(body.approvals);
    if (!approvals) throw new DispatchError("invalid_request", 'approvals must be "ask" or "auto".');
    sendJson(res, 200, conversations.setSettings(params.id!, { approvals }));
  });
  router.add("GET", "/api/conversations/:id/workers/:workerId/files", async (_req, res, params) => sendJson(res, 200, await conversations.files(params.id!, params.workerId!)));
  router.add("GET", "/api/conversations/:id/workers/:workerId/commands", async (_req, res, params) => sendJson(res, 200, await conversations.commands(params.id!, params.workerId!)));
  router.add("GET", "/api/conversations/:id/workers/:workerId/file", async (_req, res, params, url) => {
    const path = url.searchParams.get("path");
    if (!path) throw new DispatchError("invalid_request", "Pass the file's path.");
    sendJson(res, 200, await conversations.readFile(params.id!, params.workerId!, path));
  });
  router.add("POST", "/api/sessions/:sessionId/attach", async (_req, res, params) => {
    const sessionId = params.sessionId!;
    if (!isValidSessionId(sessionId) || !conversations.owns(sessionId)) throw new DispatchError("not_found", "That session isn't one of Dispatch's conversations or workers.", 404);
    sendJson(res, 200, await launchAttach(sessionId, ctx.config.repoRoot, conversations.platform.status.url, ctx.config.attachUrl));
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
<meta name="color-scheme" content="light dark"><title>Dispatch · Managed Copilot</title>
<style>
:root{--fg:#1f2328;--muted:#59636e;--canvas:#ffffff;--inset:#f6f8fa;--border:#d1d9e0;--code:#818b981f}
@media (prefers-color-scheme:dark){:root{--fg:#f0f6fc;--muted:#9198a1;--canvas:#0d1117;--inset:#010409;--border:#3d444d;--code:#656c7633}}
body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;color:var(--fg);background:var(--canvas)}
header{display:flex;align-items:center;gap:12px;min-height:64px;padding:0 16px;background:var(--inset);box-shadow:inset 0 -1px 0 var(--border)}
header svg{fill:currentColor}header strong{font-weight:600}.sep{color:var(--muted)}main{max-width:44rem;margin:64px auto;padding:0 16px}
.box{padding:80px 40px;text-align:center;border:1px solid var(--border);border-radius:6px}
.box svg{fill:var(--muted)}h1{margin:8px 0 4px;font-size:20px;font-weight:600}p{margin:0;color:var(--muted)}
code{padding:.2em .4em;font:85% ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;color:var(--fg);background:var(--code);border-radius:6px}
</style>
<header><svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true"><path d="${GITHUB_MARK}"/></svg>
<span>Managed Copilot</span><span class="sep">/</span><strong>Dispatch</strong></header>
<main><div class="box"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M1 3a2 2 0 0 1 2-2h6.5a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H7v4.063C7 16.355 7.644 17 8.438 17H12.5v-2.5a2 2 0 0 1 2-2H21a2 2 0 0 1 2 2V21a2 2 0 0 1-2 2h-6.5a2 2 0 0 1-2-2v-2.5H8.437A2.939 2.939 0 0 1 5.5 15.562V11.5H3a2 2 0 0 1-2-2Zm2-.5a.5.5 0 0 0-.5.5v6.5a.5.5 0 0 0 .5.5h6.5a.5.5 0 0 0 .5-.5V3a.5.5 0 0 0-.5-.5ZM14.5 14a.5.5 0 0 0-.5.5V21a.5.5 0 0 0 .5.5H21a.5.5 0 0 0 .5-.5v-6.5a.5.5 0 0 0-.5-.5Z"/></svg>
<h1>Dispatch's UI isn't built yet</h1>
<p>Run <code>pnpm build</code> in <code>demos/dispatch</code>, or start it with <code>pnpm dev</code>.</p></div></main></html>`;

/** Returns the server's request handler. `ui` serves everything outside `/api` (Vite middleware in dev). */
export function createRequestHandler(ctx: ApiContext, ui?: Middleware): (req: IncomingMessage, res: ServerResponse) => void {
  const router = buildRouter(ctx);
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostAllowed(req.headers.host)) {
      sendError(res, 403, "forbidden", "This host name isn't allowed. Open Dispatch at http://localhost.");
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
