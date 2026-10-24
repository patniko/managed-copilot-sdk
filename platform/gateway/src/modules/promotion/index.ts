// Owner: promotion workstream. One-way promotion of promotable sessions from shared placement into their own sandbox
// (spec section 9, gate G5): `POST /v1/sessions/:id/promote`, the `request_sandbox` platform tool, the
// `session.promoted` platform event, and crash recovery of interrupted attempts.
import { join } from "node:path";
import { PLATFORM_TOOLS, ROUTES } from "@managed-copilot/protocol";
import type { GatewayModule } from "../../app.js";
import { PromotionManager } from "./service.js";
import { PromotionStore } from "./store.js";

export const REQUEST_SANDBOX_DESCRIPTION = [
  "Moves this conversation into its own Linux sandbox: a container with a shell, Python 3, and a writable /workspace.",
  "Call it when the task needs to run code or commands, or to read and write files; you cannot do those things before calling it.",
  "The conversation, its history, and this request continue in the sandbox. Preparing the sandbox can take a minute.",
].join(" ");

export const REQUEST_SANDBOX_PARAMETERS = {
  type: "object",
  properties: {
    reason: { type: "string", description: "One sentence on what you need to run or write, shown to the user." },
  },
  required: ["reason"],
  additionalProperties: false,
} as const;

export const promotionModule: GatewayModule = {
  name: "promotion",
  register(app) {
    const log = app.log.child("promotion");
    const store = new PromotionStore(app.db);
    const manager = new PromotionManager({
      app,
      log,
      store,
      platformRoots: [join(app.config.dataDir, "runtime", "shared")],
      stagingRoot: join(app.config.dataDir, "promotion"),
    });
    app.provide("promotion", manager);

    app.routes.post(ROUTES.promote(":id"), async (ctx) => manager.promote(ctx.principal!, ctx.params["id"]!));

    // Injected only into promotable sessions on shared placement, and approved through the session's permission
    // policy like any tool: the call is then carried into the sandbox and answered there.
    app.service("platformTools").register({
      name: PLATFORM_TOOLS.requestSandbox,
      description: REQUEST_SANDBOX_DESCRIPTION,
      parameters: REQUEST_SANDBOX_PARAMETERS as unknown as Record<string, unknown>,
      skipPermission: false,
      appliesTo: ({ type, placement }) => type === "promotable" && placement === "shared",
      handler: (args, context) => {
        const reason = typeof (args as { reason?: unknown } | undefined)?.reason === "string" ? (args as { reason: string }).reason.slice(0, 300) : undefined;
        log.info("The agent asked for a sandbox", { sessionId: context.sessionId, toolCallId: context.toolCallId, ...(reason ? { reason } : {}) });
        return manager.fromTool(context);
      },
    });

    app.onStart(async () => {
      if (manager.available()) app.capabilities.add("promotion");
      else log.warn("Promotion is unavailable: it needs the router's placement cutover and sandboxes that import session state");
      await manager.recover().catch((error: unknown) => log.error("Promotion recovery failed", { error: (error as Error).message }));
    });
  },
};
