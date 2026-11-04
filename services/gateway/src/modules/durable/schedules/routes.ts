import { ManagedCopilotError, ROUTES, type RunScheduleRequest } from "@managed-copilot/protocol";
import type { GatewayApp } from "../../../app.js";
import type { Principal } from "../../../http.js";
import type { DurableSchedules } from "./service.js";

/**
 * Schedules are an account's own, across every environment, and run with its background sign-in: none of them is
 * reachable through an app (spec section 2), whose requests see only the app's environments.
 */
function notThroughApp(principal: Principal): void {
  if (!principal.app) return;
  throw new ManagedCopilotError(
    "capability_unavailable",
    principal.kind === "app-user"
      ? "Schedules run with their owner's background GitHub sign-in, and an app's own users have none."
      : `Schedules run with their owner's background sign-in (\`npx managed-copilot login\`) and are managed outside apps; they are not available through the "${principal.app}" app.`,
  );
}

export function registerScheduleRoutes(app: GatewayApp, schedules: DurableSchedules): void {
  const owner = (ctx: { principal: Principal | undefined }) => {
    notThroughApp(ctx.principal!);
    return ctx.principal!.accountId;
  };

  app.routes.get(ROUTES.schedules, (ctx) => {
    const account = owner(ctx);
    // AppHost declarations naming this account appear here (paused) so the account can approve them.
    schedules.syncAppHost(ctx.principal!);
    return schedules.list(account);
  });

  app.routes.post(ROUTES.schedules, async (ctx) => {
    const created = await schedules.create(ctx.principal!, await ctx.json());
    ctx.status(201);
    return created;
  });

  app.routes.get("/v1/schedules/:id", (ctx) => schedules.get(owner(ctx), ctx.params.id!));

  app.routes.delete("/v1/schedules/:id", (ctx) => {
    schedules.delete(owner(ctx), ctx.params.id!);
    return undefined;
  });

  app.routes.get("/v1/schedules/:id/runs", (ctx) => schedules.runs(owner(ctx), ctx.params.id!));

  app.routes.post("/v1/schedules/:id/pause", (ctx) => schedules.pause(owner(ctx), ctx.params.id!));

  app.routes.post("/v1/schedules/:id/resume", (ctx) => schedules.resume(owner(ctx), ctx.params.id!));

  app.routes.post("/v1/schedules/:id/run", async (ctx) => {
    const body = await ctx.json<RunScheduleRequest>();
    if (body.invocationId !== undefined && typeof body.invocationId !== "string") throw new ManagedCopilotError("invalid_request", "invocationId must be a string");
    const run = await schedules.runNow(owner(ctx), ctx.params.id!, body.invocationId);
    ctx.status(202);
    return run;
  });
}
