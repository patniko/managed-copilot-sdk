import { describe, expect, it } from "vitest";
import { isWithin, normalizeWorkspacePath, PathError } from "../src/shared/paths.js";
import { redact } from "../src/sandboxd/exec.js";
import { runtimeEnvironment, workloadEnvironment } from "../src/sandboxd/env.js";

function code(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof PathError ? error.code : "other";
  }
}

describe("normalizeWorkspacePath", () => {
  it("normalizes relative and /workspace paths", () => {
    expect(normalizeWorkspacePath("data/sales.csv")).toBe("data/sales.csv");
    expect(normalizeWorkspacePath("./data//sales.csv")).toBe("data/sales.csv");
    expect(normalizeWorkspacePath("/workspace/outputs/report.md")).toBe("outputs/report.md");
    expect(normalizeWorkspacePath("", { allowRoot: true })).toBe("");
    expect(normalizeWorkspacePath("/workspace", { allowRoot: true })).toBe("");
    expect(normalizeWorkspacePath("report.md", { root: "/workspace/outputs" })).toBe("report.md");
    expect(normalizeWorkspacePath("/workspace/outputs/charts/a.png", { root: "/workspace/outputs" })).toBe("charts/a.png");
  });

  it("rejects traversal, absolute, Windows, and control-character paths", () => {
    expect(code(() => normalizeWorkspacePath("../etc/passwd"))).toBe("forbidden");
    expect(code(() => normalizeWorkspacePath("data/../../etc"))).toBe("forbidden");
    expect(code(() => normalizeWorkspacePath("/etc/passwd"))).toBe("forbidden");
    expect(code(() => normalizeWorkspacePath("/workspacex/file"))).toBe("forbidden");
    expect(code(() => normalizeWorkspacePath("C:\\temp\\x"))).toBe("invalid_request");
    expect(code(() => normalizeWorkspacePath("data\\x"))).toBe("invalid_request");
    expect(code(() => normalizeWorkspacePath("a\u0000b"))).toBe("invalid_request");
    expect(code(() => normalizeWorkspacePath(""))).toBe("invalid_request");
    expect(code(() => normalizeWorkspacePath(42))).toBe("invalid_request");
    expect(code(() => normalizeWorkspacePath("x".repeat(300)))).toBe("invalid_request");
  });

  it("checks containment on segment boundaries", () => {
    expect(isWithin("/workspace", "/workspace")).toBe(true);
    expect(isWithin("/workspace", "/workspace/a/b")).toBe(true);
    expect(isWithin("/workspace/", "/workspace/a")).toBe(true);
    expect(isWithin("/workspace", "/workspace2/a")).toBe(false);
    expect(isWithin("/workspace", "/etc")).toBe(false);
  });
});

describe("sandbox environment", () => {
  const input = {
    platformEnv: { HTTPS_PROXY: "http://sbx_1:s3cr3t-cred@mc-egress:3128", NO_PROXY: "internal.example", STRIPE_API_KEY: "mcv_placeholder_123456" },
    workloadEnv: { REPORT_TITLE: "Q3", HTTP_PROXY: "http://evil", PATH: "/evil", COPILOT_HOME: "/tmp/x", TZ: "UTC" },
    caInstalled: true,
  };

  it("drops reserved customer variables and applies platform settings last", () => {
    const env = workloadEnvironment(input);
    expect(env.REPORT_TITLE).toBe("Q3");
    expect(env.TZ).toBe("UTC");
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.PATH).toMatch(/^\/home\/agent\/\.venv\/bin:/);
    expect(env.COPILOT_HOME).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe(input.platformEnv.HTTPS_PROXY);
    expect(env.STRIPE_API_KEY).toBe("mcv_placeholder_123456");
    expect(env.NO_PROXY.split(",")).toEqual(expect.arrayContaining(["internal.example", "localhost", "127.0.0.1", "::1"]));
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/usr/local/share/ca-certificates/managed-copilot-egress.crt");
    expect(env.REQUESTS_CA_BUNDLE).toBe("/etc/ssl/certs/ca-certificates.crt");
  });

  it("adds runtime settings only for the runtime", () => {
    const env = runtimeEnvironment(input, "connection-token-value");
    expect(env.COPILOT_HOME).toBe("/var/lib/managed-copilot/runtime");
    expect(env.COPILOT_CONNECTION_TOKEN).toBe("connection-token-value");
    expect(env.COPILOT_DISABLE_KEYTAR).toBe("1");
    expect(Object.keys(env).some((name) => name.startsWith("SANDBOXD_"))).toBe(false);
  });

  it("omits trust variables when no CA is installed", () => {
    const env = workloadEnvironment({ ...input, caInstalled: false });
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.SSL_CERT_FILE).toBeUndefined();
  });
});

describe("redact", () => {
  it("masks secrets and URL credentials", () => {
    const text = "proxy http://sbx_1:s3cr3t-cred@mc-egress:3128 failed; token connection-token-value leaked";
    const out = redact(text, ["connection-token-value", "abc"]);
    expect(out).not.toContain("s3cr3t-cred");
    expect(out).not.toContain("connection-token-value");
    expect(out).toContain("http://[redacted]@mc-egress:3128");
  });
});
