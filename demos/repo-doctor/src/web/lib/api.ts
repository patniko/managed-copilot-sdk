import type { AppState, RunDetail, RunView } from "../../shared/types.js";

/** A failed API call with the server's friendly message (never a stack trace). */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Please try again.";
}

function isApiErrorBody(value: unknown): value is { error: { code: string; message: string } } {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const inner = (value as { error: unknown }).error;
  return typeof inner === "object" && inner !== null && typeof (inner as { message?: unknown }).message === "string" && typeof (inner as { code?: unknown }).code === "string";
}

function fallbackMessage(status: number): string {
  if (status === 404) return "Not found.";
  if (status === 502 || status === 503 || status === 504) return "Repo Doctor's server is unavailable right now.";
  if (status >= 500) return `Repo Doctor's server hit an error (${status}).`;
  return `Request failed (${status}).`;
}

async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError("Can't reach Repo Doctor's server. Check that it's running.", "network_error", 0);
  }
  if (!response.ok) {
    const parsed: unknown = await response.json().catch(() => undefined);
    if (isApiErrorBody(parsed)) throw new ApiError(parsed.error.message, parsed.error.code, response.status);
    throw new ApiError(fallbackMessage(response.status), `http_${response.status}`, response.status);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  try {
    return (text ? JSON.parse(text) : undefined) as T;
  } catch {
    throw new ApiError("Repo Doctor's server sent an unexpected response.", "invalid_response", response.status);
  }
}

const runUrl = (id: string) => `/api/runs/${encodeURIComponent(id)}`;

export const api = {
  state: () => json<AppState>("GET", "/api/state"),
  run: (id: string) => json<RunDetail>("GET", runUrl(id)),
  create: (input: { readonly repo: string } | { readonly sample: true }) => json<RunView>("POST", "/api/runs", input),
  stop: (id: string) => json<undefined>("POST", `${runUrl(id)}/stop`),
  delete: (id: string) => json<undefined>("DELETE", runUrl(id)),
  patchUrl: (id: string) => `${runUrl(id)}/patch`,
};
