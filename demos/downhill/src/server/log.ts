/**
 * The demo's server logger: the shared demo logger (`@managed-copilot/demo-log`) with this demo's prefix and level
 * variable. Telemetry receives its lines through {@link setLogSink}; `log.local` lines stay out of telemetry.
 */

import { createDemoLog, type LogSink } from "@managed-copilot/demo-log";

export type { Level, LogSink } from "@managed-copilot/demo-log";

export const log = createDemoLog({ name: "downhill", levelEnv: "DOWNHILL_LOG_LEVEL" });

/** Sends every line written from now on to `next` too (or stops, without one). */
export function setLogSink(next?: LogSink): void {
  log.setSink(next);
}