import { describe, expect, it } from "vitest";
import { withMove } from "../src/server/analysis.js";
import { describeStep, exitCode, mergeHistory, plainError, resultView, Transcript, type DeskEvent } from "../src/server/projection.js";
import { event } from "./fakes.js";

const own = new Set(["Which store sold the most?", "Chart it"]);
const transcript = () => new Transcript((content) => own.has(content));
const apply = (target: Transcript, ...events: unknown[]) => events.map((value) => target.apply(value as DeskEvent));

const table = JSON.stringify({ title: "Revenue by store", matched: 3, shown: 3, columns: ["store", "sum(revenue)"], rows: [["Downtown", "190417"], ["Harbor", "160124.8"], ["Campus", "123058.6"]] });

describe("transcript", () => {
  it("shows the person's messages, Copilot's replies as they stream, and who sent each message", () => {
    const t = transcript();
    apply(
      t,
      event("user.message", { content: "Which store sold the most?" }),
      event("assistant.message_delta", { messageId: "m1", deltaContent: "Down" }, { ephemeral: true }),
      event("assistant.message_delta", { messageId: "m1", deltaContent: "town" }, { ephemeral: true }),
    );
    expect(t.busy).toBe(true);
    expect(t.items.at(-1)).toMatchObject({ kind: "assistant", text: "Downtown", streaming: true });
    apply(t, event("assistant.message", { messageId: "m1", content: "Downtown, by far." }), event("session.idle", {}, { ephemeral: true }));
    expect(t.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(t.items[1]).toMatchObject({ text: "Downtown, by far." });
    expect(t.items[1]).not.toHaveProperty("streaming");
    expect(t.busy).toBe(false);

    apply(t, event("user.message", { content: "Hello from the terminal" }));
    expect(t.items.at(-1)).toMatchObject({ kind: "user", via: "cli" });
    expect(t.items[0]).toMatchObject({ via: "app" });
  });

  it("turns Data Desk's tool answers into grid tables linked from their step", () => {
    const t = transcript();
    apply(
      t,
      event("user.message", { content: "Which store sold the most?" }),
      event("tool.execution_start", { toolCallId: "call-1", toolName: "aggregate", arguments: { title: "Revenue by store", groupBy: ["store"] } }),
      event("tool.execution_complete", { toolCallId: "call-1", success: true, result: { content: table } }),
    );
    expect(t.items[1]).toMatchObject({ kind: "step", type: "data", label: "Revenue by store", status: "done", outcome: "3 groups", resultId: "call-1" });
    expect(t.results).toEqual([expect.objectContaining({ id: "call-1", title: "Revenue by store", columns: ["store", "sum(revenue)"], total: 3 })]);
  });

  it("shows a tool's mistake as a failed step", () => {
    const t = transcript();
    apply(
      t,
      event("tool.execution_start", { toolCallId: "call-1", toolName: "query_rows", arguments: { title: "West" } }),
      event("tool.execution_complete", { toolCallId: "call-1", success: true, result: { content: JSON.stringify({ error: 'There\'s no column "region".' }) } }),
    );
    expect(t.items[0]).toMatchObject({ status: "failed", outcome: 'There\'s no column "region".' });
    expect(t.results).toEqual([]);
  });

  it("follows a move: asked, approved, then moved, with the turn continuing in the sandbox", () => {
    const t = transcript();
    apply(
      t,
      event("user.message", { content: "Chart it" }),
      event("tool.execution_start", { toolCallId: "move-1", toolName: "request_sandbox", arguments: { reason: "Need Python for a chart" } }),
      event("permission.requested", { requestId: "p1", permissionRequest: { kind: "custom-tool", toolName: "request_sandbox", toolCallId: "move-1" } }),
    );
    expect(t.items[1]).toMatchObject({ type: "move", status: "asking", detail: "Need Python for a chart" });
    expect(t.isSettled("move-1")).toBe(false);
    expect(t.moving).toBe(false);

    apply(t, event("permission.completed", { requestId: "p1", toolCallId: "move-1", result: { kind: "approved" } }));
    expect(t.moving).toBe(true);
    expect(t.lastMoveId).toBe("move-1");

    apply(
      t,
      event("tool.execution_complete", { toolCallId: "move-1", success: true, result: { content: "You are now running in your own sandbox." } }),
      event("tool.execution_start", { toolCallId: "sh-1", toolName: "bash", arguments: { command: "python3 chart.py", description: "Draw the chart" } }),
      event("tool.execution_complete", { toolCallId: "sh-1", success: true, result: { content: "done\n<shellId: 0 completed with exit code 0>" } }),
    );
    expect(t.moved).toBe(true);
    expect(t.moving).toBe(false);
    expect(t.items.map((item) => item.kind)).toEqual(["user", "step", "moved", "step"]);
    expect(t.items[3]).toMatchObject({ type: "shell", label: "Draw the chart", detail: "python3 chart.py", status: "done" });
  });

  it("keeps the session where it is when the person says not now", () => {
    const t = transcript();
    apply(
      t,
      event("tool.execution_start", { toolCallId: "move-1", toolName: "request_sandbox", arguments: { reason: "Chart" } }),
      event("permission.requested", { requestId: "p1", permissionRequest: { kind: "custom-tool", toolName: "request_sandbox", toolCallId: "move-1" } }),
      event("permission.completed", { requestId: "p1", result: { kind: "denied-interactively-by-user" } }),
      event("tool.execution_complete", { toolCallId: "move-1", success: false, error: { message: "denied" } }),
    );
    expect(t.items[0]).toMatchObject({ status: "declined", outcome: "Not now" });
    expect(t.moved).toBe(false);
    expect(t.isSettled("move-1")).toBe(true);
  });

  it("reports a failed command's exit code and a move that couldn't happen", () => {
    const t = transcript();
    apply(
      t,
      event("tool.execution_start", { toolCallId: "sh-1", toolName: "bash", arguments: { command: "python3 broken.py" } }),
      event("tool.execution_complete", { toolCallId: "sh-1", success: true, result: { content: "Traceback\n<shellId: 1 completed with exit code 1>" } }),
      event("tool.execution_start", { toolCallId: "move-1", toolName: "request_sandbox", arguments: {} }),
      event("tool.execution_complete", { toolCallId: "move-1", success: false, error: { message: "capability_unavailable: Sandboxes aren't available." } }),
    );
    expect(t.items[0]).toMatchObject({ status: "failed", outcome: "Exit code 1" });
    expect(t.items[1]).toMatchObject({ status: "failed", outcome: "Sandboxes aren't available." });
  });

  it("ends a turn's unfinished work when the turn ends, and hides bookkeeping and sub-agents", () => {
    const t = transcript();
    apply(
      t,
      event("user.message", { content: "Chart it" }),
      event("tool.execution_start", { toolCallId: "r", toolName: "report_intent", arguments: {} }),
      event("tool.execution_start", { toolCallId: "sub", toolName: "bash", arguments: {} }, { agentId: "agent-1" }),
      event("tool.execution_start", { toolCallId: "sh-1", toolName: "bash", arguments: { command: "sleep 100" } }),
      event("abort", {}),
    );
    expect(t.items.map((item) => item.kind)).toEqual(["user", "step"]);
    expect(t.items[1]).toMatchObject({ status: "failed", outcome: "Stopped" });
    expect(t.busy).toBe(false);
  });

  it("applies each persisted event once when history and live delivery overlap", () => {
    const t = transcript();
    const message = event("user.message", { content: "Chart it" });
    expect(apply(t, message, message)).toEqual([true, false]);
    expect(t.items).toHaveLength(1);
  });

  it("shows a turn's error", () => {
    const t = transcript();
    apply(t, event("user.message", { content: "Chart it" }), event("session.error", { errorType: "quota", message: "quota_exceeded: You're out of premium requests." }));
    expect(t.items.at(-1)).toMatchObject({ kind: "error", text: "You're out of premium requests." });
    expect(t.busy).toBe(false);
  });
});

describe("steps and results", () => {
  it("labels each kind of tool call", () => {
    expect(describeStep("describe_dataset", {})).toEqual({ type: "data", label: "Read the dataset's columns" });
    expect(describeStep("create", { path: "/workspace/chart.py" })).toEqual({ type: "file", label: "Wrote chart.py", detail: "/workspace/chart.py" });
    expect(describeStep("view", { path: "/workspace/data/sales.csv" })).toMatchObject({ type: "read", label: "Read sales.csv" });
    expect(describeStep("bash", { command: "python3 a.py\npython3 b.py" })).toMatchObject({ type: "shell", label: "python3 a.py" });
    expect(describeStep("glob", {})).toEqual({ type: "other", label: "glob" });
  });

  it("reads exit codes, errors, and tables", () => {
    expect(exitCode("ok\n<shellId: 3 completed with exit code 2>")).toBe(2);
    expect(exitCode("<exited with exit code 0>")).toBe(0);
    expect(exitCode("no status")).toBeUndefined();
    expect(plainError("policy_violation: Not allowed\nmore")).toBe("Not allowed");
    expect(resultView("id", "2026-11-04T10:00:00Z", "not json")).toBeUndefined();
    expect(resultView("id", "2026-11-04T10:00:00Z", JSON.stringify({ columns: ["a"], rows: [[1, null]] }))).toMatchObject({ title: "Result", rows: [["1", ""]], total: 1 });
  });
});

describe("history", () => {
  it("places events delivered while the history loaded by when they happened", () => {
    const history = [
      { id: "1", type: "user.message", timestamp: "2026-11-04T10:00:01.000Z" },
      { id: "2", type: "assistant.message", timestamp: "2026-11-04T10:00:03.000Z" },
    ];
    const live = [
      { id: "2", type: "assistant.message", timestamp: "2026-11-04T10:00:03.000Z" },
      { id: "idle", type: "session.idle", timestamp: "2026-11-04T10:00:02.000Z" },
    ];
    expect(mergeHistory(history, live).map((value) => value.id)).toEqual(["1", "idle", "2"]);
  });
});

describe("move marker", () => {
  const move = { at: "2026-11-04T10:00:05.000Z", sandboxId: "sbx_1", durationMs: 4200 };

  it("adds the sandbox and duration to the marker the agent's request left", () => {
    const items = [{ kind: "moved" as const, id: "moved-1", at: "2026-11-04T10:00:06.000Z" }];
    expect(withMove(items, move)).toEqual([{ kind: "moved", id: "moved-1", at: "2026-11-04T10:00:06.000Z", sandboxId: "sbx_1", durationMs: 4200 }]);
  });

  it("marks a move nobody asked for in the conversation at its time", () => {
    const items = [
      { kind: "user" as const, id: "u1", text: "a", at: "2026-11-04T10:00:01.000Z", via: "app" as const },
      { kind: "user" as const, id: "u2", text: "b", at: "2026-11-04T10:00:09.000Z", via: "app" as const },
    ];
    expect(withMove(items, move).map((item) => item.id)).toEqual(["u1", "moved-2026-11-04T10:00:05.000Z", "u2"]);
    expect(withMove(items, undefined)).toEqual(items);
  });
});
