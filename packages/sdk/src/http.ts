import { ManagedCopilotError, type ErrorBody } from "@managed-copilot/protocol";

export interface RequestOptions {
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
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

  /** Sends a request and returns the raw response after mapping error statuses. */
  async fetch(method: string, path: string, options: RequestOptions & { rawBody?: RequestInit["body"]; duplex?: "half" } = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}`, ...options.headers };
    let body: RequestInit["body"] = options.rawBody;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    let response: Response;
    try {
      response = await fetch(this.url(path, options.query), {
        method,
        headers,
        body,
        signal: options.signal,
        ...(options.duplex ? { duplex: options.duplex } : {}),
      } as RequestInit);
    } catch (error) {
      throw new ManagedCopilotError("capability_unavailable", `Cannot reach the Managed Copilot deployment at ${this.baseUrl}: ${(error as Error).message}`);
    }
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

  async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.fetch(method, path, options);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
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
}
