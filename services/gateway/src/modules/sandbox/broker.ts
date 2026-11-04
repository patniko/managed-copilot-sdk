// Credential isolation for sandbox runtimes (architecture "Credentials and inference").
//
// The runtime inside a sandbox never holds a GitHub token. The gateway registers itself as the runtime's inference
// provider (`llmInference.setProvider`), installs an opaque placeholder credential together with a Copilot identity it
// resolved itself (`session.gitHubAuth.setCredentials` with `copilotUser`, which the runtime trusts without
// re-fetching), and answers every `llmInference.httpRequestStart`/`httpRequestChunk`: it swaps the placeholder for the
// owner's current token, only for allowlisted Copilot API hosts and only for the sandbox's own session.
import { createHash } from "node:crypto";
import { isManagedCopilotError, ManagedCopilotError } from "@managed-copilot/protocol";
import WebSocket from "ws";
import type { Logger } from "../../log.js";
import type { UpstreamSend } from "./contract.js";

/** Copilot API hosts reachable through the broker, in addition to the identity's own `endpoints.api`. */
const COPILOT_API_HOSTS = new Set(["api.githubcopilot.com", "api.individual.githubcopilot.com", "api.business.githubcopilot.com", "api.enterprise.githubcopilot.com"]);
const FORBIDDEN_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "proxy-connection", "proxy-authorization", "te", "trailer", "cookie"]);
const COPILOT_USER_TTL_MS = 5 * 60_000;

type Headers = Record<string, string[] | undefined>;

interface StartParams {
  readonly requestId: string;
  readonly sessionId?: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly transport?: "http" | "websocket";
}

interface ChunkParams {
  readonly requestId: string;
  readonly data?: string;
  readonly binary?: boolean;
  readonly end?: boolean;
  readonly cancel?: boolean;
  readonly cancelReason?: string;
}

interface Exchange {
  start?: StartParams;
  /** Request body chunks; `binary` keeps WebSocket frame types intact. */
  readonly chunks: { readonly data: Buffer; readonly binary: boolean }[];
  ended: boolean;
  cancelled: boolean;
  readonly abort: AbortController;
  /** Wakes the body reader when chunks arrive. */
  wake?: () => void;
  /** Serializes response frames for this request. */
  chain: Promise<unknown>;
  running: boolean;
  /** True once `httpResponseStart` was sent. */
  started: boolean;
  socket?: WebSocket;
}

const identityCache = new Map<string, { value: Record<string, unknown>; expires: number }>();

/** The stock runtime's refusal of a second inference provider (`llmInference.setProvider`). */
const PROVIDER_TAKEN = /already the LLM inference provider/i;

/** True for the broker's error when the runtime already has an inference provider (see `InferenceBroker.initialize`). */
export function isProviderTaken(error: unknown): boolean {
  return isManagedCopilotError(error, "conflict") && (error as ManagedCopilotError).details?.["providerTaken"] === true;
}

function identityKey(token: string, githubApiUrl: string): string {
  return createHash("sha256").update(`${githubApiUrl}\0${token}`).digest("hex");
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}

/** Resolves the owner's Copilot identity (`copilot_internal/user`) outside the sandbox, with a short cache. */
export async function resolveCopilotUser(token: string, githubApiUrl: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const key = identityKey(token, githubApiUrl);
  const cached = identityCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  let response: Response;
  try {
    response = await fetchImpl(`${githubApiUrl}/copilot_internal/user`, {
      headers: { authorization: `token ${token}`, accept: "application/json", "user-agent": "managed-copilot-gateway" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new ManagedCopilotError("inference_unavailable", `Could not reach GitHub to resolve the session owner's Copilot access: ${(error as Error).message}`);
  }
  if (response.status === 401) throw new ManagedCopilotError("authentication_required", "The session owner's GitHub credential is no longer valid; sign in again.");
  if (response.status === 403 || response.status === 404) throw new ManagedCopilotError("inference_unavailable", "The session owner's GitHub account has no Copilot access.");
  if (!response.ok) throw new ManagedCopilotError("inference_unavailable", `GitHub returned HTTP ${response.status} while resolving the session owner's Copilot access.`);
  const value = (await response.json()) as Record<string, unknown>;
  identityCache.set(key, { value, expires: Date.now() + COPILOT_USER_TTL_MS });
  return value;
}

export interface InferenceBrokerOptions {
  readonly sessionId: string;
  /** Opaque per-session placeholder the runtime holds instead of a token (`mcrt_…`). */
  readonly placeholder: string;
  resolveToken(): Promise<string>;
  /**
   * Reports a token from `resolveToken` that GitHub rejected (HTTP 401 from the Copilot API or `copilot_internal/user`),
   * so core verifies it with GitHub again before its next use (core's `auth.invalidate`).
   */
  invalidateToken?(token: string): void;
  readonly githubApiUrl: string;
  readonly log: Logger;
  /**
   * The session's model calls go to an Azure AI Foundry account (spec section 15): no GitHub credential is ever
   * installed or brokered, and model calls may reach only `host`, with `token()` in place of the placeholder.
   */
  readonly foundry?: { readonly account: string; readonly host: string; token(): Promise<string> };
  readonly fetch?: typeof fetch;
  /** Opens upstream WebSockets (tests); defaults to `ws`. */
  readonly webSocket?: (url: URL, options: WebSocket.ClientOptions) => WebSocket;
}

export class InferenceBroker {
  readonly handlers: ReadonlyMap<string, (params: unknown) => Promise<unknown>>;
  readonly #options: InferenceBrokerOptions;
  readonly #exchanges = new Map<string, Exchange>();
  #send: UpstreamSend | undefined;
  #apiHosts = new Set(COPILOT_API_HOSTS);
  #closed = false;

  constructor(options: InferenceBrokerOptions) {
    this.#options = options;
    this.handlers = new Map<string, (params: unknown) => Promise<unknown>>([
      ["llmInference.httpRequestStart", async (params) => this.#onStart(params as StartParams)],
      ["llmInference.httpRequestChunk", async (params) => this.#onChunk(params as ChunkParams)],
      [
        "gitHubToken.getToken",
        async () => {
          throw new ManagedCopilotError("forbidden", "GitHub tokens are never provided to sandbox runtimes; inference is brokered by the gateway.");
        },
      ],
      [
        "providerToken.getToken",
        async () => {
          throw new ManagedCopilotError("forbidden", "Custom model providers are not available in sandboxes; inference is brokered by the gateway.");
        },
      ],
    ]);
  }

  /** Registers the gateway as the runtime's inference provider on this upstream connection. */
  async initialize(send: UpstreamSend): Promise<void> {
    this.#send = send;
    let result: { success?: boolean } | undefined;
    try {
      result = (await send("llmInference.setProvider", {})) as { success?: boolean } | undefined;
    } catch (error) {
      // Stock runtimes keep the registration with the first provider connection, even after it closed (1.0.103).
      if (PROVIDER_TAKEN.test((error as Error)?.message ?? "")) {
        throw new ManagedCopilotError("conflict", "Another connection is already the sandbox runtime's inference provider.", { providerTaken: true });
      }
      throw error;
    }
    if (result && result.success === false) throw new ManagedCopilotError("inference_unavailable", "The sandbox runtime refused the gateway as its inference provider.");
  }

  /** Installs the placeholder credential with the owner's pre-resolved Copilot identity. */
  async sessionOpened(sessionId: string): Promise<void> {
    if (!this.#send) throw new ManagedCopilotError("internal", "The sandbox runtime connection was not initialized.");
    // A Foundry session holds no GitHub credential at all: its provider's placeholder is all the runtime has.
    if (this.#options.foundry) return;
    const token = await this.#options.resolveToken();
    let copilotUser: Record<string, unknown>;
    try {
      copilotUser = await resolveCopilotUser(token, this.#options.githubApiUrl, this.#options.fetch);
    } catch (error) {
      // resolveCopilotUser reports GitHub's 401 (and only that) as authentication_required.
      if (isManagedCopilotError(error, "authentication_required")) this.#rejected(token, "copilot_internal/user");
      throw error;
    }
    this.#learnEndpoints(copilotUser);
    const result = (await this.#send("session.gitHubAuth.setCredentials", {
      sessionId,
      credentials: { type: "token", host: "https://github.com", token: this.#options.placeholder, copilotUser },
    })) as { success?: boolean; copilotUserResolved?: boolean } | undefined;
    if (!result?.success) throw new ManagedCopilotError("inference_unavailable", "The sandbox runtime did not accept the session's brokered credential.");
    if (result.copilotUserResolved === false) {
      throw new ManagedCopilotError("inference_unavailable", "The sandbox runtime could not use the session owner's Copilot identity.");
    }
  }

  close(): void {
    this.#closed = true;
    for (const exchange of this.#exchanges.values()) {
      exchange.cancelled = true;
      exchange.abort.abort();
      exchange.socket?.terminate();
      exchange.wake?.();
    }
    this.#exchanges.clear();
  }

  /** Selects the session's requested custom agent (after `sessionOpened`, when the runtime can resolve it). */
  async selectAgent(sessionId: string, name: string): Promise<void> {
    if (!this.#send) throw new ManagedCopilotError("internal", "The sandbox runtime connection was not initialized.");
    try {
      await this.#send("session.agent.select", { sessionId, name });
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      throw new ManagedCopilotError("invalid_request", /not found/i.test(message) ? `Custom agent '${name}' not found` : `Custom agent '${name}' could not be selected: ${message}`, { agent: name });
    }
  }

  #learnEndpoints(copilotUser: Record<string, unknown>): void {
    const api = (copilotUser["endpoints"] as Record<string, unknown> | undefined)?.["api"];
    if (typeof api !== "string") return;
    try {
      const url = new URL(api);
      if (url.protocol === "https:") this.#apiHosts.add(url.hostname.toLowerCase());
    } catch {
      // ignore malformed endpoint
    }
  }

  #exchange(requestId: string): Exchange {
    let exchange = this.#exchanges.get(requestId);
    if (!exchange) {
      exchange = { chunks: [], ended: false, cancelled: false, abort: new AbortController(), chain: Promise.resolve(), running: false, started: false };
      this.#exchanges.set(requestId, exchange);
    }
    return exchange;
  }

  #onStart(params: StartParams): Record<string, never> {
    if (!params || typeof params.requestId !== "string") throw new ManagedCopilotError("invalid_request", "llmInference.httpRequestStart needs a requestId");
    const exchange = this.#exchange(params.requestId);
    exchange.start = params;
    if (!exchange.running) {
      exchange.running = true;
      void this.#run(params.requestId, exchange);
    }
    return {};
  }

  #onChunk(params: ChunkParams): Record<string, never> {
    if (!params || typeof params.requestId !== "string") return {};
    const exchange = this.#exchange(params.requestId);
    if (params.cancel) {
      exchange.cancelled = true;
      exchange.ended = true;
      exchange.abort.abort();
      exchange.socket?.terminate();
    } else {
      if (params.data) exchange.chunks.push({ data: params.binary ? Buffer.from(params.data, "base64") : Buffer.from(params.data, "utf8"), binary: params.binary === true });
      if (params.end) exchange.ended = true;
    }
    const wake = exchange.wake;
    exchange.wake = undefined;
    wake?.();
    return {};
  }

  #respond(requestId: string, exchange: Exchange, method: string, params: Record<string, unknown>): Promise<unknown> {
    const send = this.#send;
    if (method === "llmInference.httpResponseStart") exchange.started = true;
    exchange.chain = exchange.chain.then(() => (send && !this.#closed ? send(method, { requestId, ...params }) : undefined)).catch(() => undefined);
    return exchange.chain;
  }

  async #fail(requestId: string, exchange: Exchange, status: number, message: string, code: string): Promise<void> {
    if (!exchange.started) await this.#respond(requestId, exchange, "llmInference.httpResponseStart", { status, statusText: message, headers: { "content-type": ["application/json"] } });
    await this.#respond(requestId, exchange, "llmInference.httpResponseChunk", { data: "", end: true, error: { message, code } });
  }

  /** Validates the request and returns the upstream headers with the owner's token in place of the placeholder. */
  async #authorize(start: StartParams): Promise<{ url: URL; headers: Record<string, string>; token: string } | { status: number; message: string; code: string }> {
    if (start.sessionId !== undefined && start.sessionId !== this.#options.sessionId) {
      return { status: 403, message: "Inference requests are only brokered for this sandbox's own session.", code: "forbidden" };
    }
    // Only model-catalog style reads happen outside a session; anything that can spend tokens must name the session.
    const method = typeof start.method === "string" ? start.method.toUpperCase() : "";
    if (start.sessionId === undefined && method !== "GET" && method !== "HEAD") {
      return { status: 403, message: "Sandbox inference requests that are not reads must belong to the sandbox's session.", code: "forbidden" };
    }
    let url: URL;
    try {
      url = new URL(start.url);
    } catch {
      return { status: 400, message: "Invalid inference URL.", code: "invalid_request" };
    }
    if (url.protocol !== "https:" && !(url.protocol === "wss:" && start.transport === "websocket")) {
      return { status: 403, message: "Only HTTPS Copilot API endpoints are reachable from sandboxes.", code: "forbidden" };
    }
    const foundry = this.#options.foundry;
    if (foundry) {
      // Only the session's own Foundry account: never the Copilot API, never another host.
      if (url.username || url.password || (url.port && url.port !== "443") || url.hostname.toLowerCase() !== foundry.host) {
        return { status: 403, message: `This session's model calls go to Azure AI Foundry account "${foundry.account}", not ${url.hostname}.`, code: "forbidden" };
      }
    } else if (url.username || url.password || (url.port && url.port !== "443") || !this.#apiHosts.has(url.hostname.toLowerCase())) {
      return { status: 403, message: `Sandbox inference can only reach the Copilot API, not ${url.hostname}. Custom model providers are not available in sandboxes.`, code: "forbidden" };
    }
    const unauthorized = { status: 401, message: "Sandbox inference requests must use the session's brokered credential.", code: "authentication_required" };
    const headers: Record<string, string> = {};
    let token: string | undefined;
    for (const [name, values] of Object.entries(start.headers ?? {})) {
      const lower = name.toLowerCase();
      if (!values || FORBIDDEN_REQUEST_HEADERS.has(lower)) continue;
      // A Foundry call authenticates only with the platform's token in place of the placeholder.
      if (foundry && lower === "api-key") return unauthorized;
      if (lower in headers) return { status: 400, message: `Duplicate "${lower}" request header.`, code: "invalid_request" };
      let value = values.join(", ");
      if (lower === "authorization") {
        // Exactly one credential, and it must be the placeholder itself: nothing else is ever rewritten.
        const match = values.length === 1 ? /^(Bearer|token) (\S+)$/i.exec(value) : null;
        if (!match || match[2] !== this.#options.placeholder) return unauthorized;
        try {
          token = foundry ? await foundry.token() : await this.#options.resolveToken();
        } catch (error) {
          const managed = error instanceof ManagedCopilotError ? error : undefined;
          return { status: 401, message: managed?.message ?? "The session owner has no usable GitHub credential.", code: managed?.code ?? "authentication_required" };
        }
        value = `${match[1]} ${token}`;
      }
      headers[lower] = value;
    }
    if (token === undefined) return unauthorized;
    return { url, headers, token };
  }

  /**
   * GitHub rejected the owner's token: core forgets its verification, so the token is verified with GitHub again (and
   * dropped if GitHub agrees) before its next use. The cached Copilot identity for it goes too.
   */
  #rejected(token: string, source: string): void {
    if (this.#options.foundry) {
      // The platform's own Azure token: nothing about the owner's GitHub sign-in to forget.
      this.#options.log.warn("Azure AI Foundry refused the platform's token for a model call", { sessionId: this.#options.sessionId, account: this.#options.foundry.account, source });
      return;
    }
    identityCache.delete(identityKey(token, this.#options.githubApiUrl));
    this.#options.log.info("GitHub rejected the session owner's credential; it is verified again before its next use", { sessionId: this.#options.sessionId, source });
    try {
      this.#options.invalidateToken?.(token);
    } catch (error) {
      this.#options.log.warn("Could not invalidate a rejected credential", { sessionId: this.#options.sessionId, error: (error as Error).message });
    }
  }

  async #body(exchange: Exchange): Promise<Buffer> {
    while (!exchange.ended && !exchange.cancelled) await new Promise<void>((resolve) => (exchange.wake = resolve));
    return Buffer.concat(exchange.chunks.splice(0).map((chunk) => chunk.data));
  }

  async #run(requestId: string, exchange: Exchange): Promise<void> {
    const start = exchange.start!;
    const began = Date.now();
    this.#options.log.debug("Brokering sandbox inference request", { sessionId: this.#options.sessionId, requestId, method: start.method, host: safeHost(start.url), transport: start.transport ?? "http" });
    try {
      const authorized = await this.#authorize(start);
      if ("status" in authorized) {
        this.#options.log.warn("Refused a sandbox inference request", { sessionId: this.#options.sessionId, reason: authorized.message });
        await this.#fail(requestId, exchange, authorized.status, authorized.message, authorized.code);
        return;
      }
      if (start.transport === "websocket") await this.#runWebSocket(requestId, exchange, authorized.url, authorized.headers, authorized.token);
      else await this.#runHttp(requestId, exchange, start.method, authorized.url, authorized.headers, authorized.token);
    } catch (error) {
      if (!exchange.cancelled) this.#options.log.warn("Sandbox inference request failed", { sessionId: this.#options.sessionId, error: (error as Error).message });
      await this.#fail(requestId, exchange, 502, exchange.cancelled ? "Request cancelled by the runtime" : `Inference request failed: ${(error as Error).message}`, exchange.cancelled ? "cancelled" : "bad_gateway");
    } finally {
      this.#exchanges.delete(requestId);
      this.#options.log.debug("Sandbox inference request finished", { sessionId: this.#options.sessionId, requestId, ms: Date.now() - began, cancelled: exchange.cancelled });
    }
  }

  async #runHttp(requestId: string, exchange: Exchange, method: string, url: URL, headers: Record<string, string>, token: string): Promise<void> {
    const upper = method.toUpperCase();
    const body = await this.#body(exchange);
    if (exchange.cancelled) throw new Error("cancelled");
    const fetchImpl = this.#options.fetch ?? fetch;
    const response = await fetchImpl(url, { method: upper, headers, ...(upper !== "GET" && upper !== "HEAD" && body.length > 0 ? { body } : {}), signal: exchange.abort.signal });
    if (response.status === 401) this.#rejected(token, url.host);
    const responseHeaders: Headers = {};
    response.headers.forEach((value, name) => {
      if (name.toLowerCase() === "set-cookie") return;
      (responseHeaders[name] ??= []).push(value);
    });
    await this.#respond(requestId, exchange, "llmInference.httpResponseStart", { status: response.status, ...(response.statusText ? { statusText: response.statusText } : {}), headers: responseHeaders });
    try {
      if (response.body) {
        for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
          if (exchange.cancelled) break;
          if (chunk.byteLength === 0) continue;
          await this.#respond(requestId, exchange, "llmInference.httpResponseChunk", { data: Buffer.from(chunk).toString("base64"), binary: true });
        }
      }
    } catch (error) {
      await this.#respond(requestId, exchange, "llmInference.httpResponseChunk", { data: "", end: true, error: { message: exchange.cancelled ? "Request cancelled by the runtime" : `Response stream failed: ${(error as Error).message}`, code: exchange.cancelled ? "cancelled" : "bad_gateway" } });
      return;
    }
    await this.#respond(requestId, exchange, "llmInference.httpResponseChunk", { data: "", end: true });
  }

  async #runWebSocket(requestId: string, exchange: Exchange, url: URL, headers: Record<string, string>, token: string): Promise<void> {
    const target = new URL(url);
    if (target.protocol === "https:") target.protocol = "wss:";
    const options: WebSocket.ClientOptions = { headers, perMessageDeflate: false, handshakeTimeout: 20_000 };
    const socket = this.#options.webSocket ? this.#options.webSocket(target, options) : new WebSocket(target, options);
    exchange.socket = socket;
    // A persistent listener: an unhandled WebSocket 'error' would crash the gateway.
    let failure: Error | undefined;
    socket.on("error", (error) => {
      failure ??= error;
    });
    const wakeSender = () => {
      const wake = exchange.wake;
      exchange.wake = undefined;
      wake?.();
    };
    const done = new Promise<void>((resolve) =>
      socket.once("close", () => {
        wakeSender();
        resolve();
      }),
    );
    // Listen from the start: frames that arrive before the response start is acknowledged are buffered, then
    // forwarded in order.
    const early: { data: Buffer; binary: boolean }[] = [];
    let forwarding = false;
    const forward = (data: Buffer, binary: boolean) => {
      void this.#respond(requestId, exchange, "llmInference.httpResponseChunk", binary ? { data: data.toString("base64"), binary: true } : { data: data.toString("utf8") });
    };
    socket.on("message", (data, isBinary) => {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (forwarding) forward(buffer, isBinary);
      else early.push({ data: buffer, binary: isBinary });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
      socket.once("unexpected-response", (request, response) => {
        response.resume();
        request.destroy();
        if (response.statusCode === 401) this.#rejected(token, target.host);
        reject(new Error(`WebSocket upgrade refused with HTTP ${response.statusCode}`));
      });
      socket.once("close", () => reject(failure ?? new Error("WebSocket closed during the upgrade")));
    });
    await this.#respond(requestId, exchange, "llmInference.httpResponseStart", { status: 101, headers: {} });
    forwarding = true;
    for (const frame of early.splice(0)) forward(frame.data, frame.binary);
    // Each request chunk is one runtime message, sent with its original frame type.
    void (async () => {
      while (!exchange.cancelled && socket.readyState === WebSocket.OPEN) {
        const chunk = exchange.chunks.shift();
        if (!chunk) {
          if (exchange.ended) break;
          await new Promise<void>((resolve) => (exchange.wake = resolve));
          continue;
        }
        try {
          socket.send(chunk.binary ? chunk.data : chunk.data.toString("utf8"), { binary: chunk.binary });
        } catch (error) {
          failure ??= error as Error;
          socket.terminate();
        }
      }
      if (socket.readyState === WebSocket.OPEN) socket.close(1000);
    })();
    await done;
    if (failure && !exchange.cancelled) {
      await this.#respond(requestId, exchange, "llmInference.httpResponseChunk", { data: "", end: true, error: { message: `Inference stream failed: ${failure.message}`, code: "bad_gateway" } });
      return;
    }
    await this.#respond(requestId, exchange, "llmInference.httpResponseChunk", { data: "", end: true });
  }
}
