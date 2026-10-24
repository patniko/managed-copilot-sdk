/**
 * The stdio-to-WSS bridge (spec "Native SDK connection contract").
 *
 * `managed.client(...)` returns a stock `CopilotClient` whose connection is
 * `RuntimeConnection.forStdio({ path: <bridge.js>, env: { [BRIDGE_ENV]: JSON(BridgeConfig) } })`.
 * The SDK spawns the bridge with node and speaks framed JSON-RPC over its stdio. The bridge starts no local
 * agent: it forwards each message to the gateway over an authenticated WebSocket and writes replies back.
 *
 * Handshake: the bridge opens `/v1/connect` with `Authorization: Bearer <token>` and the `BRIDGE_SUBPROTOCOL`,
 * then sends one `BridgeHello` text frame. The gateway validates the environment request and answers with a
 * `BridgeWelcome` frame, or closes with a `BRIDGE_CLOSE_CODES` code whose reason is an `ErrorCode`.
 *
 * Framing after the welcome: each text message carries exactly one JSON-RPC 2.0 message (no Content-Length
 * headers). The bridge owns LSP-style framing on its stdio side. Credentials travel only in `BRIDGE_ENV` and the
 * upgrade `Authorization` header, never on the command line, in frames, or in logs.
 */
import type { EnvironmentRequest } from "./config.js";

export const BRIDGE_ENV = "MANAGED_COPILOT_BRIDGE";
export const BRIDGE_SUBPROTOCOL = "managed-copilot.jsonrpc.v1";
/** Upper bound for one frame (hello or JSON-RPC message). Large files go through the streamed files API. */
export const BRIDGE_MAX_FRAME_BYTES = 32 * 1024 * 1024;

export interface BridgeConfig {
  /** ws:// (loopback only) or wss:// URL of `/v1/connect`. */
  readonly url: string;
  readonly token: string;
  readonly environment: EnvironmentRequest;
  readonly clientName?: string;
}

export const BRIDGE_HELLO = "managed-copilot/hello";
export const BRIDGE_WELCOME = "managed-copilot/welcome";

/** First frame from the bridge. Carries the full environment request, including small base64 files. */
export interface BridgeHello {
  readonly type: typeof BRIDGE_HELLO;
  readonly version: 1;
  readonly environment: EnvironmentRequest;
  readonly clientName?: string;
}

/** The gateway's answer to `BridgeHello`; JSON-RPC traffic starts after it. */
export interface BridgeWelcome {
  readonly type: typeof BRIDGE_WELCOME;
  readonly connectionId: string;
  /** Resolved environment name. */
  readonly environment: string;
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