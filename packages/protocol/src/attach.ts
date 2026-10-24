/**
 * Copilot CLI attach (spec section 14). The gateway relays the stock CLI's AHP connection to a per-session listener;
 * the SDK's local relay sits between the CLI and the gateway so no credential appears on the CLI's command line.
 */

/** Prefix of single-use attach tickets, so they are easy to recognize and redact. */
export const ATTACH_TICKET_PREFIX = "mcat_";

/** WebSocket close codes the attach relays use; the reason string explains the outcome. */
export const ATTACH_CLOSE_CODES = {
  /** The session was deleted, moved into a sandbox, or its runtime stopped. Attach again to continue. */
  sessionGone: 4410,
  /** The attachment reached its maximum lifetime. Attach again to continue. */
  expired: 4408,
} as const;

export const CREDENTIAL_REFUSAL =
  "Managed Copilot authenticates Copilot CLI attachments itself; credentials are never forwarded to the session's runtime.";

/** AHP action names that carry credentials. */
const CREDENTIAL_ACTION = /auth|token|credential|secret/i;

interface RpcMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: { readonly action?: { readonly type?: unknown } };
}

function carriesCredential(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const { method, params } = message as RpcMessage;
  if (typeof method !== "string") return false;
  if (/auth/i.test(method)) return true;
  const action = params?.action?.type;
  return typeof action === "string" && CREDENTIAL_ACTION.test(action);
}

export interface FilteredAhpFrame {
  /** Text to send upstream, if anything is left after filtering. */
  readonly forward?: string;
  /** JSON-RPC error replies for refused requests, to send back to the client. */
  readonly replies: readonly string[];
  /** Names of refused methods, for logs. */
  readonly refused: readonly string[];
  /** The frame is not JSON, so it is not AHP. */
  readonly invalid?: boolean;
}

/**
 * Removes credential-bearing AHP messages from a client frame. The stock Copilot CLI presents its own GitHub token
 * with `authenticate`; attach is authorized by Managed Copilot, so those requests are answered with an error (the CLI
 * continues without them) and the token never reaches a runtime. Other frames pass through byte for byte.
 */
export function filterAhpClientFrame(text: string): FilteredAhpFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { replies: [], refused: [], invalid: true };
  }
  const batch = Array.isArray(parsed);
  const items: unknown[] = batch ? (parsed as unknown[]) : [parsed];
  const kept: unknown[] = [];
  const errors: object[] = [];
  const refused: string[] = [];
  for (const item of items) {
    if (carriesCredential(item)) {
      const { id, method } = item as RpcMessage;
      refused.push(String(method));
      if (id !== undefined && id !== null) errors.push({ jsonrpc: "2.0", id, error: { code: -32602, message: CREDENTIAL_REFUSAL } });
      continue;
    }
    kept.push(item);
  }
  if (refused.length === 0) return { forward: text, replies: [], refused };
  const replies = errors.length === 0 ? [] : batch ? [JSON.stringify(errors)] : errors.map((error) => JSON.stringify(error));
  const forward = kept.length === 0 ? undefined : JSON.stringify(batch ? kept : kept[0]);
  return { ...(forward !== undefined ? { forward } : {}), replies, refused };
}
