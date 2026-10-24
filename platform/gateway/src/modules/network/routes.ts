/** Public REST routes of the network module: vaults created in code, and a session's network view. */
import { ManagedCopilotError, ROUTES, type SessionNetworkInfo } from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import type { PolicyService } from "./policy.js";
import type { VaultStore } from "./vaults.js";

export function registerNetworkRoutes(app: GatewayApp, options: { readonly policy: PolicyService; readonly vaults: VaultStore }): void {
  const { policy, vaults } = options;

  app.routes.post(ROUTES.vaults, async (ctx) => {
    const info = vaults.create(ctx.principal!.accountId, await ctx.json());
    ctx.status(201);
    return info;
  });

  app.routes.get(ROUTES.vaults, (ctx) => vaults.list(ctx.principal!.accountId));

  app.routes.get("/v1/vaults/:id", (ctx) => vaults.get(ctx.principal!.accountId, ctx.params["id"]!));

  app.routes.delete("/v1/vaults/:id", (ctx) => {
    vaults.delete(ctx.principal!.accountId, ctx.params["id"]!);
    return undefined;
  });

  app.routes.get("/v1/sessions/:id/network", (ctx) => {
    const sessionId = ctx.params["id"]!;
    const session = policy.session(sessionId);
    if (!session || session.ownerId !== ctx.principal!.accountId) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`);
    const limitText = ctx.query.get("limit");
    const limit = limitText === null ? 50 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1) throw new ManagedCopilotError("invalid_request", "limit must be a positive integer");
    const info: SessionNetworkInfo = {
      sessionId,
      ...(session.environment ? { environment: session.environment } : {}),
      ...(session.promotedTo ? { promotedTo: session.promotedTo } : {}),
      policy: session.policy,
      vaults: session.vaults.flatMap((id) => {
        const vault = vaults.find(id);
        return vault ? [{ id: vault.id, name: vault.name, kind: vault.kind }] : [];
      }),
      blocked: policy.blocked(sessionId, limit).map(({ id: _id, ...report }) => report),
    };
    return info;
  });
}
