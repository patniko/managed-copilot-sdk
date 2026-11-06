import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { isManagedCopilotError } from "@managed-copilot/sdk";
import { TEMPLATES } from "../shared/templates.js";
import type { ApiErrorBody, CreateRevisionRequest, CreateWorkOrderRequest, FactoryState, GitHubStatus, MergeRequest } from "../shared/types.js";
import { attachCommandTemplate, canLaunchTerminal, isValidSessionId, launchAttach } from "./attach.js";
import type { FactoryConfig } from "./config.js";
import type { GitHubApi } from "./github.js";
import type { EventHub } from "./hub.js";
import { log } from "./log.js";
import type { Factory } from "./pipeline/factory.js";
import { StationError } from "./pipeline/errors.js";
import type { Platform } from "./platform.js";
import { createZip } from "./zip.js";

export interface ApiContext {
  readonly factory: Factory;
  readonly platform: Platform;
  readonly hub: EventHub;
  readonly config: FactoryConfig;
  /** The factory's GitHub access, for browsing repositories and issues. */
  readonly github?: GitHubApi;
}

type Next = () => void;
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;
type Params = Record<string, string>;
type Handler = (req: IncomingMessage, res: ServerResponse, params: Params, url: URL) => Promise<void> | void;

const STATUS_BY_CODE: Record<string, number> = {
  invalid_request: 400,
  authentication_required: 401,
  not_found: 404,
  conflict: 409,
  platform_unavailable: 503,
  upstream_unavailable: 502,
  rate_limited: 429,
  payload_too_large: 413,
  unsupported_media_type: 415,
  forbidden: 403,
};

const NO_GITHUB: GitHubStatus = { available: false, message: "This factory isn't set up to work with GitHub." };

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
  if (error instanceof StationError) return sendError(res, STATUS_BY_CODE[error.code] ?? 500, error.code, error.message);
  if (isManagedCopilotError(error)) return sendError(res, error.status, error.code, error.message);
  log.error("Request failed", { error: (error as Error).message });
  sendError(res, 500, "internal", "Something went wrong in the factory server. Check its log for details.");
}

async function readJson<T>(req: IncomingMessage, limit = 64 * 1024): Promise<T> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    throw new StationError("unsupported_media_type", "Send the request body as application/json.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new StationError("payload_too_large", "The request body is too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
  } catch {
    throw new StationError("invalid_request", "The request body isn't valid JSON.");
  }
}

/**
 * Blocks DNS rebinding: only loopback names may address this local server. `*.localhost` names (as Aspire can assign)
 * always resolve to loopback (RFC 6761); `FACTORY_ALLOWED_HOSTS` adds more for deliberate remote setups.
 */
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  const extra = (process.env.FACTORY_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return ["localhost", "127.0.0.1", "::1"].includes(name) || name.endsWith(".localhost") || extra.includes(name);
}

/** Cross-site requests can't drive the factory: a present Origin must match the Host. */
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

export async function factoryState(ctx: ApiContext): Promise<FactoryState> {
  return {
    platform: ctx.platform.status,
    workOrders: ctx.factory.list(),
    templates: TEMPLATES,
    attachCommand: attachCommandTemplate(ctx.config.attachUrl),
    canLaunchTerminal: canLaunchTerminal(),
    github: ctx.github ? await ctx.github.status() : NO_GITHUB,
  };
}

function requireGitHub(ctx: ApiContext): GitHubApi {
  if (!ctx.github) throw new StationError("platform_unavailable", NO_GITHUB.message!);
  return ctx.github;
}

function issueNumber(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new StationError("invalid_request", "Issue numbers are positive whole numbers.");
  return number;
}

function buildRouter(ctx: ApiContext): Router {
  const router = new Router();
  const { factory } = ctx;
  const workOrder = (id: string) => {
    const wo = factory.get(id);
    if (!wo) throw new StationError("not_found", "That work order doesn't exist.");
    return wo;
  };

  router.add("GET", "/api/health", (_req, res) => sendJson(res, 200, { status: "ok", platform: ctx.platform.status.state }));
  router.add("GET", "/api/state", async (_req, res) => sendJson(res, 200, await factoryState(ctx)));
  router.add("GET", "/api/events", (req, res) => ctx.hub.attach(req, res, [{ type: "platform", platform: ctx.platform.status }]));
  router.add("GET", "/api/github", async (_req, res) => sendJson(res, 200, ctx.github ? await ctx.github.status() : NO_GITHUB));
  router.add("GET", "/api/github/repos", async (_req, res, _params, url) => {
    sendJson(res, 200, await requireGitHub(ctx).listRepositories(url.searchParams.get("q") ?? undefined));
  });
  router.add("GET", "/api/github/repos/:owner/:name", async (_req, res, params) => {
    sendJson(res, 200, await requireGitHub(ctx).repository(params.owner!, params.name!));
  });
  router.add("GET", "/api/github/repos/:owner/:name/issues", async (_req, res, params, url) => {
    sendJson(res, 200, await requireGitHub(ctx).listIssues(params.owner!, params.name!, url.searchParams.get("q") ?? undefined));
  });
  router.add("GET", "/api/github/repos/:owner/:name/issues/:number", async (_req, res, params) => {
    sendJson(res, 200, await requireGitHub(ctx).issue(params.owner!, params.name!, issueNumber(params.number!)));
  });
  router.add("GET", "/api/work-orders", (_req, res) => sendJson(res, 200, factory.list()));
  router.add("POST", "/api/work-orders", async (req, res) => {
    const body = await readJson<CreateWorkOrderRequest>(req);
    sendJson(res, 201, body && typeof body === "object" && body.github !== undefined ? await factory.createGitHub(body) : factory.create(body));
  });
  router.add("POST", "/api/work-orders/:id/revisions", async (req, res, params) => {
    const body = await readJson<CreateRevisionRequest>(req);
    sendJson(res, 200, await factory.revise(params.id!, body?.request));
  });
  router.add("GET", "/api/work-orders/:id/pull-request", async (_req, res, params) => sendJson(res, 200, await factory.refreshPullRequest(params.id!)));
  router.add("POST", "/api/work-orders/:id/merge", async (req, res, params) => {
    const body = await readJson<MergeRequest>(req);
    sendJson(res, 200, await factory.merge(params.id!, body?.method ?? "squash"));
  });
  router.add("GET", "/api/work-orders/:id/media", (_req, res, params, url) => {
    const stationId = url.searchParams.get("stationId");
    const path = url.searchParams.get("path");
    const versionParam = url.searchParams.get("version");
    if (!stationId || !path) throw new StationError("invalid_request", "Pass stationId and path.");
    const version = versionParam ? Number(versionParam) : undefined;
    const media = factory.media(params.id!, stationId, path, Number.isInteger(version) ? version : undefined);
    if (!media) throw new StationError("not_found", "That screenshot or recording doesn't exist.");
    const filename = path.split("/").pop() ?? "media";
    res.writeHead(200, {
      "content-type": media.contentType,
      "content-length": media.bytes.length,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      "content-disposition": `inline; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    });
    res.end(Buffer.from(media.bytes));
  });
  router.add("GET", "/api/work-orders/:id", (_req, res, params) => sendJson(res, 200, workOrder(params.id!)));
  router.add("DELETE", "/api/work-orders/:id", async (_req, res, params) => {
    await factory.delete(params.id!);
    res.writeHead(204).end();
  });
  router.add("POST", "/api/work-orders/:id/cancel", async (_req, res, params) => sendJson(res, 200, await factory.cancel(params.id!)));
  router.add("POST", "/api/work-orders/:id/retry", (_req, res, params) => sendJson(res, 200, factory.retry(params.id!)));
  router.add("GET", "/api/work-orders/:id/activity", (_req, res, params, url) => {
    workOrder(params.id!);
    sendJson(res, 200, factory.activity(params.id!, url.searchParams.get("stationId") ?? undefined));
  });
  router.add("GET", "/api/work-orders/:id/artifacts", (_req, res, params) => {
    workOrder(params.id!);
    sendJson(res, 200, factory.artifactIndex(params.id!));
  });
  router.add("GET", "/api/work-orders/:id/artifacts/content", (_req, res, params, url) => {
    const stationId = url.searchParams.get("stationId");
    const path = url.searchParams.get("path");
    const versionParam = url.searchParams.get("version");
    if (!stationId || !path) throw new StationError("invalid_request", "Pass stationId and path.");
    const version = versionParam ? Number(versionParam) : undefined;
    const artifact = factory.artifact(params.id!, stationId, path, Number.isInteger(version) ? version : undefined);
    if (!artifact) throw new StationError("not_found", "That artifact doesn't exist.");
    if (artifact.content === undefined) throw new StationError("unsupported_media_type", "This artifact is binary or too large to preview.");
    const filename = path.split("/").pop() ?? "artifact.txt";
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": `inline; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    });
    res.end(artifact.content);
  });
  router.add("GET", "/api/work-orders/:id/bundle.zip", (_req, res, params) => {
    const release = factory.releaseFiles(params.id!);
    if (!release || release.files.length === 0) throw new StationError("not_found", "This work order has no release yet.");
    const zip = createZip(release.files);
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": zip.length,
      "content-disposition": `attachment; filename="${release.projectName.replace(/[^A-Za-z0-9._-]/g, "_")}.zip"`,
    });
    res.end(zip);
  });
  router.add("POST", "/api/sessions/:sessionId/attach", async (_req, res, params) => {
    const sessionId = params.sessionId!;
    const known = factory
      .list()
      .some((summary) =>
        factory.get(summary.id)?.stations.some((station) => station.sessionId === sessionId || station.previousSessionIds?.includes(sessionId)),
      );
    if (!known || !isValidSessionId(sessionId)) throw new StationError("not_found", "That session doesn't belong to a work order.");
    sendJson(res, 200, await launchAttach(sessionId, ctx.config.repoRoot, ctx.platform.status.url, ctx.config.attachUrl));
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
<meta name="color-scheme" content="light dark"><title>Software Factory · Managed Copilot</title>
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
<span>Managed Copilot</span><span class="sep">/</span><strong>Software Factory</strong></header>
<main><div class="box"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M1 3a2 2 0 0 1 2-2h6.5a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H7v4.063C7 16.355 7.644 17 8.438 17H12.5v-2.5a2 2 0 0 1 2-2H21a2 2 0 0 1 2 2V21a2 2 0 0 1-2 2h-6.5a2 2 0 0 1-2-2v-2.5H8.437A2.939 2.939 0 0 1 5.5 15.562V11.5H3a2 2 0 0 1-2-2Zm2-.5a.5.5 0 0 0-.5.5v6.5a.5.5 0 0 0 .5.5h6.5a.5.5 0 0 0 .5-.5V3a.5.5 0 0 0-.5-.5ZM14.5 14a.5.5 0 0 0-.5.5V21a.5.5 0 0 0 .5.5H21a.5.5 0 0 0 .5-.5v-6.5a.5.5 0 0 0-.5-.5Z"/></svg>
<h1>The factory floor UI isn't built yet</h1>
<p>Run <code>pnpm build</code> in <code>demos/software-factory</code>, or start it with <code>pnpm dev</code>.</p></div></main></html>`;

/** Returns the server's request handler. `ui` serves everything outside `/api` (Vite middleware in dev). */
export function createRequestHandler(ctx: ApiContext, ui?: Middleware): (req: IncomingMessage, res: ServerResponse) => void {
  const router = buildRouter(ctx);
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostAllowed(req.headers.host)) {
      sendError(res, 403, "forbidden", "This host name isn't allowed. Open the factory at http://localhost.");
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
