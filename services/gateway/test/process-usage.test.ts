import { describe, expect, it } from "vitest";
import { parseProcStat, parseProcStatus, parsePs, parseWindows, readProcessUsage } from "../src/modules/core/process-usage.js";

describe("the shared runtime's process usage", () => {
  it("reads Linux /proc: user and system ticks, and the resident and peak sets", () => {
    // The command name can hold spaces and parentheses; fields count from after its closing one.
    const stat = "4242 (copilot (runtime)) S 1 4242 4242 0 -1 4194560 81223 0 12 0 1234 566 0 0 20 0 23 0 9871 1316802560 61234";
    expect(parseProcStat(stat, 100)).toBe(18_000);
    expect(parseProcStatus("Name:\tnode\nVmHWM:\t  412340 kB\nVmRSS:\t  298000 kB\n")).toEqual({ memoryBytes: 298_000 * 1024, peakMemoryBytes: 412_340 * 1024 });
    expect(parseProcStatus("Name:\tnode\n")).toBeUndefined();
  });

  it("reads macOS ps and the Windows probe", () => {
    expect(parsePs("  301234   1:02.50\n")).toEqual({ cpuMs: 62_500, memoryBytes: 301_234 * 1024 });
    expect(parsePs("1024 1-02:00:00")).toEqual({ cpuMs: (86_400 + 7_200) * 1000, memoryBytes: 1024 * 1024 });
    expect(parseWindows("15320 314572800 419430400\r\n")).toEqual({ cpuMs: 15_320, memoryBytes: 314_572_800, peakMemoryBytes: 419_430_400 });
    expect(parseWindows("")).toBeUndefined();
  });

  it("reads this test's own process on the platform it runs on", async () => {
    const usage = await readProcessUsage(process.pid);
    expect(usage?.cpuMs).toBeGreaterThan(0);
    expect(usage?.memoryBytes).toBeGreaterThan(1024 * 1024);
    expect(await readProcessUsage(-1)).toBeUndefined();
  });
});
