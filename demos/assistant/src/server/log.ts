/**
 * The assistant's console logger: the shared demo scoped loggers (`@managed-copilot/demo-log`) with this demo's level
 * variable. Values under sensitive-looking keys are redacted before printing.
 */

import { createScopedLoggers, type ScopedLogger } from "@managed-copilot/demo-log";

export { errorMessage } from "@managed-copilot/demo-log";

export type Logger = ScopedLogger;

export const createLogger: (scope: string) => Logger = createScopedLoggers({ levelEnv: "ASSISTANT_LOG_LEVEL" });