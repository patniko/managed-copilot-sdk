// Core REST routes: deployment info, the caller's account, owner-scoped sessions, and platform events (SSE).
import { ManagedCopilotError, ROUTES, type DeploymentInfo, type SessionState } from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import { accountInfo } from "./auth.js";
import type { Environments } from "./environments.js";
import type { PlatformEvents } from "./events.js";
import type { SharedRuntime } from "./runtime.js";
import type { SessionManager } from "./sessions.js";

const SESSION_STATES: readonly SessionState[] = ["creating", "ready", "running", "waiting", "idle", "stopped", "promoting", "deleting", "deleted", "failed"];

/** Capability strings advertised in `/v1/info`, keyed by the service that provides them. */
const SERVICE_CAPABILITIES: Record<string, readonly string[]> = {
  sandboxes: ["isolated", "files"],
  artifacts: ["artifacts"],
  vaults: ["vaults"],
  actions: ["actions"],
  webhooks: ["webhooks"],
  schedules: ["schedules"],
  credentials: ["background"],
};

export function deploymentInfo(app: GatewayApp, environments: Environments, runtime: SharedRuntime | undefined): DeploymentInfo {
  const capabilities = new Set<string>(["events"]);
  if (runtime) capabilities.add("shared");
  for (const [service, provided] of Object.entries(SERVICE_CAPABILITIES)) {
    if ((app.services as Record<string, unknown>)[service] !== undefined) for (const capability of provided) capabilities.add(capability);
  }
  for (const capability of app.capabilities) capabilities.add(capability);
  const deployment = app.config.deployment;
  return {
    name: deployment.name,
    version: app.config.version,
    mode: app.config.mode,
    environments: environments.info(),
    ...(deployment.inline ? { inline: deployment.inline } : {}),
    capabilities: [...capabilities].sort(),
    sdk: { copilotSdk: "1.0.26", copilotRuntime: runtime?.current()?.version ?? "1.0.103" },
  };
}

export function registerRoutes(app: GatewayApp, options: { manager: SessionManager; environments: Environments; events: PlatformEvents; runtime: SharedRuntime | undefined }): void {
  const { manager, environments, events, runtime } = options;

  app.routes.get(ROUTES.info, () => deploymentInfo(app, environments, runtime));

  app.routes.get(ROUTES.me, (ctx) => accountInfo(ctx.principal!));

  app.routes.get(ROUTES.sessions, async (ctx) => {
    const state = ctx.query.get("state") ?? undefined;
    if (state !== undefined && !(SESSION_STATES as readonly string[]).includes(state)) {
      throw new ManagedCopilotError("invalid_request", `Unknown session state "${state}"`);
    }
    const limitText = ctx.query.get("limit");
    const limit = limitText === null ? undefined : Number(limitText);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new ManagedCopilotError("invalid_request", "limit must be a positive integer");
    const environment = ctx.query.get("environment") ?? undefined;
    const records = manager.list(ctx.principal!.accountId, {
      ...(environment ? { environment } : {}),
      ...(state ? { state: state as SessionState } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return Promise.all(records.map((record) => manager.toInfo(record)));
  });

  app.routes.get("/v1/sessions/:id", (ctx) => manager.info(ctx.principal!.accountId, ctx.params["id"]!));

  app.routes.delete("/v1/sessions/:id", async (ctx) => {
    await manager.delete(ctx.principal!.accountId, ctx.params["id"]!);
    return undefined;
  });

  app.routes.get(ROUTES.events, (ctx) =>
    events.stream(ctx, async () => {
      const principal = await app.service("auth").authenticate(ctx.principal!.token);
      if (principal.accountId !== ctx.principal!.accountId) throw new ManagedCopilotError("authentication_required", "The credential now belongs to another account");
    }),
  );
}
