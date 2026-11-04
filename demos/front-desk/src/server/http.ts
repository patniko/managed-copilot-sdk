/**
 * Front Desk's HTTP surface: the JSON API under /api, the GitHub sign-in round trip under /auth, and the web UI.
 * Every /api route except health, sign-in, and /api/me needs a signed-in person, and every read or change is scoped
 * to that person.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { ApiErrorBody, MeResponse, MemoryItem, ServerEvent, SignInRequest, SignUpRequest } from "../shared/types.js";
import { clearCookie, oauthCookie, OAUTH_TTL_MS, readCookies, sessionCookie, SESSION_TTL_MS, setCookie } from "./auth/cookies.js";
import type { EmailAccounts } from "./auth/email.js";
import { GitHubSignInError, safeReturnTo, type GitHubAuth } from "./auth/github.js";
import type { RateLimiter } from "./auth/ratelimit.js";
import type { FrontDeskConfig } from "./config.js";
import { isLoopbackHost } from "./config.js";
import type { Conversations } from "./conversations.js";
import { AppError, notFound, signInRequired } from "./errors.js";
import type { Hub } from "./hub.js";
import { log } from "./log.js";
import type { People } from "./people.js";
import type { Platform } from "./platform.js";
import { hashSecret, type Store, type UserRecord } from "./store.js";

export interface ServerContext {
  readonly config: FrontDeskConfig;
  readonly store: Store;
  readonly people: People;
  readonly github: GitHubAuth;
  readonly email: EmailAccounts;
  readonly conversations: Conversations;
  readonly hub: Hub;
  readonly limiter: RateLimiter;
  readonly platform: Platform;
}

type Next = () => void;
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

interface Request {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  /** The signed-in person (routes that need one). */
  readonly user: UserRecord;
  json<T>(): Promise<Partial<T>>;
}

type Handler = (request: Request) => unknown | Promise<unknown>;

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly keys: readonly string[];
  readonly handler: Handler;
  readonly signedIn: boolean;
}

const MAX_JSON = 64 * 1024;
const MESSAGES_PER_MINUTE = 20;

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

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

function securityHeaders(config: FrontDeskConfig, html: boolean): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
    ...(html && !config.dev ? { "content-security-policy": CSP } : {}),
    ...(config.secureCookies ? { "strict-transport-security": "max-age=31536000" } : {}),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown, config: FrontDeskConfig): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload), ...securityHeaders(config, false) });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string, config: FrontDeskConfig): void {
  const body: ApiErrorBody = { error: { code, message } };
  sendJson(res, status, body, config);
}

function redirect(res: ServerResponse, location: string, config: FrontDeskConfig): void {
  res.writeHead(302, { location, "cache-control": "no-store", ...securityHeaders(config, false) });
  res.end();
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

async function readJson<T>(req: IncomingMessage): Promise<Partial<T>> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new AppError("unsupported_media_type", "Send the request body as JSON.", 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON) throw new AppError("payload_too_large", "The request is too large.", 413);
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new AppError("invalid_json", "The request body isn't valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("invalid_json", "The request body must be a JSON object.");
  return parsed as Partial<T>;
}

/** DNS-rebinding protection: only answer requests addressed to Front Desk's own host names. */
export function hostAllowed(host: string | undefined, allowed: readonly string[]): boolean {
  if (!host) return false;
  const name = host.toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return allowed.includes(name) || name.endsWith(".localhost");
}

/** Browsers can't make cross-site changes: a present Origin must be this host, and Sec-Fetch-Site same-origin. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== req.headers.host) return false;
    } catch {
      return false;
    }
  }
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
}

/** The caller's network address, for rate limits: the proxy's last hop when behind Azure Container Apps' ingress. */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const value = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    const last = value?.split(",").map((part) => part.trim()).filter(Boolean).at(-1);
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

class Router {
  readonly #routes: Route[] = [];

  add(method: string, path: string, handler: Handler, options: { signedIn?: boolean } = {}): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/\//g, "\\/").replace(/:([a-zA-Z]+)/g, (_, key: string) => {
        keys.push(key);
        return "([^/]+)";
      })}$`,
    );
    this.#routes.push({ method, pattern, keys, handler, signedIn: options.signedIn ?? true });
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | "method_not_allowed" | undefined {
    let pathMatched = false;
    for (const route of this.#routes) {
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      for (const [index, key] of route.keys.entries()) {
        const value = safeDecode(match[index + 1]!);
        if (value === undefined) return undefined;
        params[key] = value;
      }
      return { route, params };
    }
    return pathMatched ? "method_not_allowed" : undefined;
  }
}

export function createRequestHandler(ctx: ServerContext, ui?: Middleware): (req: IncomingMessage, res: ServerResponse) => void {
  const { config, store, people, github, email, conversations, hub, limiter, platform } = ctx;
  const cookieName = sessionCookie(config.secureCookies);
  const stateCookie = oauthCookie(config.secureCookies);

  const currentUser = (req: IncomingMessage): UserRecord | undefined => {
    const value = readCookies(req).get(cookieName);
    return value ? store.resolveBrowserSession(value, SESSION_TTL_MS) : undefined;
  };

  const signIn = (res: ServerResponse, user: UserRecord) => {
    setCookie(res, cookieName, store.createBrowserSession(user.id, SESSION_TTL_MS), { secure: config.secureCookies, maxAgeMs: SESSION_TTL_MS });
    return { user: people.view(user) };
  };

  const authOptions = (): MeResponse["options"] => ({
    github: github.configured,
    localGitHub: config.localGitHubSignIn,
    email: true,
    inviteRequired: email.inviteRequired,
    appUsers: platform.appUsers(),
  });

  const memories = (userId: string): MemoryItem[] => store.listMemories(userId).map(({ id, text, createdAt }) => ({ id, text, createdAt }));

  const router = new Router();
  router.add("GET", "/api/health", () => ({ status: "ok" }), { signedIn: false });
  router.add(
    "GET",
    "/api/me",
    ({ req }) => {
      const user = currentUser(req);
      const body: MeResponse = { user: user ? people.view(user) : null, options: authOptions() };
      return body;
    },
    { signedIn: false },
  );
  router.add(
    "POST",
    "/api/auth/signup",
    async ({ req, res, json }) => signIn(res, await email.signUp(await json<SignUpRequest>(), clientAddress(req, config.trustProxy))),
    { signedIn: false },
  );
  router.add(
    "POST",
    "/api/auth/signin",
    async ({ req, res, json }) => signIn(res, await email.signIn(await json<SignInRequest>(), clientAddress(req, config.trustProxy))),
    { signedIn: false },
  );
  router.add(
    "POST",
    "/api/auth/github/local",
    async ({ req, res }) => {
      // Only a Front Desk on your own computer, asked from your own computer, ever offers this.
      if (!config.localGitHubSignIn || !isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHost((req.headers.host ?? "").replace(/:\d+$/, ""))) {
        throw new AppError("unavailable", "This sign-in is only offered by a Front Desk running on your own computer.", 403);
      }
      try {
        return signIn(res, await github.signInWithLocalCli());
      } catch (error) {
        if (error instanceof GitHubSignInError) throw new AppError(`github_${error.code}`, error.message, error.code === "unavailable" ? 400 : 502);
        throw error;
      }
    },
    { signedIn: false },
  );
  router.add(
    "POST",
    "/api/auth/signout",
    async ({ req, res }) => {
      const value = readCookies(req).get(cookieName);
      clearCookie(res, cookieName, { secure: config.secureCookies });
      const userId = value ? store.deleteBrowserSession(value) : undefined;
      // This browser stops receiving live events now, even while the person is still signed in somewhere else.
      if (value) hub.disconnectSession(hashSecret(value));
      if (userId && store.countBrowserSessions(userId) === 0) {
        // Signed out everywhere: let go of their connection, and keep no GitHub token for them.
        hub.disconnect(userId);
        await conversations.release(userId);
        github.forget(userId);
        log.info("Signed out everywhere", { user: userId });
      }
      res.writeHead(204, { "cache-control": "no-store" }).end();
    },
    { signedIn: false },
  );

  router.add("GET", "/api/conversations", ({ user }) => conversations.list(user));
  router.add("POST", "/api/conversations", async ({ user, res, json }) => {
    takeMessage(user);
    const body = await json<{ prompt: string }>();
    const created = await conversations.create(user, body.prompt);
    sendJson(res, 201, created, config);
  });
  router.add("GET", "/api/conversations/:id", ({ user, params }) => conversations.view(user, params.id!));
  router.add("POST", "/api/conversations/:id/messages", async ({ user, params, res, json }) => {
    takeMessage(user);
    const body = await json<{ prompt: string }>();
    sendJson(res, 202, await conversations.send(user, params.id!, body.prompt), config);
  });
  router.add("POST", "/api/conversations/:id/stop", async ({ user, params, res }) => {
    await conversations.stop(user, params.id!);
    res.writeHead(204, { "cache-control": "no-store" }).end();
  });
  router.add("DELETE", "/api/conversations/:id", async ({ user, params, res }) => {
    await conversations.delete(user, params.id!);
    res.writeHead(204, { "cache-control": "no-store" }).end();
  });
  router.add("GET", "/api/memories", ({ user }) => memories(user.id));
  router.add("DELETE", "/api/memories/:id", ({ user, params, res }) => {
    if (!store.deleteMemory(user.id, params.id!)) throw notFound("That memory");
    hub.publish(user.id, { type: "memories", memories: memories(user.id) });
    res.writeHead(204, { "cache-control": "no-store" }).end();
  });
  router.add("DELETE", "/api/memories", ({ user, res }) => {
    store.clearMemories(user.id);
    hub.publish(user.id, { type: "memories", memories: [] });
    res.writeHead(204, { "cache-control": "no-store" }).end();
  });
  router.add("GET", "/api/events", ({ user, req, res }) => {
    const initial: ServerEvent[] = [
      { type: "billing", billing: people.billing(user) },
      { type: "memories", memories: memories(user.id) },
    ];
    // The stream lasts only as long as this browser's sign-in: signing out, or its expiry, ends it.
    const session = hashSecret(readCookies(req).get(cookieName) ?? "");
    hub.attach(user.id, req, res, { session, active: () => store.browserSessionActive(session) }, initial);
  });

  function takeMessage(user: UserRecord): void {
    const attempt = limiter.take(`messages:${user.id}`, MESSAGES_PER_MINUTE, 60_000);
    if (!attempt.allowed) throw new AppError("rate_limited", "You're sending messages very fast. Wait a moment, then try again.", 429);
  }

  const handleApi = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    const method = req.method ?? "GET";
    if (safeDecode(url.pathname) === undefined) return sendError(res, 400, "invalid_request", "The request path is malformed.", config);
    if (method !== "GET" && method !== "HEAD" && !sameOrigin(req)) return sendError(res, 403, "forbidden", "Cross-site requests aren't allowed.", config);
    const match = router.match(method, url.pathname);
    if (match === "method_not_allowed") return sendError(res, 405, "method_not_allowed", "That method isn't supported here.", config);
    if (!match) return sendError(res, 404, "not_found", "No such API route.", config);
    Promise.resolve()
      .then(async () => {
        const user = match.route.signedIn ? currentUser(req) : undefined;
        if (match.route.signedIn && !user) throw signInRequired();
        const result = await match.route.handler({ req, res, url, params: match.params, user: user!, json: <T>() => readJson<T>(req) });
        if (!res.headersSent && !res.writableEnded) sendJson(res, 200, result ?? { ok: true }, config);
      })
      .catch((error: unknown) => {
        if (res.headersSent) return void res.end();
        if (error instanceof AppError) return sendError(res, error.status, error.code, error.message, config);
        log.error("Request failed", { method, path: url.pathname, error: (error as Error).message });
        sendError(res, 500, "internal", "Something went wrong in Front Desk. Try again.", config);
      });
  };

  const handleGitHubStart = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    try {
      const { url: target, state } = github.begin(safeReturnTo(url.searchParams.get("return")));
      setCookie(res, stateCookie, state, { secure: config.secureCookies, maxAgeMs: OAUTH_TTL_MS });
      redirect(res, target, config);
    } catch (error) {
      const code = error instanceof GitHubSignInError ? error.code : "failed";
      redirect(res, `/?signin_error=${code}`, config);
    }
  };

  const handleGitHubCallback = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    const browserState = readCookies(req).get(stateCookie);
    clearCookie(res, stateCookie, { secure: config.secureCookies });
    github
      .complete(url.searchParams, browserState)
      .then(({ user, returnTo }) => {
        signIn(res, user);
        redirect(res, returnTo, config);
      })
      .catch((error: unknown) => {
        const code = error instanceof GitHubSignInError ? error.code : "failed";
        if (!(error instanceof GitHubSignInError)) log.error("GitHub sign-in failed", { error: (error as Error).message });
        else log.warn("GitHub sign-in didn't complete", { code, error: error.message });
        redirect(res, `/?signin_error=${code}`, config);
      });
  };

  const serveStatic = (pathname: string, res: ServerResponse): boolean => {
    const root = resolve(config.webRoot);
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
      ...securityHeaders(config, extname(file) === ".html"),
    });
    createReadStream(file).pipe(res);
    return true;
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostAllowed(req.headers.host, config.allowedHosts)) {
      sendError(res, 421, "misdirected", "This host name isn't Front Desk's.", config);
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    if (url.pathname === "/auth/github" && method === "GET") return handleGitHubStart(req, res, url);
    if (url.pathname === "/auth/github/callback" && method === "GET") return handleGitHubCallback(req, res, url);
    if (ui) {
      ui(req, res, () => sendError(res, 404, "not_found", "Not found.", config));
      return;
    }
    if ((method === "GET" || method === "HEAD") && serveStatic(url.pathname, res)) return;
    if (method === "GET" && !extname(url.pathname)) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("Front Desk's web UI isn't built yet. Run `pnpm --filter @managed-copilot/demo-front-desk build`.");
      return;
    }
    sendError(res, 404, "not_found", "Not found.", config);
  };

  return (req, res) => {
    try {
      handle(req, res);
    } catch (error) {
      log.error("Request failed", { error: (error as Error).message });
      if (!res.headersSent) sendError(res, 500, "internal", "Something went wrong in Front Desk.", config);
      else res.end();
    }
  };
}
