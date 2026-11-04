// Builds a stock CopilotClient whose transport is the stdio-to-WSS bridge.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CopilotClient, RuntimeConnection, type CopilotSession } from "@github/copilot-sdk";
import {
  BRIDGE_ENV,
  ERROR_CODES,
  ManagedCopilotError,
  ROUTES,
  type BridgeConfig,
  type DeploymentInfo,
  type EnvironmentRequest,
  type ErrorCode,
  type SessionInfo,
} from "@managed-copilot/protocol";
import type { ManagedState } from "../connection.js";
import { HttpClient } from "../http.js";
import type { EnvironmentSelector, ManagedClientOptions, ManagedResumeConfig, ManagedSessionConfig } from "../types.js";

const BRIDGE_PATH = fileURLToPath(new URL("../bridge.js", import.meta.url));

function encodeFiles(files: Record<string, string | Uint8Array> | undefined): Record<string, string> | undefined {
  if (!files) return undefined;
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, Buffer.from(content).toString("base64")]));
}

/** Combines a selector with client-level defaults into the wire `EnvironmentRequest`. */
export function toEnvironmentRequest(selector: EnvironmentSelector, options: ManagedClientOptions = {}): EnvironmentRequest {
  const descriptor = typeof selector === "string" ? { name: selector } : selector;
  const files = { ...(encodeFiles(options.files) ?? {}), ...(encodeFiles(descriptor.files) ?? {}) };
  const env = { ...(options.env ?? {}), ...(descriptor.env ?? {}) };
  const packages = options.packages || descriptor.packages
    ? {
        ...((options.packages?.python || descriptor.packages?.python) ? { python: [...(options.packages?.python ?? []), ...(descriptor.packages?.python ?? [])] } : {}),
        ...((options.packages?.npm || descriptor.packages?.npm) ? { npm: [...(options.packages?.npm ?? []), ...(descriptor.packages?.npm ?? [])] } : {}),
      }
    : undefined;
  const network = descriptor.network ?? options.network;
  const vaults = descriptor.vaults ?? options.vaults;
  return {
    ...(descriptor.name !== undefined ? { name: descriptor.name } : {}),
    ...(descriptor.type !== undefined ? { type: descriptor.type } : {}),
    ...(descriptor.size !== undefined ? { size: descriptor.size } : {}),
    ...(network !== undefined ? { network: network as EnvironmentRequest["network"] } : {}),
    ...(vaults !== undefined ? { vaults: [...vaults] } : {}),
    ...(packages ? { packages } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(Object.keys(files).length > 0 ? { files } : {}),
  };
}

/** Fails early, at `managed.client(...)`, for environments the deployment does not offer. */
export function checkEnvironment(info: DeploymentInfo, request: EnvironmentRequest): void {
  if (request.name !== undefined) {
    if (!info.environments.some((environment) => environment.name === request.name)) {
      const known = info.environments.map((environment) => environment.name);
      throw new ManagedCopilotError("environment_not_found", `Unknown environment "${request.name}".${known.length > 0 ? ` This deployment offers: ${known.join(", ")}.` : ""}`);
    }
    return;
  }
  if (request.type === undefined) throw new ManagedCopilotError("invalid_request", "Choose an environment by name, or an inline { type }");
  if (!info.inline?.types.includes(request.type)) {
    throw new ManagedCopilotError("environment_not_found", `This deployment does not allow inline ${request.type} environments. Use a declared environment name.`);
  }
  if (request.size !== undefined && info.inline.sizes && !info.inline.sizes.includes(request.size)) {
    throw new ManagedCopilotError("environment_not_found", `This deployment does not allow inline ${request.type} environments of size ${request.size}`);
  }
}

function connectUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl}${ROUTES.connect}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** The bridge reports gateway errors on stderr as `... (<error_code>)`; surface them as ManagedCopilotError. */
function toManagedError(error: unknown): unknown {
  if (error instanceof ManagedCopilotError) return error;
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split(/\r?\n/).find((candidate) => candidate.includes("[managed-copilot]"));
  if (!line) return error;
  const message = line.slice(line.indexOf("[managed-copilot]") + "[managed-copilot]".length).trim();
  const match = /\(([a-z_]+)\)\s*$/.exec(message);
  const code = match && (ERROR_CODES as readonly string[]).includes(match[1]!) ? (match[1] as ErrorCode) : "capability_unavailable";
  return new ManagedCopilotError(code, match ? message.slice(0, match.index).trim() : message);
}

/** Environment variables for the bridge: the caller's environment minus credentials, plus the bridge config. */
function bridgeEnvironment(config: BridgeConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /token|secret|password|^COPILOT_|^MANAGED_COPILOT_/i.test(key)) continue;
    env[key] = value;
  }
  env[BRIDGE_ENV] = JSON.stringify(config);
  return env;
}

export async function createClient(ctx: ManagedState, environment: EnvironmentSelector, options: ManagedClientOptions = {}): Promise<CopilotClient> {
  const request = toEnvironmentRequest(environment, options);
  checkEnvironment(ctx.info, request);
  const { gitHubToken, vaults: _vaults, network: _network, packages: _packages, env: _env, files: _files, ...clientOptions } = options;
  const token = gitHubToken ?? ctx.token;
  const config: BridgeConfig = { url: connectUrl(ctx.url), token, environment: request, ...(ctx.clientName ? { clientName: ctx.clientName } : {}) };
  const client = new CopilotClient({ ...clientOptions, connection: RuntimeConnection.forStdio({ path: BRIDGE_PATH, env: bridgeEnvironment(config) }) });
  try {
    await client.start();
  } catch (error) {
    await client.forceStop().catch(() => undefined);
    throw toManagedError(error);
  }
  // Sessions this client creates or resumes act as its identity in REST helpers (files, artifacts, actions).
  client.onLifecycle((event) => {
    if (event.type === "session.deleted") ctx.identities.delete(event.sessionId);
    else ctx.identities.set(event.sessionId, token);
  });
  ctx.clients.add(client);
  return client;
}

function cacheKey(request: EnvironmentRequest, token: string): string {
  return `${createHash("sha256").update(token).digest("base64url").slice(0, 16)}:${JSON.stringify(request)}`;
}

/** The REST client acting as a given GitHub identity. */
function httpForToken(ctx: ManagedState, token: string): HttpClient {
  let client = ctx.httpClients.get(token);
  if (!client) {
    client = new HttpClient(ctx.url, token);
    ctx.httpClients.set(token, client);
  }
  return client;
}

/** One client per environment selector and identity, reused by `managed.createSession` / `resumeSession`. */
async function cachedClient(ctx: ManagedState, environment: EnvironmentSelector, gitHubToken: string | undefined): Promise<CopilotClient> {
  const key = cacheKey(toEnvironmentRequest(environment), gitHubToken ?? ctx.token);
  let pending = ctx.cachedClients.get(key);
  if (!pending) {
    // Pass the original selector: createClient encodes files exactly once.
    pending = createClient(ctx, environment, gitHubToken ? { gitHubToken } : {});
    ctx.cachedClients.set(key, pending);
    pending.catch(() => ctx.cachedClients.delete(key));
  }
  const client = await pending;
  // A stock client whose bridge exited reconnects by itself on the next createSession/resumeSession.
  return client;
}

export async function createManagedSession(ctx: ManagedState, config: ManagedSessionConfig): Promise<CopilotSession> {
  const { environment, ...sessionConfig } = config;
  if (environment === undefined) throw new ManagedCopilotError("invalid_request", "managed.createSession needs an environment");
  const client = await cachedClient(ctx, environment, sessionConfig.gitHubToken);
  const session = await client.createSession(sessionConfig);
  // REST helpers called right away act as the identity that created it (the lifecycle notification can come later).
  ctx.identities.set(session.sessionId, sessionConfig.gitHubToken ?? ctx.token);
  return session;
}

export async function resumeManagedSession(ctx: ManagedState, sessionId: string, config: ManagedResumeConfig = {}): Promise<CopilotSession> {
  const { environment, ...resumeConfig } = config;
  let selector: EnvironmentSelector | undefined = environment;
  if (selector === undefined) {
    const http = resumeConfig.gitHubToken ? httpForToken(ctx, resumeConfig.gitHubToken) : ctx.httpFor(sessionId);
    const info = await http.get<SessionInfo>(ROUTES.session(sessionId));
    const declared = ctx.info.environments.some((candidate) => candidate.name === info.environment);
    selector = declared ? info.environment : { type: info.type, ...(info.sandbox?.size && info.type !== "shared" ? { size: info.sandbox.size } : {}) };
  }
  const client = await cachedClient(ctx, selector, resumeConfig.gitHubToken);
  const session = await client.resumeSession(sessionId, resumeConfig);
  ctx.identities.set(session.sessionId, resumeConfig.gitHubToken ?? ctx.token);
  return session;
}
