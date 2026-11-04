// Azure AI Foundry as an inference route (spec section 15): see service.ts. Core routes Foundry sessions
// through the `foundry` service; the sandbox broker brokers their model calls.
import type { GatewayModule } from "../../app.js";
import { FoundryService } from "./service.js";

export { COGNITIVE_SERVICES_RESOURCE, FoundryService, type FoundryAccountStatus, type FoundryRoute } from "./service.js";

declare module "../../app.js" {
  interface GatewayServices {
    foundry: FoundryService;
  }
}

export const foundryModule: GatewayModule = {
  name: "foundry",
  register(app) {
    if (Object.keys(app.config.deployment.foundry ?? {}).length === 0) return;
    const service = new FoundryService({ deployment: app.config.deployment, mode: app.config.mode, env: app.config.env, log: app.log.child("foundry") });
    app.provide("foundry", service);
    // Looked up in the background: a problem shows in the log and the console, and sessions fail with its reason.
    app.onStart(() => {
      void service.refresh();
    });
  },
};
