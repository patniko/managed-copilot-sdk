import { ManagedCopilotError } from "@managed-copilot/protocol";
import type { GatewayApp } from "../../../app.js";
import type { RequestContext } from "../../../http.js";
import type { WebhookDeliveryState, WebhooksService } from "../contract.js";

const STATES: readonly WebhookDeliveryState[] = ["pending", "delivering", "delivered", "failed"];

function query(ctx: RequestContext): { state?: WebhookDeliveryState; limit?: number } {
  const state = ctx.query.get("state") ?? undefined;
  if (state !== undefined && !(STATES as readonly string[]).includes(state)) {
    throw new ManagedCopilotError("invalid_request", `state must be one of ${STATES.join(", ")}`);
  }
  const limitText = ctx.query.get("limit");
  const limit = limitText === null ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new ManagedCopilotError("invalid_request", "limit must be a positive integer");
  return { ...(state ? { state: state as WebhookDeliveryState } : {}), ...(limit !== undefined ? { limit } : {}) };
}

/**
 * Delivery status: `GET /v1/webhooks/deliveries` shows the caller's own sessions' deliveries (including `failed`
 * ones), and the operator view `GET /v1/webhooks/deliveries/all` (platform key) shows every delivery.
 */
export function registerWebhookRoutes(app: GatewayApp, webhooks: WebhooksService): void {
  app.routes.get("/v1/webhooks/deliveries", (ctx) => {
    const principal = ctx.principal!;
    // Through an app (spec section 2): only deliveries of events in the app's environments.
    const environments = principal.app ? (app.services.apps?.get(principal.app)?.environments ?? []) : undefined;
    return webhooks.deliveries({ ...query(ctx), ownerId: principal.accountId, ...(environments ? { environments } : {}) });
  });
  app.routes.get("/v1/webhooks/deliveries/all", (ctx) => webhooks.deliveries(query(ctx)), { auth: "platform" });
}
