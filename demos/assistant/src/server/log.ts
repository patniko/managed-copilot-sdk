/** Small structured console logger. Values under sensitive-looking keys are redacted before printing. */

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /token|secret|password|authorization|cookie|verifier|apikey|sealing|^code$/i;
const minLevel = LEVELS[(process.env.ASSISTANT_LOG_LEVEL as Level | undefined) ?? "info"] ?? LEVELS.info;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) && entry !== undefined && typeof entry !== "boolean" && typeof entry !== "number" ? "[redacted]" : redact(entry, depth + 1);
  }
  return out;
}

function format(fields: Record<string, unknown> | undefined): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(redact(fields) as Record<string, unknown>)) {
    if (value === undefined) continue;
    parts.push(`${key}=${typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value)}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  const write = (level: Level, message: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < minLevel) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${format(fields)}`;
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (child) => createLogger(`${scope}:${child}`),
  };
}

/** A short, human-readable message for an unknown error (never a stack trace). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unexpected error";
}
