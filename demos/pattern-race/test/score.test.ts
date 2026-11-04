import { describe, expect, it } from "vitest";
import { agentCount, bests, elapsedMs, formatClock, formatCount, ordinal, plural, premiumRequests, sandboxCount } from "../src/shared/score.js";
import type { LaneRun, RaceSnapshot } from "../src/shared/types.js";

function run(fields: Partial<LaneRun> & Pick<LaneRun, "lane">): LaneRun {
  return { status: "done", brain: "runtime", subagents: 0, sandboxes: [], premium: { session: 1, workers: 0 }, modelCalls: 1, approvals: 0, ...fields };
}

const token = (kind: "own" | "hands" | "worker", id: string) => ({ id, kind, name: id, state: "idle" as const, environment: "coder" });

describe("score", () => {
  it("times lanes from the start of the race", () => {
    const race = { startedAt: 1_000 };
    expect(elapsedMs(race, run({ lane: "shared", finishedAt: 9_400 }), 50_000)).toBe(8_400);
    expect(elapsedMs(race, run({ lane: "shared", status: "working" }), 4_000)).toBe(3_000);
    expect(elapsedMs(race, run({ lane: "shared", status: "skipped" }), 4_000)).toBeUndefined();
  });

  it("counts agents and sandboxes: its own brain, sub-agents, workers, and every sandbox", () => {
    const delegate = run({ lane: "delegate", subagents: 0, sandboxes: [token("worker", "a"), token("worker", "b")] });
    const mixed = run({ lane: "mixed", subagents: 2, sandboxes: [token("hands", "h"), token("worker", "w")] });
    expect([agentCount(delegate), sandboxCount(delegate)]).toEqual([3, 2]);
    expect([agentCount(mixed), sandboxCount(mixed)]).toEqual([4, 2]);
    expect(agentCount(run({ lane: "shared", status: "skipped" }))).toBe(0);
    expect(premiumRequests(run({ lane: "delegate", premium: { session: 1, workers: 2.5 } }))).toBe(3.5);
  });

  it("finds the best values among correct lanes only", () => {
    const race: RaceSnapshot = {
      id: "r",
      job: "code",
      model: "m",
      expected: [],
      startedAt: 0,
      state: "finished",
      lanes: [
        run({ lane: "shared", verdict: "missed", finishedAt: 3_000 }),
        run({ lane: "direct", verdict: "correct", finishedAt: 9_000, sandboxes: [token("hands", "h")] }),
        run({ lane: "delegate", verdict: "correct", finishedAt: 20_000, sandboxes: [token("worker", "a"), token("worker", "b")], premium: { session: 1, workers: 2 } }),
      ],
    };
    expect(bests(race)).toEqual({ time: 9_000, sandboxes: 1, requests: 1 });
    expect(bests({ ...race, lanes: [race.lanes[0]!] })).toEqual({});
  });

  it("formats a stopwatch, counts, and places", () => {
    expect([formatClock(undefined), formatClock(7_449), formatClock(75_000), formatClock(3_600_000)]).toEqual(["0:00.0", "0:07.4", "1:15.0", "60:00.0"]);
    expect([formatCount(1), formatCount(2.5), formatCount(1 / 3)]).toEqual(["1", "2.5", "0.33"]);
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd"]);
    expect([plural(1, "sandbox", "sandboxes"), plural(0, "sandbox", "sandboxes"), plural(1.5, "request", "requests")]).toEqual(["1 sandbox", "0 sandboxes", "1.5 requests"]);
  });
});
