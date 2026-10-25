import type { AttentionItem, CustomizationFileInfo, OperatorEvent, OperatorLogEntry } from "@managed-copilot/protocol/operator";
import { describe, expect, it } from "vitest";
import { unwrapList } from "../src/lib/api.js";
import { atLeastLevel, isOperatorEvent, isOperatorLogEntry, logMatches, mergeEvents, mergeLogs } from "../src/lib/feed.js";
import { isMarkdownPath, parseFrontmatter } from "../src/lib/frontmatter.js";
import { bucketStart, seriesStats, sortAttention, sparklinePaths } from "../src/lib/overview.js";
import { ancestorFolders, buildFileTree } from "../src/lib/tree.js";

describe("parseFrontmatter", () => {
  it("splits frontmatter from the body", () => {
    const parsed = parseFrontmatter('---\nname: planner\ndescription: "Plans the work"\ntools: [read, search]\n---\n\n# Planner\nBody');
    expect(parsed.frontmatter).toEqual([
      { key: "name", value: "planner" },
      { key: "description", value: "Plans the work" },
      { key: "tools", value: "[read, search]" },
    ]);
    expect(parsed.body).toBe("# Planner\nBody");
  });

  it("keeps nested values under their key", () => {
    const parsed = parseFrontmatter("---\r\nname: reviewer\r\ntools:\r\n  - read\r\n  - grep\r\nprompt: |\r\n  Be thorough.\r\n---\r\nText");
    expect(parsed.frontmatter).toEqual([
      { key: "name", value: "reviewer" },
      { key: "tools", value: "- read\n  - grep" },
      { key: "prompt", value: "|\n  Be thorough." },
    ]);
    expect(parsed.body).toBe("Text");
  });

  it("treats documents without a complete block as body only", () => {
    expect(parseFrontmatter("# Title\n---\nname: x\n---")).toEqual({ frontmatter: [], body: "# Title\n---\nname: x\n---" });
    expect(parseFrontmatter("---\nname: truncated")).toEqual({ frontmatter: [], body: "---\nname: truncated" });
    expect(parseFrontmatter("\ufeff---\na: 1\n---\nb").frontmatter).toEqual([{ key: "a", value: "1" }]);
  });

  it("recognizes markdown paths", () => {
    expect(isMarkdownPath("agents/planner.agent.md")).toBe(true);
    expect(isMarkdownPath("skills/x/SKILL.MD")).toBe(true);
    expect(isMarkdownPath("skills/x/run.py")).toBe(false);
  });
});

describe("buildFileTree", () => {
  const file = (path: string, kind: CustomizationFileInfo["kind"] = "other"): CustomizationFileInfo => ({ path, size: 10, kind });

  it("nests folders first, alphabetically", () => {
    const tree = buildFileTree([
      file("README.md"),
      file("skills/review/SKILL.md", "skill"),
      file("agents/planner.agent.md", "agent"),
      file("skills/review/scripts/check.py"),
      file("agents/builder.agent.md", "agent"),
    ]);
    expect(tree.map((node) => node.name)).toEqual(["agents", "skills", "README.md"]);
    expect(tree[0]?.children.map((node) => node.path)).toEqual(["agents/builder.agent.md", "agents/planner.agent.md"]);
    expect(tree[1]?.children[0]?.children.map((node) => node.name)).toEqual(["scripts", "SKILL.md"]);
    expect(tree[2]?.file?.path).toBe("README.md");
    expect(tree[0]?.file).toBeUndefined();
  });

  it("lists the folders above a path", () => {
    expect(ancestorFolders("skills/review/scripts/check.py")).toEqual(["skills", "skills/review", "skills/review/scripts"]);
    expect(ancestorFolders("README.md")).toEqual([]);
  });
});

describe("overview helpers", () => {
  it("sorts attention by severity, newest first", () => {
    const items: AttentionItem[] = [
      { id: "1", severity: "info", title: "info" },
      { id: "2", severity: "warning", title: "old warning", at: "2026-10-25T20:00:00Z" },
      { id: "3", severity: "error", title: "error" },
      { id: "4", severity: "warning", title: "new warning", at: "2026-10-25T21:00:00Z" },
    ];
    expect(sortAttention(items).map((item) => item.id)).toEqual(["3", "4", "2", "1"]);
  });

  it("dates traffic buckets from the generation time", () => {
    const generatedAt = "2026-10-25T21:13:52.217Z";
    expect(new Date(bucketStart(generatedAt, 59, 60)).toISOString()).toBe("2026-10-25T21:13:00.000Z");
    expect(new Date(bucketStart(generatedAt, 0, 60)).toISOString()).toBe("2026-10-25T20:14:00.000Z");
  });

  it("summarizes a series", () => {
    expect(seriesStats({ total: 6, perMinute: [0, 4, 1, 1] })).toEqual({ peak: 4, peakIndex: 1, latest: 1 });
    expect(seriesStats({ total: 0, perMinute: [] })).toEqual({ peak: 0, peakIndex: -1, latest: 0 });
  });

  it("draws sparklines in the box", () => {
    const { line, area } = sparklinePaths([0, 5, 10], 100, 20, 0);
    expect(line).toBe("M0 20 L50 10 L100 0");
    expect(area).toBe("M0 20 L50 10 L100 0 L100 20 L0 20 Z");
    expect(sparklinePaths([0, 0], 10, 10, 1).line).toBe("M0 9 L10 9");
    expect(sparklinePaths([], 10, 10)).toEqual({ line: "", area: "" });
  });
});

describe("live feed merging", () => {
  const owner = { id: 1, login: "octocat" };
  const event = (id: string, createdAt: string): OperatorEvent => ({ id, type: "session.created", createdAt, owner, data: {} });
  const log = (seq: number, level: OperatorLogEntry["level"] = "info", message = `line ${seq}`): OperatorLogEntry => ({
    seq,
    at: "2026-10-25T21:00:00Z",
    level,
    logger: "gateway:core",
    message,
  });

  it("dedupes events by ID, oldest first, keeping the newest", () => {
    const history = [event("a", "2026-10-25T21:00:01Z"), event("b", "2026-10-25T21:00:02Z")];
    const live = [event("b", "2026-10-25T21:00:02Z"), event("c", "2026-10-25T21:00:03Z"), event("d", "2026-10-25T21:00:00Z")];
    expect(mergeEvents([history, live], 10).map((item) => item.id)).toEqual(["d", "a", "b", "c"]);
    expect(mergeEvents([history, live], 2).map((item) => item.id)).toEqual(["b", "c"]);
  });

  it("dedupes logs by sequence number", () => {
    expect(mergeLogs([[log(3), log(1)], [log(3), log(4), log(2)]], 3).map((entry) => entry.seq)).toEqual([2, 3, 4]);
  });

  it("filters logs by minimum level and text", () => {
    expect(atLeastLevel("warn", "info")).toBe(true);
    expect(atLeastLevel("debug", "info")).toBe(false);
    expect(atLeastLevel("error", undefined)).toBe(true);
    expect(atLeastLevel("trace", "error")).toBe(true);
    const entry = { ...log(1, "warn", "Sandbox stopped"), fields: { sessionId: "abc-123" } };
    expect(logMatches(entry, "sandbox")).toBe(true);
    expect(logMatches(entry, "ABC-123")).toBe(true);
    expect(logMatches(entry, "gateway:core")).toBe(true);
    expect(logMatches(entry, "missing")).toBe(false);
    expect(logMatches(entry, "  ")).toBe(true);
  });

  it("validates stream payloads", () => {
    expect(isOperatorEvent(event("a", "2026-10-25T21:00:00Z"))).toBe(true);
    expect(isOperatorEvent({ id: 1 })).toBe(false);
    expect(isOperatorLogEntry(log(1))).toBe(true);
    expect(isOperatorLogEntry({ seq: "1", level: "info", message: "x" })).toBe(false);
  });
});

describe("unwrapList", () => {
  it("accepts arrays and named wrappers", () => {
    expect(unwrapList<number>([1, 2])).toEqual([1, 2]);
    expect(unwrapList<number>({ sessions: [3] }, "sessions")).toEqual([3]);
    expect(unwrapList<number>({ items: [4] }, "sessions")).toEqual([4]);
    expect(() => unwrapList({ nope: 1 }, "sessions")).toThrow(/couldn't read/);
  });
});
