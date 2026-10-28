// Gateway-side client for one sandbox's sandboxd, reached at the provider's endpoint (the Docker relay locally).
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex, Readable } from "node:stream";
import {
  ManagedCopilotError,
  SANDBOXD_ROUTES,
  sandboxdExecRoute,
  type ErrorCode,
  type FileEntry,
  type SandboxdStatus,
  type SandboxExecRead,
  type SandboxExecRecord,
  type SandboxExecRequest,
  type SandboxOutputsManifest,
  type SandboxStartEvent,
  type SandboxStartRequest,
} from "@managed-copilot/protocol";
import WebSocket, { createWebSocketStream } from "ws";
import type { SandboxEndpoint } from "./providers/types.js";

/** How often runtime and tunnel streams are pinged (see `SandboxAgentClient.openStream`). */
const KEEPALIVE_MS = 30_000;

const CODE_MAP: Record<string, ErrorCode> = {
  invalid_request: "invalid_request",
  forbidden: "forbidden",
  not_found: "not_found",
  conflict: "conflict",
  unavailable: "capability_unavailable",
  authentication_required: "internal",
  internal: "internal",
};

interface SendOptions {
  query?: Record<string, string>;
  body?: Buffer | Readable;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function errorFrom(res: IncomingMessage, fallback: string): Promise<ManagedCopilotError> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error?: { code?: string; message?: string } };
    const code = CODE_MAP[body.error?.code ?? ""] ?? "internal";
    return new ManagedCopilotError(code, body.error?.message ?? fallback);
  } catch {
    return new ManagedCopilotError(res.statusCode === 503 ? "capability_unavailable" : "internal", `${fallback} (HTTP ${res.statusCode})`);
  }
}

export class SandboxAgentClient {
  readonly #endpoint: () => Promise<SandboxEndpoint>;
  readonly #key: string;
  readonly #onUnreachable: (() => void) | undefined;

  constructor(endpoint: () => Promise<SandboxEndpoint>, key: string, onUnreachable?: () => void) {
    this.#endpoint = endpoint;
    this.#key = key;
    this.#onUnreachable = onUnreachable;
  }

  async #headers(): Promise<{ base: URL; headers: Record<string, string> }> {
    const endpoint = await this.#endpoint();
    return { base: new URL(endpoint.url.replace(/\/+$/, "")), headers: { ...endpoint.headers, authorization: "Bearer " + this.#key } };
  }

  /** Sends a request and returns the raw response for 2xx statuses; maps errors to ManagedCopilotError. */
  async #send(method: string, route: string, options: SendOptions = {}): Promise<IncomingMessage> {
    const { base, headers } = await this.#headers();
    const search = new URLSearchParams(options.query ?? {}).toString();
    const path = `${base.pathname === "/" ? "" : base.pathname}${route}${search ? `?${search}` : ""}`;
    const request = (base.protocol === "https:" ? httpsRequest : httpRequest) as typeof httpRequest;
    return new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        { protocol: base.protocol, hostname: base.hostname, ...(base.port ? { port: Number(base.port) } : {}), method, path, headers: { ...headers, ...options.headers }, ...(options.signal ? { signal: options.signal } : {}) },
        (res) => {
          if ((res.statusCode ?? 500) >= 400) {
            void errorFrom(res, `Sandbox request ${method} ${route} failed`).then(reject, reject);
            return;
          }
          resolve(res);
        },
      );
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (error.name === "AbortError") return reject(new ManagedCopilotError("invalid_request", "The sandbox request was cancelled."));
        if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") this.#onUnreachable?.();
        reject(new ManagedCopilotError("capability_unavailable", `The sandbox is not reachable: ${error.message}`));
      });
      if (options.timeoutMs) req.setTimeout(options.timeoutMs, () => req.destroy(new Error(`timed out after ${options.timeoutMs} ms`)));
      const body = options.body;
      if (body === undefined) req.end();
      else if (Buffer.isBuffer(body)) req.end(body);
      else {
        body.on("error", (error) => req.destroy(error));
        body.pipe(req);
      }
    });
  }

  async #json<T>(method: string, route: string, options: SendOptions = {}): Promise<T> {
    const res = await this.#send(method, route, options);
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  }

  health(timeoutMs = 5000): Promise<SandboxdStatus> {
    return this.#json("GET", SANDBOXD_ROUTES.health, { timeoutMs });
  }

  /** Replaces the sandbox's runtime process with a fresh one (`SANDBOXD_ROUTES.runtimeRestart`); resolves once it listens. */
  restartRuntime(): Promise<SandboxdStatus> {
    return this.#json("POST", SANDBOXD_ROUTES.runtimeRestart, { timeoutMs: 120_000 });
  }

  /** Waits until sandboxd answers (the container just started). */
  async waitHealthy(timeoutMs = 60_000): Promise<SandboxdStatus> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.health(3000);
      } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new ManagedCopilotError("capability_unavailable", `The sandbox agent did not become reachable within ${Math.round(timeoutMs / 1000)} seconds: ${(last as Error)?.message ?? "no response"}`);
  }

  /** Runs sandboxd's start sequence, reporting each progress event; resolves with the final event. */
  async start(body: SandboxStartRequest, onEvent: (event: SandboxStartEvent) => void): Promise<SandboxStartEvent> {
    const res = await this.#send("POST", SANDBOXD_ROUTES.start, { body: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } });
    let buffer = "";
    let last: SandboxStartEvent | undefined;
    for await (const chunk of res) {
      buffer += (chunk as Buffer).toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line) as SandboxStartEvent;
        last = event;
        onEvent(event);
      }
    }
    if (!last || (last.type !== "ready" && last.type !== "failed")) {
      throw new ManagedCopilotError("internal", "The sandbox start stream ended before the sandbox was ready.");
    }
    return last;
  }

  listFiles(path: string, recursive: boolean): Promise<FileEntry[]> {
    return this.#json("GET", SANDBOXD_ROUTES.files, { query: { path, ...(recursive ? { recursive: "true" } : {}) } });
  }

  async readFile(path: string): Promise<{ size: number; modifiedAt: string; body: IncomingMessage }> {
    const res = await this.#send("GET", SANDBOXD_ROUTES.fileContent, { query: { path } });
    return { size: Number(res.headers["content-length"] ?? 0), modifiedAt: String(res.headers["x-file-modified-at"] ?? new Date().toISOString()), body: res };
  }

  writeFile(path: string, body: Readable | Buffer, options: { overwrite: boolean; size?: number; signal?: AbortSignal }): Promise<FileEntry & { sha256?: string }> {
    return this.#json("PUT", SANDBOXD_ROUTES.fileContent, {
      query: { path, overwrite: String(options.overwrite) },
      body,
      headers: { "content-type": "application/octet-stream", ...(options.size !== undefined ? { "content-length": String(options.size) } : { "transfer-encoding": "chunked" }) },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  outputsManifest(): Promise<SandboxOutputsManifest> {
    return this.#json("POST", SANDBOXD_ROUTES.outputsManifest, { timeoutMs: 10 * 60_000 });
  }

  async readOutput(path: string): Promise<IncomingMessage> {
    return this.#send("GET", SANDBOXD_ROUTES.outputsContent, { query: { path } });
  }

  /** Writes one file of a runtime-state import into a staging directory (see `SandboxService.importRuntimeState`). */
  writeRuntimeImport(staging: string, path: string, body: Readable, size: number): Promise<FileEntry> {
    return this.#json("PUT", SANDBOXD_ROUTES.runtimeImportContent, {
      query: { staging, path },
      body,
      headers: { "content-type": "application/octet-stream", "content-length": String(size) },
    });
  }

  async commitRuntimeImport(staging: string, sessionId: string): Promise<void> {
    await this.#json("POST", SANDBOXD_ROUTES.runtimeImportCommit, { query: { staging, sessionId } });
  }

  async abortRuntimeImport(staging: string): Promise<void> {
    await this.#json("POST", SANDBOXD_ROUTES.runtimeImportAbort, { query: { staging } });
  }

  // Commands (`SANDBOXD_ROUTES.exec`) ------------------------------------------------------------------------------

  startExec(request: SandboxExecRequest): Promise<SandboxExecRecord> {
    return this.#json("POST", SANDBOXD_ROUTES.exec, { body: Buffer.from(JSON.stringify(request)), headers: { "content-type": "application/json" }, timeoutMs: 30_000 });
  }

  listExecs(timeoutMs = 15_000): Promise<SandboxExecRecord[]> {
    return this.#json("GET", SANDBOXD_ROUTES.exec, { timeoutMs });
  }

  /** Output from `offset`, waiting up to `waitMs` for more. */
  readExec(id: string, offset: number, waitMs: number, signal?: AbortSignal): Promise<SandboxExecRead> {
    return this.#json("GET", sandboxdExecRoute(id), { query: { offset: String(offset), waitMs: String(waitMs) }, timeoutMs: waitMs + 15_000, ...(signal ? { signal } : {}) });
  }

  /** Waits up to `waitMs` for the command to end (no output). */
  async waitExec(id: string, waitMs: number, signal?: AbortSignal): Promise<SandboxExecRecord> {
    const read = await this.#json<SandboxExecRead>("GET", sandboxdExecRoute(id), { query: { output: "false", waitMs: String(waitMs) }, timeoutMs: waitMs + 15_000, ...(signal ? { signal } : {}) });
    return read.exec;
  }

  execInput(id: string, data: string | undefined, eof: boolean): Promise<SandboxExecRecord> {
    return this.#json("POST", sandboxdExecRoute(id, "input"), { body: Buffer.from(JSON.stringify({ ...(data !== undefined ? { data } : {}), eof })), headers: { "content-type": "application/json" }, timeoutMs: 30_000 });
  }

  stopExec(id: string, reason?: string): Promise<SandboxExecRecord> {
    return this.#json("POST", sandboxdExecRoute(id, "stop"), { ...(reason ? { query: { reason } } : {}), timeoutMs: 30_000 });
  }

  stopAllExecs(reason: string): Promise<SandboxExecRecord[]> {
    return this.#json("POST", SANDBOXD_ROUTES.execStopAll, { query: { reason }, timeoutMs: 30_000 });
  }

  /**
   * Opens a WebSocket to `route` and returns a byte stream (binary frames). The link is pinged every `keepaliveMs`
   * (default 30 s) and closed when two pings go unanswered, so a dead path (a vanished sandbox, a dropped proxy) ends
   * the stream instead of holding the session's runtime connection open, and idle intermediaries keep the link.
   */
  async openStream(route: string, query?: Record<string, string>, options: { readonly keepaliveMs?: number } = {}): Promise<Duplex> {
    const { base, headers } = await this.#headers();
    const search = new URLSearchParams(query ?? {}).toString();
    const url = `${base.protocol === "https:" ? "wss:" : "ws:"}//${base.host}${base.pathname === "/" ? "" : base.pathname}${route}${search ? `?${search}` : ""}`;
    const ws = new WebSocket(url, { headers, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024, handshakeTimeout: 15_000 });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("unexpected-response", (_req, res) => {
        void errorFrom(res, `Opening ${route} failed`).then(reject, reject);
      });
      ws.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") this.#onUnreachable?.();
        reject(new ManagedCopilotError("capability_unavailable", `The sandbox is not reachable: ${error.message}`));
      });
    });
    const stream = createWebSocketStream(ws, { allowHalfOpen: false });
    stream.on("error", () => stream.destroy());
    // Destroying the stream (not just terminating the socket) is what ends it for readers: after a local terminate,
    // createWebSocketStream's duplex ends but never closes.
    let answered = true;
    ws.on("pong", () => {
      answered = true;
    });
    const keepalive = setInterval(() => {
      if (!answered) {
        stream.destroy(new Error("The sandbox stopped answering keepalive pings"));
        return;
      }
      answered = false;
      try {
        ws.ping();
      } catch {
        stream.destroy();
      }
    }, options.keepaliveMs ?? KEEPALIVE_MS);
    keepalive.unref();
    ws.once("close", () => clearInterval(keepalive));
    return stream;
  }
}
