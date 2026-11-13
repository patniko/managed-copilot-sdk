import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoLog, createScopedLoggers, errorMessage, redact, redactFields, type LogSink } from "../src/index.js";

const TOKEN = `ghp_${"a".repeat(36)}`;

describe("redact", () => {
  it("replaces GitHub tokens and bearer credentials", () => {
    expect(redact(`using ${TOKEN} now`)).toBe("using *** now");
    expect(redact(`pat github_pat_${"B1_".repeat(10)} end`)).toBe("pat *** end");
    expect(redact("Authorization: Bearer abcdefghijklmnop.qrs")).toBe("Authorization: ***");
  });

  it("leaves short or ordinary text alone", () => {
    expect(redact("ghp_short and Bearer short")).toBe("ghp_short and Bearer short");
  });
});

describe("createDemoLog", () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (out.push(String(chunk)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (err.push(String(chunk)), true));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("writes prefixed lines with redacted messages and fields, warnings to stderr", () => {
    vi.stubEnv("TEST_LOG_LEVEL", "debug");
    const log = createDemoLog({ name: "demo", levelEnv: "TEST_LOG_LEVEL" });
    log.info(`token ${TOKEN}`, { count: 2, note: `see ${TOKEN}`, apiToken: "plain", skipped: undefined, nested: { a: 1 } });
    log.warn("careful");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^\[demo\] \d\d:\d\d:\d\d info {2}token \*\*\* count=2 note=see \*\*\* apiToken=\*\*\* nested=\{"a":1\}\n$/);
    expect(err).toEqual([expect.stringMatching(/^\[demo\] \d\d:\d\d:\d\d warn {2}careful\n$/)]);
  });

  it("filters below the level read from its environment variable, defaulting to info", () => {
    vi.stubEnv("TEST_LOG_LEVEL", "warn");
    const quiet = createDemoLog({ name: "demo", levelEnv: "TEST_LOG_LEVEL" });
    quiet.info("hidden");
    quiet.error("shown");
    vi.stubEnv("TEST_LOG_LEVEL", "nonsense");
    const fallback = createDemoLog({ name: "demo", levelEnv: "TEST_LOG_LEVEL" });
    fallback.debug("hidden");
    fallback.info("shown");
    expect(out).toHaveLength(1);
    expect(err).toHaveLength(1);
  });

  it("masks custom secret field names", () => {
    const log = createDemoLog({ name: "demo", levelEnv: "TEST_LOG_LEVEL", secretKeys: /signature/i });
    log.info("hook", { signature: "abc", token: "kept" });
    expect(out[0]).toContain("signature=*** token=kept");
  });

  it("sends exported lines to the sink, but not local ones", () => {
    const log = createDemoLog({ name: "demo", levelEnv: "TEST_LOG_LEVEL" });
    const sink = vi.fn<LogSink>();
    log.setSink(sink);
    log.info(`sent ${TOKEN}`, { password: "x", n: 1 });
    log.local.warn("not sent");
    log.setSink();
    log.info("after");
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith("info", "sent ***", { password: "***", n: "1" });
    expect(out).toHaveLength(2);
    expect(err).toHaveLength(1);
  });
});

describe("redactFields", () => {
  it("masks sensitive keys at any depth but keeps numbers and booleans", () => {
    expect(redactFields({ code: "abc", codeLength: 3, tokens: 5, hasSecret: true, list: [{ refreshToken: "r" }], user: { apiKey: "k", name: "n" } })).toEqual({
      code: "[redacted]",
      codeLength: 3,
      tokens: 5,
      hasSecret: true,
      list: [{ refreshToken: "[redacted]" }],
      user: { apiKey: "[redacted]", name: "n" },
    });
  });
});

describe("createScopedLoggers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("writes scoped console lines with JSON field values", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("TEST_LOG_LEVEL", "info");
    const logger = createScopedLoggers({ levelEnv: "TEST_LOG_LEVEL" })("app").child("google");
    logger.debug("hidden");
    logger.info("signed in", { email: "a@b.c", accessToken: "t", count: 1, gone: undefined });
    logger.warn("retry");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/^\S+Z INFO {2}\[app:google\] signed in email="a@b\.c" accessToken="\[redacted\]" count=1$/);
    expect(error.mock.calls[0]?.[0]).toMatch(/^\S+Z WARN {2}\[app:google\] retry$/);
  });
});

describe("errorMessage", () => {
  it("never returns a stack trace", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage({ stack: "x" })).toBe("Unexpected error");
  });
});
