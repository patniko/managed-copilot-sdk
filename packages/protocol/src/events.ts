/** Platform events (`managed.on`, `GET /v1/events` SSE) and signed webhook deliveries (spec section 12). */

export const PLATFORM_EVENT_TYPES = [
  "session.created",
  "session.idle",
  "session.failed",
  "session.deleted",
  "session.promoted",
  "session.action_required",
  "artifact.published",
  "schedule.run_started",
  "schedule.run_completed",
  /** A shared session's outbound request was blocked by network policy (`{ host, port, reason }`; no credentials). */
  "network.blocked",
] as const;
export type PlatformEventType = (typeof PLATFORM_EVENT_TYPES)[number];

export interface PlatformEvent<T = Record<string, unknown>> {
  readonly id: string;
  readonly type: PlatformEventType;
  readonly createdAt: string;
  readonly sessionId?: string;
  readonly environment?: string;
  /** Set on sandbox-related events such as `session.promoted` (spec section 9: `e.sandboxId`). */
  readonly sandboxId?: string;
  readonly data: T;
}

/** Short-lived capability for the listed actions of one session; never arbitrary session control. */
export interface ActionCapability {
  readonly token: string;
  readonly expiresAt: string;
  readonly sessionId: string;
  readonly actionIds: readonly string[];
  /** Deployment base URL the capability is valid for; never trust a different URL from a payload. */
  readonly audience: string;
}

export interface WebhookEnvelope<T = Record<string, unknown>> extends PlatformEvent<T> {
  readonly deployment: string;
  readonly capability?: ActionCapability;
}

export const WEBHOOK_HEADERS = {
  /** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` */
  signature: "x-managed-copilot-signature",
  eventId: "x-managed-copilot-event-id",
  deliveryAttempt: "x-managed-copilot-delivery-attempt",
} as const;

/** Replay window for webhook timestamps. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
