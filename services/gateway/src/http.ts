import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { APP_KEY_HEADER, APP_USER_HEADER, APP_USER_NAME_HEADER, ManagedCopilotError } from "@managed-copilot/protocol";
import { ZodError } from "zod";
import type { GatewayApp } from "./app.js";

/**
 * An authenticated caller. Ownership binds to `accountId`, never to `login`.
 *
 * - A GitHub user (`kind` absent or `github`): positive account ID, and `token` holds their verified GitHub token.
 * - One of an app's own users (`app-user`): a negative account ID the gateway assigned for (app, user ID). No token:
 *   never a GitHub account, never an operator, and their model calls go only to Foundry.
 * - An app acting for itself (`app`): deployment information only (routes with `auth: "user-or-app"`).
 *
 * `app` names the app whose key the request carried; requests through an app use only its environments.
 */
export interface Principal {
  readonly accountId: number;
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
  /** A GitHub user's token; held in memory only and never forwarded into sandboxes. Absent for app users and apps. */
  readonly token?: string;
  readonly kind?: "github" | "app-user" | "app";
  /** The app the request came through (its key). */
  readonly app?: string;
  /** App users: the ID the app's own sign-in gave them. */
  readonly userId?: string;
}

/** A GitHub user, whose verified token is at hand. */
export type GitHubPrincipal = Principal & { readonly token: string; readonly kind?: "github" };

export function isGitHubPrincipal(principal: Principal): principal is GitHubPrincipal {
  return (principal.kind === undefined || principal.kind === "github") && typeof principal.token === "string" && principal.token.length > 0;
}

/** What a request presented: a GitHub bearer token, an app key, and the app user it acts for. */
export interface RequestCredentials {
  readonly token?: string;
  readonly appKey?: string;
  /** Raw (percent-encoded) header values. */
  readonly appUser?: string;
  readonly appUserName?: string;
}

/** Provided by the core module as `app.services.auth`. */
export interface Authenticator {
  /**
   * Verifies a bearer token (GitHub user, service, or scoped capability) and applies the AppHost access rules. Pass
   * `background` when re-verifying a stored credential rather than a connected caller's: it never becomes the
   * account's live credential.
   */
  authenticate(token: string, options?: { readonly background?: boolean; readonly app?: string }): Promise<Principal>;
  /**
   * Authenticates a request's credentials: a GitHub token, or an app key acting for one of the app's users, a GitHub
   * user who signed in to it, or itself. Gateways without apps only accept GitHub tokens.
   */
  authenticateRequest?(credentials: RequestCredentials): Promise<Principal>;
  /** Checks a principal again for a long-lived connection: its token with GitHub, or its app key still configured. */
  reverify?(principal: Principal): Promise<Principal>;
  /**
   * Forgets a token GitHub rejected (a 401 from the Copilot API, for example): its cached verification and every
   * reference to it. Its next use is verified with GitHub again.
   */
  invalidate?(token: string): void;
  /** Drops the account references to a stored token being removed (logout), without forgetting its verification. */
  forgetCredential?(token: string): void;
}

/**
 * `user`: GitHub bearer token (default), or an app key acting for a user. `user-or-app`: also an app acting for itself.
 * `platform`: internal services presenting `x-managed-copilot-platform-key`. `none`: unauthenticated (health only).
 * Routes may also verify their own scoped capabilities.
 */
export type RouteAuth = "user" | "user-or-app" | "platform" | "none";

export interface RequestContext {
  readonly app: GatewayApp;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  /** Set for `auth: "user"` routes. */
  readonly principal: Principal | undefined;
  /** Parses a JSON body (1 MiB limit). */
  json<T = unknown>(): Promise<T>;
  /** Reads the raw body (`limit` bytes, default 1 MiB). Stream large uploads from `req` instead. */
  raw(limit?: number): Promise<Buffer>;
  /** Sets the status for a returned JSON body (default 200). */
  status(code: number): void;
}

/** A handler returns a JSON-serializable value (sent with the chosen status), or writes `res` itself. */
export type Handler = (ctx: RequestContext) => unknown | Promise<unknown>;

/** Route details passed to upgrade handlers. */
export interface UpgradeContext {
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
}

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, principal: Principal | undefined, context: UpgradeContext) => void | Promise<void>;

interface Route<T> {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: T;
  readonly auth: RouteAuth;
}

interface PrefixRoute {
  readonly segments: readonly string[];
  readonly methods: ReadonlySet<string>;
  readonly handler: Handler;
  readonly auth: RouteAuth;
}

/** Traffic the operator console charts: the platform API, not health checks, the console, or the operator API. */
function countsAsTraffic(path: string): boolean {
  return path.startsWith("/v1/") && !path.startsWith("/v1/operator/");
}

const PLATFORM_KEY_HEADER = "x-managed-copilot-platform-key";
const MAX_JSON_BYTES = 1024 * 1024;

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function matchSegments(pattern: readonly string[], actual: readonly string[]): Record<string, string> | undefined {
  if (pattern.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i]!;
    const value = actual[i]!;
    if (expected.startsWith(":")) {
      try {
        params[expected.slice(1)] = decodeURIComponent(value);
      } catch {
        throw new ManagedCopilotError("invalid_request", "The request path is not valid URL encoding");
      }
    } else if (expected !== value) return undefined;
  }
  return params;
}

/** Parses a request target; malformed targets are client errors, never unhandled rejections. */
function parseUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? "/", "http://gateway.local");
  } catch {
    throw new ManagedCopilotError("invalid_request", "The request URL is malformed");
  }
}

/** Timing-safe comparison of the internal platform key. Empty keys and repeated headers never match. */
export function platformKeyMatches(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== "string" || !header || !expected) return false;
  const actual = Buffer.from(header, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim();
}

/** A single-valued request header; repeated headers are refused rather than merged. */
function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw new ManagedCopilotError("invalid_request", `Send the ${name} header once`);
  return value;
}

/** The credentials a request presented (`Authorization`, and the app headers). */
export function requestCredentials(req: IncomingMessage): RequestCredentials {
  const token = bearerToken(req);
  const appKey = singleHeader(req, APP_KEY_HEADER);
  const appUser = singleHeader(req, APP_USER_HEADER);
  const appUserName = singleHeader(req, APP_USER_NAME_HEADER);
  return {
    ...(token ? { token } : {}),
    ...(appKey !== undefined ? { appKey } : {}),
    ...(appUser !== undefined ? { appUser } : {}),
    ...(appUserName !== undefined ? { appUserName } : {}),
  };
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ManagedCopilotError("invalid_request", `Request body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

export function toManagedError(error: unknown): ManagedCopilotError {
  if (error instanceof ManagedCopilotError) return error;
  if (error instanceof ZodError) {
    return new ManagedCopilotError("invalid_request", "Request failed validation", { issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
  }
  return new ManagedCopilotError("internal", "Internal error");
}

/** The caller a route's `auth` setting admits: a GitHub user, one acting through an app's key, or (`user-or-app`) the app. */
export async function resolvePrincipal(app: GatewayApp, req: IncomingMessage, auth: RouteAuth): Promise<Principal | undefined> {
  if (auth === "none") return undefined;
  if (auth === "platform") {
    if (!platformKeyMatches(req.headers[PLATFORM_KEY_HEADER], app.config.platformKey)) throw new ManagedCopilotError("forbidden", "Platform credential required");
    return undefined;
  }
  const credentials = requestCredentials(req);
  const authenticator = app.services.auth;
  if (!authenticator) throw new ManagedCopilotError("capability_unavailable", "Authentication is not configured on this gateway");
  if (credentials.appKey !== undefined || credentials.appUser !== undefined) {
    if (!authenticator.authenticateRequest) throw new ManagedCopilotError("authentication_required", "This gateway does not accept app keys");
    const principal = await authenticator.authenticateRequest(credentials);
    if (principal.kind === "app" && auth !== "user-or-app") {
      throw new ManagedCopilotError(
        "authentication_required",
        `This request needs a person to act for, and it carries only the "${principal.app}" app's key: send one of the app's users (managed.as({ appUser })) or a GitHub user's token (managed.as({ gitHubToken })).`,
      );
    }
    return principal;
  }
  if (!credentials.token) throw new ManagedCopilotError("authentication_required", "Sign in with a GitHub token (Authorization: Bearer <token>)");
  return authenticator.authenticate(credentials.token);
}

export class Router {
  readonly #routes: Route<Handler>[] = [];
  readonly #prefixes: PrefixRoute[] = [];

  add(method: string, path: string, handler: Handler, options: { auth?: RouteAuth } = {}): void {
    this.#routes.push({ method: method.toUpperCase(), segments: splitPath(path), handler, auth: options.auth ?? "user" });
  }

  /**
   * Serves `path` and everything under it that no exact route matches (a single-page app). The handler gets the
   * decoded remainder as `params["*"]` ("" for `path` itself).
   */
  prefix(path: string, handler: Handler, options: { auth?: RouteAuth; methods?: readonly string[] } = {}): void {
    this.#prefixes.push({ segments: splitPath(path), methods: new Set((options.methods ?? ["GET", "HEAD"]).map((method) => method.toUpperCase())), handler, auth: options.auth ?? "user" });
  }

  get(path: string, handler: Handler, options?: { auth?: RouteAuth }): void {
    this.add("GET", path, handler, options);
  }
  post(path: string, handler: Handler, options?: { auth?: RouteAuth }): void {
    this.add("POST", path, handler, options);
  }
  put(path: string, handler: Handler, options?: { auth?: RouteAuth }): void {
    this.add("PUT", path, handler, options);
  }
  delete(path: string, handler: Handler, options?: { auth?: RouteAuth }): void {
    this.add("DELETE", path, handler, options);
  }

  async handle(app: GatewayApp, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url = new URL("http://gateway.local/");
    let traffic = false;
    try {
      url = parseUrl(req);
      traffic = countsAsTraffic(url.pathname);
      if (traffic) app.metrics.increment("http.requests");
      const segments = splitPath(url.pathname);
      let pathMatched = false;
      let route: Route<Handler> | undefined;
      let params: Record<string, string> | undefined;
      for (const candidate of this.#routes) {
        const matched = matchSegments(candidate.segments, segments);
        if (!matched) continue;
        pathMatched = true;
        if (candidate.method === req.method) {
          route = candidate;
          params = matched;
          break;
        }
      }
      if (!route && !pathMatched) {
        const prefix = this.#prefixes.find((candidate) => candidate.segments.every((segment, index) => segments[index] === segment));
        if (prefix) {
          pathMatched = true;
          if (prefix.methods.has(req.method ?? "")) {
            let rest: string;
            try {
              rest = segments.slice(prefix.segments.length).map((segment) => decodeURIComponent(segment)).join("/");
            } catch {
              throw new ManagedCopilotError("invalid_request", "The request path is not valid URL encoding");
            }
            route = { method: req.method ?? "GET", segments: prefix.segments, handler: prefix.handler, auth: prefix.auth };
            params = { "*": rest };
          }
        }
      }
      if (!route || !params) {
        throw new ManagedCopilotError(pathMatched ? "invalid_request" : "not_found", pathMatched ? `Method ${req.method} not allowed` : `No route for ${url.pathname}`);
      }
      const principal = await resolvePrincipal(app, req, route.auth);
      // A request through an app reaches only the sessions within that app's environments, whatever module serves it.
      if (principal?.app && route.segments[0] === "v1" && route.segments[1] === "sessions" && route.segments[2] === ":id" && params["id"]) {
        app.services.sessions?.assertAppScope?.(principal, params["id"]);
      }
      let status = 200;
      const ctx: RequestContext = {
        app,
        req,
        res,
        url,
        params,
        query: url.searchParams,
        principal,
        json: async <T>() => {
          const body = await readBody(req, MAX_JSON_BYTES);
          if (body.length === 0) return {} as T;
          try {
            return JSON.parse(body.toString("utf8")) as T;
          } catch {
            throw new ManagedCopilotError("invalid_request", "Request body is not valid JSON");
          }
        },
        raw: (limit = MAX_JSON_BYTES) => readBody(req, limit),
        status: (code) => {
          status = code;
        },
      };
      const result = await route.handler(ctx);
      if (res.headersSent || res.writableEnded) return;
      if (traffic && status >= 500) app.metrics.increment("http.errors");
      if (result === undefined) {
        res.writeHead(status === 200 ? 204 : status);
        res.end();
      } else {
        sendJson(res, status, result);
      }
    } catch (error) {
      const managed = toManagedError(error);
      if (managed.code === "internal") app.log.error("Unhandled request error", { method: req.method, path: url.pathname, error: (error as Error)?.stack ?? String(error) });
      if (traffic && managed.status >= 500) app.metrics.increment("http.errors");
      if (!res.headersSent) {
        const retryAfter = retryAfterSeconds(managed);
        if (retryAfter !== undefined) res.setHeader("retry-after", String(retryAfter));
        sendJson(res, managed.status, managed.toBody());
      } else res.destroy();
    }
  }
}

/** WebSocket (and other) upgrades by exact path. Handlers own the socket after authentication succeeds. */
export class UpgradeRouter {
  readonly #routes: Route<UpgradeHandler>[] = [];

  add(path: string, handler: UpgradeHandler, options: { auth?: RouteAuth } = {}): void {
    this.#routes.push({ method: "GET", segments: splitPath(path), handler, auth: options.auth ?? "user" });
  }

  async handle(app: GatewayApp, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let url = new URL("http://gateway.local/");
    try {
      url = parseUrl(req);
      const segments = splitPath(url.pathname);
      let route: Route<UpgradeHandler> | undefined;
      let params: Record<string, string> | undefined;
      for (const candidate of this.#routes) {
        params = matchSegments(candidate.segments, segments);
        if (params) {
          route = candidate;
          break;
        }
      }
      if (!route || !params) throw new ManagedCopilotError("not_found", `No upgrade route for ${url.pathname}`);
      const principal = await resolvePrincipal(app, req, route.auth);
      await route.handler(req, socket, head, principal, { url, params, query: url.searchParams });
    } catch (error) {
      const managed = toManagedError(error);
      if (managed.code === "internal") app.log.error("Unhandled upgrade error", { path: url.pathname, error: (error as Error)?.stack ?? String(error) });
      if (socket.destroyed || !socket.writable) return;
      const body = JSON.stringify(managed.toBody());
      const retryAfter = retryAfterSeconds(managed);
      socket.end(`HTTP/1.1 ${managed.status} Error\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n${retryAfter !== undefined ? `retry-after: ${retryAfter}\r\n` : ""}connection: close\r\n\r\n${body}`);
    }
  }
}

/** `Retry-After` for retryable errors that say when to retry (`details.retryAfterSeconds`). */
function retryAfterSeconds(error: ManagedCopilotError): number | undefined {
  const value = error.details?.["retryAfterSeconds"];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}
