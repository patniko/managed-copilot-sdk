// Redaction for operator views. Operators see configuration, never credentials: URL query values and user
// information, command-line arguments that look like secrets, and values under credential-like keys are masked.
import { redact } from "./log.js";

export const REDACTED = "[redacted]";

/** Flag names whose next argument (or `=value`) is a credential. */
const SECRET_FLAG = /token|secret|passw|apikey|api-key|api_key|auth|credential|cookie|bearer|signature|private|key$/i;

/** Well-known credential shapes. */
const SECRET_SHAPES: readonly RegExp[] = [
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^sk-[A-Za-z0-9_-]{16,}$/,
  /^xox[abposr]-[A-Za-z0-9-]{10,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  /^(mcc|mcrt|mcv|mcsk)_[A-Za-z0-9_-]{8,}$/,
  /^Bearer\s+\S+$/i,
  /^Basic\s+\S+$/i,
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a string looks like a credential: a known token shape, or a long opaque mix of letters and digits. */
export function looksSecret(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (SECRET_SHAPES.some((shape) => shape.test(text))) return true;
  if (UUID.test(text)) return false;
  return text.length >= 32 && /^[A-Za-z0-9_-]+={0,2}$/.test(text) && /[0-9]/.test(text) && /[A-Za-z]/.test(text);
}

/** A URL with its query values and user information masked; non-URLs pass through unless they look secret. */
export function redactUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return looksSecret(value) ? REDACTED : value;
  }
  if (url.username || url.password) {
    url.username = "***";
    url.password = "";
  }
  if (url.search) {
    const masked = new URLSearchParams();
    for (const key of url.searchParams.keys()) if (!masked.has(key)) masked.set(key, "***");
    url.search = masked.toString();
  }
  return url.toString();
}

/** Command-line arguments with credential values masked (`--token x`, `--api-key=x`, token-shaped values). */
export function scrubArgs(args: readonly unknown[]): string[] {
  const out: string[] = [];
  let hideNext = false;
  for (const raw of args) {
    const arg = typeof raw === "string" ? raw : JSON.stringify(raw) ?? "";
    if (hideNext) {
      out.push(REDACTED);
      hideNext = false;
      continue;
    }
    const assignment = /^(--?[A-Za-z0-9_.-]+)=(.*)$/s.exec(arg);
    if (assignment) {
      out.push(SECRET_FLAG.test(assignment[1]!) || looksSecret(assignment[2]!) ? `${assignment[1]}=${REDACTED}` : `${assignment[1]}=${redactUrl(assignment[2]!)}`);
      continue;
    }
    if (/^--?[A-Za-z0-9_.-]+$/.test(arg)) {
      out.push(arg);
      if (SECRET_FLAG.test(arg)) hideNext = true;
      continue;
    }
    out.push(looksSecret(arg) ? REDACTED : /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ? redactUrl(arg) : arg);
  }
  return out;
}

/**
 * A free-form value with token-shaped strings masked anywhere and, unless `keys` is false, values under
 * credential-like keys masked too (the logger's rules). Pass `keys: false` for JSON schemas, whose keys are property
 * names rather than secrets.
 */
export function redactValue(value: unknown, options: { readonly keys?: boolean } = {}): unknown {
  const masked = options.keys === false ? value : redact(value);
  const walk = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") return looksSecret(item) ? REDACTED : item;
    if (depth > 12 || item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map((entry) => walk(entry, depth + 1));
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, entry]) => [key, walk(entry, depth + 1)]));
  };
  return walk(masked, 0);
}
