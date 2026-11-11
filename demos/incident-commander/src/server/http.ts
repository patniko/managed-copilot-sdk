import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { isManagedCopilotError } from "@managed-copilot/sdk";
import type { AlertsAccepted, ApiErrorBody, CreatedIncident, DecisionRequest, FixRoute, NoteRequest, SettingsRequest, SimulateRequest } from "../shared/types.js";
import { authorized, parseAlertPayload } from "./alerts.js";
import type { Commander } from "./commander.js";
import { AppError } from "./errors.js";
import type { EventHub } from "./hub.js";
import { log } from "./log.js";

export interface ApiContext {
  readonly commander: Commander;
  readonly hub: EventHub;
}

type Next = () => void;
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;
type Params = Record<string, string>;
type Handler = (req: IncomingMessage, res: ServerResponse, params: Params) => Promise<void> | void;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
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
  if (error instanceof AppError) return sendError(res, error.status, error.code, error.message);
  if (isManagedCopilotError(error)) return sendError(res, error.status, error.code, error.message);
  log.error("Request failed", { error: (error as Error).message });
  sendError(res, 500, "internal", "Something went wrong in Incident Commander. Its log has the details.");
}

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new AppError("payload_too_large", "The request body is too large.", 413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** A JSON object body. `optional`: a request without a body reads as `{}`. */
async function readJson<T>(req: IncomingMessage, limit = 64 * 1024, { optional = false } = {}): Promise<T> {
  const json = /^application\/json\b/i.test(req.headers["content-type"] ?? "");
  if (!json && !optional) throw new AppError("unsupported_media_type", "Send the request body as application/json.", 415);
  let parsed: unknown;
  try {
    const raw = await readRaw(req, limit);
    if (optional && raw.length === 0) return {} as T;
    if (!json) throw new AppError("unsupported_media_type", "Send the request body as application/json.", 415);
    parsed = JSON.parse(raw.toString("utf8") || "{}");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("invalid_request", "The request body isn't valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("invalid_request", "The request body must be a JSON object.");
  return parsed as T;
}

const FIX_ROUTES: readonly FixRoute[] = ["workers", "factory"];

/**
 * Blocks DNS rebinding: only loopback names may address this server. `*.localhost` names always resolve to loopback
 * (RFC 6761); `INCIDENT_ALLOWED_HOSTS` adds the deployed app's host names.
 */
export function hostAllowed(host: string | undefined, extraHosts = process.env.INCIDENT_ALLOWED_HOSTS): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  const extra = (extraHosts ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return ["localhost", "127.0.0.1", "::1"].includes(name) || name.endsWith(".localhost") || extra.includes(name);
}

/** Cross-site requests can't drive the app: a present Origin must match the Host. */
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

function buildRouter({ commander, hub }: ApiContext): Router {
  const router = new Router();

  router.add("GET", "/api/health", (_req, res) => sendJson(res, 200, { status: "ok", platform: commander.platform.status.state }));
  router.add("GET", "/api/state", (_req, res) => sendJson(res, 200, commander.state()));
  router.add("GET", "/api/events", (req, res) => hub.attach(req, res, commander.initialEvents()));
  router.add("GET", "/api/incidents/:id", (_req, res, params) => sendJson(res, 200, commander.view(params.id!)));
  router.add("DELETE", "/api/incidents/:id", async (_req, res, params) => {
    await commander.delete(params.id!);
    res.writeHead(204).end();
  });
  router.add("POST", "/api/incidents/:id/decision", async (req, res, params) => {
    const body = await readJson<Partial<DecisionRequest>>(req);
    if (typeof body.approve !== "boolean") throw new AppError("invalid_request", "Pass approve: true or false.");
    if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 500)) throw new AppError("invalid_request", "Keep the reason under 500 characters.");
    await commander.decide(params.id!, body.approve, body.reason?.trim() || undefined);
    res.writeHead(204).end();
  });
  router.add("POST", "/api/incidents/:id/notes", async (req, res, params) => {
    const body = await readJson<Partial<NoteRequest>>(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw new AppError("invalid_request", "Write a note first.");
    if (text.length > 2_000) throw new AppError("invalid_request", "Keep the note under 2,000 characters.");
    await commander.message(params.id!, text);
    res.writeHead(202).end();
  });
  // How the next incidents' fixes are made: Copilot's workers, or Software Factory.
  router.add("PUT", "/api/settings", async (req, res) => {
    const body = await readJson<Partial<SettingsRequest>>(req);
    if (!FIX_ROUTES.includes(body.fixRoute as FixRoute)) throw new AppError("invalid_request", 'Pass fixRoute: "workers" or "factory".');
    sendJson(res, 200, commander.setFixRoute(body.fixRoute!));
  });
  // The labeled demo: a sample alert for the bundled demo service. An optional { fixRoute } overrides the setting.
  router.add("POST", "/api/simulate", async (req, res) => {
    const body = await readJson<Partial<SimulateRequest>>(req, 4 * 1024, { optional: true });
    if (body.fixRoute !== undefined && !FIX_ROUTES.includes(body.fixRoute)) throw new AppError("invalid_request", 'Pass fixRoute: "workers" or "factory", or no body to use the setting.');
    const created: CreatedIncident = { id: await commander.simulate(body.fixRoute) };
    sendJson(res, 201, created);
  });
  // Monitoring tools: Alertmanager, Grafana, or { title, service, severity, summary }, with the shared secret.
  router.add("POST", "/api/alerts", async (req, res) => {
    const secret = commander.config.alertSecret;
    if (!secret) throw new AppError("alerts_not_configured", "Set INCIDENT_ALERT_SECRET to accept alerts from monitoring tools.", 503);
    if (!authorized(req.headers.authorization, secret)) throw new AppError("unauthorized", "Send the alert secret as a bearer token (Authorization: Bearer <secret>).", 401);
    const alerts = parseAlertPayload(await readJson<unknown>(req, 256 * 1024));
    const accepted: AlertsAccepted = { incidents: await commander.ingest(alerts) };
    sendJson(res, 202, accepted);
  });
  // The platform's signed webhook: session.action_required, session.idle, session.failed, and worker.*.
  router.add("POST", "/api/copilot-events", async (req, res) => {
    await commander.webhook(req.headers, await readRaw(req, 1024 * 1024));
    sendJson(res, 200, { ok: true });
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
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  createReadStream(file).pipe(res);
  return true;
}

const NOT_BUILT_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Incident Commander · Managed Copilot</title>
<style>body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}main{max-width:40rem;margin:96px auto;padding:0 16px;text-align:center}
h1{font-size:20px;font-weight:600}p{opacity:.7}code{font:85% ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}</style>
<main><h1>Incident Commander's UI isn't built yet</h1><p>Run <code>pnpm build</code> in <code>demos/incident-commander</code>.</p></main></html>`;

/** Returns the server's request handler. `ui` serves everything outside `/api` (Vite middleware in dev). */
export function createRequestHandler(ctx: ApiContext, webRoot: string, ui?: Middleware): (req: IncomingMessage, res: ServerResponse) => void {
  const router = buildRouter(ctx);
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostAllowed(req.headers.host)) {
      sendError(res, 403, "forbidden", "This host name isn't allowed. Open Incident Commander at http://localhost.");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (url.pathname.startsWith("/api/")) {
      if (safeDecode(url.pathname) === undefined) return sendError(res, 400, "invalid_request", "The request path is malformed.");
      if (method !== "GET" && method !== "HEAD" && !originAllowed(req)) return sendError(res, 403, "forbidden", "Cross-site requests aren't allowed.");
      const match = router.match(method, url.pathname);
      if (match === "method_not_allowed") return sendError(res, 405, "method_not_allowed", "That method isn't supported here.");
      if (!match) return sendError(res, 404, "not_found", "No such API route.");
      Promise.resolve()
        .then(() => match.handler(req, res, match.params))
        .catch((error: unknown) => handleError(res, error));
      return;
    }
    if (ui) return ui(req, res, () => sendError(res, 404, "not_found", "Not found."));
    if (method === "GET" && serveStatic(webRoot, url.pathname, res)) return;
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
