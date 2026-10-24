const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

/**
 * Keys whose values are masked. Matches credential-bearing names (`token`, `secret`, `authorization`, `value`,
 * `headers`, `placeholder`, ...) but not identifiers that merely end in "key" (`idempotencyKey`, `cacheKey`).
 */
const SENSITIVE_KEY = /token|secret|authorization|password|passwd|cookie|credential|^value$|^values$|^headers$|placeholder|private|^apikey$|^api_key$|^key$|accesskey|access_key|signingkey|signing_key|platformkey|platform_key/i;

/** Masks values whose keys look sensitive. Logs must never carry credentials, placeholders, or vault values. */
export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "bigint") return value.toString();
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(item, depth + 1, seen);
  }
  return out;
}

function stringify(fields: Record<string, unknown>): string {
  try {
    return JSON.stringify(redact(fields));
  } catch {
    return '"[unserializable fields]"';
  }
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(name: string): Logger;
}

export function createLogger(name: string, level: string = process.env.LOG_LEVEL ?? "info"): Logger {
  const threshold = LEVELS[(level as Level) in LEVELS ? (level as Level) : "info"];
  const write = (at: Level, message: string, fields?: Record<string, unknown>) => {
    if (LEVELS[at] < threshold) return;
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${stringify(fields)}` : "";
    const line = `${new Date().toISOString()} ${at.toUpperCase().padEnd(5)} [${name}] ${message}${suffix}\n`;
    (at === "error" || at === "warn" ? process.stderr : process.stdout).write(line);
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (child) => createLogger(`${name}:${child}`, level),
  };
}
