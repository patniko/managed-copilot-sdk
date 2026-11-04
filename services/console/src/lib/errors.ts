import type { ErrorCode } from "@managed-copilot/protocol";

/** Codes the console adds for failures that never reached (or never came back from) the gateway. */
export type ClientErrorCode = "network_error" | "invalid_response" | "http_error";

export type ApiErrorCode = ErrorCode | ClientErrorCode | (string & {});

/** A failed operator API request, mapped from the gateway's `{ error: { code, message, details? } }` body. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly code: ApiErrorCode;
  /** HTTP status; 0 when the request never got a response. */
  readonly status: number;
  /** How long to wait before retrying (`Retry-After`, or `details.retryAfterSeconds`). */
  readonly retryAfterSeconds: number | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ApiErrorCode, message: string, status: number, retryAfterSeconds?: number, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.details = details;
  }
}

/** `Retry-After` as seconds: a delay (`"120"`) or an HTTP date. */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FALLBACK_MESSAGES: Readonly<Record<number, readonly [ApiErrorCode, string]>> = {
  401: ["authentication_required", "Your console session has ended. Sign in again."],
  403: ["forbidden", "You don't have access to the operator console."],
  404: ["not_found", "The gateway couldn't find that."],
  429: ["http_error", "The gateway is receiving too many requests. Try again shortly."],
  502: ["http_error", "The gateway is unreachable behind its proxy (HTTP 502)."],
  503: ["http_error", "The gateway is temporarily unavailable (HTTP 503)."],
  504: ["timeout", "The gateway took too long to respond (HTTP 504)."],
};

/**
 * Maps an error response to an `ApiError`. Gateway errors keep their stable code and message; anything else (a proxy
 * page, an empty body) becomes a short, readable message rather than raw HTML.
 */
export function apiErrorFromResponse(status: number, bodyText: string, retryAfterHeader?: string | null, now = Date.now()): ApiError {
  let body: unknown;
  try {
    body = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    body = undefined;
  }
  const headerRetry = parseRetryAfter(retryAfterHeader, now);
  const error = isRecord(body) ? body["error"] : undefined;
  if (isRecord(error) && typeof error["code"] === "string" && typeof error["message"] === "string" && error["message"].trim()) {
    const details = isRecord(error["details"]) ? error["details"] : undefined;
    const detailRetry = details && typeof details["retryAfterSeconds"] === "number" && details["retryAfterSeconds"] >= 0 ? details["retryAfterSeconds"] : undefined;
    return new ApiError(error["code"], error["message"], status, headerRetry ?? detailRetry, details);
  }
  const fallback = FALLBACK_MESSAGES[status];
  if (fallback) return new ApiError(fallback[0], fallback[1], status, headerRetry);
  return new ApiError("http_error", `The gateway returned an unexpected response (HTTP ${status}).`, status, headerRetry);
}

export function networkError(): ApiError {
  return new ApiError("network_error", "Can't reach the gateway. Check that it's running and that you're online.", 0);
}

export function timeoutError(): ApiError {
  return new ApiError("timeout", "The gateway took too long to respond.", 0);
}

export function invalidResponseError(): ApiError {
  return new ApiError("invalid_response", "The gateway sent a response the console couldn't read.", 0);
}

export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name: unknown }).name === "AbortError";
}

export function isTimeoutError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name: unknown }).name === "TimeoutError";
}

/** Any thrown value as an `ApiError` with a message fit for the UI (never a stack trace). */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (isTimeoutError(error)) return timeoutError();
  return new ApiError("internal", "Something went wrong in the console. Try again.", 0);
}

/** One-line description for banners and toasts. */
export function errorMessage(error: unknown): string {
  return toApiError(error).message;
}
