// JSON-RPC 2.0 primitives for the gateway router: message types, framed transports, and a request/response
// endpoint with ID remapping and `$/cancelRequest` support. The router relays raw messages, so this layer never
// interprets method semantics.
import type { Duplex } from "node:stream";
import { ManagedCopilotError, type ErrorCode } from "@managed-copilot/protocol";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node.js";
import type { WebSocket } from "ws";

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorObject;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Managed Copilot errors carry `data.code` with a stable `ErrorCode`. */
  managed: -32000,
  requestCancelled: -32800,
} as const;

export const CANCEL_METHOD = "$/cancelRequest";

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return typeof (message as JsonRpcRequest).method === "string" && (message as JsonRpcRequest).id !== undefined && (message as JsonRpcRequest).id !== null;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return typeof (message as JsonRpcNotification).method === "string" && ((message as JsonRpcRequest).id === undefined || (message as JsonRpcRequest).id === null);
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return typeof (message as JsonRpcRequest).method !== "string" && "id" in message;
}

/** An error returned by a JSON-RPC peer, preserved verbatim so it can be relayed to another peer. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }

  toObject(): JsonRpcErrorObject {
    return this.data === undefined ? { code: this.code, message: this.message } : { code: this.code, message: this.message, data: this.data };
  }

  /** The managed error code carried in `data.code`, if any. */
  get managedCode(): ErrorCode | undefined {
    const code = (this.data as { code?: unknown } | undefined)?.code;
    return typeof code === "string" ? (code as ErrorCode) : undefined;
  }
}

/**
 * Converts any thrown value into a JSON-RPC error object for a peer. Managed errors keep their stable code in
 * `data.code`; unsupported methods use the standard MethodNotFound code so SDK fallbacks behave natively.
 */
export function toRpcError(error: unknown): JsonRpcErrorObject {
  if (error instanceof RpcError) return error.toObject();
  if (error instanceof ManagedCopilotError) {
    const code = error.details?.["rpc"] === "methodNotFound" ? RPC_ERROR.methodNotFound : RPC_ERROR.managed;
    const details = error.details ? Object.fromEntries(Object.entries(error.details).filter(([key]) => key !== "rpc")) : undefined;
    return {
      code,
      message: `${error.message} [${error.code}]`,
      data: { code: error.code, ...(details && Object.keys(details).length > 0 ? { details } : {}) },
    };
  }
  return { code: RPC_ERROR.internal, message: "Internal error [internal]", data: { code: "internal" } };
}

/** A managed error for methods the gateway does not route. Encoded as JSON-RPC MethodNotFound. */
export function unsupportedMethod(method: string, reason?: string): ManagedCopilotError {
  return new ManagedCopilotError(
    "capability_unavailable",
    reason ?? `${method} is not available through Managed Copilot`,
    { method, rpc: "methodNotFound" },
  );
}

/** A message-level transport. Framing is the implementation's concern; messages are parsed objects. */
export interface MessageTransport {
  send(message: JsonRpcMessage): void;
  onMessage(listener: (message: JsonRpcMessage) => void): void;
  onClose(listener: (error?: Error) => void): void;
  close(): void;
  readonly closed: boolean;
}

abstract class BaseTransport implements MessageTransport {
  #closed = false;
  readonly #messageListeners: ((message: JsonRpcMessage) => void)[] = [];
  readonly #closeListeners: ((error?: Error) => void)[] = [];

  get closed(): boolean {
    return this.#closed;
  }

  abstract send(message: JsonRpcMessage): void;
  protected abstract shutdown(): void;

  onMessage(listener: (message: JsonRpcMessage) => void): void {
    this.#messageListeners.push(listener);
  }

  onClose(listener: (error?: Error) => void): void {
    if (this.#closed) queueMicrotask(() => listener());
    else this.#closeListeners.push(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.shutdown();
    this.emitClose();
  }

  protected emitMessage(message: JsonRpcMessage): void {
    if (this.#closed) return;
    for (const listener of this.#messageListeners) listener(message);
  }

  protected emitClose(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners.splice(0)) listener(error);
  }
}

/** LSP-framed (Content-Length) JSON-RPC over a byte stream, e.g. the runtime's TCP listener. */
export function streamTransport(stream: Duplex): MessageTransport {
  class StreamTransport extends BaseTransport {
    readonly #reader = new StreamMessageReader(stream);
    readonly #writer = new StreamMessageWriter(stream);

    constructor() {
      super();
      this.#reader.listen((message) => this.emitMessage(message as unknown as JsonRpcMessage));
      this.#reader.onError((error) => {
        stream.destroy();
        this.emitClose(error instanceof Error ? error : new Error(String(error)));
      });
      stream.on("close", () => this.emitClose());
      stream.on("error", (error) => this.emitClose(error));
    }

    send(message: JsonRpcMessage): void {
      if (this.closed) return;
      void this.#writer.write(message as never).catch((error: unknown) => this.emitClose(error instanceof Error ? error : new Error(String(error))));
    }

    protected shutdown(): void {
      this.#reader.dispose();
      this.#writer.dispose();
      stream.destroy();
    }
  }
  return new StreamTransport();
}

/** One JSON-RPC message per WebSocket text frame (the bridge and sandbox relay framing). */
export function webSocketTransport(ws: WebSocket, options: { onInvalid?: (raw: string) => void } = {}): MessageTransport {
  class WsTransport extends BaseTransport {
    constructor() {
      super();
      ws.on("message", (data, isBinary) => {
        const text = isBinary ? Buffer.from(data as Buffer).toString("utf8") : data.toString();
        let message: unknown;
        try {
          message = JSON.parse(text);
        } catch {
          options.onInvalid?.(text.slice(0, 200));
          return;
        }
        if (!message || typeof message !== "object" || (message as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
          options.onInvalid?.(text.slice(0, 200));
          return;
        }
        this.emitMessage(message as JsonRpcMessage);
      });
      ws.on("close", () => this.emitClose());
      ws.on("error", (error) => this.emitClose(error));
    }

    send(message: JsonRpcMessage): void {
      if (this.closed || ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(message));
    }

    protected shutdown(): void {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000);
    }
  }
  return new WsTransport();
}

export interface IncomingRequestContext {
  readonly id: JsonRpcId;
  /** Aborted when the peer sends `$/cancelRequest` for this request or the transport closes. */
  readonly signal: AbortSignal;
}

export interface RpcEndpointOptions {
  readonly name: string;
  readonly onRequest?: (method: string, params: unknown, context: IncomingRequestContext) => unknown | Promise<unknown>;
  readonly onNotification?: (method: string, params: unknown) => void;
  readonly onError?: (error: unknown, context: { method: string }) => void;
}

interface Pending {
  readonly method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/**
 * Request/response correlation over a transport. Outgoing requests get endpoint-local IDs, so relayed traffic from
 * many peers never collides; incoming requests are answered with the peer's original ID.
 */
export class RpcEndpoint {
  readonly name: string;
  readonly transport: MessageTransport;
  readonly #options: RpcEndpointOptions;
  readonly #pending = new Map<JsonRpcId, Pending>();
  readonly #incoming = new Map<JsonRpcId, AbortController>();
  #nextId = 1;

  constructor(transport: MessageTransport, options: RpcEndpointOptions) {
    this.name = options.name;
    this.transport = transport;
    this.#options = options;
    transport.onMessage((message) => this.#handle(message));
    transport.onClose((error) => {
      const reason = new RpcError(RPC_ERROR.internal, `${this.name} connection closed${error ? `: ${error.message}` : ""}`, { code: "capability_unavailable" });
      for (const pending of this.#pending.values()) pending.reject(reason);
      this.#pending.clear();
      for (const controller of this.#incoming.values()) controller.abort();
      this.#incoming.clear();
    });
  }

  get closed(): boolean {
    return this.transport.closed;
  }

  /** Number of outstanding outgoing requests (diagnostics and tests). */
  get pendingCount(): number {
    return this.#pending.size;
  }

  request<T = unknown>(method: string, params?: unknown, options: { signal?: AbortSignal } = {}): Promise<T> {
    if (this.transport.closed) {
      return Promise.reject(new RpcError(RPC_ERROR.internal, `${this.name} is not connected`, { code: "capability_unavailable" }));
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      const signal = options.signal;
      if (signal) {
        const cancel = () => this.notify(CANCEL_METHOD, { id });
        if (signal.aborted) queueMicrotask(cancel);
        else signal.addEventListener("abort", cancel, { once: true });
      }
      this.transport.send(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.transport.send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.transport.close();
  }

  #handle(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      if (message.id === null) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new RpcError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
      return;
    }
    if (isNotification(message)) {
      if (message.method === CANCEL_METHOD) {
        const id = (message.params as { id?: JsonRpcId } | undefined)?.id;
        if (id !== undefined) this.#incoming.get(id)?.abort();
        return;
      }
      try {
        this.#options.onNotification?.(message.method, message.params);
      } catch (error) {
        this.#options.onError?.(error, { method: message.method });
      }
      return;
    }
    if (isRequest(message)) void this.#answer(message);
  }

  async #answer(request: JsonRpcRequest): Promise<void> {
    const controller = new AbortController();
    this.#incoming.set(request.id, controller);
    try {
      if (!this.#options.onRequest) throw unsupportedMethod(request.method);
      const result = await this.#options.onRequest(request.method, request.params, { id: request.id, signal: controller.signal });
      this.transport.send({ jsonrpc: "2.0", id: request.id, result: result === undefined ? null : result });
    } catch (error) {
      if (!(error instanceof RpcError) && !(error instanceof ManagedCopilotError)) this.#options.onError?.(error, { method: request.method });
      this.transport.send({ jsonrpc: "2.0", id: request.id, error: toRpcError(error) });
    } finally {
      this.#incoming.delete(request.id);
    }
  }
}
