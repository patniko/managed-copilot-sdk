import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionConfig } from "@github/copilot-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Conversation, SYSTEM_MESSAGE, titleFrom, visibleFiles } from "../src/server/conversation.js";
import { EventHub } from "../src/server/hub.js";
import { ConversationManager } from "../src/server/manager.js";
import { digest, Store } from "../src/server/store.js";
import type { ServerEvent } from "../src/shared/types.js";
import { event, FakePlatform, FakeSession, info, settle, testConfig, worker } from "./fakes.js";

const WORKER_A = "11111111-1111-4111-8111-111111111111";

const user = (content: string, messageId?: string) => event("user.message", { content, ...(messageId ? { messageId } : {}) });
const start = (toolCallId: string, toolName: string, args: Record<string, unknown>) => event("tool.execution_start", { toolCallId, toolName, arguments: args });
const done = (toolCallId: string, content: string) => event("tool.execution_complete", { toolCallId, success: true, result: { content } });
const startWorker = (toolCallId: string, name: string, environment: string) => ({ kind: "custom-tool", toolName: "start_worker", toolCallId, toolDescription: "", args: { name, environment, task: `Task for ${name}` } });

describe("ConversationManager", () => {
  let dir: string;
  let platform: FakePlatform;
  let store: Store;
  let hub: EventHub;
  let manager: ConversationManager;
  let published: ServerEvent[];

  const begin = (): void => {
    manager = new ConversationManager(platform, testConfig(dir), store, hub);
    manager.start();
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-test-"));
    platform = new FakePlatform();
    store = new Store(dir);
    hub = new EventHub();
    published = [];
    hub.subscribe((value) => published.push(value));
  });

  afterEach(async () => {
    await manager?.close();
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts a conversation as a stock session of the orchestrator environment and sends the first message", async () => {
    begin();
    const view = await manager.create("Benchmark three sorts in Python and JavaScript", "ask");
    const session = platform.sessions.get(view.id)!;
    expect(platform.created[0]).toMatchObject({ model: "claude-sonnet-5", streaming: true, systemMessage: { content: SYSTEM_MESSAGE } });
    expect(session.sent).toEqual([{ prompt: "Benchmark three sorts in Python and JavaScript" }]);
    expect(store.get(view.id)).toMatchObject({ title: "Benchmark three sorts in Python and JavaScript", settings: { approvals: "ask" } });

    // The runtime confirms the message with the ID `send` returned: it's labelled as sent from Dispatch.
    session.emit(user("Benchmark three sorts in Python and JavaScript", `${view.id}-message-1`));
    session.emit(user("How far along is it?", "cli-message"));
    const current = await manager.view(view.id);
    expect(current.messages.map((message) => [message.index, message.via])).toEqual([
      [1, "dispatch"],
      [2, "other"],
    ]);
    expect(current).toMatchObject({ busy: true, status: "working", messageCount: 2 });
  });

  it("sends a message while the coordinator works as an immediate one, and an ordinary one otherwise", async () => {
    begin();
    const view = await manager.create("go", "ask");
    const session = platform.sessions.get(view.id)!;
    session.emit(user("go", `${view.id}-message-1`));
    await manager.send(view.id, "How is it going?");
    expect(session.sent.at(-1)).toEqual({ prompt: "How is it going?", mode: "immediate" });
    session.emit(event("session.idle"));
    await manager.send(view.id, "Next, add a chart");
    expect(session.sent.at(-1)).toEqual({ prompt: "Next, add a chart" });
  });

  it("asks before each new sandbox and gives the coordinator the person's answer", async () => {
    begin();
    const view = await manager.create("go", "ask");
    const session = platform.sessions.get(view.id)!;
    session.emit(user("go", `${view.id}-message-1`));
    const answer = session.ask(startWorker("c1", "py-bench", "dispatch-python"));
    await settle();
    const asking = await manager.view(view.id);
    expect(asking.status).toBe("asking");
    expect(asking.approvals).toEqual([expect.objectContaining({ id: "c1", decisionId: "c1", worker: "py-bench", environment: "dispatch-python", task: "Task for py-bench", messageIndex: 1 })]);

    manager.answer(view.id, "c1", true);
    await expect(answer).resolves.toEqual({ kind: "approve-once", approvedInteractively: true });
    expect((await manager.view(view.id)).approvals).toEqual([]);
    expect(() => manager.answer(view.id, "c1", true)).toThrow(/already answered/);
  });

  it("passes the person's reason for declining to the coordinator", async () => {
    begin();
    const view = await manager.create("go", "ask");
    const session = platform.sessions.get(view.id)!;
    session.emit(user("go"));
    session.emit(start("c2", "start_worker", { name: "node-bench", environment: "dispatch-python", task: "JS" }));
    const answer = session.ask(startWorker("c2", "node-bench", "dispatch-python"));
    await settle();
    manager.answer(view.id, "c2", false, "  This is Node work:\n use dispatch-node ");
    await expect(answer).resolves.toEqual({ kind: "reject", feedback: "The person declined this sandbox: This is Node work: use dispatch-node" });
    const decision = (await manager.view(view.id)).messages[0]?.decisions?.[0];
    expect(decision).toMatchObject({ status: "denied", detail: "The person declined this sandbox: This is Node work: use dispatch-node" });
  });

  it("creates sandboxes without asking in auto mode; switching to auto approves what's waiting", async () => {
    begin();
    const auto = await manager.create("go", "auto");
    await expect(platform.sessions.get(auto.id)!.ask(startWorker("c1", "a", "dispatch-python"))).resolves.toEqual({ kind: "approve-once" });

    const ask = await manager.create("go", "ask");
    const pending = platform.sessions.get(ask.id)!.ask(startWorker("c2", "b", "dispatch-node"));
    await settle();
    const view = manager.setSettings(ask.id, { approvals: "auto" });
    await expect(pending).resolves.toEqual({ kind: "approve-once", approvedInteractively: true });
    expect(view.settings).toEqual({ approvals: "auto" });
    expect(store.get(ask.id)?.settings).toEqual({ approvals: "auto" });
  });

  it("approves the coordinator's own platform tools without asking", async () => {
    begin();
    const view = await manager.create("go", "ask");
    await expect(platform.sessions.get(view.id)!.ask({ kind: "custom-tool", toolName: "web_fetch", toolDescription: "", args: {} })).resolves.toEqual({ kind: "approve-once" });
  });

  it("drops a sandbox request answered in Copilot CLI, and lets go of its callback", async () => {
    begin();
    const view = await manager.create("go", "ask");
    const session = platform.sessions.get(view.id)!;
    session.emit(user("go", `${view.id}-message-1`));
    session.emit(start("c1", "start_worker", { name: "py", environment: "dispatch-python", task: "t" }));
    session.emit(event("permission.requested", { requestId: "r1", permissionRequest: startWorker("c1", "py", "dispatch-python") }));
    const answer = session.ask(startWorker("c1", "py", "dispatch-python"));
    await settle();
    expect((await manager.view(view.id)).approvals).toHaveLength(1);
    session.emit(event("permission.completed", { requestId: "r1", toolCallId: "c1", result: { kind: "approved" } }));
    await expect(answer).resolves.toEqual({ kind: "no-result" });
    const current = await manager.view(view.id);
    expect(current.approvals).toEqual([]);
    expect(current.status).toBe("working");
    expect(() => manager.answer(view.id, "c1", true)).toThrow(/already answered/);
  });

  it("lets go of requests when their turn ends", async () => {
    begin();
    const view = await manager.create("go", "ask");
    const session = platform.sessions.get(view.id)!;
    session.emit(user("go", `${view.id}-message-1`));
    const answer = session.ask(startWorker("c1", "py", "dispatch-python"));
    await settle();
    session.emit(event("session.idle", {}, { ephemeral: true }));
    await expect(answer).resolves.toEqual({ kind: "no-result" });
    expect(await manager.view(view.id)).toMatchObject({ approvals: [], status: "idle", busy: false });
  });

  it("doesn't ask again for a request the history shows was already answered", async () => {
    const session = new FakeSession("answered", {} as SessionConfig);
    session.history.push(
      user("go", "m1"),
      start("c1", "start_worker", { name: "py", task: "t" }),
      event("permission.requested", { requestId: "r1", permissionRequest: startWorker("c1", "py", "dispatch-python") }),
      event("permission.completed", { requestId: "r1", toolCallId: "c1", result: { kind: "approved" } }),
    );
    platform.sessions.set("answered", session);
    platform.listed.set("answered", info("answered"));
    // A stale delivery of the same prompt arrives while the history loads.
    platform.pendingPrompts.set("answered", [startWorker("c1", "py", "dispatch-python")]);
    begin();
    await manager.sync();
    await settle();
    expect((await manager.view("answered")).approvals).toEqual([]);
  });

  it("lets go of a request whose turn ended while the history loaded", async () => {
    const session = new FakeSession("ended", {} as SessionConfig);
    const t = (second: number) => Date.UTC(2026, 9, 27, 12, 0, second);
    session.history.push(
      event("user.message", { content: "go", messageId: "m1" }, { at: t(1) }),
      event("tool.execution_start", { toolCallId: "c1", toolName: "start_worker", arguments: { name: "py", task: "t" } }, { at: t(2) }),
      event("permission.requested", { requestId: "r1", permissionRequest: startWorker("c1", "py", "dispatch-python") }, { at: t(2) }),
    );
    session.getEvents = async () => {
      // The turn ends (for example cancelled elsewhere) while the history is being read.
      session.handlers.onEvent?.(event("session.idle", {}, { ephemeral: true, at: t(4) }));
      return [...session.history];
    };
    platform.sessions.set("ended", session);
    platform.listed.set("ended", info("ended"));
    platform.pendingPrompts.set("ended", [startWorker("c1", "py", "dispatch-python")]);
    begin();
    await manager.sync();
    await settle();
    expect(await manager.view("ended")).toMatchObject({ approvals: [], busy: false, status: "idle" });
  });

  it("keeps conversations a capped list leaves out, and drops only ones confirmed gone", async () => {
    for (const id of ["older", "deleted"]) {
      store.ensure(id, { settings: { approvals: "ask" } });
      platform.sessions.set(id, new FakeSession(id, {} as SessionConfig));
    }
    // "older" still exists but is beyond the list's limit; "deleted" is gone.
    platform.listed.set("older", info("older"));
    platform.listSessions = async () => [];
    begin();
    await manager.sync();
    expect(manager.summaries().map((summary) => summary.id)).toEqual(["older"]);
    expect(store.get("deleted")).toBeUndefined();
    expect(store.get("older")).toBeDefined();
  });

  it("doesn't ask for a request whose turn the platform reports finished", async () => {
    const session = new FakeSession("cut", {} as SessionConfig);
    session.history.push(
      user("go", "m1"),
      start("c1", "start_worker", { name: "py", task: "t" }),
      event("permission.requested", { requestId: "r1", permissionRequest: startWorker("c1", "py", "dispatch-python") }),
    );
    platform.sessions.set("cut", session);
    // The runtime restarted mid-turn; core ended the turn.
    platform.listed.set("cut", info("cut", { lastTurn: { turnId: "t1", status: "failed", completedAt: "2026-10-27T10:05:00.000Z" } }));
    platform.pendingPrompts.set("cut", [startWorker("c1", "py", "dispatch-python")]);
    begin();
    await manager.sync();
    await settle();
    const view = await manager.view("cut");
    expect(view).toMatchObject({ approvals: [], busy: false, status: "idle" });
    expect(view.messages[0]?.decisions?.[0]).toMatchObject({ id: "c1", status: "failed", detail: "Cancelled before anyone answered." });
  });

  it("keeps a conversation started while discovery reads the list, and doesn't revive one deleted meanwhile", async () => {
    begin();
    const doomed = await manager.create("delete me", "ask");
    const releases: ((sessions: Awaited<ReturnType<FakePlatform["listSessions"]>>) => void)[] = [];
    // The list is read before both changes below (one list per style's environment).
    const snapshot = [info(doomed.id)];
    platform.listSessions = () => new Promise((resolve) => releases.push(resolve));
    const syncing = manager.sync();
    await settle();
    const fresh = await manager.create("new one", "ask");
    await manager.delete(doomed.id);
    releases.forEach((release, index) => release(index === 0 ? snapshot : []));
    await syncing;
    expect(manager.summaries().map((summary) => summary.id)).toEqual([fresh.id]);
    // The deleted one wasn't brought back, not even briefly (it would be resumed, then found gone).
    expect(platform.resumeAttempts).not.toContain(doomed.id);
    await expect(manager.send(fresh.id, "still here?")).resolves.toEqual(expect.any(String));
  });

  it("keeps a conversation usable when deleting it fails", async () => {
    begin();
    const view = await manager.create("go", "ask");
    const remove = platform.deleteSession.bind(platform);
    platform.deleteSession = async () => {
      throw new Error("gateway timeout");
    };
    await expect(manager.delete(view.id)).rejects.toMatchObject({ code: "delete_failed", status: 502 });
    platform.deleteSession = remove;
    const resumes = platform.resumed.length;
    await manager.view(view.id);
    expect(platform.resumed.length).toBe(resumes + 1);
    await expect(manager.send(view.id, "still here?")).resolves.toEqual(expect.any(String));
  });

  it("attaches on the new connection when a reconnect cuts an attach short", async () => {
    const session = new FakeSession("slow", {} as SessionConfig);
    session.history.push(user("go", "m1"));
    platform.sessions.set("slow", session);
    platform.listed.set("slow", info("slow"));
    begin();
    const resume = platform.resumeSession.bind(platform);
    let release: () => void = () => undefined;
    let calls = 0;
    platform.resumeSession = async (id, config) => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
      return resume(id, config);
    };
    const conversation = new Conversation(manager, "slow");
    const first = conversation.attach();
    await settle();
    conversation.detach();
    const second = conversation.attach();
    await second;
    release();
    await first;
    expect(calls).toBe(2);
    expect(conversation.attached).toBe(true);
    conversation.dispose();
  });

  it("puts events delivered while the history loads in order, so a newer turn stays busy", async () => {
    const session = new FakeSession("overlap", {} as SessionConfig);
    const t = (second: number) => Date.UTC(2026, 9, 27, 12, 0, second);
    const newer = event("user.message", { content: "two", messageId: "m2" }, { at: t(5) });
    session.history.push(event("user.message", { content: "one", messageId: "m1" }, { at: t(1) }), newer);
    session.getEvents = async () => {
      // Live delivery during the load: the end of turn one (never persisted), then turn two, which the history has.
      session.handlers.onEvent?.(event("session.idle", {}, { ephemeral: true, at: t(3) }));
      session.handlers.onEvent?.(newer);
      return [...session.history];
    };
    platform.sessions.set("overlap", session);
    platform.listed.set("overlap", info("overlap"));
    begin();
    await manager.sync();
    expect(await manager.view("overlap")).toMatchObject({ busy: true, status: "working" });
  });

  it("labels messages by ID: the same words from Copilot CLI aren't Dispatch's", async () => {
    const session = new FakeSession("labels", {} as SessionConfig);
    session.history.push(user("continue", "from-dispatch"), event("session.idle", {}, { ephemeral: true }), user("continue", "from-cli"));
    platform.sessions.set("labels", session);
    platform.listed.set("labels", info("labels"));
    store.ensure("labels", { settings: { approvals: "ask" } });
    store.addOwn("labels", { id: "from-dispatch", digest: digest("continue") });
    begin();
    await manager.sync();
    expect((await manager.view("labels")).messages.map((message) => message.via)).toEqual(["dispatch", "other"]);
  });

  it("resumes conversations after connecting: rebuilds them from their history and shows prompts still waiting", async () => {
    // A conversation from an earlier run of Dispatch, with a sandbox request nobody answered yet.
    const session = new FakeSession("earlier", {} as SessionConfig);
    session.history.push(
      user("Estimate pi three ways", "sent-earlier"),
      event("permission.requested", { requestId: "r1", permissionRequest: startWorker("c1", "monte-carlo", "dispatch-python") }),
      // Typed in Copilot CLI while the turn waited for the answer: queued behind it, not a new turn.
      event("user.message", { content: "Use a million samples", messageId: "from-cli", delivery: "queued" }),
    );
    platform.sessions.set("earlier", session);
    platform.listed.set("earlier", info("earlier", { title: "Estimate pi three ways" }));
    platform.pendingPrompts.set("earlier", [startWorker("c1", "monte-carlo", "dispatch-python")]);
    store.ensure("earlier", { settings: { approvals: "ask" } });
    store.addOwn("earlier", { id: "sent-earlier", digest: digest("Estimate pi three ways") });
    begin();

    await manager.sync();
    await settle();
    const view = await manager.view("earlier");
    expect(platform.resumed[0]?.config).toMatchObject({ continuePendingWork: true, suppressResumeEvent: true, streaming: true });
    expect(view.messages.map((message) => [message.content, message.via])).toEqual([
      ["Estimate pi three ways", "dispatch"],
      ["Use a million samples", "other"],
    ]);
    // The prompt came back on the new connection; it belongs to message #1 and keeps its original time.
    expect(view.approvals).toEqual([expect.objectContaining({ id: "c1", worker: "monte-carlo", messageIndex: 1, requestedAt: session.history[1]!.timestamp })]);
    expect(view.status).toBe("asking");
  });

  it("drops conversations deleted elsewhere and adopts ones it didn't know about", async () => {
    store.ensure("gone", { settings: { approvals: "ask" } });
    platform.sessions.set("new", new FakeSession("new", {} as SessionConfig));
    platform.listed.set("new", info("new", { title: "Started from another app" }));
    begin();
    expect(manager.summaries().map((summary) => summary.id)).toEqual(["gone"]);
    await manager.sync();
    expect(manager.summaries().map((summary) => [summary.id, summary.title])).toEqual([["new", "Started from another app"]]);
    expect(store.get("gone")).toBeUndefined();
    expect(published).toContainEqual({ type: "removed", id: "gone" });
  });

  it("shows each worker with its sandbox, timeline, outputs, files, and the messages that created it", async () => {
    begin();
    const view = await manager.create("go", "auto");
    const session = platform.sessions.get(view.id)!;
    session.emit(user("go", `${view.id}-message-1`));
    session.emit(start("c1", "start_worker", { name: "py-bench", environment: "dispatch-python", task: "Time the sorts" }));
    session.emit(done("c1", `Started worker "py-bench" (ID ${WORKER_A}) in environment dispatch-python.`));
    platform.workerLists.set(view.id, [worker({ id: WORKER_A, name: "py-bench", coordinatorId: view.id, state: "working", createdAt: "2026-10-27T10:00:05.000Z", updatedAt: "2026-10-27T10:00:09.000Z" })]);
    platform.infos.set(WORKER_A, info(WORKER_A, { environment: "dispatch-python", sandbox: { id: "sbx_1", size: "medium", state: "running", network: { access: "disabled", allowedDomains: [] } } }));
    platform.workerEvent({ id: "p1", type: "worker.started", createdAt: "2026-10-27T10:00:05.000Z", sessionId: view.id, data: { workerId: WORKER_A, name: "py-bench", environment: "dispatch-python", state: "starting" } });
    await settle(250);
    let current = await manager.view(view.id);
    expect(current.workers[0]).toMatchObject({ id: WORKER_A, state: "working", createdBy: 1, sentWorkBy: [], sandbox: { id: "sbx_1", state: "running", size: "medium" } });
    expect(current.workers[0]?.timeline.map((entry) => entry.state)).toEqual(["starting", "working"]);
    expect(current).toMatchObject({ sandboxCount: 1, liveSandboxes: 1 });

    platform.workerLists.set(view.id, [worker({ id: WORKER_A, name: "py-bench", coordinatorId: view.id, state: "idle", result: "Quicksort: 412 ms", updatedAt: "2026-10-27T10:01:00.000Z" })]);
    platform.artifactLists.set(WORKER_A, [{ id: "a1", path: "results.json", size: 20, digest: "x", turnId: "t", version: 1, state: "published" }]);
    platform.fileLists.set(WORKER_A, [
      { path: "bench.py", type: "file", size: 120, modifiedAt: "2026-10-27T10:00:30.000Z" },
      { path: "node_modules/x/index.js", type: "file", size: 5, modifiedAt: "2026-10-27T10:00:30.000Z" },
      { path: "outputs", type: "directory", size: 0, modifiedAt: "2026-10-27T10:00:30.000Z" },
    ]);
    platform.workerEvent({ id: "p2", type: "worker.idle", createdAt: "2026-10-27T10:01:00.000Z", sessionId: view.id, data: { workerId: WORKER_A, name: "py-bench", environment: "dispatch-python", state: "idle" } });
    await settle(250);
    current = await manager.view(view.id);
    expect(current.workers[0]).toMatchObject({ state: "idle", result: "Quicksort: 412 ms", outputs: ["results.json"], files: [{ path: "bench.py", size: 120 }] });
    expect(current.workers[0]?.timeline.map((entry) => entry.state)).toEqual(["starting", "working", "idle"]);
  });

  it("reads only files inside one of the conversation's workers", async () => {
    begin();
    const view = await manager.create("go", "auto");
    platform.workerLists.set(view.id, [worker({ id: WORKER_A, name: "py-bench", coordinatorId: view.id })]);
    await manager.view(view.id);
    platform.workerEvent({ id: "p1", type: "worker.started", createdAt: "2026-10-27T10:00:05.000Z", sessionId: view.id, data: { workerId: WORKER_A, state: "working" } });
    await settle(250);
    platform.fileContents.set(`${WORKER_A}:outputs/report.md`, "# Report");
    platform.fileContents.set(`${WORKER_A}:data.bin`, "\u0000\u0001");
    await expect(manager.readFile(view.id, WORKER_A, "/outputs/report.md")).resolves.toEqual({ path: "outputs/report.md", content: "# Report", truncated: false, binary: false });
    await expect(manager.readFile(view.id, WORKER_A, "data.bin")).resolves.toMatchObject({ binary: true, content: "" });
    await expect(manager.readFile(view.id, WORKER_A, "../secrets")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(manager.readFile(view.id, WORKER_A, "a//b")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(manager.readFile(view.id, "someone-else", "x")).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(manager.owns(WORKER_A)).toBe(true);
    expect(manager.owns(view.id)).toBe(true);
    expect(manager.owns("unrelated")).toBe(false);
  });

  it("deletes the coordinator session, which deletes its workers", async () => {
    begin();
    const view = await manager.create("go", "ask");
    await manager.delete(view.id);
    expect(platform.deleted).toEqual([view.id]);
    expect(platform.sessions.get(view.id)?.disconnected).toBe(true);
    expect(manager.summaries()).toEqual([]);
    expect(store.get(view.id)).toBeUndefined();
    expect(published).toContainEqual({ type: "removed", id: view.id });
    await expect(manager.view(view.id)).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("deletes a new conversation whose first message couldn't be sent", async () => {
    begin();
    const create = platform.createSession.bind(platform);
    platform.createSession = async (config) => {
      const session = await create(config);
      session.send = async () => {
        throw new Error("connection closed");
      };
      return session;
    };
    await expect(manager.create("go", "ask")).rejects.toMatchObject({ code: "send_failed", status: 502, message: "Your message wasn't delivered: connection closed" });
    expect(platform.deleted).toEqual(["session-1"]);
    expect(manager.summaries()).toEqual([]);
  });

  it("explains why it can't work while Managed Copilot is unavailable, and checks messages", async () => {
    begin();
    await expect(manager.create("   ", "ask")).rejects.toMatchObject({ code: "invalid_request", message: "Write a message first." });
    await expect(manager.create("x".repeat(20_001), "ask")).rejects.toMatchObject({ code: "invalid_request" });
    platform.status = { state: "unavailable", message: "Managed Copilot isn't reachable yet." };
    await expect(manager.create("go", "ask")).rejects.toMatchObject({ code: "platform_unavailable", status: 503, message: "Managed Copilot isn't reachable yet." });
  });

  describe("execution styles", () => {
    const SUB = "8bb791c7-bec7-4d7a-8e67-5cb4895760bf";
    const HANDS = "33333333-3333-4333-8333-333333333333";
    const bash = (toolCallId: string, command: string) => ({ kind: "custom-tool", toolName: "bash", toolCallId, toolDescription: "", args: { command } });

    it("creates each conversation in its style's orchestrator environment, with that style's instructions", async () => {
      begin();
      const direct = await manager.create("Count primes", "ask", "direct");
      const mixed = await manager.create("Count primes", "ask", "mixed");
      const delegate = await manager.create("Count primes", "ask");
      expect(platform.createdIn).toEqual(["dispatch-direct", "dispatch-mixed", "dispatch"]);
      expect(platform.created[0]?.systemMessage?.content).toMatch(/working directly/);
      expect(platform.created[0]?.systemMessage?.content).not.toMatch(/start_worker/);
      expect(platform.created[1]?.systemMessage?.content).toMatch(/start_worker/);
      expect(platform.created[2]?.systemMessage).toEqual({ content: SYSTEM_MESSAGE });
      expect([direct, mixed, delegate].map((view) => [view.style, view.environment])).toEqual([
        ["direct", "dispatch-direct"],
        ["mixed", "dispatch-mixed"],
        ["delegate", "dispatch"],
      ]);
      expect(manager.state()).toMatchObject({ defaults: { style: "delegate" }, styles: platform.styles });
    });

    it("refuses a style this deployment doesn't declare, saying why", async () => {
      platform.styles = platform.styles.map((style) => (style.style === "mixed" ? { ...style, available: false, reason: 'This deployment has no "dispatch-mixed" environment.' } : style));
      begin();
      await expect(manager.create("go", "ask", "mixed")).rejects.toMatchObject({ code: "style_unavailable", status: 409, message: 'This deployment has no "dispatch-mixed" environment.' });
    });

    it("finds conversations in every style's environment after a restart and resumes them there", async () => {
      const session = new FakeSession("direct-1", {} as SessionConfig);
      session.history.push(user("go", "m1"), start("b1", "bash", { command: "ls" }), done("b1", "a.txt\n<exited with exit code 0; shellId: ex_1>"));
      platform.sessions.set("direct-1", session);
      platform.listed.set("direct-1", info("direct-1", { environment: "dispatch-direct" }));
      begin();
      await manager.sync();
      const view = await manager.view("direct-1");
      expect(view).toMatchObject({ style: "direct", environment: "dispatch-direct" });
      expect(platform.resumed.at(-1)).toMatchObject({ sessionId: "direct-1", environment: "dispatch-direct" });
      expect(view.messages[0]?.commands).toEqual([expect.objectContaining({ id: "b1", command: "ls", exitCode: 0, output: "a.txt" })]);
      expect(store.get("direct-1")?.environment).toBe("dispatch-direct");
    });

    it("asks before each command, and approving the rest of a message covers its later commands only", async () => {
      begin();
      const view = await manager.create("go", "ask", "direct");
      const session = platform.sessions.get(view.id)!;
      session.emit(user("go", `${view.id}-message-1`));
      session.emit(event("tool.execution_start", { toolCallId: "b1", toolName: "bash", arguments: { command: "python3 a.py" } }, { agentId: SUB }));
      session.emit(start("b2", "bash", { command: "ls" }));
      const first = session.ask(bash("b1", "python3 a.py"));
      const second = session.ask(bash("b2", "ls"));
      // Reading never asks.
      await expect(session.ask({ kind: "custom-tool", toolName: "view", toolCallId: "v1", toolDescription: "", args: { path: "/workspace" } })).resolves.toEqual({ kind: "approve-once" });
      await settle();
      const asking = await manager.view(view.id);
      expect(asking.status).toBe("asking");
      expect(asking.approvals).toEqual([
        expect.objectContaining({ id: "b1", kind: "command", tool: "bash", command: "python3 a.py", agentId: SUB, messageIndex: 1 }),
        expect.objectContaining({ id: "b2", kind: "command", tool: "bash", command: "ls", messageIndex: 1 }),
      ]);
      expect(asking.messages[0]?.commands?.map((command) => command.status)).toEqual(["asking", "asking"]);

      manager.answer(view.id, "b1", true, undefined, true);
      await expect(first).resolves.toEqual({ kind: "approve-once", approvedInteractively: true });
      await expect(second).resolves.toEqual({ kind: "approve-once", approvedInteractively: true });
      expect(store.get(view.id)?.approvedRest).toEqual([1]);
      expect((await manager.view(view.id)).approvedRest).toEqual([1]);
      session.emit(start("b3", "create", { path: "/workspace/x.py", file_text: "print(1)" }));
      await expect(session.ask({ kind: "custom-tool", toolName: "create", toolCallId: "b3", toolDescription: "", args: { path: "/workspace/x.py" } })).resolves.toEqual({ kind: "approve-once" });

      // The next message asks again; declining tells the agent why.
      session.emit(event("session.idle", {}, { ephemeral: true }));
      session.emit(user("now delete it", `${view.id}-message-2`));
      session.emit(start("b4", "bash", { command: "rm x.py" }));
      const fourth = session.ask(bash("b4", "rm x.py"));
      await settle();
      expect((await manager.view(view.id)).approvals).toEqual([expect.objectContaining({ id: "b4", messageIndex: 2 })]);
      manager.answer(view.id, "b4", false, "keep it");
      await expect(fourth).resolves.toEqual({ kind: "reject", feedback: "The person declined this command: keep it" });
      expect((await manager.view(view.id)).messages[1]?.commands?.[0]).toMatchObject({ status: "denied", outcome: "The person declined this command: keep it" });
    });

    it("doesn't let 'approve the rest' of one message answer a request redelivered for a later one", async () => {
      begin();
      const view = await manager.create("go", "ask", "direct");
      const session = platform.sessions.get(view.id)!;
      session.emit(user("go", `${view.id}-message-1`));
      session.emit(start("b1", "bash", { command: "ls" }));
      const first = session.ask(bash("b1", "ls"));
      await settle();
      manager.answer(view.id, "b1", true, undefined, true);
      await first;
      // While Dispatch is away, message #2 starts and asks; the platform delivers the prompt again on resume.
      session.history.push(event("session.idle"), user("now delete it", "m2"), start("b2", "bash", { command: "rm -rf out" }));
      platform.pendingPrompts.set(view.id, [bash("b2", "rm -rf out")]);
      platform.connect();
      await settle(50);
      const current = await manager.view(view.id);
      expect(current.approvals).toEqual([expect.objectContaining({ id: "b2", kind: "command", messageIndex: 2 })]);
    });

    it("runs commands without asking in auto mode", async () => {
      begin();
      const view = await manager.create("go", "auto", "direct");
      await expect(platform.sessions.get(view.id)!.ask(bash("b1", "ls"))).resolves.toEqual({ kind: "approve-once" });
    });

    it("shows the coordinator's own sandbox, and lists the commands the platform recorded in it", async () => {
      begin();
      const view = await manager.create("go", "ask", "direct");
      const session = platform.sessions.get(view.id)!;
      session.emit(user("go", `${view.id}-message-1`));
      session.emit(start("b1", "bash", { command: "ls" }));
      platform.workerLists.set(view.id, [worker({ id: HANDS, name: "hands", role: "hands", coordinatorId: view.id, state: "idle", task: "Sandbox the coordinator works in directly.", messages: 0 })]);
      platform.execLists.set(HANDS, [
        { id: "ex_1", sessionId: HANDS, command: "ls", state: "completed", background: false, exitCode: 0, startedAt: "2026-10-27T10:00:07.000Z", finishedAt: "2026-10-27T10:00:08.000Z", outputBytes: 6, caller: { kind: "platform", name: "bash", agentId: SUB } },
        { id: "ex_2", sessionId: HANDS, command: "pwd", state: "running", background: true, startedAt: "2026-10-27T10:00:09.000Z", outputBytes: 0, caller: { kind: "api", login: "octocat" } },
      ]);
      platform.workerEvent({ id: "p1", type: "worker.started", createdAt: "2026-10-27T10:00:05.000Z", sessionId: view.id, data: { workerId: HANDS, name: "hands", environment: "dispatch-python", state: "starting", role: "hands" } });
      await settle(250);
      const current = await manager.view(view.id);
      expect(current.workers).toEqual([expect.objectContaining({ id: HANDS, role: "hands", createdBy: 1, sentWorkBy: [] })]);
      await expect(manager.commands(view.id, HANDS)).resolves.toEqual([
        { id: "ex_1", command: "ls", state: "completed", exitCode: 0, startedAt: "2026-10-27T10:00:07.000Z", finishedAt: "2026-10-27T10:00:08.000Z", background: false, tool: "bash", agentId: SUB },
        { id: "ex_2", command: "pwd", state: "running", startedAt: "2026-10-27T10:00:09.000Z", background: true, tool: "api" },
      ]);
    });

    it("only lists commands for the coordinator's own sandboxes", async () => {
      begin();
      const view = await manager.create("go", "ask", "mixed");
      platform.workerLists.set(view.id, [worker({ id: WORKER_A, name: "py-bench", coordinatorId: view.id })]);
      platform.workerEvent({ id: "p1", type: "worker.started", createdAt: "2026-10-27T10:00:05.000Z", sessionId: view.id, data: { workerId: WORKER_A, name: "py-bench", environment: "dispatch-python", state: "starting" } });
      await settle(250);
      await expect(manager.commands(view.id, WORKER_A)).rejects.toMatchObject({ code: "invalid_request" });
    });
  });
});

describe("helpers", () => {
  it("titles a conversation with the first line of its first message", () => {
    expect(titleFrom("Estimate pi\nthree ways")).toBe("Estimate pi");
    expect(titleFrom("word ".repeat(40)).length).toBeLessThanOrEqual(64);
    expect(titleFrom("   ")).toBe("New conversation");
  });

  it("lists a workspace's own files, not dependencies or hidden folders", () => {
    const files = visibleFiles([
      { path: "src/index.js", type: "file", size: 1, modifiedAt: "" },
      { path: "node_modules/a.js", type: "file", size: 1, modifiedAt: "" },
      { path: ".git/HEAD", type: "file", size: 1, modifiedAt: "" },
      { path: "pkg/__pycache__/x.pyc", type: "file", size: 1, modifiedAt: "" },
      { path: "README.md", type: "file", size: 1, modifiedAt: "" },
      { path: "src", type: "directory", size: 0, modifiedAt: "" },
    ]);
    expect(files.map((file) => file.path)).toEqual(["README.md", "src/index.js"]);
  });
});
