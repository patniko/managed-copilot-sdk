/** What a race's lanes add up to: shared by the page, the happy-path script, and tests. */
import { laneById } from "./lanes.js";
import type { LaneRun, RaceSnapshot, SandboxToken } from "./types.js";

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

/**
 * Sum of a measurement over the sandboxes that reported it; undefined with no sandbox (its brain used the shared
 * runtime, which every shared session shares: see the race's `runtime`) or none reported yet.
 */
function sandboxSum(lane: Pick<LaneRun, "sandboxes">, read: (token: SandboxToken) => number | undefined): number | undefined {
  if (lane.sandboxes.length === 0) return undefined;
  const values = lane.sandboxes.map(read).filter((value): value is number => value !== undefined);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

/** CPU time its sandboxes used, in milliseconds (work on the shared runtime isn't counted here: it's shared). */
export function cpuMs(lane: Pick<LaneRun, "sandboxes">): number | undefined {
  return sandboxSum(lane, (token) => token.usage?.cpuMs);
}

/** Memory its sandboxes held: the sum of each one's peak, in bytes. */
export function peakMemoryBytes(lane: Pick<LaneRun, "sandboxes">): number | undefined {
  return sandboxSum(lane, (token) => token.usage?.peakMemoryBytes);
}

/** Whether some of its sandboxes went unmeasured (deleted before a reading, or not measurable here). */
export function partlyMeasured(lane: Pick<LaneRun, "sandboxes">): boolean {
  const measured = lane.sandboxes.filter((token) => token.usage).length;
  return measured > 0 && measured < lane.sandboxes.length;
}

/** The vCPUs it held, times how long it held them: what sandboxes cost while they exist, busy or not. */
export function reservedCpuSeconds(lane: Pick<LaneRun, "sandboxes">, now: number): number {
  return lane.sandboxes.reduce((sum, token) => (token.cpus === undefined || token.appearedAt === undefined ? sum : sum + (token.cpus * Math.max(0, (token.endedAt ?? now) - token.appearedAt)) / 1000), 0);
}

/** How long it had a sandbox starting: wall-clock time, with sandboxes that started together counted once. */
export function sandboxWaitMs(lane: Pick<LaneRun, "sandboxes">, now: number): number {
  const spans = lane.sandboxes
    .filter((token) => token.appearedAt !== undefined)
    .map((token) => [token.appearedAt!, token.readyAt ?? token.endedAt ?? now] as const)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of spans) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

/**
 * The lanes whose brain thought on the shared runtime during the race, by name: every lane that raced except those
 * that started in a sandbox; a promotable lane that moved is there "until it moved".
 */
export function runtimeBrains(race: Pick<RaceSnapshot, "lanes">): string[] {
  return race.lanes
    .filter((lane) => lane.status !== "skipped" && lane.status !== "ready" && laneById(lane.lane).brain === "runtime")
    .map((lane) => `${laneById(lane.lane).pattern}${lane.brain === "sandbox" ? " (until it moved)" : ""}`);
}

/** Tokens its own session used: input and output (sub-agents included; workers' aren't visible). */
export function tokenCount(lane: Pick<LaneRun, "tokens">): number {
  return (lane.tokens?.input ?? 0) + (lane.tokens?.output ?? 0);
}

/** Whether it had workers, whose own sessions' tokens the race can't see. */
export function hasWorkers(lane: Pick<LaneRun, "sandboxes">): boolean {
  return lane.sandboxes.some((token) => token.kind === "worker");
}

export interface Bests {
  readonly time?: number;
  readonly sandboxes?: number;
  readonly requests?: number;
  readonly cpu?: number;
  readonly memory?: number;
  readonly tokens?: number;
}

/** The best value of each measure among lanes that answered correctly (fastest, fewest, least). */
export function bests(race: RaceSnapshot): Bests {
  const correct = race.lanes.filter((lane) => lane.verdict === "correct");
  if (correct.length === 0) return {};
  const least = (values: readonly (number | undefined)[]) => {
    const known = values.filter((value): value is number => value !== undefined);
    return known.length ? Math.min(...known) : undefined;
  };
  const cpu = least(correct.map(cpuMs));
  const memory = least(correct.map(peakMemoryBytes));
  const tokens = least(correct.filter((lane) => lane.tokens).map(tokenCount));
  return {
    time: Math.min(...correct.map((lane) => elapsedMs(race, lane, lane.finishedAt ?? race.startedAt) ?? Infinity)),
    sandboxes: Math.min(...correct.map(sandboxCount)),
    requests: Math.min(...correct.map(premiumRequests)),
    ...(cpu !== undefined ? { cpu } : {}),
    ...(memory !== undefined ? { memory } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
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

/** A short span of time: `0.4 s`, `12.3 s`, `2 min 05 s`. */
export function formatSeconds(ms: number): string {
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}

/** Memory: `512 MiB`, `1.4 GiB`. */
export function formatBytes(bytes: number): string {
  const mib = bytes / 1024 ** 2;
  if (mib < 1024) return `${Math.round(mib)} MiB`;
  return `${(Math.round((mib / 1024) * 10) / 10).toFixed(1)} GiB`;
}

/** Token counts: `980`, `12.3k`, `1.2M`. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${Math.round(count / 100) / 10}k`;
  return `${Math.round(count / 100_000) / 10}M`;
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
