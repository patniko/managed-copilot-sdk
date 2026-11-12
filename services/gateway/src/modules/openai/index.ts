// OpenAI-compatible endpoints as an inference route (spec section 15): see service.ts. Core routes the sessions of a
// shared environment with `inference: { openai }` through the `openai` service.
import type { GatewayModule } from "../../app.js";
import { OpenAIEndpointService } from "./service.js";

export { OpenAIEndpointService, type OpenAIEndpointStatus } from "./service.js";

declare module "../../app.js" {
  interface GatewayServices {
    openai: OpenAIEndpointService;
  }
}

export const openaiModule: GatewayModule = {
  name: "openai",
  register(app) {
    if (Object.keys(app.config.deployment.openai ?? {}).length === 0) return;
    const service = new OpenAIEndpointService({ deployment: app.config.deployment, env: app.config.env });
    app.provide("openai", service);
    for (const status of service.status()) {
      if (status.problem) app.log.warn("OpenAI-compatible endpoint unavailable", { endpoint: status.name, problem: status.problem });
      else app.log.info("OpenAI-compatible endpoint declared", { endpoint: status.name, url: status.url, models: status.models });
    }
  },
};
