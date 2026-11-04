import { isManagedCopilotError } from "@managed-copilot/sdk";

/** An error a person sees: a stable code, plain words, and the HTTP status the API answers with. */
export class HelpDeskError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "HelpDeskError";
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The session was deleted (here, from another client, or by the platform). */
export function isMissingSession(error: unknown): boolean {
  return isManagedCopilotError(error, "not_found") || /not found|no such session|unknown session|session_not_found/i.test(errorText(error));
}
