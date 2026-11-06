import { ERROR_HTTP_STATUS, type ErrorCode } from "@managed-copilot/protocol";
import { isManagedCopilotError } from "@managed-copilot/sdk";

/** An error a person sees: a stable platform error code, plain words, and the HTTP status the API answers with. */
export class SwarmError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "SwarmError";
    this.status = status ?? ERROR_HTTP_STATUS[code];
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The session was deleted (here, from another client, or with its coordinator). */
export function isMissingSession(error: unknown): boolean {
  return isManagedCopilotError(error, "not_found") || /not found|no such session|unknown session|session_not_found/i.test(errorText(error));
}
