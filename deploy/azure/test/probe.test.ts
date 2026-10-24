import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runProbe } from "../src/probe/probe.js";

const entry = fileURLToPath(new URL("../src/probe/main.ts", import.meta.url));
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("storage probe", () => {
  it("passes every applicable check on a local disk and cleans up after itself", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mc-probe-"));
    cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
    const directory = join(parent, "run");
    const report = await runProbe({ directory, childCommand: [process.execPath, "--import", "tsx", entry] });

    const failed = report.checks.filter((check) => check.status === "failed");
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(report.result).toBe("passed");
    expect(report.checks.map((check) => check.name)).toEqual([
      "posix-metadata",
      "atomic-rename",
      "fsync",
      "lock-exclusion",
      "sqlite-wal",
      "sqlite-rollback",
      "sqlite-wal-concurrent-writers",
      "sqlite-wal-crash-recovery",
      "sqlite-rollback-crash-recovery",
    ]);
    if (process.platform !== "win32") expect(report.checks.every((check) => check.status === "passed")).toBe(true);
    expect(() => rmSync(directory)).toThrow(); // already removed by the probe
  }, 120_000);
});
