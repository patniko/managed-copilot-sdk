// Credential isolation for sandbox runtimes (architecture "Credentials and inference").
//
// The runtime inside a sandbox never holds a GitHub token. The gateway registers itself as the runtime's inference
// provider (`llmInference.setProvider`), installs an opaque placeholder credential together with a Copilot identity it
// resolved itself (`session.gitHubAuth.setCredentials` with `copilotUser`, which the runtime trusts without
// re-fetching), and answers every `llmInference.httpRequestStart`/`httpRequestChunk`: it swaps the placeholder for the
// owner's current token, only for allowlisted Copilot API hosts and only for the sandbox's own session.
import { createHash } from "node:crypto";
import { ManagedCopilotError } from "@managed-copilot/protocol";
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
  readonly chunks: Buffer[];
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

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}

/** Resolves the owner's Copilot identity (`copilot_internal/user`) outside the sandbox, with a short cache. */
export async function resolveCopilotUser(token: string, githubApiUrl: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const key = createHash("sha256").update(`${githubApiUrl}\0${token}`).digest("hex");
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
  readonly githubApiUrl: string;
  readonly log: Logger;
  readonly fetch?: typeof fetch;
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
    ]);
  }

  /** Registers the gateway as the runtime's inference provider on this upstream connection. */
  async initialize(send: UpstreamSend): Promise<void> {
    this.#send = send;
    const result = (await send("llmInference.setProvider", {})) as { success?: boolean } | undefined;
    if (result && result.success === false) throw new ManagedCopilotError("inference_unavailable", "The sandbox runtime refused the gateway as its inference provider.");
  }

  /** Installs the placeholder credential with the owner's pre-resolved Copilot identity. */
  async sessionOpened(sessionId: string): Promise<void> {
    if (!this.#send) throw new ManagedCopilotError("internal", "The sandbox runtime connection was not initialized.");
    const token = await this.#options.resolveToken();
    const copilotUser = await resolveCopilotUser(token, this.#options.githubApiUrl, this.#options.fetch);
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
      if (params.data) exchange.chunks.push(params.binary ? Buffer.from(params.data, "base64") : Buffer.from(params.data, "utf8"));
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
  async #authorize(start: StartParams): Promise<{ url: URL; headers: Record<string, string> } | { status: number; message: string; code: string }> {
    if (start.sessionId !== undefined && start.sessionId !== this.#options.sessionId) {
      return { status: 403, message: "Inference requests are only brokered for this sandbox's own session.", code: "forbidden" };
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
    if (url.username || url.password || (url.port && url.port !== "443") || !this.#apiHosts.has(url.hostname.toLowerCase())) {
      return { status: 403, message: `Sandbox inference can only reach the Copilot API, not ${url.hostname}. Custom model providers are not available in sandboxes.`, code: "forbidden" };
    }
    const headers: Record<string, string> = {};
    let authorized = false;
    for (const [name, values] of Object.entries(start.headers ?? {})) {
      const lower = name.toLowerCase();
      if (!values || FORBIDDEN_REQUEST_HEADERS.has(lower)) continue;
      let value = values.join(", ");
      if (lower === "authorization") {
        if (!value.includes(this.#options.placeholder)) return { status: 401, message: "Sandbox inference requests must use the session's brokered credential.", code: "authentication_required" };
        let token: string;
        try {
          token = await this.#options.resolveToken();
        } catch (error) {
          const managed = error instanceof ManagedCopilotError ? error : undefined;
          return { status: 401, message: managed?.message ?? "The session owner has no usable GitHub credential.", code: managed?.code ?? "authentication_required" };
        }
        value = value.split(this.#options.placeholder).join(token);
        authorized = true;
      }
      headers[lower] = value;
    }
    if (!authorized) return { status: 401, message: "Sandbox inference requests must use the session's brokered credential.", code: "authentication_required" };
    return { url, headers };
  }

  async #body(exchange: Exchange): Promise<Buffer> {
    while (!exchange.ended && !exchange.cancelled) await new Promise<void>((resolve) => (exchange.wake = resolve));
    return Buffer.concat(exchange.chunks.splice(0));
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
      if (start.transport === "websocket") await this.#runWebSocket(requestId, exchange, authorized.url, authorized.headers);
      else await this.#runHttp(requestId, exchange, start.method, authorized.url, authorized.headers);
    } catch (error) {
      if (!exchange.cancelled) this.#options.log.warn("Sandbox inference request failed", { sessionId: this.#options.sessionId, error: (error as Error).message });
      await this.#fail(requestId, exchange, 502, exchange.cancelled ? "Request cancelled by the runtime" : `Inference request failed: ${(error as Error).message}`, exchange.cancelled ? "cancelled" : "bad_gateway");
    } finally {
      this.#exchanges.delete(requestId);
      this.#options.log.debug("Sandbox inference request finished", { sessionId: this.#options.sessionId, requestId, ms: Date.now() - began, cancelled: exchange.cancelled });
    }
  }

  async #runHttp(requestId: string, exchange: Exchange, method: string, url: URL, headers: Record<string, string>): Promise<void> {
    const upper = method.toUpperCase();
    const body = await this.#body(exchange);
    if (exchange.cancelled) throw new Error("cancelled");
    const fetchImpl = this.#options.fetch ?? fetch;
    const response = await fetchImpl(url, { method: upper, headers, ...(upper !== "GET" && upper !== "HEAD" && body.length > 0 ? { body } : {}), signal: exchange.abort.signal });
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

  async #runWebSocket(requestId: string, exchange: Exchange, url: URL, headers: Record<string, string>): Promise<void> {
    const target = new URL(url);
    if (target.protocol === "https:") target.protocol = "wss:";
    const socket = new WebSocket(target, { headers, perMessageDeflate: false, handshakeTimeout: 20_000 });
    exchange.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
      socket.once("unexpected-response", (_req, res) => reject(new Error(`WebSocket upgrade refused with HTTP ${res.statusCode}`)));
    });
    await this.#respond(requestId, exchange, "llmInference.httpResponseStart", { status: 101, headers: {} });
    const done = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("message", (data, isBinary) => {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      void this.#respond(requestId, exchange, "llmInference.httpResponseChunk", isBinary ? { data: buffer.toString("base64"), binary: true } : { data: buffer.toString("utf8") });
    });
    // Each request chunk is one runtime message.
    void (async () => {
      while (!exchange.cancelled && socket.readyState === WebSocket.OPEN) {
        if (exchange.chunks.length === 0) {
          if (exchange.ended) break;
          await new Promise<void>((resolve) => (exchange.wake = resolve));
          continue;
        }
        socket.send(exchange.chunks.shift()!.toString("utf8"));
      }
      if (socket.readyState === WebSocket.OPEN) socket.close(1000);
    })();
    await done;
    await this.#respond(requestId, exchange, "llmInference.httpResponseChunk", { data: "", end: true });
  }
}
