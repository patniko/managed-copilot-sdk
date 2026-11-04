import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { CopilotClient } from "@github/copilot-sdk";
import {
  APP_KEY_ENV,
  discoveryFile,
  ManagedCopilotError,
  ROUTES,
  TOKEN_ENVS,
  URL_ENV,
  type AccountInfo,
  type DeploymentInfo,
  type DiscoveryRecord,
} from "@managed-copilot/protocol";
import { HttpClient, timings } from "./http.js";
import { identityKey, type Identity } from "./identity.js";
import type { ConnectOptions, ManagedContext } from "./types.js";

const execFileAsync = promisify(execFile);

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Validates a deployment URL before any credential is sent to it: HTTPS for remote deployments, HTTP only for
 * loopback, and no embedded credentials, query, or fragment. Returns the normalized base URL.
 */
export function validateDeploymentUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ManagedCopilotError("invalid_request", `"${value}" is not a valid Managed Copilot deployment URL`);
  }
  if (url.username || url.password) throw new ManagedCopilotError("invalid_request", "The deployment URL must not embed credentials");
  if (url.search || url.hash) throw new ManagedCopilotError("invalid_request", "The deployment URL must not include a query or fragment");
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new ManagedCopilotError("invalid_request", `Refusing to send your GitHub token over plain HTTP to ${url.host}; remote deployments must use https://`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ManagedCopilotError("invalid_request", `Unsupported deployment URL scheme ${url.protocol}`);
  return url.toString().replace(/\/+$/, "");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Reads and validates the discovery record a running local gateway writes. */
export async function readDiscovery(file: string = discoveryFile()): Promise<DiscoveryRecord> {
  let record: Partial<DiscoveryRecord>;
  try {
    record = JSON.parse(await readFile(file, "utf8")) as Partial<DiscoveryRecord>;
  } catch {
    throw new ManagedCopilotError(
      "capability_unavailable",
      `No Managed Copilot deployment found. Start the local platform with \`aspire run\`, or pass { url } / set ${URL_ENV}.`,
    );
  }
  if (typeof record.url !== "string" || typeof record.pid !== "number") {
    throw new ManagedCopilotError("capability_unavailable", `The local discovery record ${file} is invalid; restart the local platform with \`aspire run\`.`);
  }
  const url = new URL(record.url);
  if (!isLoopbackHost(url.hostname)) {
    throw new ManagedCopilotError("invalid_request", `The local discovery record points at ${url.host}, which is not a loopback address; refusing to use it.`);
  }
  if (!processAlive(record.pid)) {
    throw new ManagedCopilotError("capability_unavailable", "The local Managed Copilot platform is not running anymore. Start it with `aspire run`.");
  }
  return record as DiscoveryRecord;
}

/** Explicit option, then `MANAGED_COPILOT_URL`, then the discovery record written by a running local AppHost. */
export async function resolveUrl(explicit?: string): Promise<string> {
  const fromEnv = process.env[URL_ENV];
  if (explicit) return validateDeploymentUrl(explicit);
  if (fromEnv) return validateDeploymentUrl(fromEnv);
  return validateDeploymentUrl((await readDiscovery()).url);
}

/** Explicit token, then the documented environment variables, then the signed-in GitHub CLI. */
export async function resolveToken(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  for (const name of TOKEN_ENVS) {
    const value = process.env[name];
    if (value) return value;
  }
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { windowsHide: true, timeout: 10_000 });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // Fall through to the explicit error below.
  }
  throw new ManagedCopilotError(
    "authentication_required",
    `Sign in with GitHub first: pass { gitHubToken }, set ${TOKEN_ENVS.join(" or ")}, or run \`gh auth login\`.`,
  );
}

/** Internal state beyond the public `ManagedContext` shape. */
export interface ManagedState extends ManagedContext {
  /** Session ID → the identity of the client that created or resumed it (shared by every view of a connection). */
  readonly identities: Map<string, Identity>;
  /** `managed.createSession` / `resumeSession` reuse one client per environment selector and identity. */
  readonly cachedClients: Map<string, Promise<CopilotClient>>;
  /** Per-identity REST clients, by `identityKey`. */
  readonly httpClients: Map<string, HttpClient>;
  /** `managed.as(...)` views of this connection, by `identityKey` (the root's map, shared by its views). */
  readonly views: Map<string, Promise<ManagedState>>;
  /** The connection this view came from (undefined for the connection itself). */
  readonly root: ManagedState | undefined;
}

/** The REST client acting as `identity`, shared across a connection's views. */
export function httpForIdentity(ctx: Pick<ManagedState, "url" | "httpClients">, identity: Identity): HttpClient {
  const key = identityKey(identity);
  let client = ctx.httpClients.get(key);
  if (!client) {
    client = new HttpClient(ctx.url, identity);
    ctx.httpClients.set(key, client);
  }
  return client;
}

function withDefaults(state: Omit<ManagedState, "httpFor">): ManagedState {
  const ctx: ManagedState = {
    ...state,
    httpFor(sessionId: string): HttpClient {
      const identity = state.identities.get(sessionId);
      return identity ? httpForIdentity(ctx, identity) : state.http;
    },
  };
  return ctx;
}

/** The app key: the explicit option, then `MANAGED_COPILOT_APP_KEY`. */
export function resolveAppKey(explicit?: string): string | undefined {
  if (explicit !== undefined) {
    if (!explicit.trim()) throw new ManagedCopilotError("authentication_required", "appKey is empty; pass the key the AppHost issued to your app.");
    return explicit.trim();
  }
  const fromEnv = process.env[APP_KEY_ENV]?.trim();
  return fromEnv ? fromEnv : undefined;
}

export async function createContext(options: ConnectOptions = {}): Promise<ManagedState> {
  const url = await resolveUrl(options.url);
  const appKey = resolveAppKey(options.appKey);
  // An app connection is the app itself: it never falls back to this machine's GitHub sign-in. It acts for a GitHub
  // user only when one is named (`gitHubToken` here, or per client and view).
  const identity: Identity = appKey ? { appKey, ...(options.gitHubToken ? { token: options.gitHubToken } : {}) } : { token: await resolveToken(options.gitHubToken) };
  const http = new HttpClient(url, identity);
  // Bounded, so a deployment that never answers (a gateway being replaced behind its ingress) fails with `timeout`.
  const bound = { timeoutMs: timings.connectMs };
  const [info, account] = await Promise.all([http.get<DeploymentInfo>(ROUTES.info, bound), http.get<AccountInfo>(ROUTES.me, bound)]);
  return withDefaults({
    url: http.baseUrl,
    identity,
    clientName: options.clientName,
    info,
    account,
    http,
    clients: new Set(),
    listeners: new Map(),
    disposables: new Set(),
    identities: new Map(),
    cachedClients: new Map(),
    httpClients: new Map([[identityKey(identity), http]]),
    views: new Map(),
    root: undefined,
  });
}

/**
 * A view of a connection that acts for another person by default (`managed.as(...)`): it shares the connection's
 * deployment information, REST clients, and session identities, and has its own account, clients, and event stream.
 */
export async function createView(ctx: ManagedState, identity: Identity): Promise<ManagedState> {
  const root = ctx.root ?? ctx;
  const key = identityKey(identity);
  if (key === identityKey(root.identity)) return root;
  let pending = root.views.get(key);
  if (!pending) {
    pending = (async () => {
      const http = httpForIdentity(root, identity);
      const account = await http.get<AccountInfo>(ROUTES.me, { timeoutMs: timings.connectMs });
      return withDefaults({
        url: root.url,
        identity,
        clientName: root.clientName,
        info: root.info,
        account,
        http,
        clients: new Set(),
        listeners: new Map(),
        disposables: new Set(),
        identities: root.identities,
        cachedClients: root.cachedClients,
        httpClients: root.httpClients,
        views: root.views,
        root,
      });
    })();
    root.views.set(key, pending);
    pending.catch(() => root.views.delete(key));
  }
  return pending;
}

export function notImplemented(feature: string): never {
  throw new ManagedCopilotError("capability_unavailable", `${feature} is not available in this build of @managed-copilot/sdk yet.`);
}
