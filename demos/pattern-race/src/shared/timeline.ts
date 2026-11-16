/** The race timeline's math: its time axis and each lane's usage series. Shared by the page and tests. */
import type { LaneRun, Phase, UsageSample } from "./types.js";

export interface Axis {
  /** The axis length in milliseconds from the race's start: a whole number of steps. */
  readonly span: number;
  /** The distance between tick marks. */
  readonly step: number;
}

/** A time axis that fits `elapsed` with round ticks: 10 s steps up to a minute, then 30 s, 1 min, and 5 min. */
export function axisFor(elapsed: number): Axis {
  const ms = Math.max(10_000, elapsed);
  const step = ms <= 60_000 ? 10_000 : ms <= 180_000 ? 30_000 : ms <= 600_000 ? 60_000 : 300_000;
  return { span: Math.ceil(ms / step) * step, step };
}

export interface Segment {
  readonly from: number;
  readonly to: number;
  readonly phase: Phase;
}

/** Each phase from when it began until the next one, the lane's end, or `now`. */
export function segments(timeline: readonly Phase[], end: number): Segment[] {
  return timeline
    .map((phase, index) => ({ from: phase.at, to: Math.max(phase.at, Math.min(timeline[index + 1]?.at ?? end, end)), phase }))
    .filter((segment) => segment.to > segment.from);
}

export interface Point {
  readonly at: number;
  readonly value: number;
}

/** When its sandboxes began counting: the first one's appearance. */
export function usageStart(lane: Pick<LaneRun, "sandboxes">): number | undefined {
  const starts = lane.sandboxes.map((token) => token.appearedAt).filter((at): at is number => at !== undefined);
  return starts.length ? Math.min(...starts) : undefined;
}

/** vCPUs its sandboxes kept busy between readings: the CPU time they used over the time that passed. */
export function cpuSeries(samples: readonly UsageSample[], from: number): Point[] {
  const points: Point[] = [];
  let previous = { at: from, cpuMs: 0 };
  for (const sample of samples) {
    const elapsed = sample.at - previous.at;
    if (elapsed <= 0) continue;
    points.push({ at: sample.at, value: Math.max(0, (sample.cpuMs - previous.cpuMs) / elapsed) });
    previous = sample;
  }
  return points;
}

/** Memory its live sandboxes held at each reading. */
export function memorySeries(samples: readonly UsageSample[]): Point[] {
  return samples.map((sample) => ({ at: sample.at, value: sample.memoryBytes }));
}
