const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function parseTime(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? undefined : value;
}

/** "just now", "3 min ago", "2 hr ago", "yesterday", "Oct 3". */
export function formatRelative(iso: string | undefined, now: number): string {
  const time = parseTime(iso);
  if (time === undefined) return "";
  const diff = Math.max(0, now - time);
  if (diff < 45 * SECOND) return "just now";
  if (diff < HOUR) return `${Math.max(1, Math.floor(diff / MINUTE))} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} hr ago`;
  if (diff < 2 * DAY) return "yesterday";
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "10:46". */
export function formatClock(iso: string | undefined): string {
  const time = parseTime(iso);
  if (time === undefined) return "";
  return new Date(time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "0:42", "12:05", "1:02:09". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / SECOND));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

export function between(start: string | undefined, end: string | undefined, now: number): number {
  const a = parseTime(start);
  if (a === undefined) return 0;
  return Math.max(0, (parseTime(end) ?? now) - a);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "1 sandbox", "3 sandboxes". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function splitInlineCode(text: string): { readonly code: boolean; readonly text: string }[] {
  const parts: { code: boolean; text: string }[] = [];
  const pattern = /`([^`]+)`/g;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) parts.push({ code: false, text: text.slice(last, match.index) });
    parts.push({ code: true, text: match[1] ?? "" });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts;
}

export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .split(/[\s_-]+/)
    .filter(Boolean);
  const first = words[0]?.[0] ?? "?";
  const second = words.length > 1 ? (words[1]?.[0] ?? "") : (words[0]?.[1] ?? "");
  return `${first}${second}`.toUpperCase();
}

/** `sbx_9a42c1f07e3b…` → `sbx_9a42c1f0…`. */
export function shortId(id: string, keep = 12): string {
  return id.length > keep + 1 ? `${id.slice(0, keep)}…` : id;
}

/** One line of a longer text, for compact rows. */
export function oneLine(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
