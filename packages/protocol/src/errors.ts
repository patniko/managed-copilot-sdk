/**
 * Stable error codes (spec "Errors and recovery"). Surfaced through REST bodies, bridge close reasons,
 * and SDK exceptions. Never replaced by silent fallbacks.
 */
export const ERROR_CODES = [
  "invalid_request",
  "authentication_required",
  "forbidden",
  "not_found",
  "environment_not_found",
  "policy_violation",
  "conflict",
  "capability_unavailable",
  "background_callback_unsupported",
  "session_busy",
  "promotion_busy",
  "needs_reconciliation",
  "setup_failed",
  "state_restore_failed",
  "publication_failed",
  "inference_unavailable",
  "transport_unsupported",
  "timeout",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400,
  authentication_required: 401,
  forbidden: 403,
  not_found: 404,
  environment_not_found: 404,
  policy_violation: 422,
  conflict: 409,
  capability_unavailable: 501,
  background_callback_unsupported: 422,
  session_busy: 409,
  promotion_busy: 409,
  needs_reconciliation: 409,
  setup_failed: 424,
  state_restore_failed: 424,
  publication_failed: 424,
  inference_unavailable: 503,
  transport_unsupported: 400,
  timeout: 504,
  internal: 500,
};

export interface ErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export class ManagedCopilotError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ManagedCopilotError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_HTTP_STATUS[this.code];
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }

  static fromBody(body: unknown, fallbackStatus?: number): ManagedCopilotError {
    const error = (body as Partial<ErrorBody> | undefined)?.error;
    if (error && typeof error.message === "string" && (ERROR_CODES as readonly string[]).includes(error.code)) {
      return new ManagedCopilotError(error.code, error.message, error.details as Record<string, unknown> | undefined);
    }
    return new ManagedCopilotError("internal", `Unexpected error response${fallbackStatus ? ` (HTTP ${fallbackStatus})` : ""}`);
  }
}

export function isManagedCopilotError(value: unknown, code?: ErrorCode): value is ManagedCopilotError {
  return value instanceof ManagedCopilotError && (code === undefined || value.code === code);
}
