type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured JSON lines on stdout/stderr (visible with `docker logs`). Never pass secrets or environment values. */
export function createLog(component: string, level: Level = (process.env.SANDBOXD_LOG_LEVEL as Level) ?? "info") {
  const threshold = ORDER[level] ?? ORDER.info;
  const write = (at: Level, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[at] < threshold) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: at, component, message, ...fields });
    (at === "warn" || at === "error" ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
    info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
    error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
  };
}

export type Log = ReturnType<typeof createLog>;
