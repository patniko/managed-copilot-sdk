export type AgentErrorCode = "invalid_request" | "forbidden" | "not_found" | "conflict" | "internal" | "unavailable";

/** A sandboxd failure with one of the codes its HTTP API maps to the platform's error codes. */
export class AgentError extends Error {
  readonly code: AgentErrorCode;
  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
