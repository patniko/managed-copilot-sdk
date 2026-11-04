/** Small structured logger. Never logs credentials: token-shaped strings are redacted. */

type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

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
const threshold = ORDER[(process.env.DATA_DESK_LOG_LEVEL as Level | undefined) ?? "info"] ?? ORDER.info;

function write(level: Level, message: string, fields?: Fields): void {
  if (ORDER[level] < threshold) return;
  const time = new Date().toISOString().slice(11, 19);
  const extra = fields
    ? Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${formatValue(key, value)}`)
        .join(" ")
    : "";
  const line = `[data-desk] ${time} ${level.padEnd(5)} ${redact(message)}${extra ? ` ${extra}` : ""}\n`;
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line);
}

export const log = {
  debug: (message: string, fields?: Fields) => write("debug", message, fields),
  info: (message: string, fields?: Fields) => write("info", message, fields),
  warn: (message: string, fields?: Fields) => write("warn", message, fields),
  error: (message: string, fields?: Fields) => write("error", message, fields),
};
