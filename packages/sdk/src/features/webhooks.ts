// Owner: durable workstream. Verifies signed webhook deliveries and exposes `handleActions` (spec section 12).
import type { WebhookEnvelope } from "@managed-copilot/protocol";
import { notImplemented } from "../connection.js";
import type { ActionHandlers } from "../types.js";

export interface VerifyWebhookOptions {
  /** Replay window in seconds. Defaults to `WEBHOOK_TOLERANCE_SECONDS`. */
  toleranceSeconds?: number;
  /** Returns true if this event ID was already processed (deduplication store). */
  seen?: (eventId: string) => boolean | Promise<boolean>;
}

export interface VerifiedWebhookEvent extends WebhookEnvelope {
  /** Claims and answers this event's listed actions using its scoped capability. */
  handleActions(handlers: ActionHandlers): Promise<void>;
}

/** Accepts a Fetch `Request` (Azure Functions, Hono, etc.) or a raw body plus headers. */
export type WebhookRequestLike = Request | { readonly headers: Record<string, string | string[] | undefined> | Headers; readonly rawBody: string | Uint8Array };

export async function verifyWebhook(_request: WebhookRequestLike, _secret: string, _options?: VerifyWebhookOptions): Promise<VerifiedWebhookEvent> {
  return notImplemented("verifyWebhook()");
}
