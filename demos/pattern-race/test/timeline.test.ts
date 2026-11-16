import { describe, expect, it } from "vitest";
import { axisFor, cpuSeries, memorySeries, segments, usageStart } from "../src/shared/timeline.js";

describe("the race timeline", () => {
  it("picks a round axis that fits the race", () => {
    expect([axisFor(3_000), axisFor(42_000), axisFor(95_000), axisFor(400_000)]).toEqual([
      { span: 10_000, step: 10_000 },
      { span: 50_000, step: 10_000 },
      { span: 120_000, step: 30_000 },
      { span: 420_000, step: 60_000 },
    ]);
  });

  it("runs each phase until the next, the lane's end, or now", () => {
    const timeline = [
      { at: 0, kind: "starting" as const, label: "Starting its sandbox" },
      { at: 6_000, kind: "thinking" as const, label: "Thinking" },
      { at: 9_000, kind: "command" as const, label: "$ python3 hash.py" },
    ];
    expect(segments(timeline, 12_000).map(({ from, to, phase }) => [from, to, phase.kind])).toEqual([
      [0, 6_000, "starting"],
      [6_000, 9_000, "thinking"],
      [9_000, 12_000, "command"],
    ]);
    // A phase that began after the lane ended isn't drawn.
    expect(segments(timeline, 7_000).map((segment) => segment.phase.kind)).toEqual(["starting", "thinking"]);
  });

  it("turns cumulative CPU time into the vCPUs busy between readings, from the first sandbox's start", () => {
    const samples = [
      { at: 3_000, cpuMs: 1_500, memoryBytes: 100 },
      { at: 5_000, cpuMs: 5_500, memoryBytes: 300 },
      { at: 5_000, cpuMs: 5_500, memoryBytes: 300 },
      { at: 7_000, cpuMs: 5_700, memoryBytes: 0 },
    ];
    expect(usageStart({ sandboxes: [{ id: "b", kind: "worker", name: "b", state: "idle", environment: "coder", appearedAt: 2_000 }, { id: "a", kind: "own", name: "a", state: "idle", environment: "coder", appearedAt: 1_000 }] })).toBe(1_000);
    expect(cpuSeries(samples, 1_000)).toEqual([
      { at: 3_000, value: 0.75 },
      { at: 5_000, value: 2 },
      { at: 7_000, value: 0.1 },
    ]);
    expect(memorySeries(samples).map((point) => point.value)).toEqual([100, 300, 300, 0]);
  });
});
