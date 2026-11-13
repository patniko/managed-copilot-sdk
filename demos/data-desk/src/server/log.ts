/** The demo's server logger: the shared demo logger (`@managed-copilot/demo-log`) with this demo's prefix and level variable. */

import { createDemoLog } from "@managed-copilot/demo-log";

export const log = createDemoLog({ name: "data-desk", levelEnv: "DATA_DESK_LOG_LEVEL" });
