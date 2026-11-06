import { ManagedCopilotError, type DeploymentInfo } from "@managed-copilot/sdk";
import { describe, expect, it } from "vitest";
import { cloneFailure, diffScript, OutputBuffer, shellQuote, snapshotScript, testsSummary } from "../src/server/driver.js";
import { describeConnectError, describeEnvironment, reconnectDelay } from "../src/server/platform.js";

describe("driver helpers", () => {
  it("quotes shell words, including single quotes", () => {
    expect(shellQuote("release/2.x")).toBe("'release/2.x'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("snapshots through a temporary index that starts from HEAD, leaving new dependencies and caches out", () => {
    const snapshot = snapshotScript("before");
    expect(snapshot).toContain("export GIT_INDEX_FILE=/tmp/repo-doctor-before.index");
    expect(snapshot).toContain("{ git read-tree HEAD 2>/dev/null || true; } && git add -u && git add -A -- . ':(exclude,glob)**/node_modules/**'");
    expect(snapshot.endsWith("git write-tree")).toBe(true);
  });

  it("diffs the snapshots, keeping git's warnings out of the patch itself", () => {
    expect(diffScript("a", "b")).toBe("cd /workspace/repo && git diff --no-color --no-ext-diff --find-renames a b 2>/dev/null");
    expect(diffScript("a", "b", true)).toBe("cd /workspace/repo && git diff --no-color --no-ext-diff --find-renames --stat a b");
  });

  it("logs output without newlines once 64 KB build up, and trims it in linear time", () => {
    const emitted: string[] = [];
    const buffer = new OutputBuffer((text) => emitted.push(text));
    const started = performance.now();
    buffer.push(`x${" ".repeat(70_000)}`);
    expect(emitted).toEqual(["x"]);
    buffer.push(`${" \n".repeat(100_000)}y`);
    buffer.end();
    expect(performance.now() - started).toBeLessThan(500);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]!.endsWith(" \ny")).toBe(true);
  });

  it("explains failed clones in plain words", () => {
    expect(cloneFailure("remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found", "o/r")).toBe("Couldn't clone o/r: it doesn't exist, or it isn't public.");
    expect(cloneFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled", "o/r")).toBe("Couldn't clone o/r: it doesn't exist, or it isn't public.");
    expect(cloneFailure("warning: Could not find remote branch nope to clone.\nfatal: Remote branch nope not found in upstream origin", "o/r")).toBe("Couldn't clone o/r: that branch or tag doesn't exist.");
    expect(cloneFailure("fatal: unable to access 'https://github.com/o/r.git/': CONNECT tunnel failed, response 403", "o/r")).toBe("Couldn't clone o/r: the sandbox's network rules blocked it.");
    expect(cloneFailure("fatal: early EOF", "o/r")).toBe("Couldn't clone o/r.");
  });

  it("sums up a test run in a few words", () => {
    const report = { command: "npm test", failures: [], durationMs: 1, tail: "" };
    expect(testsSummary({ ...report, exitCode: 0, passed: 7 })).toBe("7 passing");
    expect(testsSummary({ ...report, exitCode: 0 })).toBe("Passing");
    expect(testsSummary({ ...report, exitCode: 1, failed: 2 })).toBe("2 failing");
    expect(testsSummary({ ...report, exitCode: 2 })).toBe("Exit code 2");
    expect(testsSummary(report)).toBe("Didn't finish");
  });
});

describe("platform helpers", () => {
  const info = (environments: unknown[], capabilities = ["isolated", "exec"]): DeploymentInfo =>
    ({ name: "copilot", version: "0.1.0", mode: "local", environments, capabilities, sdk: { copilotSdk: "1.0.26", copilotRuntime: "1.0.103" } }) as DeploymentInfo;
  const isolated = { name: "repo-doctor", type: "isolated", size: "medium", network: { access: "restricted", allowedDomains: ["github.com"] }, scheduling: true, agents: [] };

  it("describes Repo Doctor's environment, or why it can't be used", () => {
    expect(describeEnvironment(info([isolated]), "repo-doctor")).toEqual({ environment: { name: "repo-doctor", size: "medium", network: { access: "restricted", hosts: ["github.com"] } } });
    expect(describeEnvironment(info([]), "repo-doctor").problem).toContain('no "repo-doctor" environment');
    expect(describeEnvironment(info([{ ...isolated, type: "shared" }]), "repo-doctor").problem).toContain("needs an isolated one");
    expect(describeEnvironment(info([{ ...isolated, exec: false }]), "repo-doctor").problem).toContain("Running commands directly is turned off");
    expect(describeEnvironment(info([isolated], []), "repo-doctor").problem).toContain("Sandboxes aren't available");
  });

  it("explains connection failures in plain words", () => {
    expect(describeConnectError(new ManagedCopilotError("authentication_required", "no token"))).toContain("gh auth login");
    expect(describeConnectError(new ManagedCopilotError("forbidden", "no"))).toBe("This GitHub account can't use this Managed Copilot deployment.");
    expect(describeConnectError(new Error("fetch failed"))).toContain("aspire run");
  });

  it("backs off exponentially to 30 seconds, with jitter", () => {
    expect(reconnectDelay(1, () => 1)).toBe(1_000);
    expect(reconnectDelay(3, () => 0)).toBe(2_000);
    expect(reconnectDelay(20, () => 1)).toBe(30_000);
  });
});
