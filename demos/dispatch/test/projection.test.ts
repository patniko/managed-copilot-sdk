import { describe, expect, it } from "vitest";
import { firstLine, Transcript, type CoordinatorEvent } from "../src/server/projection.js";
import { event } from "./fakes.js";

const WORKER_A = "11111111-1111-4111-8111-111111111111";
const WORKER_B = "22222222-2222-4222-8222-222222222222";

function transcript(own: string[] = []) {
  return new Transcript((messageId) => messageId !== undefined && own.includes(messageId), "dispatch-python");
}

const apply = (t: Transcript, ...events: unknown[]) => events.map((value) => t.apply(value as CoordinatorEvent));

const user = (content: string, messageId?: string, extra: Record<string, unknown> = {}) => event("user.message", { content, ...(messageId ? { messageId } : {}), ...extra });
const start = (toolCallId: string, toolName: string, args: Record<string, unknown>) => event("tool.execution_start", { toolCallId, toolName, arguments: args });
const done = (toolCallId: string, content: string, success = true) => event("tool.execution_complete", { toolCallId, success, ...(success ? { result: { content } } : { error: { message: content } }) });

describe("Transcript", () => {
  it("attributes created and reused workers to the messages whose handling did it", () => {
    const t = transcript(["m1"]);
    apply(
      t,
      user("Benchmark sorts", "m1"),
      start("c1", "start_worker", { name: "py-bench", environment: "dispatch-python", task: "Time the sorts" }),
      done("c1", `Started worker "py-bench" (ID ${WORKER_A}) in environment dispatch-python.`),
      start("c2", "start_worker", { name: "node-bench", environment: "dispatch-node", task: "Time them in JS" }),
      done("c2", `Started worker "node-bench" (ID ${WORKER_B}) in environment dispatch-node.`),
      event("session.idle"),
      user("Add insertion sort", "m2"),
      start("c3", "message_worker", { worker: "py-bench", message: "Add insertion sort" }),
      done("c3", "Sent."),
      event("session.idle"),
    );
    expect(t.attribution({ id: WORKER_A, name: "py-bench" })).toEqual({ createdBy: 1, sentWorkBy: [2] });
    expect(t.attribution({ id: WORKER_B, name: "node-bench" })).toEqual({ createdBy: 1, sentWorkBy: [] });
    const [first, second] = t.messages().filter((message) => message.role === "user");
    expect(first).toMatchObject({ index: 1, via: "dispatch" });
    expect(first?.decisions?.map((decision) => [decision.kind, decision.worker, decision.environment, decision.status])).toEqual([
      ["create", "py-bench", "dispatch-python", "done"],
      ["create", "node-bench", "dispatch-node", "done"],
    ]);
    expect(second).toMatchObject({ index: 2, via: "other" });
    expect(second?.decisions?.[0]).toMatchObject({ kind: "message", worker: "py-bench", task: "Add insertion sort", status: "done" });
    expect(t.busy).toBe(false);
  });

  it("matches a later worker by ID even when a stopped one had the same name", () => {
    const t = transcript();
    apply(
      t,
      user("first"),
      start("c1", "start_worker", { name: "helper", task: "one" }),
      done("c1", `Started worker "helper" (ID ${WORKER_A}).`),
      start("c2", "stop_worker", { worker: "helper" }),
      done("c2", "Stopped."),
      user("second"),
      start("c3", "start_worker", { name: "helper", task: "two" }),
      done("c3", `Started worker "helper" (ID ${WORKER_B}).`),
    );
    expect(t.attribution({ id: WORKER_A, name: "helper" }).createdBy).toBe(1);
    expect(t.attribution({ id: WORKER_B, name: "helper" }).createdBy).toBe(2);
    // The default environment fills in when the coordinator names none.
    expect(t.messages()[0]?.decisions?.[0]?.environment).toBe("dispatch-python");
  });

  it("applies each persisted event once, so history and live delivery can overlap", () => {
    const t = transcript();
    const message = user("hello");
    const reply = event("assistant.message", { messageId: "a1", content: "Hi" });
    expect(apply(t, message, reply)).toEqual([true, true]);
    expect(apply(t, message, reply)).toEqual([false, false]);
    expect(t.messages()).toHaveLength(2);
  });

  it("streams replies and never reopens one that finished", () => {
    const t = transcript();
    apply(t, user("hello"), event("assistant.message_delta", { messageId: "a1", deltaContent: "Hel" }, { ephemeral: true }), event("assistant.message_delta", { messageId: "a1", deltaContent: "lo" }, { ephemeral: true }));
    expect(t.messages().at(-1)).toMatchObject({ role: "assistant", content: "Hello", streaming: true });
    apply(t, event("assistant.message", { messageId: "a1", content: "Hello!" }));
    expect(t.messages().at(-1)).toMatchObject({ content: "Hello!", streaming: false });
    // A delta that arrives after the message (live delivery overlapping a history load) is ignored.
    expect(apply(t, event("assistant.message_delta", { messageId: "a1", deltaContent: "late" }, { ephemeral: true }))).toEqual([false]);
    expect(t.messages()).toHaveLength(2);
  });

  it("shows sandbox requests from permission prompts, and a decline with the person's reason", () => {
    const t = transcript();
    apply(
      t,
      user("go"),
      event("permission.requested", { requestId: "r1", permissionRequest: { kind: "custom-tool", toolName: "start_worker", toolCallId: "c1", args: { name: "node-bench", environment: "dispatch-python", task: "JS" } } }),
    );
    expect(t.messages()[0]?.decisions?.[0]).toMatchObject({ kind: "create", status: "asking", worker: "node-bench", environment: "dispatch-python" });
    apply(t, event("permission.completed", { requestId: "r1", toolCallId: "c1", result: { kind: "denied-interactively-by-user", feedback: "The person declined this sandbox: use dispatch-node" } }));
    // The tool's own failure result doesn't overwrite the person's reason.
    apply(t, start("c1", "start_worker", { name: "node-bench" }), done("c1", "Permission denied", false));
    expect(t.messages()[0]?.decisions?.[0]).toMatchObject({ status: "denied", detail: "The person declined this sandbox: use dispatch-node" });
  });

  it("marks an approved request running, and ignores other tools' prompts", () => {
    const t = transcript();
    apply(
      t,
      user("go"),
      event("permission.requested", { requestId: "r0", permissionRequest: { kind: "shell", fullCommandText: "ls" } }),
      event("permission.requested", { requestId: "r1", permissionRequest: { kind: "custom-tool", toolName: "start_worker", toolCallId: "c1", args: { name: "w", task: "t" } } }),
      event("permission.completed", { requestId: "r1", result: { kind: "approved" } }),
    );
    expect(t.messages()[0]?.decisions).toHaveLength(1);
    expect(t.messages()[0]?.decisions?.[0]?.status).toBe("running");
    expect(t.messageIndexOf("c1")).toBe(1);
  });

  it("tracks waiting for workers and clears it when the wait returns", () => {
    const t = transcript();
    apply(t, user("go"), start("w1", "wait_for_workers", { workers: ["a", "b"] }));
    expect(t.waiting).toMatchObject({ workers: ["a", "b"], toolCallId: "w1" });
    apply(t, done("w1", "Both finished."));
    expect(t.waiting).toBeUndefined();
    expect(t.busy).toBe(true);
    apply(t, event("session.idle"));
    expect(t.busy).toBe(false);
  });

  it("leaves out autopilot continuations, skill prompts, subagents, and other tools", () => {
    const t = transcript();
    const results = apply(
      t,
      user("Continue", undefined, { isAutopilotContinuation: true }),
      user("Skill text", undefined, { source: "skill-review" }),
      event("assistant.message", { messageId: "s1", content: "sub" }, { agentId: "sub-agent" }),
      user("real"),
      start("x1", "bash", { command: "ls" }),
    );
    expect(results).toEqual([false, false, false, true, false]);
    expect(t.userMessages).toBe(1);
  });

  it("reports errors as notices and takes the runtime's title", () => {
    const t = transcript();
    apply(t, user("go"), event("session.error", { message: "Model unavailable", errorType: "model" }), event("session.title_changed", { title: "Sorting showdown" }));
    expect(t.messages().at(-1)).toMatchObject({ role: "notice", content: "Model unavailable", tone: "danger" });
    expect(t.title).toBe("Sorting showdown");
  });

  it("keeps outcomes to one line", () => {
    expect(firstLine("\n\n  Started worker x  \nmore")).toBe("Started worker x");
    expect(firstLine("a".repeat(300))?.length).toBe(220);
    expect(firstLine(undefined)).toBeUndefined();
  });
});
