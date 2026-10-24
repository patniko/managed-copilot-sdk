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

/** A platform call made while the factory has no connection to Managed Copilot, for example while it reconnects. */
export class PlatformUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformUnavailableError";
  }
}

/** Gateway error codes that mean "briefly unavailable" (a draining or handed-over gateway, GitHub unreachable). */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(["capability_unavailable", "upstream_unavailable", "inference_unavailable"]);

/** Codes the bridge can report that retrying won't fix. */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  "authentication_required",
  "forbidden",
  "invalid_request",
  "not_found",
  "environment_not_found",
  "policy_violation",
  "conflict",
]);

/**
 * Whether an error means the factory lost its connection to Managed Copilot (a gateway handover, a dropped bridge, a
 * draining or unreachable gateway) rather than that a station's work failed.
 */
export function isPlatformInterruption(error: unknown): boolean {
  if (error instanceof PlatformUnavailableError) return true;
  if (isManagedCopilotError(error)) {
    // The SDK gave up on a request in transit (`details.stage`): the deployment didn't answer in time. Other timeouts,
    // such as waiting for a publication, are outcomes.
    if (error.code === "timeout") return typeof error.details?.["stage"] === "string";
    // Proxies in front of the gateway answer 502/503/504 without a platform error body.
    return TRANSIENT_CODES.has(error.code) || (error.code === "internal" && /\(HTTP 5\d\d\)/.test(error.message));
  }
  if (!(error instanceof Error)) return false;
  // Gateway errors on a session's JSON-RPC connection arrive as the SDK's ResponseError, with the platform code in `data.code`.
  const data = (error as { data?: { code?: unknown; details?: { step?: unknown } } }).data;
  const rpcCode = data?.code;
  // A registration step (a resume, a reconcile) the session's runtime never answered (`details.step`): the gateway
  // closed that runtime connection, and a retry reconnects. Other timeouts are outcomes.
  if (rpcCode === "timeout") return typeof data?.details?.step === "string";
  if (typeof rpcCode === "string" && (TRANSIENT_CODES.has(rpcCode) || PERMANENT_CODES.has(rpcCode))) return TRANSIENT_CODES.has(rpcCode);
  // The bridge reports gateway closes and rejections as "[managed-copilot] ... (<code>)".
  const bridge = /\[managed-copilot\][^\n]*?(?:\((\w+)\))?\s*$/m.exec(error.message);
  if (bridge) return bridge[1] === undefined || !PERMANENT_CODES.has(bridge[1]);
  // "Completion wait cancelled": the runtime gave up a turn's completion wait, as when a gateway shuts down mid-turn.
  // A cancel by the factory itself never gets here: the run is marked cancelled first.
  // "... lost the connection ...": the gateway ended a turn (or the wait for its answer) whose runtime connection it lost;
  // a turn's `session.error` reaches a completion wait without a code.
  return /session (?:is )?disconnected|client not connected|connection (?:is |got )?(?:closed|disposed)|lost the connection|cli (?:server|process) (?:connection closed|exited)|completion wait cancelled|cannot reach managed copilot|ECONNRESET|ECONNREFUSED|socket hang up/i.test(
    error.message,
  );
}

/** Converts anything thrown into a user-facing error: a code and one line of text, never a stack trace. */
export function toFactoryError(error: unknown): FactoryError {
  if (error instanceof StationError) return { code: error.code, message: error.message };
  if (error instanceof PlatformUnavailableError) return { code: "platform_unavailable", message: error.message };
  if (isManagedCopilotError(error)) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0]?.trim() || "Unknown error";
  if (/timeout|timed out/i.test(firstLine)) return { code: "timeout", message: firstLine };
  if (/connection|disconnected|closed|ECONNREFUSED|socket/i.test(firstLine)) {
    return { code: "interrupted", message: `Lost the connection to the platform: ${firstLine}` };
  }
  return { code: "internal", message: firstLine };
}
