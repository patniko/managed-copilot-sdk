import { describe, expect, it } from "vitest";
import { firstLine, mergeHistory, Transcript, type CoordinatorEvent } from "../src/server/projection.js";
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
    const workers = [
      { id: WORKER_A, name: "py-bench", createdAt: "2026-10-27T10:00:04.000Z" },
      { id: WORKER_B, name: "node-bench", createdAt: "2026-10-27T10:00:06.000Z" },
    ];
    const resolved = t.resolveWorkers(workers);
    expect(t.attribution(WORKER_A, resolved)).toEqual({ createdBy: 1, sentWorkBy: [2] });
    expect(t.attribution(WORKER_B, resolved)).toEqual({ createdBy: 1, sentWorkBy: [] });
    const [first, second] = t.messages(resolved).filter((message) => message.role === "user");
    expect(first).toMatchObject({ index: 1, via: "dispatch" });
    expect(first?.decisions?.map((decision) => [decision.kind, decision.worker, decision.environment, decision.status, decision.workerId])).toEqual([
      ["create", "py-bench", "dispatch-python", "done", WORKER_A],
      ["create", "node-bench", "dispatch-node", "done", WORKER_B],
    ]);
    expect(second).toMatchObject({ index: 2, via: "other" });
    expect(second?.decisions?.[0]).toMatchObject({ kind: "message", worker: "py-bench", task: "Add insertion sort", status: "done", workerId: WORKER_A });
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
    const resolved = t.resolveWorkers([
      { id: WORKER_A, name: "helper", createdAt: "2026-10-27T09:00:00.000Z" },
      { id: WORKER_B, name: "helper", createdAt: "2026-10-27T11:00:00.000Z" },
    ]);
    expect(t.attribution(WORKER_A, resolved).createdBy).toBe(1);
    expect(t.attribution(WORKER_B, resolved).createdBy).toBe(2);
    // The default environment fills in when the coordinator names none.
    expect(t.messages()[0]?.decisions?.[0]?.environment).toBe("dispatch-python");
  });

  it("never gives a reused name's pending creation, or its follow-ups, to the stopped worker that had it", () => {
    const t = transcript();
    const at = (seconds: number) => Date.parse("2026-10-27T12:00:00.000Z") + seconds * 1000;
    t.apply(event("user.message", { content: "first" }, { at: at(0) }) as unknown as CoordinatorEvent);
    t.apply(event("tool.execution_start", { toolCallId: "c1", toolName: "start_worker", arguments: { name: "helper", task: "one" } }, { at: at(1) }) as unknown as CoordinatorEvent);
    // The ID can't be read from the answer (another format): names and times decide.
    t.apply(event("tool.execution_complete", { toolCallId: "c1", success: true, result: { content: "Started." } }, { at: at(2) }) as unknown as CoordinatorEvent);
    t.apply(event("user.message", { content: "second" }, { at: at(600) }) as unknown as CoordinatorEvent);
    t.apply(event("tool.execution_start", { toolCallId: "c2", toolName: "start_worker", arguments: { name: "helper", task: "two" } }, { at: at(601) }) as unknown as CoordinatorEvent);
    t.apply(event("permission.requested", { requestId: "r2", permissionRequest: { kind: "custom-tool", toolName: "start_worker", toolCallId: "c2", args: { name: "helper", task: "two" } } }, { at: at(601) }) as unknown as CoordinatorEvent);
    const old = { id: WORKER_A, name: "helper", createdAt: new Date(at(2)).toISOString() };
    let resolved = t.resolveWorkers([old]);
    // While the second "helper" waits for approval, the first keeps only its own creation.
    expect(t.attribution(WORKER_A, resolved)).toEqual({ createdBy: 1, sentWorkBy: [] });
    t.apply(event("permission.completed", { requestId: "r2", toolCallId: "c2", result: { kind: "approved" } }, { at: at(700) }) as unknown as CoordinatorEvent);
    t.apply(event("tool.execution_complete", { toolCallId: "c2", success: true, result: { content: "Started." } }, { at: at(701) }) as unknown as CoordinatorEvent);
    t.apply(event("tool.execution_start", { toolCallId: "c3", toolName: "message_worker", arguments: { worker: "helper", message: "more" } }, { at: at(800) }) as unknown as CoordinatorEvent);
    resolved = t.resolveWorkers([old, { id: WORKER_B, name: "helper", createdAt: new Date(at(700)).toISOString() }]);
    expect(t.attribution(WORKER_A, resolved)).toEqual({ createdBy: 1, sentWorkBy: [] });
    expect(t.attribution(WORKER_B, resolved)).toEqual({ createdBy: 2, sentWorkBy: [2] });
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
    apply(t, event("session.idle", {}, { ephemeral: true }));
    expect(t.busy).toBe(false);
  });

  it("closes what a cut turn left open: on abort, and when the history shows the next turn starting", () => {
    const t = transcript();
    apply(
      t,
      user("go"),
      start("w1", "wait_for_workers", { workers: ["a"] }),
      start("c1", "start_worker", { name: "b", task: "t" }),
      event("permission.requested", { requestId: "r1", permissionRequest: { kind: "custom-tool", toolName: "start_worker", toolCallId: "c1", args: { name: "b", task: "t" } } }),
    );
    // The runtime restarted mid-turn: no completions, no idle (it's never persisted). The next turn starts.
    apply(t, user("are you there?"));
    const cut = t.messages()[0]?.decisions;
    expect(cut?.map((decision) => [decision.id, decision.status, decision.detail])).toEqual([
      ["w1", "failed", "Interrupted: the turn ended before this finished."],
      ["c1", "failed", "Cancelled before anyone answered."],
    ]);
    expect(cut?.every((decision) => decision.endedAt !== undefined)).toBe(true);
    expect(t.busy).toBe(true);

    apply(t, start("w2", "wait_for_workers", {}), event("abort", { reason: "user" }));
    expect(t.busy).toBe(false);
    expect(t.waiting).toBeUndefined();
    expect(t.messages()[1]?.decisions?.[0]).toMatchObject({ id: "w2", status: "failed" });
  });

  it("keeps a turn's open work when a message steers it", () => {
    const t = transcript();
    apply(t, user("go"), start("w1", "wait_for_workers", {}), user("how is it going?", undefined, { delivery: "steering" }));
    expect(t.messages()[0]?.decisions?.[0]).toMatchObject({ id: "w1", status: "running" });
    expect(t.waiting?.toolCallId).toBe("w1");
  });

  it("knows which sandbox requests were answered or withdrawn, wherever that happened", () => {
    const t = transcript();
    apply(t, user("go"), event("permission.requested", { requestId: "r1", permissionRequest: { kind: "custom-tool", toolName: "start_worker", toolCallId: "c1", args: {} } }));
    expect(t.isSettled("c1")).toBe(false);
    // Completed without a tool call ID: matched through the request.
    apply(t, event("permission.completed", { requestId: "r1", result: { kind: "approved" } }));
    expect(t.isSettled("c1")).toBe(true);
    expect(t.isSettled(undefined)).toBe(false);
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

describe("mergeHistory", () => {
  const e = (id: string, second: number, ephemeral = false) => ({ id, timestamp: new Date(Date.UTC(2026, 9, 27, 12, 0, second)).toISOString(), ephemeral });

  it("puts events delivered while the history loaded where they happened, without duplicates", () => {
    const history = [e("u1", 1), e("t1", 2), e("u2", 5)];
    // Live: the end of turn 1 (idle, never persisted), then turn 2's message, which the history already has.
    const live = [e("idle1", 3, true), e("u2", 5)];
    expect(mergeHistory(history, live).map((event) => event.id)).toEqual(["u1", "t1", "idle1", "u2"]);
  });

  it("keeps an earlier idle from undoing a newer turn", () => {
    const t = new Transcript(() => true);
    const history = [event("user.message", { content: "one" }, { at: Date.UTC(2026, 9, 27, 12, 0, 1) }), event("user.message", { content: "two" }, { at: Date.UTC(2026, 9, 27, 12, 0, 5) })];
    const live = [event("session.idle", {}, { ephemeral: true, at: Date.UTC(2026, 9, 27, 12, 0, 3) }), history[1]!];
    for (const value of mergeHistory(history, live)) t.apply(value as unknown as CoordinatorEvent);
    expect(t.busy).toBe(true);
  });

  it("appends what came after the history, in order, and places ties before history events", () => {
    const history = [e("a", 1), e("b", 2)];
    expect(mergeHistory(history, [e("delta", 2, true), e("c", 4), e("idle", 5, true)]).map((event) => event.id)).toEqual(["a", "delta", "b", "c", "idle"]);
    expect(mergeHistory([], [e("x", 1)]).map((event) => event.id)).toEqual(["x"]);
  });
});
