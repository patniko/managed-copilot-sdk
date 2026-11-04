/** The first 8 characters of a session ID: enough to recognize it, short enough to read from across a room. */
export const shortId = (id: string): string => id.replace(/-/g, "").slice(0, 8);

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export const isNumeric = (value: string): boolean => NUMBER.test(value.trim());

const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** A computed number for reading: thousands separators, at most two decimals. Anything else is shown as is. */
export function formatCell(value: string): string {
  return isNumeric(value) ? grouped.format(Number(value)) : value;
}

export function formatCount(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** Premium requests can be fractional (model multipliers): whole numbers stay whole. */
export function formatRequests(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(value < 1 ? 2 : 1);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}

/** "7 s", "1 min 5 s". */
export function formatSeconds(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase() || "?";
}

/** A file's name without its folders. */
export const fileName = (path: string): string => path.split("/").at(-1) ?? path;
