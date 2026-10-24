import { ManagedCopilotError, type ErrorBody } from "@managed-copilot/protocol";

/**
 * How long calls to the gateway may take (internal defaults, not public API; tests change them). A call past its
 * bound fails with the `timeout` error code instead of waiting on a stalled connection: an ingress can hold a request
 * for minutes while the gateway behind it is replaced.
 */
export const timings = {
  /** An ordinary call, its answer included. Longer than the gateway's 35 s GitHub verification, so its own error wins. */
  requestMs: 60_000,
  /** `ManagedCopilot.connect()`'s calls and the event stream's connection. */
  connectMs: 45_000,
  /** A streamed upload or download that moves no bytes for this long (its size sets no bound). */
  streamIdleMs: 60_000,
  /** The event stream without a byte: the gateway writes a heartbeat every 15 s, so it is dead and reconnects. */
  eventsIdleMs: 45_000,
  /** The event stream's first reconnect delay (doubling up to 30 s). */
  eventsRetryMs: 1_000,
};

export interface RequestOptions {
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Cancels the call, which then rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /**
   * How long the gateway may take to answer (default `timings.requestMs`); long polls and operations with their own
   * bound pass theirs. A streamed upload's answer is due this long after the upload ends.
   */
  readonly timeoutMs?: number;
  /** How long a streamed upload, or a body `fetch` returns, may go without moving bytes (default `timings.streamIdleMs`). */
  readonly idleTimeoutMs?: number;
}

type Expiry = { readonly kind: "answer" | "send" | "read"; readonly ms: number };

/** One call's cancellation: the caller's signal, and the bound currently running. */
class Call {
  readonly controller = new AbortController();
  /** The bound this layer aborted the call for. */
  expired: Expiry | undefined;
  /** The gateway answered (headers arrived). */
  answered = false;
  #disposed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #unlink: () => void;

  constructor(readonly signal: AbortSignal | undefined) {
    const forward = () => this.controller.abort(signal!.reason);
    if (signal?.aborted) forward();
    else signal?.addEventListener("abort", forward, { once: true });
    this.#unlink = () => signal?.removeEventListener("abort", forward);
  }

  arm(kind: Expiry["kind"], ms: number): void {
    this.disarm();
    // Nothing is armed for a call that ended: a stray timer would hold the process open.
    if (this.#disposed || this.controller.signal.aborted || !Number.isFinite(ms)) return;
    this.#timer = setTimeout(() => {
      if (this.controller.signal.aborted) return;
      this.expired = { kind, ms };
      this.controller.abort();
    }, ms);
  }

  disarm(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  dispose(): void {
    this.#disposed = true;
    this.disarm();
    this.#unlink();
  }
}

/** Minimal authenticated REST client for the gateway. Errors become `ManagedCopilotError`. */
export class HttpClient {
  readonly baseUrl: string;
  readonly #token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.#token = token;
  }

  url(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * Sends a request and returns the response once it is answered, after mapping error statuses. Its body is then
   * bounded by its progress: a read that waits `idleTimeoutMs` for bytes fails with `timeout`, however large it is.
   */
  async fetch(method: string, path: string, options: RequestOptions & { rawBody?: RequestInit["body"]; duplex?: "half" } = {}): Promise<Response> {
    const call = new Call(options.signal);
    let response: Response;
    try {
      response = await this.#send(method, path, options, call);
    } catch (error) {
      call.dispose();
      throw this.#failure(error, call, method, path);
    }
    call.disarm();
    if (!response.body) {
      call.dispose();
      return response;
    }
    const body = this.#watch(response.body, call, method, path, options.idleTimeoutMs ?? timings.streamIdleMs);
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const call = new Call(options.signal);
    try {
      const response = await this.#send(method, path, options, call);
      // The answer's body is part of the answer: it is read under the same bound.
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } catch (error) {
      throw this.#failure(error, call, method, path);
    } finally {
      call.dispose();
    }
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.json<T>("GET", path, options);
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.json<T>("POST", path, { ...options, body: body ?? {} });
  }

  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.json<T>("PUT", path, { ...options, body: body ?? {} });
  }

  delete<T = void>(path: string, options?: RequestOptions): Promise<T> {
    return this.json<T>("DELETE", path, options);
  }

  async #send(method: string, path: string, options: RequestOptions & { rawBody?: RequestInit["body"]; duplex?: "half" }, call: Call): Promise<Response> {
    const answerMs = options.timeoutMs ?? timings.requestMs;
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}`, ...options.headers };
    let body: RequestInit["body"] = options.rawBody;
    if (body === undefined && options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    // An upload is bounded by its progress, and the answer is due once it has been sent.
    const streamed = body instanceof ReadableStream || body instanceof Uint8Array;
    if (streamed) {
      const idleMs = options.idleTimeoutMs ?? timings.streamIdleMs;
      let sending = true;
      body = progress(body instanceof Uint8Array ? chunked(body) : (body as ReadableStream<Uint8Array>), {
        moved: () => {
          if (sending && !call.answered) call.arm("send", idleMs);
        },
        sent: () => {
          sending = false;
          if (!call.answered) call.arm("answer", answerMs);
        },
      });
    } else {
      call.arm("answer", answerMs);
    }
    const response = await fetch(this.url(path, options.query), {
      method,
      headers,
      body,
      signal: call.controller.signal,
      ...(streamed || options.duplex ? { duplex: "half" } : {}),
    } as RequestInit);
    call.answered = true;
    // Answered while uploading (refusing the upload): only the answer's own bound applies to reading it.
    if (streamed) call.arm("answer", answerMs);
    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      throw ManagedCopilotError.fromBody(payload as ErrorBody | undefined, response.status);
    }
    return response;
  }

  /** A response body whose reads fail with `timeout` when they wait `idleMs` for bytes. */
  #watch(body: ReadableStream<Uint8Array>, call: Call, method: string, path: string, idleMs: number): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          call.arm("read", idleMs);
          try {
            const { value, done } = await reader.read();
            call.disarm();
            if (done) {
              call.dispose();
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch (error) {
            call.dispose();
            controller.error(this.#failure(error, call, method, path));
          }
        },
        cancel: (reason) => {
          call.dispose();
          return reader.cancel(reason);
        },
      },
      // Read only when the consumer asks, so the bound measures waiting for the network, not the consumer.
      { highWaterMark: 0 },
    );
  }

  #failure(error: unknown, call: Call, method: string, path: string): unknown {
    const expired = call.expired;
    if (expired) {
      const where = `the Managed Copilot deployment at ${this.baseUrl}`;
      const message =
        expired.kind === "answer"
          ? `${capitalize(where)} did not answer ${method} ${path} within ${duration(expired.ms)}.`
          : expired.kind === "send"
            ? `Sending ${method} ${path} to ${where} made no progress for ${duration(expired.ms)}.`
            : `Reading the answer to ${method} ${path} from ${where} made no progress for ${duration(expired.ms)}.`;
      return new ManagedCopilotError("timeout", `${message} It may be restarting or unreachable; try again shortly.`, { method, path, timeoutMs: expired.ms });
    }
    // Cancelled by the caller: rejects with its reason, like fetch.
    if (call.signal?.aborted) return call.signal.reason;
    if (error instanceof ManagedCopilotError) return error;
    if (error instanceof SyntaxError) return new ManagedCopilotError("internal", `The Managed Copilot deployment at ${this.baseUrl} answered ${method} ${path} with a malformed response.`);
    const reason = (error as Error)?.message ?? String(error);
    return new ManagedCopilotError(
      "capability_unavailable",
      call.answered ? `The connection to the Managed Copilot deployment at ${this.baseUrl} broke while reading the answer to ${method} ${path}: ${reason}` : `Cannot reach the Managed Copilot deployment at ${this.baseUrl}: ${reason}`,
    );
  }
}

/** Re-reads an upload chunk by chunk, reporting each time the request takes more (`moved`) and its end (`sent`). */
function progress(source: ReadableStream<Uint8Array>, on: { moved(): void; sent(): void }): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  // The request starts: its body must start moving.
  on.moved();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        on.moved();
        const { value, done } = await reader.read();
        if (done) {
          on.sent();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
}

/** Bytes as an upload stream, so their progress is bounded like a file's. */
function chunked(bytes: Uint8Array, size = 64 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)));
        offset += size;
      },
    },
    { highWaterMark: 0 },
  );
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
