/** Small structured logger. Never logs credentials: token-shaped strings are redacted. */

export type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;
/** Receives every line this logger writes, redacted, with its fields as text (telemetry exports them). */
export type LogSink = (level: Level, message: string, fields: Readonly<Record<string, string>>) => void;

let sink: LogSink | undefined;

/** Sends every line written from now on to `next` too (or stops, without one). */
export function setLogSink(next?: LogSink): void {
  sink = next;
}

const TOKEN_PATTERNS = [/\bgh[opusr]_[A-Za-z0-9]{20,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi];
const SECRET_KEYS = /token|secret|password|authorization|cookie/i;

export function redact(text: string): string {
  return TOKEN_PATTERNS.reduce((value, pattern) => value.replace(pattern, "***"), text);
}

function formatValue(key: string, value: unknown): string {
  if (SECRET_KEYS.test(key)) return "***";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return redact(text ?? String(value));
}

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.DOWNHILL_LOG_LEVEL as Level | undefined) ?? "info"] ?? ORDER.info;

function write(level: Level, message: string, fields: Fields | undefined, exported: boolean): void {
  if (ORDER[level] < threshold) return;
  const time = new Date().toISOString().slice(11, 19);
  const formatted: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields ?? {})) if (value !== undefined) formatted[key] = formatValue(key, value);
  const extra = Object.entries(formatted)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const line = `[downhill] ${time} ${level.padEnd(5)} ${redact(message)}${extra ? ` ${extra}` : ""}\n`;
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line);
  if (exported) sink?.(level, redact(message), formatted);
}

export const log = {
  debug: (message: string, fields?: Fields) => write("debug", message, fields, true),
  info: (message: string, fields?: Fields) => write("info", message, fields, true),
  warn: (message: string, fields?: Fields) => write("warn", message, fields, true),
  error: (message: string, fields?: Fields) => write("error", message, fields, true),
  /** Written here only, never to the sink: the telemetry pipeline's own news, which it can't be trusted to deliver. */
  local: {
    info: (message: string, fields?: Fields) => write("info", message, fields, false),
    warn: (message: string, fields?: Fields) => write("warn", message, fields, false),
  },
};
