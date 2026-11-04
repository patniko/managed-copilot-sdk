/** What a race's lanes add up to: shared by the page, the happy-path script, and tests. */
import type { LaneRun, RaceSnapshot } from "./types.js";

/** How long a lane took (or has taken, at `now`): from the start of the race to its answer. */
export function elapsedMs(race: Pick<RaceSnapshot, "startedAt">, lane: Pick<LaneRun, "finishedAt" | "status">, now: number): number | undefined {
  if (lane.status === "ready" || lane.status === "skipped") return undefined;
  return Math.max(0, (lane.finishedAt ?? now) - race.startedAt);
}

/** Sandboxes it had: its own, hands sandboxes, and workers' (a pending one is being created). */
export function sandboxCount(lane: Pick<LaneRun, "sandboxes">): number {
  return lane.sandboxes.length;
}

/** Agents (model loops) it ran: its own, its sub-agents, and its workers. */
export function agentCount(lane: Pick<LaneRun, "status" | "subagents" | "sandboxes">): number {
  if (lane.status === "ready" || lane.status === "skipped") return 0;
  return 1 + lane.subagents + lane.sandboxes.filter((token) => token.kind === "worker").length;
}

/** Premium requests it used: its own session's and its workers'. */
export function premiumRequests(lane: Pick<LaneRun, "premium">): number {
  return lane.premium.session + lane.premium.workers;
}

/** The best value of each measure among lanes that answered correctly (fastest, fewest sandboxes, fewest requests). */
export function bests(race: RaceSnapshot): { readonly time?: number; readonly sandboxes?: number; readonly requests?: number } {
  const correct = race.lanes.filter((lane) => lane.verdict === "correct");
  if (correct.length === 0) return {};
  return {
    time: Math.min(...correct.map((lane) => elapsedMs(race, lane, lane.finishedAt ?? race.startedAt) ?? Infinity)),
    sandboxes: Math.min(...correct.map(sandboxCount)),
    requests: Math.min(...correct.map(premiumRequests)),
  };
}

/** A stopwatch reading: `0:07.4`, `1:15.0`. */
export function formatClock(ms: number | undefined): string {
  if (ms === undefined) return "0:00.0";
  const tenths = Math.floor(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths % 10}`;
}

/** Premium requests can be fractional (model multipliers): at most two decimals, no trailing zeros. */
export function formatCount(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function ordinal(place: number): string {
  const tens = place % 100;
  if (tens >= 11 && tens <= 13) return `${place}th`;
  return `${place}${["th", "st", "nd", "rd"][place % 10] ?? "th"}`;
}

/** `1 sandbox`, `2 sandboxes`. */
export function plural(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}
