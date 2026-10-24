import { isManagedCopilotError } from "@managed-copilot/sdk";
import type { FactoryError } from "../../shared/types.js";

/** A station failure with a stable code and a message written for the factory floor. */
export class StationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StationError";
    this.code = code;
  }
}

export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

/** Converts anything thrown into a user-facing error: a code and one line of text, never a stack trace. */
export function toFactoryError(error: unknown): FactoryError {
  if (error instanceof StationError) return { code: error.code, message: error.message };
  if (isManagedCopilotError(error)) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0]?.trim() || "Unknown error";
  if (/timeout|timed out/i.test(firstLine)) return { code: "timeout", message: firstLine };
  if (/connection|disconnected|closed|ECONNREFUSED|socket/i.test(firstLine)) {
    return { code: "interrupted", message: `Lost the connection to the platform: ${firstLine}` };
  }
  return { code: "internal", message: firstLine };
}
