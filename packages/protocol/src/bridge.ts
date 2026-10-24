/**
 * The stdio-to-WSS bridge (spec "Native SDK connection contract").
 *
 * `managed.client(...)` returns a stock `CopilotClient` whose connection is
 * `RuntimeConnection.forStdio({ path: <bridge.js>, env: { [BRIDGE_ENV]: JSON(BridgeConfig) } })`.
 * The SDK spawns the bridge with node and speaks framed JSON-RPC over its stdio. The bridge starts no local
 * agent: it forwards each message to the gateway over an authenticated WebSocket and writes replies back.
 *
 * Framing on the WebSocket: each text message carries exactly one JSON-RPC 2.0 message (no Content-Length
 * headers). The bridge owns LSP-style framing on its stdio side. Credentials travel only in `BRIDGE_ENV`
 * and the WebSocket `Authorization` header, never on the command line or in logs.
 */
import type { EnvironmentRequest } from "./config.js";

export const BRIDGE_ENV = "MANAGED_COPILOT_BRIDGE";
export const BRIDGE_SUBPROTOCOL = "managed-copilot.jsonrpc.v1";
/** base64url(JSON(EnvironmentRequest)) sent on the WebSocket upgrade request. */
export const ENVIRONMENT_HEADER = "x-managed-copilot-environment";
/** Optional caller label recorded in audit/session metadata. */
export const CLIENT_NAME_HEADER = "x-managed-copilot-client";

export interface BridgeConfig {
  /** ws:// (loopback only) or wss:// URL of `/v1/connect`. */
  readonly url: string;
  readonly token: string;
  readonly environment: EnvironmentRequest;
  readonly clientName?: string;
}

/** WebSocket close codes the gateway uses; the reason string carries an `ErrorCode`. */
export const BRIDGE_CLOSE_CODES = {
  normal: 1000,
  authenticationRequired: 4401,
  forbidden: 4403,
  environmentNotFound: 4404,
  policyViolation: 4422,
  internal: 4500,
  capabilityUnavailable: 4501,
} as const;

export function encodeEnvironmentHeader(request: EnvironmentRequest): string {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

export function decodeEnvironmentHeader(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}
