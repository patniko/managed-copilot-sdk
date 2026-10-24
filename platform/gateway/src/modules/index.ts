import type { GatewayModule } from "../app.js";
import { attachModule } from "./attach/index.js";
import { coreModule } from "./core/index.js";
import { durableModule } from "./durable/index.js";
import { networkModule } from "./network/index.js";
import { promotionModule } from "./promotion/index.js";
import { sandboxModule } from "./sandbox/index.js";

/** Registration order matters only for services: providers register before consumers resolve them at start. */
export const modules: readonly GatewayModule[] = [coreModule, sandboxModule, networkModule, durableModule, attachModule, promotionModule];
