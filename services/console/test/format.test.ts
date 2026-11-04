import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCompact,
  formatDuration,
  formatIso,
  formatMemoryMiB,
  formatMilliseconds,
  formatNumber,
  formatRelative,
  formatResources,
  formatSize,
  formatValue,
  humanize,
  initials,
  pluralize,
  safeAvatarUrl,
  safeExternalUrl,
  shortId,
  summarizeNetwork,
} from "../src/lib/format.js";

const NOW = Date.parse("2026-10-25T21:00:00.000Z");
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

describe("formatRelative", () => {
  it("formats the past", () => {
    expect(formatRelative(at(-500), NOW)).toBe("just now");
    expect(formatRelative(at(-3_000), NOW)).toBe("3s ago");
    expect(formatRelative(at(-12_000), NOW)).toBe("12s ago");
    expect(formatRelative(at(-59_999), NOW)).toBe("59s ago");
    expect(formatRelative(at(-60_000), NOW)).toBe("1 min ago");
    expect(formatRelative(at(-3 * 60_000 - 20_000), NOW)).toBe("3 min ago");
    expect(formatRelative(at(-2 * 3_600_000), NOW)).toBe("2 h ago");
    expect(formatRelative(at(-4 * 86_400_000), NOW)).toBe("4 d ago");
  });

  it("formats the future", () => {
    expect(formatRelative(at(1_000), NOW)).toBe("just now");
    expect(formatRelative(at(12_000), NOW)).toBe("in 12s");
    expect(formatRelative(at(3 * 60_000), NOW)).toBe("in 3 min");
    expect(formatRelative(at(5 * 3_600_000 + 1), NOW)).toBe("in 5 h");
    expect(formatRelative(at(2 * 86_400_000), NOW)).toBe("in 2 d");
  });

  it("falls back to a date beyond 30 days and tolerates missing values", () => {
    const old = formatRelative(at(-40 * 86_400_000), NOW);
    expect(old).not.toContain("ago");
    expect(old).toMatch(/2026/);
    expect(formatRelative(undefined, NOW)).toBe("");
    expect(formatRelative("not a date", NOW)).toBe("");
    expect(formatRelative(NOW - 5_000, NOW)).toBe("5s ago");
  });
});

describe("formatIso", () => {
  it("normalizes timestamps to ISO-8601", () => {
    expect(formatIso("2026-10-25T21:00:00Z")).toBe("2026-10-25T21:00:00.000Z");
    expect(formatIso(NOW)).toBe("2026-10-25T21:00:00.000Z");
    expect(formatIso(undefined)).toBe("");
  });
});

describe("formatDuration", () => {
  it("uses at most two adjacent units", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(42.9)).toBe("42 s");
    expect(formatDuration(60)).toBe("1 min");
    expect(formatDuration(90)).toBe("1 min 30 s");
    expect(formatDuration(900)).toBe("15 min");
    expect(formatDuration(3600)).toBe("1 h");
    expect(formatDuration(2 * 3600 + 14 * 60 + 9)).toBe("2 h 14 min");
    expect(formatDuration(3 * 86_400 + 4 * 3600)).toBe("3 d 4 h");
    expect(formatDuration(86_400 + 30)).toBe("1 d");
  });

  it("rejects invalid input", () => {
    expect(formatDuration(undefined)).toBe("");
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration(Number.NaN)).toBe("");
  });
});

describe("formatMilliseconds", () => {
  it("formats short spans", () => {
    expect(formatMilliseconds(0.42)).toBe("0.4 ms");
    expect(formatMilliseconds(5)).toBe("5 ms");
    expect(formatMilliseconds(12.4)).toBe("12 ms");
    expect(formatMilliseconds(1000)).toBe("1 s");
    expect(formatMilliseconds(1500)).toBe("1.5 s");
    expect(formatMilliseconds(30_000)).toBe("30 s");
    expect(formatMilliseconds(120_000)).toBe("2 min");
  });
});

describe("formatBytes", () => {
  it("uses binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(10 * 1024)).toBe("10 KiB");
    expect(formatBytes(12 * 1024 * 1024)).toBe("12 MiB");
    expect(formatBytes(1.25 * 1024 ** 3)).toBe("1.3 GiB");
    expect(formatBytes(undefined)).toBe("");
  });
});

describe("numbers", () => {
  it("formats counts", () => {
    expect(formatNumber(12345)).toBe("12,345");
    expect(formatCompact(950)).toBe("950");
    expect(formatCompact(12_400)).toBe("12.4k");
    expect(formatCompact(3_200_000)).toBe("3.2M");
    expect(pluralize(1, "host")).toBe("1 host");
    expect(pluralize(3, "host")).toBe("3 hosts");
    expect(pluralize(2, "is", "are")).toBe("2 are");
  });
});

describe("shortId", () => {
  it("keeps the first 8 characters", () => {
    expect(shortId("3f2a9c1e-7b4d-4c3a-9f00-123456789abc")).toBe("3f2a9c1e");
    expect(shortId("short")).toBe("short");
    expect(shortId("")).toBe("");
    expect(shortId(undefined)).toBe("");
  });

  it("keeps a readable type prefix", () => {
    expect(shortId("sbx_0123456789abcdef01234567")).toBe("sbx_01234567");
    expect(shortId("conn_3f2a9c1e-7b4d-4c3a")).toBe("conn_3f2a9c1e");
    expect(shortId("act_ab")).toBe("act_ab");
  });
});

describe("text helpers", () => {
  it("humanizes identifiers", () => {
    expect(humanize("needs_reconciliation")).toBe("Needs reconciliation");
    expect(humanize("session.created")).toBe("Session created");
    expect(humanize("")).toBe("");
  });

  it("builds initials", () => {
    expect(initials("Mona Lisa Octocat")).toBe("ML");
    expect(initials("octocat")).toBe("OC");
    expect(initials("")).toBe("?");
  });

  it("formats values compactly", () => {
    expect(formatValue("text")).toBe("text");
    expect(formatValue(42)).toBe("42");
    expect(formatValue(null)).toBe("null");
    expect(formatValue({ host: "example.com", port: 443 })).toBe('{"host":"example.com","port":443}');
    expect(formatValue("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("URL safety", () => {
  it("only loads GitHub avatars and data images", () => {
    expect(safeAvatarUrl("https://avatars.githubusercontent.com/u/583231?v=4")).toBe("https://avatars.githubusercontent.com/u/583231?v=4");
    expect(safeAvatarUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(safeAvatarUrl("http://avatars.githubusercontent.com/u/1")).toBeUndefined();
    expect(safeAvatarUrl("https://evil.example/avatar.png")).toBeUndefined();
    expect(safeAvatarUrl("https://avatars.githubusercontent.com.evil.example/u/1")).toBeUndefined();
    expect(safeAvatarUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeAvatarUrl(undefined)).toBeUndefined();
  });

  it("only links http(s) URLs", () => {
    expect(safeExternalUrl("https://docs.github.com/copilot")).toBe("https://docs.github.com/copilot");
    expect(safeExternalUrl("http://example.com")).toBe("http://example.com/");
    expect(safeExternalUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeExternalUrl("./skills/review/SKILL.md")).toBeUndefined();
    expect(safeExternalUrl("mailto:someone@example.com")).toBeUndefined();
  });
});

describe("summarizeNetwork", () => {
  it("describes each access mode", () => {
    expect(summarizeNetwork({ access: "enabled", allowedDomains: [] })).toMatchObject({ kind: "enabled", label: "Enabled" });
    expect(summarizeNetwork({ access: "disabled", allowedDomains: [] })).toMatchObject({ kind: "disabled", label: "Disabled" });
    expect(summarizeNetwork({ access: "restricted", allowedDomains: ["github.com", "*.githubusercontent.com"] })).toMatchObject({
      kind: "restricted",
      label: "Restricted to 2 hosts",
      hosts: ["github.com", "*.githubusercontent.com"],
    });
    expect(summarizeNetwork({ access: "restricted", allowedDomains: ["pypi.org"] })?.label).toBe("Restricted to 1 host");
    expect(summarizeNetwork(undefined)).toBeUndefined();
  });
});

describe("sizes", () => {
  it("formats sandbox resources", () => {
    expect(formatMemoryMiB(512)).toBe("512 MiB");
    expect(formatMemoryMiB(4096)).toBe("4 GiB");
    expect(formatMemoryMiB(1536)).toBe("1.5 GiB");
    expect(formatResources({ cpus: 2, memoryMiB: 4096 })).toBe("2 vCPU · 4 GiB");
    expect(formatSize("medium", { cpus: 2, memoryMiB: 4096 })).toBe("medium · 2 vCPU · 4 GiB");
    expect(formatSize(undefined)).toBe("");
  });
});
