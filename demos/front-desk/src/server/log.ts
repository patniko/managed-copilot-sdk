/** The demo's server logger: the shared demo logger (`@managed-copilot/demo-log`) with this demo's prefix and level variable. */

import { createDemoLog } from "@managed-copilot/demo-log";

/** Also masks fields named like sign-in codes and PKCE verifiers. */
export const log = createDemoLog({
  name: "front-desk",
  levelEnv: "FRONT_DESK_LOG_LEVEL",
  secretKeys: /token|secret|password|authorization|cookie|code|verifier/i,
});

export type Logger = typeof log;
