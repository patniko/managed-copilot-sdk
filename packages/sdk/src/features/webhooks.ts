// Owner: durable workstream. Verifies signed webhook deliveries and exposes `handleActions` (spec section 12).
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ManagedCopilotError,
  URL_ENV,
  WEBHOOK_HEADERS,
  WEBHOOK_TOLERANCE_SECONDS,
  type HandleActionResult,
  type WebhookEnvelope,
} from "@managed-copilot/protocol";
import { validateDeploymentUrl } from "../connection.js";
import { HttpClient } from "../http.js";
import type { ActionHandlers } from "../types.js";
import { runActions } from "./actions.js";

export interface VerifyWebhookOptions {
  /** Replay window in seconds. Defaults to `WEBHOOK_TOLERANCE_SECONDS`. */
  toleranceSeconds?: number;
  /**
   * Returns true if this event ID was already processed (deduplication store). A seen event is still returned, with
   * `duplicate: true`; acknowledge it without repeating your own side effects.
   */
  seen?: (eventId: string) => boolean | Promise<boolean>;
  /**
   * The deployment this worker serves. When set (or when `MANAGED_COPILOT_URL` is set), a capability issued for any
   * other deployment is refused instead of being used.
   */
  deploymentUrl?: string;
  /** Clock override for tests, in milliseconds. */
  now?: () => number;
}

export interface VerifiedWebhookEvent extends WebhookEnvelope {
  /** True when `options.seen` reported this event ID as already processed. */
  readonly duplicate: boolean;
  /**
   * Claims and answers this event's listed actions using its scoped capability, with the same claim/result contract
   * as live delivery. Actions this worker has no handler for stay pending. Resolves with one entry per action
   * attempted (empty when the event carries no capability, e.g. its actions were already handled).
   */
  handleActions(handlers: ActionHandlers): Promise<HandleActionResult[]>;
}

/** Accepts a Fetch `Request` (Azure Functions, Hono, etc.) or a raw body plus headers. */
export type WebhookRequestLike =
  | Request
  | { readonly headers: Record<string, string | string[] | undefined> | Headers; readonly rawBody: string | Uint8Array };

interface ReadableRequest {
  readonly headers: Headers | Record<string, string | string[] | undefined>;
  readonly arrayBuffer?: () => Promise<ArrayBuffer>;
  readonly rawBody?: string | Uint8Array;
}

function header(headers: ReadableRequest["headers"], name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : record[key];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(request: ReadableRequest): Promise<Buffer> {
  if (request.rawBody !== undefined) return typeof request.rawBody === "string" ? Buffer.from(request.rawBody, "utf8") : Buffer.from(request.rawBody);
  if (typeof request.arrayBuffer === "function") return Buffer.from(await request.arrayBuffer());
  throw new ManagedCopilotError("invalid_request", "verifyWebhook needs the raw request body: pass a Fetch Request or { headers, rawBody }");
}

const rejected = (message: string) => new ManagedCopilotError("authentication_required", message);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Same deployment: identical URLs, or loopback aliases (localhost, 127.0.0.1, ::1) with the same scheme, port, and path. */
function sameDeployment(a: string, b: string): boolean {
  if (a === b) return true;
  const left = new URL(a);
  const right = new URL(b);
  const loopback = (url: URL) => LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost");
  return loopback(left) && loopback(right) && left.protocol === right.protocol && left.port === right.port && left.pathname === right.pathname;
}

/**
 * Verifies a webhook delivery from Managed Copilot: the HMAC-SHA256 signature over `<t>.<raw body>` (timing-safe,
 * any `v1` entry, so secrets can rotate), the timestamp replay window, and the event ID. Throws
 * `authentication_required` for anything that does not verify. Pass several secrets while rotating.
 */
export async function verifyWebhook(request: WebhookRequestLike, secret: string | readonly string[], options: VerifyWebhookOptions = {}): Promise<VerifiedWebhookEvent> {
  const secrets = (typeof secret === "string" ? [secret] : [...secret]).filter((value) => value.length > 0);
  if (secrets.length === 0) throw new ManagedCopilotError("invalid_request", "verifyWebhook needs the webhook secret");
  const readable = request as unknown as ReadableRequest;
  const signature = header(readable.headers, WEBHOOK_HEADERS.signature);
  if (!signature) throw rejected(`Missing ${WEBHOOK_HEADERS.signature} header`);
  const body = await readBody(readable);

  let timestamp: number | undefined;
  const candidates: string[] = [];
  for (const part of signature.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && value) candidates.push(value);
  }
  if (timestamp === undefined || candidates.length === 0) throw rejected(`Malformed ${WEBHOOK_HEADERS.signature} header`);
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) throw rejected(`Webhook timestamp is outside the ${tolerance}s replay window`);

  const matches = secrets.some((key) => {
    const expected = createHmac("sha256", key).update(`${timestamp}.`).update(body).digest();
    return candidates.some((candidate) => {
      const provided = Buffer.from(candidate, "hex");
      return provided.length === expected.length && timingSafeEqual(provided, expected);
    });
  });
  if (!matches) throw rejected("Webhook signature does not match");

  let envelope: WebhookEnvelope;
  try {
    envelope = JSON.parse(body.toString("utf8")) as WebhookEnvelope;
  } catch {
    throw new ManagedCopilotError("invalid_request", "Webhook body is not valid JSON");
  }
  if (!envelope || typeof envelope.id !== "string" || typeof envelope.type !== "string") throw new ManagedCopilotError("invalid_request", "Webhook body is not a Managed Copilot event");
  const eventId = header(readable.headers, WEBHOOK_HEADERS.eventId);
  if (eventId !== undefined && eventId !== envelope.id) throw rejected("Webhook event ID header does not match the signed body");

  const duplicate = options.seen ? await options.seen(envelope.id) : false;
  const expectedDeployment = options.deploymentUrl ?? process.env[URL_ENV];

  return Object.assign(envelope, {
    duplicate,
    async handleActions(handlers: ActionHandlers): Promise<HandleActionResult[]> {
      const capability = envelope.capability;
      if (!capability || !envelope.sessionId) return [];
      if (capability.sessionId !== envelope.sessionId) throw rejected("The action capability is for a different session");
      // The capability is a bearer credential: only ever send it to a valid deployment URL (HTTPS unless loopback,
      // no embedded credentials), and only to the deployment this worker expects when one is configured.
      const audience = validateDeploymentUrl(capability.audience);
      if (expectedDeployment && !sameDeployment(audience, validateDeploymentUrl(expectedDeployment))) {
        throw rejected(`The action capability is for ${capability.audience}, not ${expectedDeployment}`);
      }
      if (Date.parse(capability.expiresAt) <= (options.now?.() ?? Date.now())) return [];
      return runActions(new HttpClient(audience, capability.token), envelope.sessionId, handlers, { actionIds: capability.actionIds });
    },
  });
}
