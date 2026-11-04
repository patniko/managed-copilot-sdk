import type { SessionEvent } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";
import { AgentObserver, displayPath, fixPrompt, noTestsTool, testCommandTool } from "../src/server/agent.js";
import type { LogLine } from "../src/shared/types.js";

function observe() {
  const lines: Omit<LogLine, "at" | "seq">[] = [];
  const activity: string[] = [];
  const succeeded: [string, string][] = [];
  const observer = new AgentObserver({ log: (line) => lines.push(line), activity: (text) => activity.push(text), succeeded: (command, output) => succeeded.push([command, output]) });
  let id = 0;
  const emit = (type: string, data: unknown) => observer.handle({ id: `e${++id}`, parentId: null, timestamp: "2026-01-01T00:00:00Z", type, data } as SessionEvent);
  return { observer, lines, activity, succeeded, emit };
}

describe("AgentObserver", () => {
  it("logs commands with their output and exit code, without the runtime's exit marker", () => {
    const { lines, activity, succeeded, emit } = observe();
    emit("tool.execution_start", { toolCallId: "1", toolName: "bash", arguments: { command: "npm install", description: "Install" } });
    emit("tool.execution_complete", { toolCallId: "1", success: true, result: { content: "added 3 packages in 1s\n<shellId: 2 completed with exit code 0>\n" }, shellExecution: { exitCode: 0 } });
    emit("tool.execution_start", { toolCallId: "2", toolName: "bash", arguments: { command: "npm test" } });
    emit("tool.execution_complete", { toolCallId: "2", success: false, result: { content: "✖ 2 failing\n<exited with exit code 1>" }, shellExecution: { exitCode: 1 } });
    expect(lines).toEqual([
      { kind: "command", text: "npm install" },
      { kind: "output", text: "added 3 packages in 1s" },
      { kind: "command", text: "npm test" },
      { kind: "output", text: "✖ 2 failing" },
      { kind: "note", text: "Exit code 1", exitCode: 1 },
    ]);
    expect(activity).toEqual(["npm install", "npm test"]);
    expect(succeeded).toEqual([["npm install", "added 3 packages in 1s"]]);
  });

  it("shows intents, edits, reads, and replies; keeps its own tools quiet", () => {
    const { observer, lines, activity, emit } = observe();
    emit("tool.execution_start", { toolCallId: "1", toolName: "report_intent", arguments: { intent: "Fixing the release type" } });
    emit("tool.execution_start", { toolCallId: "2", toolName: "view", arguments: { path: "/workspace/repo/src/next-version.js" } });
    emit("tool.execution_start", { toolCallId: "3", toolName: "edit", arguments: { path: "/workspace/repo/src/next-version.js" } });
    emit("tool.execution_start", { toolCallId: "4", toolName: "report_test_command", arguments: { command: "npm test" } });
    emit("tool.execution_start", { toolCallId: "5", toolName: "grep", arguments: { pattern: "feature" } });
    emit("assistant.message", { messageId: "m1", content: "  " });
    emit("assistant.message", { messageId: "m2", content: "Changed `feature` to `feat`." });
    emit("session.error", { errorType: "query", message: "Model unavailable\nstack…" });
    expect(lines).toEqual([
      { kind: "note", text: "Fixing the release type" },
      { kind: "read", text: "Read src/next-version.js" },
      { kind: "edit", text: "Edited src/next-version.js" },
      { kind: "read", text: "Searched for feature" },
      { kind: "message", text: "Changed `feature` to `feat`." },
      { kind: "error", text: "Model unavailable" },
    ]);
    expect(activity).toEqual(["Fixing the release type", "Reading src/next-version.js", "Editing src/next-version.js", "Searching for feature"]);
    expect(observer.lastMessage).toBe("Changed `feature` to `feat`.");
  });

  it("shows workspace paths relative to the repository", () => {
    expect(displayPath("/workspace/repo/src/a.js")).toBe("src/a.js");
    expect(displayPath("/workspace/repo")).toBe(".");
    expect(displayPath("/workspace/outputs/x.md")).toBe("outputs/x.md");
  });
});

describe("prompts and tools", () => {
  it("asks for a fix with what Repo Doctor saw", () => {
    const prompt = fixPrompt({ command: "npm test", exitCode: 1, passed: 5, failed: 2, total: 7, failures: ["a", "b"], durationMs: 400, tail: "✖ a\n✖ b" });
    expect(prompt).toContain("Repo Doctor ran `npm test` in /workspace/repo: 2 of 7 tests failed.");
    expect(prompt).toContain("- a\n- b");
    expect(prompt).toContain("✖ a\n✖ b");
    expect(fixPrompt({ command: "make test", exitCode: 2, failures: [], durationMs: 1, tail: "boom" })).toContain("it exited with code 2");
  });

  it("validates the reported test command", async () => {
    const reported: string[] = [];
    const tool = testCommandTool((command) => {
      reported.push(command);
      return "Recorded.";
    });
    const call = (args: unknown) => tool.handler!(args as never, {} as never);
    expect(await call({ command: "  npm test " })).toBe("Recorded.");
    expect(await call({ command: "" })).toMatchObject({ resultType: "failure" });
    expect(await call({ command: "npm test\nrm -rf /" })).toMatchObject({ resultType: "failure" });
    expect(await call({})).toMatchObject({ resultType: "failure" });
    for (const placeholder of ['echo "No tests found"', "true", "exit 0", ":"]) {
      expect(await call({ command: placeholder }), placeholder).toMatchObject({ resultType: "failure", textResultForLlm: expect.stringContaining("report_no_tests") });
    }
    expect(reported).toEqual(["npm test"]);
  });

  it("takes a reason for a repository without tests", async () => {
    const reasons: string[] = [];
    const tool = noTestsTool((reason) => {
      reasons.push(reason);
      return "Recorded.";
    });
    const call = (args: unknown) => tool.handler!(args as never, {} as never);
    expect(await call({ reason: " Only a README. " })).toBe("Recorded.");
    expect(await call({ reason: "" })).toMatchObject({ resultType: "failure" });
    expect(reasons).toEqual(["Only a README."]);
  });
});
