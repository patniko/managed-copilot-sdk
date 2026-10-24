import { SANDBOX_SIZES } from "../../shared/environments.js";
import type { NetworkView } from "../../shared/types.js";

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
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} days ago`;
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Compact human duration: "420 ms", "4.2s", "38s", "4m 05s", "1h 04m". */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  const value = Math.max(0, ms);
  if (value < SECOND) return `${Math.round(value)} ms`;
  if (value < 10 * SECOND) return `${(Math.floor(value / 100) / 10).toFixed(1)}s`;
  if (value < MINUTE) return `${Math.floor(value / SECOND)}s`;
  const totalSeconds = Math.floor(value / SECOND);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Stopwatch style: "0:42", "12:05", "1:04:09". */
export function formatClock(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  const totalSeconds = Math.max(0, Math.floor(ms / SECOND));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** 950 → "950", 12_400 → "12.4k", 3_200_000 → "3.2M". */
export function formatCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 100_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** 24-hour wall clock time with seconds: "14:03:27". */
export function formatTimeOfDay(iso: string | undefined): string {
  const time = parseTime(iso);
  if (time === undefined) return "";
  return new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** "Oct 23, 10:14 PM". */
export function formatDateTime(iso: string | undefined): string {
  const time = parseTime(iso);
  if (time === undefined) return "";
  return new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Full timestamp for tooltips. */
export function formatFullDateTime(iso: string | undefined): string {
  const time = parseTime(iso);
  if (time === undefined) return "";
  return new Date(time).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Milliseconds between two timestamps, or until `now` when the end is missing. */
export function elapsedBetween(startIso: string | undefined, endIso: string | undefined, now: number): number | undefined {
  const start = parseTime(startIso);
  if (start === undefined) return undefined;
  const end = parseTime(endIso) ?? now;
  return Math.max(0, end - start);
}

export type SandboxSize = keyof typeof SANDBOX_SIZES;

/** "small · 1 vCPU · 2 GiB" */
export function formatSandboxSize(size: SandboxSize | undefined): string {
  if (!size) return "";
  const spec = SANDBOX_SIZES[size] as (typeof SANDBOX_SIZES)[SandboxSize] | undefined;
  return spec ? `${size} · ${spec.cpus} vCPU · ${spec.memoryGiB} GiB` : size;
}

export interface NetworkSummary {
  readonly label: string;
  readonly description: string;
  readonly hosts: readonly string[];
  readonly kind: "off" | "restricted" | "open";
}

export function summarizeNetwork(network: NetworkView | undefined): NetworkSummary | undefined {
  if (!network) return undefined;
  if (network.access === "disabled") {
    return { label: "Network off", description: "No network access", hosts: [], kind: "off" };
  }
  if (network.access === "enabled") {
    return { label: "Open network", description: "Unrestricted outbound network access", hosts: [], kind: "open" };
  }
  const hosts = network.allowedDomains;
  return {
    label: hosts.length === 0 ? "Restricted" : pluralize(hosts.length, "host"),
    description: hosts.length === 0 ? "Restricted network with no allowed hosts" : "Outbound access limited to:",
    hosts,
    kind: "restricted",
  };
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Shortens long identifiers for chips: "sbx_01JB2Q7Z9X4K…" keeps its prefix and the first characters. */
export function shortId(id: string | undefined, keep = 8): string {
  if (!id) return "";
  const prefixed = /^([a-z]{2,8}[_-])(.+)$/i.exec(id);
  if (prefixed) {
    const [, prefix = "", rest = ""] = prefixed;
    return rest.length > keep + 2 ? `${prefix}${rest.slice(0, keep)}…` : id;
  }
  return id.length > keep + 2 ? `${id.slice(0, keep)}…` : id;
}

/** Shortens image digests: "ghcr.io/acme/sandbox@sha256:4f0c…9a1e". */
export function shortImage(image: string | undefined): string {
  if (!image) return "";
  return image.replace(/(sha256:)([0-9a-f]{12})[0-9a-f]{20,}/i, "$1$2…");
}

/** Splits text with `inline code` spans into parts for rendering. */
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
