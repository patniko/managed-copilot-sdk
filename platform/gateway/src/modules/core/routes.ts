// Core REST routes: deployment info, the caller's account, owner-scoped sessions, and platform events (SSE).
import { isManagedCopilotError, ManagedCopilotError, ROUTES, type DeploymentInfo, type SessionState } from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import { accountInfo } from "./auth.js";
import type { Environments } from "./environments.js";
import type { PlatformEvents } from "./events.js";
import type { SharedRuntime } from "./runtime.js";
import type { SessionManager } from "./sessions.js";

const SESSION_STATES: readonly SessionState[] = ["creating", "ready", "running", "waiting", "idle", "stopped", "promoting", "deleting", "deleted", "failed"];

/** Capability strings advertised in `/v1/info`, keyed by the service that provides them. */
const SERVICE_CAPABILITIES: Record<string, readonly string[]> = {
  sandboxes: ["isolated", "files", "exec"],
  artifacts: ["artifacts"],
  vaults: ["vaults"],
  actions: ["actions"],
  webhooks: ["webhooks"],
  schedules: ["schedules"],
  credentials: ["background"],
};

/** Module capabilities (`app.capabilities`) that need a working sandbox backend. */
const SANDBOX_BACKED_CAPABILITIES: ReadonlySet<string> = new Set(["promotion", "orchestrator"]);

export function deploymentInfo(app: GatewayApp, environments: Environments, runtime: SharedRuntime | undefined): DeploymentInfo {
  const capabilities = new Set<string>(["events"]);
  if (runtime) capabilities.add("shared");
  const services = app.services as Record<string, unknown>;
  // Only what works now: the sandbox backend reports readiness (Docker down, Azure not configured or qualified).
  const sandboxes = services["sandboxes"] as { available?: boolean } | undefined;
  const sandboxesWork = sandboxes !== undefined && sandboxes.available !== false;
  for (const [service, provided] of Object.entries(SERVICE_CAPABILITIES)) {
    if (services[service] === undefined || (service === "sandboxes" && !sandboxesWork)) continue;
    for (const capability of provided) capabilities.add(capability);
  }
  for (const capability of app.capabilities) if (sandboxesWork || !SANDBOX_BACKED_CAPABILITIES.has(capability)) capabilities.add(capability);
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
    // A session deleted while its details were read is left out.
    const infos = await Promise.all(records.map((record) => manager.toInfo(record).catch((error: unknown) => (isManagedCopilotError(error, "not_found") ? undefined : Promise.reject(error)))));
    return infos.filter((info) => info !== undefined);
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
