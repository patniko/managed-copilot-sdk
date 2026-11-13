/** The demo's server logger: the shared demo logger (`@managed-copilot/demo-log`) with this demo's prefix and level variable. */

import { createDemoLog } from "@managed-copilot/demo-log";

export { redact } from "@managed-copilot/demo-log";

/** Field names masked in log lines and in the OpenTelemetry attributes the app receives (webhook signatures too). */
export const SECRET_KEYS = /token|secret|password|authorization|cookie|signature/i;

export const log = createDemoLog({ name: "incident-commander", levelEnv: "INCIDENT_LOG_LEVEL", secretKeys: SECRET_KEYS });
