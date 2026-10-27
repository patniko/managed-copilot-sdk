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

  it("keeps a conversation started while discovery reads the list, and doesn't revive one deleted meanwhile", async () => {
    begin();
    const doomed = await manager.create("delete me", "ask");
    let release: (sessions: Awaited<ReturnType<FakePlatform["listSessions"]>>) => void = () => undefined;
    // The list is read before both changes below.
    const snapshot = [info(doomed.id)];
    platform.listSessions = () => new Promise((resolve) => (release = resolve));
    const syncing = manager.sync();
    await settle();
    const fresh = await manager.create("new one", "ask");
    await manager.delete(doomed.id);
    release(snapshot);
    await syncing;
    expect(manager.summaries().map((summary) => summary.id)).toEqual([fresh.id]);
    // The deleted one wasn't brought back, not even briefly (it would be resumed, then found gone).
    expect(platform.resumeAttempts).not.toContain(doomed.id);
    await expect(manager.send(fresh.id, "still here?")).resolves.toBeUndefined();
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
    await expect(manager.send(view.id, "still here?")).resolves.toBeUndefined();
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
      user("Use a million samples", "from-cli"),
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
