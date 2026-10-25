const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

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

/** One entry of the gateway's log, as the operator console shows it (fields already masked like the output). */
export interface LogRecord {
  readonly seq: number;
  readonly at: string;
  readonly level: Level;
  readonly logger: string;
  readonly message: string;
  readonly fields?: Record<string, unknown>;
}

const FIELD_TEXT_LIMIT = 2_000;

/** Bounds long strings (stack traces, outputs) so the in-memory ring stays small. */
function compact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > FIELD_TEXT_LIMIT ? `${value.slice(0, FIELD_TEXT_LIMIT)}… [${value.length - FIELD_TEXT_LIMIT} more characters]` : value;
  if (value === null || typeof value !== "object" || depth > 6) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => compact(item, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, compact(item, depth + 1)]));
}

/**
 * The most recent log entries this process wrote (what its output carries, at the configured level), for the
 * operator console's log view. Listeners are told about each entry as it is written.
 */
export class LogRing {
  readonly #entries: LogRecord[] = [];
  readonly #listeners = new Set<(entry: LogRecord) => void>();
  readonly #capacity: number;
  #seq = 0;
  #dispatching = false;

  constructor(capacity = 1_000) {
    this.#capacity = capacity;
  }

  push(entry: Omit<LogRecord, "seq">): void {
    const record: LogRecord = { ...entry, seq: ++this.#seq };
    this.#entries.push(record);
    if (this.#entries.length > this.#capacity) this.#entries.splice(0, this.#entries.length - this.#capacity);
    // A listener that logs must not be told about its own entries recursively.
    if (this.#dispatching) return;
    this.#dispatching = true;
    try {
      for (const listener of this.#listeners) {
        try {
          listener(record);
        } catch {
          // A failing listener never affects logging.
        }
      }
    } finally {
      this.#dispatching = false;
    }
  }

  /** Newest last; at most `limit` entries at or above `level`. */
  recent(options: { readonly level?: Level; readonly limit?: number } = {}): LogRecord[] {
    const minimum = LEVELS[options.level ?? "debug"];
    const limit = Math.min(Math.max(options.limit ?? 200, 1), this.#capacity);
    const matching = this.#entries.filter((entry) => LEVELS[entry.level] >= minimum);
    return matching.slice(-limit);
  }

  subscribe(listener: (entry: LogRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

/** This process's log ring (every logger writes to it). */
export const logRing = new LogRing();

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
    const hasFields = fields !== undefined && Object.keys(fields).length > 0;
    const suffix = hasFields ? ` ${stringify(fields)}` : "";
    const time = new Date().toISOString();
    const line = `${time} ${at.toUpperCase().padEnd(5)} [${name}] ${message}${suffix}\n`;
    (at === "error" || at === "warn" ? process.stderr : process.stdout).write(line);
    let recorded: Record<string, unknown> | undefined;
    if (hasFields) {
      try {
        recorded = compact(redact(fields)) as Record<string, unknown>;
      } catch {
        recorded = { fields: "[unserializable fields]" };
      }
    }
    logRing.push({ at: time, level: at, logger: name, message, ...(recorded ? { fields: recorded } : {}) });
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (child) => createLogger(`${name}:${child}`, level),
  };
}
