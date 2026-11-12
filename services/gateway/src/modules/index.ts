import type { GatewayModule } from "../app.js";
import { attachModule } from "./attach/index.js";
import { coreModule } from "./core/index.js";
import { durableModule } from "./durable/index.js";
import { foundryModule } from "./foundry/index.js";
import { openaiModule } from "./openai/index.js";
import { networkModule } from "./network/index.js";
import { operatorModule } from "./operator/index.js";
import { orchestratorModule } from "./orchestrator/index.js";
import { promotionModule } from "./promotion/index.js";
import { sandboxModule } from "./sandbox/index.js";

/**
 * Registration order matters only for services: providers register before consumers resolve them at start. The
 * operator module reads every other module's views, so it registers last.
 */
export const modules: readonly GatewayModule[] = [coreModule, foundryModule, openaiModule, sandboxModule, networkModule, durableModule, attachModule, promotionModule, orchestratorModule, operatorModule];
