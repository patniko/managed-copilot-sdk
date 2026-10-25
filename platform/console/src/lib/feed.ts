import type { OperatorEvent, OperatorLogEntry, OperatorLogLevel } from "@managed-copilot/protocol/operator";

/** Platform events: dedupe by ID, oldest first, newest `cap` kept. */
export function mergeEvents(lists: readonly (readonly OperatorEvent[])[], cap: number): OperatorEvent[] {
  const byId = new Map<string, { readonly event: OperatorEvent; readonly order: number }>();
  let order = 0;
  for (const list of lists) {
    for (const event of list) {
      if (!byId.has(event.id)) byId.set(event.id, { event, order: order++ });
    }
  }
  const merged = [...byId.values()].sort((a, b) => {
    const diff = timeOf(a.event.createdAt) - timeOf(b.event.createdAt);
    return diff !== 0 ? diff : a.order - b.order;
  });
  return merged.slice(Math.max(0, merged.length - cap)).map((item) => item.event);
}

/** Log entries: dedupe by sequence number, in sequence order, newest `cap` kept. */
export function mergeLogs(lists: readonly (readonly OperatorLogEntry[])[], cap: number): OperatorLogEntry[] {
  const bySeq = new Map<number, OperatorLogEntry>();
  for (const list of lists) for (const entry of list) if (!bySeq.has(entry.seq)) bySeq.set(entry.seq, entry);
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return merged.slice(Math.max(0, merged.length - cap));
}

function timeOf(iso: string): number {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? 0 : time;
}

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const satisfies readonly OperatorLogLevel[];

const LEVEL_RANK: Readonly<Record<OperatorLogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Whether an entry is at or above the minimum level (unknown levels always show). */
export function atLeastLevel(level: string, minimum: OperatorLogLevel | undefined): boolean {
  if (!minimum) return true;
  const rank = LEVEL_RANK[level as OperatorLogLevel];
  return rank === undefined || rank >= LEVEL_RANK[minimum];
}

export function isLogLevel(value: string | undefined): value is OperatorLogLevel {
  return value !== undefined && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Case-insensitive search over a log entry's message, logger, and fields. */
export function logMatches(entry: OperatorLogEntry, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  if (entry.message.toLowerCase().includes(needle) || entry.logger.toLowerCase().includes(needle)) return true;
  if (!entry.fields) return false;
  try {
    return JSON.stringify(entry.fields).toLowerCase().includes(needle);
  } catch {
    return false;
  }
}

export function isOperatorEvent(value: unknown): value is OperatorEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["id"] === "string" && typeof record["type"] === "string" && typeof record["createdAt"] === "string";
}

export function isOperatorLogEntry(value: unknown): value is OperatorLogEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["seq"] === "number" && typeof record["level"] === "string" && typeof record["message"] === "string";
}
