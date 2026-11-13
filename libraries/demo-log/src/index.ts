/**
 * The demos' small structured server logger. Never logs credentials: token-shaped strings are redacted from messages
 * and field values, and fields under secret-looking names are masked.
 */

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const TOKEN_PATTERNS = [/\bgh[opusr]_[A-Za-z0-9]{20,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi];

/** Field names whose values a {@link createDemoLog} logger masks by default. */
export const SECRET_KEYS = /token|secret|password|authorization|cookie/i;

/** `text` with GitHub tokens and bearer credentials replaced by `***`. */
export function redact(text: string): string {
  return TOKEN_PATTERNS.reduce((value, pattern) => value.replace(pattern, "***"), text);
}

function threshold(levelEnv: string): number {
  return ORDER[(process.env[levelEnv] as Level | undefined) ?? "info"] ?? ORDER.info;
}

/** Receives every line a logger writes, redacted, with its fields as text (Downhill's telemetry exports them). */
export type LogSink = (level: Level, message: string, fields: Readonly<Record<string, string>>) => void;

export interface DemoLogOptions {
  /** The line prefix, written as `[name]`. */
  readonly name: string;
  /** The environment variable holding the minimum level (`debug`, `info`, `warn`, or `error`; default `info`). */
  readonly levelEnv: string;
  /** Field names whose values are masked as `***`. Default {@link SECRET_KEYS}. */
  readonly secretKeys?: RegExp;
}

export interface DemoLog {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** Written here only, never to the sink: for the sink's own news, which it can't be trusted to deliver. */
  readonly local: {
    info(message: string, fields?: Fields): void;
    warn(message: string, fields?: Fields): void;
  };
  /** Sends every line written from now on to `next` too (or stops, without one). */
  setSink(next?: LogSink): void;
}

/**
 * A logger writing `[name] HH:MM:SS level message key=value ...` lines: warnings and errors to stderr, the rest to
 * stdout. The level is read from `levelEnv` once, when the logger is created.
 */
export function createDemoLog(options: DemoLogOptions): DemoLog {
  const secretKeys = options.secretKeys ?? SECRET_KEYS;
  const minimum = threshold(options.levelEnv);
  let sink: LogSink | undefined;

  const formatValue = (key: string, value: unknown): string => {
    if (secretKeys.test(key)) return "***";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return redact(text ?? String(value));
  };

  const write = (level: Level, message: string, fields: Fields | undefined, exported: boolean): void => {
    if (ORDER[level] < minimum) return;
    const time = new Date().toISOString().slice(11, 19);
    const formatted: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields ?? {})) if (value !== undefined) formatted[key] = formatValue(key, value);
    const extra = Object.entries(formatted)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    const line = `[${options.name}] ${time} ${level.padEnd(5)} ${redact(message)}${extra ? ` ${extra}` : ""}\n`;
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line);
    if (exported) sink?.(level, redact(message), formatted);
  };

  return {
    debug: (message, fields) => write("debug", message, fields, true),
    info: (message, fields) => write("info", message, fields, true),
    warn: (message, fields) => write("warn", message, fields, true),
    error: (message, fields) => write("error", message, fields, true),
    local: {
      info: (message, fields) => write("info", message, fields, false),
      warn: (message, fields) => write("warn", message, fields, false),
    },
    setSink: (next) => {
      sink = next;
    },
  };
}

/** Field names whose values {@link redactFields} and a {@link createScopedLoggers} logger mask by default. */
export const SENSITIVE_FIELD_KEYS = /token|secret|password|authorization|cookie|verifier|apikey|sealing|^code$/i;

/**
 * `value` with every string, object, or array under a sensitive-looking key replaced by `[redacted]`, at most five
 * levels deep. Numbers and booleans under such keys are kept (counts and flags are not secrets).
 */
export function redactFields(value: unknown, sensitiveKeys: RegExp = SENSITIVE_FIELD_KEYS, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redactFields(entry, sensitiveKeys, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = sensitiveKeys.test(key) && entry !== undefined && typeof entry !== "boolean" && typeof entry !== "number" ? "[redacted]" : redactFields(entry, sensitiveKeys, depth + 1);
  }
  return out;
}

export interface ScopedLogger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** A logger for `scope:child`. */
  child(scope: string): ScopedLogger;
}

export interface ScopedLoggerOptions {
  /** The environment variable holding the minimum level (`debug`, `info`, `warn`, or `error`; default `info`). */
  readonly levelEnv: string;
  /** Field names whose values are written as `[redacted]`. Default {@link SENSITIVE_FIELD_KEYS}. */
  readonly sensitiveKeys?: RegExp;
}

/**
 * A factory of scoped loggers writing `<ISO time> LEVEL [scope] message key=<JSON> ...` lines through the console:
 * warnings and errors with `console.error`, the rest with `console.log`. The level is read once, now.
 */
export function createScopedLoggers(options: ScopedLoggerOptions): (scope: string) => ScopedLogger {
  const sensitiveKeys = options.sensitiveKeys ?? SENSITIVE_FIELD_KEYS;
  const minimum = threshold(options.levelEnv);

  const format = (fields: Fields | undefined): string => {
    if (!fields || Object.keys(fields).length === 0) return "";
    const parts: string[] = [];
    for (const [key, value] of Object.entries(redactFields(fields, sensitiveKeys) as Fields)) {
      if (value === undefined) continue;
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
    return parts.length ? ` ${parts.join(" ")}` : "";
  };

  const create = (scope: string): ScopedLogger => {
    const write = (level: Level, message: string, fields?: Fields) => {
      if (ORDER[level] < minimum) return;
      const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${format(fields)}`;
      if (level === "error" || level === "warn") console.error(line);
      else console.log(line);
    };
    return {
      debug: (message, fields) => write("debug", message, fields),
      info: (message, fields) => write("info", message, fields),
      warn: (message, fields) => write("warn", message, fields),
      error: (message, fields) => write("error", message, fields),
      child: (child) => create(`${scope}:${child}`),
    };
  };
  return create;
}

/** A short, human-readable message for an unknown error (never a stack trace). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unexpected error";
}
