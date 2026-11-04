import type { AttentionItem, TrafficCounter, TrafficSeries } from "@managed-copilot/protocol/operator";

export const TRAFFIC_COUNTERS: Readonly<Record<TrafficCounter, { readonly label: string; readonly unit: string; readonly description: string }>> = {
  "http.requests": { label: "HTTP requests", unit: "request", description: "Requests the gateway answered." },
  "http.errors": { label: "HTTP 5xx", unit: "error", description: "Requests that failed with a server error." },
  "rpc.requests": { label: "RPC requests", unit: "request", description: "JSON-RPC requests from connected clients." },
  "rpc.notifications": { label: "RPC notifications", unit: "notification", description: "Notifications (session events) sent to clients." },
  "connections.opened": { label: "Connections opened", unit: "connection", description: "SDK and Copilot CLI connections opened." },
  "sessions.created": { label: "Sessions created", unit: "session", description: "New sessions of every owner." },
  "events.published": { label: "Platform events", unit: "event", description: "Platform events published to subscribers." },
  "inference.requests": { label: "Sandbox inference requests", unit: "request", description: "Model requests from sandboxed runtimes." },
};

/** Display order of the traffic charts. */
export const TRAFFIC_ORDER: readonly TrafficCounter[] = [
  "http.requests",
  "http.errors",
  "rpc.requests",
  "rpc.notifications",
  "connections.opened",
  "sessions.created",
  "events.published",
  "inference.requests",
];

const MINUTE = 60_000;

/**
 * Start of the minute a bucket covers. Buckets run oldest first and the last one is the minute `generatedAt` falls in.
 */
export function bucketStart(generatedAt: string | number, index: number, count: number): number {
  const reference = typeof generatedAt === "number" ? generatedAt : Date.parse(generatedAt);
  const base = Number.isNaN(reference) ? Date.now() : reference;
  const currentMinute = Math.floor(base / MINUTE) * MINUTE;
  return currentMinute - (count - 1 - index) * MINUTE;
}

export interface SeriesStats {
  readonly peak: number;
  readonly peakIndex: number;
  readonly latest: number;
}

export function seriesStats(series: TrafficSeries): SeriesStats {
  let peak = 0;
  let peakIndex = -1;
  series.perMinute.forEach((value, index) => {
    if (value > peak) {
      peak = value;
      peakIndex = index;
    }
  });
  return { peak, peakIndex, latest: series.perMinute[series.perMinute.length - 1] ?? 0 };
}

/**
 * SVG path data for a sparkline over `values` in a `width`×`height` box: the line, and the same line closed along the
 * bottom edge for the area fill. A flat zero series sits on the baseline.
 */
export function sparklinePaths(values: readonly number[], width: number, height: number, padding = 1.5): { readonly line: string; readonly area: string } {
  if (values.length === 0) return { line: "", area: "" };
  const max = Math.max(...values, 0);
  const usable = height - padding * 2;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((value, index) => {
    const x = values.length > 1 ? index * step : width / 2;
    const y = max > 0 ? padding + usable - (Math.max(0, value) / max) * usable : height - padding;
    return [round(x), round(y)] as const;
  });
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`).join(" ");
  const first = points[0];
  const last = points[points.length - 1];
  const area = first && last ? `${line} L${last[0]} ${height} L${first[0]} ${height} Z` : "";
  return { line, area };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const SEVERITY_RANK: Readonly<Record<AttentionItem["severity"], number>> = { error: 0, warning: 1, info: 2 };

/** Errors first, then warnings, then info; newest first within a severity. */
export function sortAttention(items: readonly AttentionItem[]): AttentionItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const severity = (SEVERITY_RANK[a.item.severity] ?? 3) - (SEVERITY_RANK[b.item.severity] ?? 3);
      if (severity !== 0) return severity;
      const at = (b.item.at ? Date.parse(b.item.at) || 0 : 0) - (a.item.at ? Date.parse(a.item.at) || 0 : 0);
      return at !== 0 ? at : a.index - b.index;
    })
    .map(({ item }) => item);
}
