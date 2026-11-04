import { ManagedCopilotError, type ActionClaimRequest, type ActionResultRequest } from "@managed-copilot/protocol";
import type { GatewayApp } from "../../../app.js";
import { bearerToken, resolvePrincipal, type RequestContext } from "../../../http.js";
import type { ActionCaller, ActionsService } from "../contract.js";
import { isCapabilityToken } from "./capability.js";

/**
 * Resolves the caller of an action route: an `mcc_` webhook capability, or a person as every user route admits one (a
 * GitHub user, or one acting through an app's key; never the app alone).
 */
export async function resolveActionCaller(app: GatewayApp, actions: ActionsService, ctx: RequestContext): Promise<ActionCaller> {
  const token = bearerToken(ctx.req);
  if (token && isCapabilityToken(token)) return { type: "capability", capability: actions.verifyCapability(token) };
  const principal = await resolvePrincipal(app, ctx.req, "user");
  if (!principal) throw new ManagedCopilotError("authentication_required", "Sign in with a GitHub token, or present an action capability");
  // Through an app, only the sessions within its environments (the router checks this for routes it authenticates).
  if (ctx.params["id"]) app.services.sessions?.assertAppScope?.(principal, ctx.params["id"]);
  return { type: "user", principal };
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ManagedCopilotError("invalid_request", `${name} must be a number`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ManagedCopilotError("invalid_request", `${name} must be a string`);
  return value;
}

export function registerActionRoutes(app: GatewayApp, actions: ActionsService): void {
  // Patterns for ROUTES.actions / actionClaim / actionResult.
  app.routes.get(
    "/v1/sessions/:id/actions",
    async (ctx) => {
      const caller = await resolveActionCaller(app, actions, ctx);
      const open = ctx.query.get("open");
      const states = ctx.query.get("state")?.split(",").filter(Boolean);
      const list = await actions.listFor(caller, ctx.params.id!, { open: open === "1" || open === "true" });
      return states && states.length > 0 ? list.filter((action) => states.includes(action.state)) : list;
    },
    { auth: "none" },
  );

  app.routes.post(
    "/v1/sessions/:id/actions/:actionId/claim",
    async (ctx) => {
      const caller = await resolveActionCaller(app, actions, ctx);
      const body = await ctx.json<ActionClaimRequest>();
      return actions.claim(caller, ctx.params.id!, ctx.params.actionId!, {
        claimToken: optionalString(body.claimToken, "claimToken"),
        leaseSeconds: optionalNumber(body.leaseSeconds, "leaseSeconds"),
        reconcile: body.reconcile === true,
        responder: optionalString(body.responder, "responder")?.slice(0, 100),
      });
    },
    { auth: "none" },
  );

  app.routes.post(
    "/v1/sessions/:id/actions/:actionId/result",
    async (ctx) => {
      const caller = await resolveActionCaller(app, actions, ctx);
      const body = await ctx.json<ActionResultRequest>();
      return actions.submit(caller, ctx.params.id!, ctx.params.actionId!, {
        claimToken: optionalString(body.claimToken, "claimToken") ?? "",
        ...(body.result !== undefined ? { result: body.result } : {}),
        ...(body.error !== undefined && body.error !== null ? { error: String(body.error) } : {}),
        ...(body.release === true ? { release: true } : {}),
      });
    },
    { auth: "none" },
  );
}
