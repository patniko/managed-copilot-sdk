import { describe, expect, it } from "vitest";
import { firstLine, mergeHistory, parseCommandResult, Transcript, type CoordinatorEvent } from "../src/server/projection.js";
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

  it("leaves out autopilot continuations, skill prompts, sub-agents' messages, and other tools", () => {
    const t = transcript();
    const results = apply(
      t,
      user("Continue", undefined, { isAutopilotContinuation: true }),
      user("Skill text", undefined, { source: "skill-review" }),
      event("assistant.message", { messageId: "s1", content: "sub" }, { agentId: "sub-agent" }),
      user("real"),
      start("x1", "report_intent", { intent: "Exploring" }),
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
  const e = (id: string, second: number, ephemeral = false, type = "tool.execution_start") => ({ id, type, timestamp: new Date(Date.UTC(2026, 9, 27, 12, 0, second)).toISOString(), ephemeral });

  it("puts events delivered while the history loaded where they happened, without duplicates", () => {
    const history = [e("u1", 1, false, "user.message"), e("t1", 2), e("u2", 5, false, "user.message")];
    // Live: the end of turn 1 (idle, never persisted), then turn 2's message, which the history already has.
    const live = [e("idle1", 3, true, "session.idle"), e("u2", 5, false, "user.message")];
    expect(mergeHistory(history, live).map((event) => event.id)).toEqual(["u1", "t1", "idle1", "u2"]);
  });

  it("keeps an earlier idle from undoing a newer turn", () => {
    const t = new Transcript(() => true);
    const history = [event("user.message", { content: "one" }, { at: Date.UTC(2026, 9, 27, 12, 0, 1) }), event("user.message", { content: "two" }, { at: Date.UTC(2026, 9, 27, 12, 0, 5) })];
    const live = [event("session.idle", {}, { ephemeral: true, at: Date.UTC(2026, 9, 27, 12, 0, 3) }), history[1]!];
    for (const value of mergeHistory(history, live)) t.apply(value as unknown as CoordinatorEvent);
    expect(t.busy).toBe(true);
  });

  it("appends what came after the history in order; on a tie, follows its own turn's events but precedes a new turn", () => {
    const history = [e("a", 1), e("b", 2), e("u", 3, false, "user.message")];
    expect(mergeHistory(history, [e("delta", 2, true, "assistant.message_delta"), e("idle", 3, true, "session.idle"), e("c", 4)]).map((event) => event.id)).toEqual([
      "a",
      "b",
      "delta",
      "idle",
      "u",
      "c",
    ]);
    expect(mergeHistory([], [e("x", 1)]).map((event) => event.id)).toEqual(["x"]);
  });

  it("gets same-millisecond ties right: an idle before the next turn, after its own turn's reply", () => {
    const at = Date.UTC(2026, 9, 27, 12, 0, 5);
    // The idle ends turn one in the same millisecond the history shows turn two starting.
    const next = new Transcript(() => true);
    const one = event("user.message", { content: "one" }, { at: at - 4000 });
    const two = event("user.message", { content: "two" }, { at });
    for (const value of mergeHistory([one, two], [event("session.idle", {}, { ephemeral: true, at })])) next.apply(value as unknown as CoordinatorEvent);
    expect(next.busy).toBe(true);
    // The reply streamed live and completed in the same millisecond as the idle: one message, finished, turn over.
    const same = new Transcript(() => true);
    const history = [
      event("user.message", { content: "go" }, { at: at - 4000 }),
      event("tool.execution_start", { toolCallId: "w1", toolName: "wait_for_workers", arguments: {} }, { at: at - 3000 }),
      event("tool.execution_complete", { toolCallId: "w1", success: true, result: { content: "All done." } }, { at: at - 2000 }),
      event("assistant.message", { messageId: "a", content: "Here it is." }, { at }),
    ];
    const live = [event("assistant.message_delta", { messageId: "a", deltaContent: "Here" }, { ephemeral: true, at: at - 1000 }), event("session.idle", {}, { ephemeral: true, at })];
    for (const value of mergeHistory(history, live)) same.apply(value as unknown as CoordinatorEvent);
    expect(same.busy).toBe(false);
    expect(same.messages().filter((message) => message.role === "assistant")).toEqual([expect.objectContaining({ id: "assistant:a", content: "Here it is.", streaming: false })]);
    expect(same.messages()[0]?.decisions?.[0]).toMatchObject({ id: "w1", status: "done", detail: "All done." });
  });
});

describe("Transcript assistant messages", () => {
  it("keeps one message per ID, even when the turn's end arrives between its pieces", () => {
    const t = new Transcript(() => true);
    t.apply(event("user.message", { content: "go" }) as unknown as CoordinatorEvent);
    t.apply(event("assistant.message_delta", { messageId: "a", deltaContent: "Part" }, { ephemeral: true }) as unknown as CoordinatorEvent);
    t.apply(event("session.idle", {}, { ephemeral: true }) as unknown as CoordinatorEvent);
    t.apply(event("assistant.message_delta", { messageId: "a", deltaContent: "ial" }, { ephemeral: true }) as unknown as CoordinatorEvent);
    expect(t.messages().filter((message) => message.role === "assistant")).toEqual([expect.objectContaining({ content: "Partial", streaming: true })]);
    t.apply(event("assistant.message", { messageId: "a", content: "Partial answer." }) as unknown as CoordinatorEvent);
    expect(t.messages().filter((message) => message.role === "assistant")).toEqual([expect.objectContaining({ id: "assistant:a", content: "Partial answer.", streaming: false })]);
  });

  it("gives each user message its runtime ID", () => {
    const t = new Transcript(() => true);
    t.apply(event("user.message", { content: "go", messageId: "m-1" }) as unknown as CoordinatorEvent);
    expect(t.messages()[0]).toMatchObject({ role: "user", messageId: "m-1" });
  });

  it("completes a streamed reply whose final event arrives after the turn's end", () => {
    const t = new Transcript(() => true);
    t.apply(event("user.message", { content: "go" }) as unknown as CoordinatorEvent);
    t.apply(event("assistant.message_delta", { messageId: "a", deltaContent: "Here" }, { ephemeral: true }) as unknown as CoordinatorEvent);
    t.apply(event("session.idle", {}, { ephemeral: true }) as unknown as CoordinatorEvent);
    t.apply(event("assistant.message", { messageId: "a", content: "Here it is." }) as unknown as CoordinatorEvent);
    expect(t.messages().filter((message) => message.role === "assistant")).toEqual([expect.objectContaining({ id: "assistant:a", content: "Here it is.", streaming: false })]);
  });
});

describe("Commands (direct and mixed)", () => {
  const SUB_A = "8bb791c7-bec7-4d7a-8e67-5cb4895760bf";
  const SUB_B = "f730da91-3fc7-4552-b5f4-d56337cd5ade";
  const asked = (toolCallId: string, toolName: string, args: Record<string, unknown>, agentId?: string) =>
    event("permission.requested", { requestId: `r-${toolCallId}`, permissionRequest: { kind: "custom-tool", toolName, toolCallId, args } }, agentId ? { agentId } : {});
  const answered = (toolCallId: string, kind: string, agentId?: string, feedback?: string) =>
    event("permission.completed", { requestId: `r-${toolCallId}`, toolCallId, result: { kind, ...(feedback ? { feedback } : {}) } }, agentId ? { agentId } : {});
  const sub = (type: string, toolCallId: string, agentId: string, name: string) => event(type, { toolCallId, agentName: "general-purpose", agentDisplayName: name, agentDescription: "d" }, { agentId });
  const subStart = (toolCallId: string, toolName: string, args: Record<string, unknown>, agentId: string) => event("tool.execution_start", { toolCallId, toolName, arguments: args }, { agentId });
  const subDone = (toolCallId: string, content: string, agentId: string) => event("tool.execution_complete", { toolCallId, success: true, result: { content } }, { agentId });

  it("lists the commands the coordinator and its sub-agents ran, with who ran them, exit codes, and output", () => {
    const t = transcript();
    apply(
      t,
      user("Count primes and Fibonacci digits"),
      start("task-1", "task", { name: "count primes", description: "Count primes", agent_type: "general-purpose", prompt: "..." }),
      start("task-2", "task", { name: "fibonacci digits", prompt: "..." }),
      sub("subagent.started", "task-1", SUB_A, "count primes"),
      sub("subagent.started", "task-2", SUB_B, "fibonacci digits"),
      subStart("b1", "bash", { command: "python3 primes.py", description: "Count primes" }, SUB_A),
      asked("b1", "bash", { command: "python3 primes.py" }, SUB_A),
      answered("b1", "approved", SUB_A),
      subStart("b2", "bash", { command: "node -e 'x'" }, SUB_B),
      subDone("b1", "5133\n<exited with exit code 0; shellId: ex_1>", SUB_A),
      subDone("b2", "SyntaxError\n<exited with exit code 1; shellId: ex_2>", SUB_B),
      // Their own messages and reasoning stay theirs.
      event("assistant.message", { messageId: "s", content: "done" }, { agentId: SUB_A }),
      sub("subagent.completed", "task-1", SUB_A, "count primes"),
      sub("subagent.failed", "task-2", SUB_B, "fibonacci digits"),
      done("task-1", "5133"),
      start("c1", "create", { path: "/workspace/outputs/answers.md", file_text: "# Answers" }),
      done("c1", "Created file /workspace/outputs/answers.md with 9 characters."),
      start("c2", "bash", { command: "sleep 600", mode: "async" }),
      done("c2", "<command started in the background with shellId: ex_3. Use read_bash to read its output.>"),
      event("session.idle", {}, { ephemeral: true }),
    );
    const [message] = t.messages();
    expect(message?.decisions).toEqual([]);
    expect(message?.subagents).toEqual([
      expect.objectContaining({ id: SUB_A, toolCallId: "task-1", name: "count primes", description: "Count primes", type: "general-purpose", status: "done" }),
      expect.objectContaining({ id: SUB_B, toolCallId: "task-2", name: "fibonacci digits", status: "failed" }),
    ]);
    expect(message?.commands).toEqual([
      expect.objectContaining({ id: "b1", tool: "bash", kind: "run", agentId: SUB_A, command: "python3 primes.py", description: "Count primes", status: "done", exitCode: 0, output: "5133", shellId: "ex_1" }),
      expect.objectContaining({ id: "b2", agentId: SUB_B, status: "done", exitCode: 1, output: "SyntaxError", outcome: "exit code 1" }),
      expect.objectContaining({ id: "c1", tool: "create", kind: "create", path: "/workspace/outputs/answers.md", status: "done" }),
      expect.objectContaining({ id: "c2", kind: "run", outcome: "started in the background", shellId: "ex_3" }),
    ]);
    expect(message?.commands?.[2]).not.toHaveProperty("agentId");
    expect(t.agentNames()).toEqual({ [SUB_A]: "count primes", [SUB_B]: "fibonacci digits" });
    expect(t.handsAttribution(undefined, false)).toEqual({ createdBy: 1, sentWorkBy: [] });
  });

  it("follows a command's permission prompt: asking, approved, declined with a reason, or cut short", () => {
    const t = transcript();
    apply(t, user("go"), start("b1", "bash", { command: "rm -rf build" }), asked("b1", "bash", { command: "rm -rf build" }));
    expect(t.messages()[0]?.commands?.[0]).toMatchObject({ status: "asking" });
    expect(t.messageIndexOf("b1")).toBe(1);
    expect(t.isSettled("b1")).toBe(false);
    apply(t, answered("b1", "denied-interactively-by-user", undefined, "Don't delete the build"));
    expect(t.messages()[0]?.commands?.[0]).toMatchObject({ status: "denied", outcome: "Don't delete the build" });
    expect(t.isSettled("b1")).toBe(true);
    // A request known only from its prompt (the start comes later), then the turn ends unanswered.
    apply(t, asked("e1", "edit", { path: "/workspace/a.py", old_str: "x", new_str: "y" }), event("session.idle", {}, { ephemeral: true }));
    expect(t.messages()[0]?.commands?.[1]).toMatchObject({ id: "e1", kind: "edit", path: "/workspace/a.py", status: "failed", outcome: "Cancelled before anyone answered." });
    expect(t.isSettled("e1")).toBe(true);
    // Denied and unanswered calls don't count as using the sandbox.
    expect(t.handsAttribution(undefined, false)).toEqual({ sentWorkBy: [] });
  });

  it("rebuilds the same commands from history (sub-agent events are persisted)", () => {
    const events = [
      user("go"),
      start("task-1", "task", { name: "worker one", prompt: "p" }),
      sub("subagent.started", "task-1", SUB_A, "worker one"),
      subStart("b1", "bash", { command: "ls" }, SUB_A),
      subDone("b1", "a.txt\n<exited with exit code 0; shellId: ex_1>", SUB_A),
      sub("subagent.completed", "task-1", SUB_A, "worker one"),
      done("task-1", "ok"),
    ];
    const live = transcript();
    apply(live, ...events);
    const rebuilt = transcript();
    apply(rebuilt, ...events, ...events);
    expect(rebuilt.messages()).toEqual(live.messages());
  });

  it("attributes each sub-agent's own sandbox to the messages it ran commands for", () => {
    const t = transcript();
    apply(t, user("one"), start("task-1", "task", { name: "a", prompt: "p" }), sub("subagent.started", "task-1", SUB_A, "a"), subStart("b1", "bash", { command: "ls" }, SUB_A), subDone("b1", "<exited with exit code 0; shellId: x>", SUB_A));
    apply(t, user("two"), start("b2", "bash", { command: "pwd" }), done("b2", "/workspace\n<exited with exit code 0; shellId: y>"));
    expect(t.handsAttribution(SUB_A, true)).toEqual({ createdBy: 1, sentWorkBy: [] });
    expect(t.handsAttribution(undefined, true)).toEqual({ createdBy: 2, sentWorkBy: [] });
    expect(t.handsAttribution(undefined, false)).toEqual({ createdBy: 1, sentWorkBy: [2] });
  });

  it("parses the platform's command status lines", () => {
    expect(parseCommandResult("out\n<exited with exit code 3; shellId: ex_9>")).toEqual({ output: "out", outcome: "exit code 3", exitCode: 3, shellId: "ex_9" });
    expect(parseCommandResult("partial\n<command with shellId: ex_1 is still running after 120 seconds. It keeps running: use read_bash.>")).toMatchObject({ output: "partial", outcome: "still running", running: true, shellId: "ex_1" });
    expect(parseCommandResult("<timed out; shellId: ex_2>")).toMatchObject({ outcome: "timed out", shellId: "ex_2" });
    expect(parseCommandResult("just text")).toEqual({ output: "just text" });
    expect(parseCommandResult(`${"x".repeat(3000)}\n<exited with exit code 0; shellId: e>`).output.length).toBeLessThanOrEqual(2001);
  });
});
