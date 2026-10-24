/** Minimal leveled logger with the same line format as the gateway. Never pass credentials or placeholders. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(name: string, level: string = process.env.LOG_LEVEL ?? "info"): Logger {
  const threshold = LEVELS[(level as Level) in LEVELS ? (level as Level) : "info"];
  const write = (at: Level, message: string, fields?: Record<string, unknown>) => {
    if (LEVELS[at] < threshold) return;
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
    const line = `${new Date().toISOString()} ${at.toUpperCase().padEnd(5)} [${name}] ${message}${suffix}\n`;
    (at === "error" || at === "warn" ? process.stderr : process.stdout).write(line);
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
