import { ManagedCopilotError, ROUTES, type RunScheduleRequest } from "@managed-copilot/protocol";
import type { GatewayApp } from "../../../app.js";
import type { DurableSchedules } from "./service.js";

export function registerScheduleRoutes(app: GatewayApp, schedules: DurableSchedules): void {
  const owner = (ctx: { principal: { accountId: number } | undefined }) => ctx.principal!.accountId;

  app.routes.get(ROUTES.schedules, (ctx) => schedules.list(owner(ctx)));

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
