import { describe, expect, it } from "vitest";
import {
  agentCount,
  bests,
  cpuMs,
  elapsedMs,
  formatBytes,
  formatClock,
  formatCount,
  formatSeconds,
  formatTokens,
  ordinal,
  partlyMeasured,
  peakMemoryBytes,
  plural,
  premiumRequests,
  reservedCpuSeconds,
  sandboxCount,
  sandboxWaitMs,
  tokenCount,
} from "../src/shared/score.js";
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

  it("adds up what a lane's sandboxes used, and says when some went unmeasured", () => {
    const used = (id: string, cpuMs: number, peakMemoryBytes: number) => ({ ...token("worker", id), usage: { cpuMs, peakMemoryBytes } });
    const delegate = run({ lane: "delegate", sandboxes: [used("a", 4_000, 300), used("b", 1_500, 200)] });
    expect([cpuMs(delegate), peakMemoryBytes(delegate), partlyMeasured(delegate)]).toEqual([5_500, 500, false]);
    const partly = run({ lane: "mixed", sandboxes: [used("a", 4_000, 300), token("hands", "h")] });
    expect([cpuMs(partly), partlyMeasured(partly)]).toEqual([4_000, true]);
    // No sandbox: nothing to measure, so nothing used; sandboxes not read yet: unknown.
    expect([cpuMs(run({ lane: "shared" })), cpuMs(run({ lane: "direct", sandboxes: [token("hands", "h")] }))]).toEqual([0, undefined]);
  });

  it("counts the vCPUs held over each sandbox's life, and the time spent waiting for sandboxes once", () => {
    const held = (id: string, appearedAt: number, readyAt: number | undefined, endedAt?: number) => ({ ...token("worker", id), cpus: 2, appearedAt, ...(readyAt !== undefined ? { readyAt } : {}), ...(endedAt !== undefined ? { endedAt } : {}) });
    // Two workers asked for together and one later: their start-ups overlap, so the wait counts once where they do.
    const lane = run({ lane: "delegate", sandboxes: [held("a", 1_000, 6_000, 11_000), held("b", 2_000, 7_000, 12_000), held("c", 20_000, undefined)] });
    expect(sandboxWaitMs(lane, 23_000)).toBe(6_000 + 3_000);
    expect(reservedCpuSeconds(lane, 23_000)).toBe(2 * 10 + 2 * 10 + 2 * 3);
  });

  it("counts a lane's input and output tokens, and ranks the lightest correct lanes", () => {
    const tokens = { input: 9_000, output: 400, cacheRead: 8_000, cacheWrite: 0 };
    expect(tokenCount(run({ lane: "shared", tokens }))).toBe(9_400);
    expect(tokenCount(run({ lane: "shared" }))).toBe(0);
    const race: RaceSnapshot = {
      id: "r",
      job: "answer",
      model: "m",
      expected: [],
      startedAt: 0,
      state: "finished",
      lanes: [
        run({ lane: "shared", verdict: "correct", finishedAt: 2_000, tokens }),
        run({ lane: "isolated", verdict: "correct", finishedAt: 6_000, tokens: { ...tokens, input: 20_000 }, sandboxes: [{ ...token("own", "s"), usage: { cpuMs: 3_000, peakMemoryBytes: 400 } }] }),
      ],
    };
    expect(bests(race)).toMatchObject({ cpu: 0, memory: 0, tokens: 9_400 });
  });

  it("formats seconds, memory, and tokens", () => {
    expect([formatSeconds(420), formatSeconds(12_345), formatSeconds(125_000)]).toEqual(["0.4 s", "12.3 s", "2 min 05 s"]);
    expect([formatBytes(512 * 1024 ** 2), formatBytes(1.5 * 1024 ** 3)]).toEqual(["512 MiB", "1.5 GiB"]);
    expect([formatTokens(980), formatTokens(12_345), formatTokens(1_234_567)]).toEqual(["980", "12.3k", "1.2M"]);
  });

  it("formats a stopwatch, counts, and places", () => {
    expect([formatClock(undefined), formatClock(7_449), formatClock(75_000), formatClock(3_600_000)]).toEqual(["0:00.0", "0:07.4", "1:15.0", "60:00.0"]);
    expect([formatCount(1), formatCount(2.5), formatCount(1 / 3)]).toEqual(["1", "2.5", "0.33"]);
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd"]);
    expect([plural(1, "sandbox", "sandboxes"), plural(0, "sandbox", "sandboxes"), plural(1.5, "request", "requests")]).toEqual(["1 sandbox", "0 sandboxes", "1.5 requests"]);
  });
});
