// Redaction for operator views. Operators see configuration, never credentials: URL query values and user
// information, command-line arguments that look like secrets, and values under credential-like keys are masked.
import { redact, type LogRecord } from "./log.js";

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
  /^(mcc|mcct|mcrt|mcv|mcsk)_[A-Za-z0-9_-]{8,}$/,
  /^Bearer\s+\S+$/i,
  /^Basic\s+\S+$/i,
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Platform IDs such as `evt_<uuid>`: identifiers, not credentials. */
const PREFIXED_UUID = /^[a-z]{2,10}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a string looks like a credential: a known token shape, or a long opaque mix of letters and digits. */
export function looksSecret(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (SECRET_SHAPES.some((shape) => shape.test(text))) return true;
  if (UUID.test(text) || PREFIXED_UUID.test(text)) return false;
  return text.length >= 32 && /^[A-Za-z0-9_-]+={0,2}$/.test(text) && /[0-9]/.test(text) && /[A-Za-z]/.test(text);
}

/** Hosts whose webhook URLs carry their credential in the path after the first segment (Slack: /services/T…/B…/<secret>). */
const WEBHOOK_PATH_HOSTS = /^hooks\.slack(-gov)?\.com$/i;

/** A URL with its query values, user information, and secret-looking path segments masked; non-URLs pass through unless they look secret. */
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
  // Webhook URLs (Slack, Discord, ...) carry their credential in the path.
  const path = WEBHOOK_PATH_HOSTS.test(url.hostname)
    ? url.pathname
        .split("/")
        .map((segment, index) => (index >= 2 && segment ? REDACTED : segment))
        .join("/")
    : maskSegments(url.pathname);
  if (path !== url.pathname) url.pathname = path;
  if (url.search) {
    const masked = new URLSearchParams();
    for (const key of url.searchParams.keys()) if (!masked.has(key)) masked.set(key, "***");
    url.search = masked.toString();
  }
  return url.toString();
}

/** A URL path with secret-looking segments and query values masked (paths of blocked requests, for example). */
export function redactPath(value: string): string {
  const cut = value.search(/[?#]/);
  const path = maskSegments(cut < 0 ? value : value.slice(0, cut));
  if (cut < 0 || value[cut] !== "?") return path;
  const query = value.slice(cut + 1).replace(/#.*$/s, "");
  const keys = [...new Set(new URLSearchParams(query).keys())];
  return keys.length > 0 ? `${path}?${keys.map((key) => `${encodeURIComponent(key)}=***`).join("&")}` : path;
}

function maskSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      const decoded = decodeSegment(segment);
      // `bot<id>:<token>` and `<user>:<token>` segments hide the credential behind a colon.
      return secretSegment(decoded) || decoded.split(":").some(secretSegment) ? REDACTED : segment;
    })
    .join("/");
}

/**
 * Whether a URL path segment is a credential. Keys in paths are often shorter than the 32 characters `looksSecret`
 * asks of free text, so a 20+ character opaque mix of upper case, lower case, and digits counts too (UUIDs and hex
 * digests, which have no upper case, do not).
 */
function secretSegment(text: string): boolean {
  if (looksSecret(text)) return true;
  return text.length >= 20 && /^[A-Za-z0-9_-]+$/.test(text) && /[A-Z]/.test(text) && /[a-z]/.test(text) && /[0-9]/.test(text);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Marks where a command's output starts inside an error message (sandbox setup failures). */
export const OUTPUT_TAIL_MARKER = "\nLast output:\n";

// Linear-time patterns only: these run over text clients and runtimes supply. The scheme is bounded, and user info may
// hold quotes (`postgresql://alice:it's@db/…`), which end a URL anywhere else.
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]{0,31}:\/\/(?:[^\s"<>`/@]*@)?[^\s"'<>`]+/gi;
const WORD_IN_TEXT = /[A-Za-z0-9_\-.~+]{16,}={0,2}/g;
/** Punctuation that ends a sentence after a URL, and that surrounds a token without being part of it. */
const AFTER_URL = ").,;:!?]";
const AROUND_TOKEN = ".~+-";

/**
 * Free text (error messages, reasons, log lines) as operators may see it: URLs redacted as by `redactUrl`, token-shaped
 * words masked, and the command output a message carries (setup failures) left out: that is the owner's to see.
 */
export function redactText(text: string): string {
  const cut = text.indexOf(OUTPUT_TAIL_MARKER);
  const visible = cut < 0 ? text : `${text.slice(0, cut)}\n(Command output is not shown to operators.)`;
  return visible
    .replace(URL_IN_TEXT, (match) => {
      let end = match.length;
      while (end > 0 && AFTER_URL.includes(match[end - 1]!)) end--;
      return `${redactUrl(match.slice(0, end))}${match.slice(end)}`;
    })
    .replace(WORD_IN_TEXT, (word) => {
      // A sentence's final period or a leading dash is not part of the token (index scans keep this linear).
      let start = 0;
      while (start < word.length && AROUND_TOKEN.includes(word[start]!)) start++;
      let end = word.length;
      while (end > start && AROUND_TOKEN.includes(word[end - 1]!)) end--;
      return looksSecret(word) || looksSecret(word.slice(start, end)) ? `${word.slice(0, start)}${REDACTED}${word.slice(end)}` : word;
    });
}

/** A log entry as operators see it: its message and every text field passed through `redactText`. */
export function redactLogRecord(record: LogRecord): LogRecord {
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return redactText(value);
    if (depth > 8 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, walk(item, depth + 1)]));
  };
  return { ...record, message: redactText(record.message), ...(record.fields ? { fields: walk(record.fields, 0) as Record<string, unknown> } : {}) };
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
 * A free-form value with token-shaped strings masked anywhere, credentials inside strings (URLs with user info or
 * query values, `DATABASE_URL=postgres://user:pass@…`) masked as by `redactText`, and, unless `keys` is false, values
 * under credential-like keys masked too (the logger's rules). Pass `keys: false` for JSON schemas, whose keys are
 * property names rather than secrets.
 */
export function redactValue(value: unknown, options: { readonly keys?: boolean } = {}): unknown {
  const masked = options.keys === false ? value : redact(value);
  const walk = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") return looksSecret(item) ? REDACTED : redactText(item);
    if (depth > 12 || item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map((entry) => walk(entry, depth + 1));
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, entry]) => [key, walk(entry, depth + 1)]));
  };
  return walk(masked, 0);
}
