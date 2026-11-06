import type { ApiErrorBody } from "../../shared/types.js";

/** A failed API call, with the server's stable code and its message for people. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

let onSignedOut: ((reason?: string) => void) | undefined;

/** Called when the server says nobody is signed in anymore (signed out elsewhere, or GitHub sign-in expired). */
export function handleSignedOut(handler: (reason?: string) => void): void {
  onSignedOut = handler;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError("offline", "Front Desk isn't reachable. Check your connection and try again.", 0);
  }
  if (response.status === 204) return undefined as T;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const error = (payload as Partial<ApiErrorBody> | undefined)?.error;
    const apiError = new ApiError(error?.code ?? "http_error", error?.message ?? `Front Desk answered with HTTP ${response.status}.`, response.status);
    if (response.status === 401 && (apiError.code === "sign_in_required" || apiError.code === "github_sign_in_expired")) {
      onSignedOut?.(apiError.code === "github_sign_in_expired" ? apiError.message : undefined);
    }
    throw apiError;
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  delete: <T = void>(path: string) => request<T>("DELETE", path),
};
