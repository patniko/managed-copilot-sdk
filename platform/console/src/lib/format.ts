import type { NetworkPolicy, SandboxSize } from "@managed-copilot/protocol";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const NUMBER = new Intl.NumberFormat("en-US");

export function parseTime(value: string | number | undefined | null): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

/**
 * Relative time: "just now", "12s ago", "3 min ago", "2 h ago", "4 d ago", "in 12s", "in 3 min". Beyond 30 days it
 * falls back to a date. Differences under a second (or a hair in the future, from clock skew) read "just now".
 */
export function formatRelative(value: string | number | undefined | null, now: number): string {
  const time = parseTime(value);
  if (time === undefined) return "";
  const diff = time - now;
  if (diff > -SECOND && diff < 2 * SECOND) return "just now";
  const abs = Math.abs(diff);
  let text: string;
  if (abs < MINUTE) text = `${Math.floor(abs / SECOND)}s`;
  else if (abs < HOUR) text = `${Math.floor(abs / MINUTE)} min`;
  else if (abs < DAY) text = `${Math.floor(abs / HOUR)} h`;
  else if (abs < 30 * DAY) text = `${Math.floor(abs / DAY)} d`;
  else return formatDate(time);
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

/** Canonical ISO-8601 timestamp for titles and tooltips. */
export function formatIso(value: string | number | undefined | null): string {
  const time = parseTime(value);
  return time === undefined ? "" : new Date(time).toISOString();
}

/** "Oct 3, 2026". */
export function formatDate(value: string | number): string {
  const time = parseTime(value);
  if (time === undefined) return "";
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "Oct 3, 2026, 14:03:27" (24-hour clock). */
export function formatDateTime(value: string | number | undefined | null): string {
  const time = parseTime(value);
  if (time === undefined) return "";
  return new Date(time).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

/** "14:03:27" (24-hour clock). */
export function formatClockTime(value: string | number | undefined | null): string {
  const time = parseTime(value);
  if (time === undefined) return "";
  return new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

/** "14:03" (24-hour clock). */
export function formatHourMinute(value: string | number | undefined | null): string {
  const time = parseTime(value);
  if (time === undefined) return "";
  return new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

const DURATION_UNITS: readonly (readonly [string, number])[] = [
  ["d", 86_400],
  ["h", 3_600],
  ["min", 60],
  ["s", 1],
];

/** Durations in seconds with two units at most: "42 s", "1 min 30 s", "2 h 14 min", "3 d 4 h". */
export function formatDuration(seconds: number | undefined | null): string {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds < 0) return "";
  let rest = Math.floor(seconds);
  if (rest < 60) return `${rest} s`;
  const parts: string[] = [];
  for (const [unit, size] of DURATION_UNITS) {
    if (parts.length === 0 && rest < size) continue;
    const amount = Math.floor(rest / size);
    rest -= amount * size;
    if (parts.length === 0) parts.push(`${amount} ${unit}`);
    else {
      if (amount > 0) parts.push(`${amount} ${unit}`);
      break;
    }
  }
  return parts.join(" ");
}

/** Short spans in milliseconds: "0.4 ms", "12 ms", "1.5 s", "2 min". */
export function formatMilliseconds(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10) return `${trimZero(ms.toFixed(1))} ms`;
  if (ms < SECOND) return `${Math.round(ms)} ms`;
  if (ms < MINUTE) return `${trimZero((ms / SECOND).toFixed(ms < 10 * SECOND ? 1 : 0))} s`;
  return formatDuration(ms / SECOND);
}

function trimZero(text: string): string {
  return text.replace(/\.0+$/, "");
}

const BYTE_UNITS = ["KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** "0 B", "512 B", "1.5 KiB", "12 MiB", "1.2 GiB". */
export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value < 10 ? trimZero(value.toFixed(1)) : String(Math.round(value));
  return `${text} ${BYTE_UNITS[unit]}`;
}

/** 12345 → "12,345". */
export function formatNumber(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "";
  return NUMBER.format(value);
}

/** 950 → "950", 12_400 → "12.4k", 3_200_000 → "3.2M". */
export function formatCompact(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs < 1000) return String(value);
  if (abs < 1_000_000) return `${trimZero((value / 1000).toFixed(abs < 100_000 ? 1 : 0))}k`;
  return `${trimZero((value / 1_000_000).toFixed(1))}M`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}

/**
 * Short form of an identifier: its first 8 characters, keeping a readable type prefix (`sbx_`, `act_`, `conn_`) in
 * front of them. Callers always offer the full ID (title, copy button).
 */
export function shortId(id: string | undefined | null, length = 8): string {
  if (!id) return "";
  const prefixed = /^([a-z][a-z0-9]{0,7}_)(.+)$/i.exec(id);
  if (prefixed) {
    const prefix = prefixed[1] ?? "";
    const rest = prefixed[2] ?? "";
    return rest.length > length ? `${prefix}${rest.slice(0, length)}` : id;
  }
  return id.length > length ? id.slice(0, length) : id;
}

/** "needs_reconciliation" → "Needs reconciliation"; "run_started" → "Run started". */
export function humanize(value: string | undefined | null): string {
  if (!value) return "";
  const words = value.replace(/[._-]+/g, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : value;
}

/** Two-letter initials for avatar fallbacks. */
export function initials(name: string | undefined | null): string {
  const words = (name ?? "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .split(/[\s_-]+/)
    .filter(Boolean);
  const first = words[0]?.[0] ?? "?";
  const second = words.length > 1 ? (words[1]?.[0] ?? "") : (words[0]?.[1] ?? "");
  return `${first}${second}`.toUpperCase();
}

/**
 * Avatar URLs the console may load: GitHub avatars (the only image host the gateway's Content-Security-Policy
 * allows) and inline data images. Anything else falls back to initials.
 */
export function safeAvatarUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  if (/^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "avatars.githubusercontent.com" && !parsed.username && !parsed.password
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Only absolute http(s) URLs become links; everything else renders as text. */
export function safeExternalUrl(href: string | undefined | null): string | undefined {
  if (!href) return undefined;
  try {
    const parsed = new URL(href);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export type NetworkKind = "enabled" | "restricted" | "disabled";

export interface NetworkSummary {
  readonly kind: NetworkKind;
  /** "Enabled", "Restricted to 3 hosts", "Disabled". */
  readonly label: string;
  readonly description: string;
  readonly hosts: readonly string[];
}

export function summarizeNetwork(policy: NetworkPolicy | undefined | null): NetworkSummary | undefined {
  if (!policy) return undefined;
  switch (policy.access) {
    case "enabled":
      return { kind: "enabled", label: "Enabled", description: "Public outbound access; platform protections still apply.", hosts: [] };
    case "disabled":
      return { kind: "disabled", label: "Disabled", description: "No outbound network access.", hosts: [] };
    case "restricted": {
      const hosts = policy.allowedDomains ?? [];
      return hosts.length === 0
        ? { kind: "disabled", label: "Disabled", description: "Restricted to no hosts: no outbound network access.", hosts }
        : { kind: "restricted", label: `Restricted to ${pluralize(hosts.length, "host")}`, description: "Outbound access is limited to these hosts.", hosts };
    }
    default:
      return { kind: "disabled", label: humanize(String((policy as { access?: unknown }).access ?? "unknown")), description: "Unrecognized network policy.", hosts: [] };
  }
}

/** "512 MiB", "4 GiB", "1.5 GiB". */
export function formatMemoryMiB(memoryMiB: number): string {
  if (memoryMiB < 1024) return `${memoryMiB} MiB`;
  const gib = memoryMiB / 1024;
  return `${Number.isInteger(gib) ? gib : trimZero(gib.toFixed(1))} GiB`;
}

/** "2 vCPU · 4 GiB". */
export function formatResources(resources: { readonly cpus: number; readonly memoryMiB: number } | undefined): string {
  if (!resources) return "";
  return `${resources.cpus} vCPU · ${formatMemoryMiB(resources.memoryMiB)}`;
}

/** "medium · 2 vCPU · 4 GiB". */
export function formatSize(size: SandboxSize | undefined, resources?: { readonly cpus: number; readonly memoryMiB: number }): string {
  const parts = [size ? String(size) : "", formatResources(resources)].filter(Boolean);
  return parts.join(" · ");
}

/** A compact, single-line rendering of an arbitrary JSON value (event data, options). */
export function formatValue(value: unknown, maxLength = 160): string {
  let text: string;
  if (value === null) text = "null";
  else if (value === undefined) text = "";
  else if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") text = String(value);
  else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = String(value);
    }
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Pretty JSON for expandable blocks; never throws. */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

/** Whether `value` is a non-empty string that names the same entity case-insensitively as `other`. */
export function sameLogin(value: string | undefined, other: string | undefined): boolean {
  return Boolean(value && other && value.toLowerCase() === other.toLowerCase());
}
