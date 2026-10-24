import { describe, expect, it } from "vitest";
import { parseTestReport } from "../../src/web/lib/artifacts.js";
import { languageForFence, languageForPath, languageLabel, PLAIN } from "../../src/web/lib/highlight.js";

const REPORT = {
  schema: "factory.test-report/v1",
  mode: "task",
  taskId: "csv",
  command: "node --test",
  startedAt: "2026-01-01T00:00:00.000Z",
  durationMs: 120,
  exitCode: 1,
  summary: { total: 2, passed: 1, failed: 1, skipped: 0 },
  files: ["test/csv.test.js"],
  tests: [
    { name: "parses rows", file: "test/csv.test.js", status: "passed", durationMs: 2 },
    { name: "keeps quotes", file: "test/csv.test.js", status: "failed", error: "AssertionError: expected 'a'" },
  ],
};

describe("untrusted artifact content", () => {
  it("parses a well-formed test report", () => {
    const report = parseTestReport(JSON.stringify(REPORT));
    expect(report?.summary).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 });
    expect(report?.tests[1]).toEqual({ name: "keeps quotes", file: "test/csv.test.js", status: "failed", error: "AssertionError: expected 'a'" });
    expect(report?.taskId).toBe("csv");
  });

  it("only hands strings to the viewer", () => {
    const report = parseTestReport(
      JSON.stringify({
        ...REPORT,
        taskId: { id: "csv" },
        command: ["node"],
        output: 42,
        tests: [{ name: "case", status: "failed", file: { path: "x" }, durationMs: "2", error: { message: "failure" } }],
      }),
    );
    expect(report).toBeDefined();
    expect(report!.taskId).toBeUndefined();
    expect(report!.command).toBe("");
    expect(report!.output).toBeUndefined();
    const [test] = report!.tests;
    expect(test).toEqual({ name: "case", status: "failed", error: JSON.stringify({ message: "failure" }, null, 2) });
  });

  it("falls back to the raw viewer for reports it can't trust", () => {
    const bad = [
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...REPORT, summary: [] }),
      JSON.stringify({ ...REPORT, summary: { total: "2", passed: 1, failed: 1 } }),
      JSON.stringify({ ...REPORT, tests: {} }),
      JSON.stringify({ ...REPORT, tests: [{ name: "case", status: "exploded" }] }),
      JSON.stringify({ ...REPORT, tests: [{ name: { text: "case" }, status: "passed" }] }),
      JSON.stringify({ ...REPORT, tests: [null] }),
    ];
    for (const text of bad) expect(parseTestReport(text), text).toBeUndefined();
  });

  it("never resolves languages through the object prototype", () => {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(languageForFence(name)).toBe(PLAIN);
      expect(languageForPath(`src/file.${name}`)).toBe(PLAIN);
      expect(typeof languageLabel(name)).toBe("string");
    }
    expect(languageForFence("TS")).toBe("typescript");
    expect(languageForPath("src/cli.mjs")).toBe("javascript");
    expect(languageLabel("bash")).toBe("Shell");
  });
});
