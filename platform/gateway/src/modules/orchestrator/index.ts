// Owner: orchestrator workstream. Orchestrator environments (spec section 17): the coordinator's worker tools,
// `GET /v1/sessions/:id/workers`, the `worker.*` platform events, approvals for approved workers' prompts, and the
// cleanup of workers whose coordinator is gone.
import { isManagedCopilotError } from "@managed-copilot/protocol";
import type { GatewayModule } from "../../app.js";
import type { PlatformToolCallContext, PlatformToolResult } from "../core/contracts.js";
import { WorkerManager } from "./service.js";
import { WorkerStore } from "./store.js";
import { WORKER_TOOLS } from "./tools.js";

declare module "../../app.js" {
  interface GatewayServices {
    orchestrator: WorkerManager;
  }
}

type WorkerToolHandler = (args: unknown, context: PlatformToolCallContext) => Promise<PlatformToolResult>;

/**
 * Refusals are written for the coordinator's model, so they go back as the stock SDK shows a failed tool to it
 * (`resultType: "failure"`); a thrown error would reach it only as "Tool execution failed". Unexpected errors still
 * throw, and the ledger reports them without details. A call still running when the gateway starts shutting down is
 * left unanswered: the ledger runs it again after the restart (every worker tool is idempotent by its key), and
 * nothing is recorded while the database closes.
 */
function forModel(manager: WorkerManager, handler: WorkerToolHandler): WorkerToolHandler {
  const unanswered = () => new Promise<never>(() => undefined);
  return async (args, context) => {
    let result: PlatformToolResult;
    try {
      result = await handler(args, context);
    } catch (error) {
      if (manager.closed) return unanswered();
      if (!isManagedCopilotError(error)) throw error;
      return { textResultForLlm: error.message, resultType: "failure", error: error.message };
    }
    return manager.closed ? unanswered() : result;
  };
}

export const orchestratorModule: GatewayModule = {
  name: "orchestrator",
  register(app) {
    const log = app.log.child("orchestrator");
    const manager = new WorkerManager({ app, log, store: new WorkerStore(app.db) });
    app.provide("orchestrator", manager);

    const handlers: Record<string, WorkerToolHandler> = {
      start_worker: (args, context) => manager.start(args, context),
      message_worker: (args, context) => manager.message(args, context),
      wait_for_workers: (args, context) => manager.wait(args, context),
      list_workers: async (args, context) => manager.list(args, context),
      read_worker_file: (args, context) => manager.readFile(args, context),
      copy_worker_files: (args, context) => manager.copyFiles(args, context),
      stop_worker: (args, context) => manager.stop(args, context),
    };
    const platformTools = app.service("platformTools");
    for (const tool of WORKER_TOOLS) {
      const handler = handlers[tool.name];
      if (!handler) throw new Error(`No handler for worker tool ${tool.name}`);
      platformTools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        skipPermission: tool.skipPermission,
        // Only coordinators get them: workers (isolated sessions) cannot start workers.
        appliesTo: ({ type, placement }) => type === "orchestrator" && placement === "shared",
        handler: forModel(manager, handler),
      });
    }

    // Parameterized paths are spelled out (`ROUTES.workers(id)` encodes its argument).
    app.routes.get("/v1/sessions/:id/workers", (ctx) => manager.listFor(ctx.principal!, ctx.params["id"]!));
    app.routes.get("/v1/sessions/:id/workers/:workerId", (ctx) => manager.getFor(ctx.principal!, ctx.params["id"]!, ctx.params["workerId"]!));

    // Before anything starts, so no worker event or prompt is missed.
    manager.attach();

    let recovering: Promise<void> | undefined;
    app.onStart(() => {
      const declared = Object.values(app.config.deployment.environments).some((environment) => environment.type === "orchestrator");
      if (manager.available()) app.capabilities.add("orchestrator");
      else if (declared) log.warn("Orchestrator environments are unavailable: workers need sandboxes and the actions ledger");
      recovering = manager.recover().catch((error: unknown) => log.error("Worker recovery failed", { error: (error as Error).message }));
    });
    app.onStop(async () => {
      manager.close();
      await Promise.race([recovering, new Promise((resolve) => setTimeout(resolve, 2_000).unref())]);
    });
  },
};
