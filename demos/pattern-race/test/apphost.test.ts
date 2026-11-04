import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PATTERN_RACE_DEFAULT_PORT, patternRace } from "../apphost.mts";
import { JOBS } from "../src/shared/jobs.js";
import { LANES } from "../src/shared/lanes.js";

const root = readFileSync(fileURLToPath(new URL("../../../apphost.mts", import.meta.url)), "utf8");
/** An environment's declaration in the root AppHost: inline (one line, or a block closed at the same indent), or the top-level object it names. */
const declaration = (name: string) => {
  const reference = root.match(new RegExp(`^ +${name}: (\\w+),?$`, "m"))?.[1];
  const pattern = reference ? `^const ${reference} = \\{[\\s\\S]*?^\\};` : `^( +)${name}: \\{(?:[^\\n]*\\},?|[\\s\\S]*?\\n\\1\\},?)`;
  return root.match(new RegExp(pattern, "m"))?.[0];
};

describe("AppHost fragment", () => {
  it("describes the app the way the root AppHost expects", () => {
    expect(patternRace().app).toEqual({
      name: "pattern-race",
      workingDirectory: expect.stringMatching(/pattern-race$/),
      script: "dist/server/main.js",
      port: PATTERN_RACE_DEFAULT_PORT,
      healthPath: "/api/health",
    });
    expect(patternRace({ port: 9100 }).app.port).toBe(9100);
  });

  it("is wired into the root AppHost on its own port", () => {
    expect(root).toContain('from "./demos/pattern-race/apphost.mjs"');
    expect(root).toMatch(/patternRace: PATTERN_RACE_DEFAULT_PORT \+ offset/);
    expect(root).toMatch(/addDemo\(patternRace\(\{ port: ports\.patternRace \}\)\.app, \{ dockerfile: "demos\/pattern-race\/Dockerfile"/);
  });
});

describe("lanes", () => {
  it("race the six patterns, each in the root AppHost's environment for it", () => {
    expect(LANES.map((lane) => [lane.pattern, lane.environment])).toEqual([
      ["Shared", "chat"],
      ["Isolated", "coder"],
      ["Promotable", "helper"],
      ["Direct", "operator"],
      ["Delegate", "team"],
      ["Mixed", "lead"],
    ]);
    for (const lane of LANES) {
      const declared = declaration(lane.environment);
      expect(declared, lane.environment).toContain(`type: "${lane.type}"`);
      if (lane.execution && lane.execution !== "delegate") expect(declared, lane.environment).toContain(`execution: "${lane.execution}"`);
      if (lane.execution === "delegate") expect(declared, lane.environment).not.toContain("execution:");
    }
  });

  it("offer jobs with one-line summaries and values to check", () => {
    expect(JOBS.map((job) => job.id)).toEqual(["answer", "code", "split"]);
    for (const job of JOBS) {
      expect(job.summary.length).toBeLessThanOrEqual(24);
      expect(job.checks.length).toBeGreaterThan(0);
    }
    expect(JOBS.filter((job) => job.needsShell).map((job) => job.id)).toEqual(["code", "split"]);
  });
});
