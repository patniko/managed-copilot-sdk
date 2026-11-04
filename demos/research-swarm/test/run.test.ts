import { afterEach, describe, expect, it } from "vitest";
import { EventHub } from "../src/server/hub.js";
import { NUDGE } from "../src/server/prompts.js";
import { RunManager } from "../src/server/runs.js";
import { Store } from "../src/server/store.js";
import type { Run } from "../src/shared/types.js";
import { event, FakePlatform, type FakeSession, testConfig, until } from "./fakes.js";

const managers: RunManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});

function setup(seed: Run[] = []) {
  const config = testConfig();
  const platform = new FakePlatform();
  const store = new Store(config.dataDir);
  for (const run of seed) store.put(run);
  const manager = new RunManager(platform, config, store, new EventHub());
  managers.push(manager);
  manager.start();
  return { platform, manager, store };
}

async function lead(platform: FakePlatform): Promise<FakeSession> {
  await until(() => platform.sessions.length > 0 && platform.sessions.at(-1)!.sent.length > 0, "the lead's first message");
  return platform.sessions.at(-1) as FakeSession;
}

const startWorker = (args: Record<string, unknown>) => ({ kind: "custom-tool", toolName: "start_worker", toolCallId: "call", args });

describe("a research run", () => {
  it("goes from a question to a cited report, then deletes its lead and sandboxes", async () => {
    const { platform, manager } = setup();
    const run = manager.create("  How does WebAssembly   GC work? ");
    expect(run).toMatchObject({ question: "How does WebAssembly GC work?", status: "planning", researchers: [] });
    const session = await lead(platform);
    expect(session.config.model).toBe("claude-sonnet-5");
    expect(session.config.systemMessage?.content).toContain('environment "research-swarm-web", model "claude-haiku-5.5"');
    expect(session.sent[0]!.prompt).toBe("Question: How does WebAssembly GC work?");
    const current = () => manager.get(run.id);
    const researcher = (id: string) => current().researchers.find((candidate) => candidate.id === id)!;

    expect(await session.ask(startWorker({ name: "r1", task: "x" }))).toMatchObject({ kind: "reject", feedback: expect.stringContaining("plan_research first") });
    expect(await session.call("plan_research", { subQuestions: ["How does WasmGC manage objects?", " Which browsers   ship WasmGC? "] })).toContain("- r2: Which browsers ship WasmGC?");
    expect(current()).toMatchObject({ status: "researching", researchers: [{ id: "r1", state: "queued" }, { id: "r2", state: "queued" }] });
    expect(await session.call("plan_research", { subQuestions: ["Another plan"] })).toContain("You already planned");

    // Starting a researcher is approved in its environment only; the lead itself never reads the web.
    expect(await session.ask(startWorker({ name: "r1", environment: "research-swarm-web", task: "x" }))).toEqual({ kind: "approve-once" });
    expect(await session.ask(startWorker({ name: "r1", task: "x" }))).toEqual({ kind: "approve-once" });
    expect(await session.ask(startWorker({ name: "r9", environment: "dispatch-python", task: "x" }))).toMatchObject({ kind: "reject" });
    expect(await session.ask({ kind: "url", url: "https://example.com" })).toMatchObject({ kind: "reject" });

    // The lead names one researcher its own way: the start_worker call ties that name to the sub-question.
    session.emit(event("tool.execution_start", { toolCallId: "t1", toolName: "start_worker", arguments: { name: "wasm-objects", task: "..." } }));
    session.emit(event("tool.execution_start", { toolCallId: "t2", toolName: "start_worker", arguments: { name: "r2", task: "..." } }));
    expect(current().activity).toBe("Starting researchers");
    expect(researcher("r1").state).toBe("starting");
    platform.emit("worker.started", "lead-1", { workerId: "w2", name: "r2", environment: "research-swarm-web", state: "starting" });
    platform.emit("worker.started", "lead-1", { workerId: "w1", name: "wasm-objects", environment: "research-swarm-web", state: "starting" });
    await until(() => researcher("r1").workerId === "w1" && researcher("r2").workerId === "w2", "both researchers to be linked");

    platform.worker("lead-1", { id: "w1", name: "wasm-objects", state: "working" });
    platform.worker("lead-1", { id: "w2", name: "r2", state: "working" });
    platform.sandboxes.set("w1", "sandbox-1");
    platform.pages("w1", [{ url: "https://en.wikipedia.org/wiki/WebAssembly", title: "WebAssembly - Wikipedia" }]);
    await until(() => researcher("r1").pages.length === 1 && researcher("r1").state === "reading" && researcher("r1").sandboxId === "sandbox-1", "r1's first page");

    platform.emit("network.blocked", "w2", { host: "stackoverflow.com", port: 443, reason: "host_not_allowed" });
    platform.emit("network.blocked", "w2", { host: "stackoverflow.com", port: 443, reason: "host_not_allowed" });
    // The runtime's own service calls aren't the researcher's.
    platform.emit("network.blocked", "w2", { host: "telemetry.enterprise.githubcopilot.com", port: 443, reason: "host_not_allowed" });
    await until(() => researcher("r2").blocked.length === 1, "r2's blocked host");
    expect(researcher("r2").blocked).toEqual([expect.objectContaining({ host: "stackoverflow.com", reason: "host_not_allowed" })]);

    platform.pages("w2", [
      { url: "https://developer.mozilla.org/en-US/docs/WebAssembly", title: "WebAssembly | MDN" },
      { url: "https://en.wikipedia.org/wiki/WebAssembly", title: "WebAssembly - Wikipedia" },
    ]);
    platform.worker("lead-1", { id: "w1", name: "wasm-objects", state: "idle", result: "- Objects are traced https://en.wikipedia.org/wiki/WebAssembly" });
    platform.worker("lead-1", { id: "w2", name: "r2", state: "idle", result: "- Every major browser https://developer.mozilla.org/en-US/docs/WebAssembly" });
    platform.emit("worker.idle", "lead-1", { workerId: "w1", name: "wasm-objects", environment: "research-swarm-web", state: "idle" });
    platform.emit("worker.idle", "lead-1", { workerId: "w2", name: "r2", environment: "research-swarm-web", state: "idle" });
    await until(() => researcher("r1").state === "done" && researcher("r2").state === "done" && researcher("r2").pages.length === 2, "both researchers to finish");
    expect(researcher("r1")).toMatchObject({ report: expect.stringContaining("Objects are traced"), finishedAt: expect.any(String) });

    session.emit(event("tool.execution_start", { toolCallId: "t3", toolName: "list_sources", arguments: {} }));
    expect(current()).toMatchObject({ status: "writing", activity: "Collecting sources" });
    const listed = await session.call("list_sources");
    expect(listed).toContain("[1] WebAssembly (en.wikipedia.org, read by r1, r2)");
    expect(listed).toContain("[2] WebAssembly (developer.mozilla.org, read by r2)");
    expect(listed).not.toContain("[3]");
    session.emit(event("tool.execution_complete", { toolCallId: "t3", success: true }));
    expect(current().activity).toBe("Writing the report");

    expect(await session.call("submit_report", { title: "Wasm GC", summary: "Browsers ship it [2].", body: "## How\n\nObjects are traced [5]." })).toMatchObject({
      resultType: "failure",
      textResultForLlm: expect.stringContaining("[5] isn't a source"),
    });
    expect(await session.call("submit_report", { title: "Wasm GC", summary: "Browsers ship it [2].", body: "## How\n\nObjects are traced [1]." })).toContain("Saved");
    expect(current()).toMatchObject({
      status: "done",
      report: {
        title: "Wasm GC",
        summary: "Browsers ship it [1].",
        body: "## How\n\nObjects are traced [2].",
        sources: [
          { n: 1, host: "developer.mozilla.org", readBy: ["r2"] },
          { n: 2, host: "en.wikipedia.org", readBy: ["r1", "r2"] },
        ],
      },
    });

    session.emit(event("session.idle"));
    await until(() => current().cleanedUp === true, "the cleanup");
    expect(platform.deleted).toEqual(["lead-1"]);
    expect(session.disconnected).toBe(true);
    expect(manager.state().runs[0]).toMatchObject({ id: run.id, title: "Wasm GC", status: "done", researchers: 2, sources: 2 });
    expect(manager.report(run.id)).toMatchObject({ filename: "wasm-gc.md", markdown: expect.stringContaining("1. [WebAssembly](https://developer.mozilla.org/en-US/docs/WebAssembly)") });
  });

  it("asks a lead that ends its turn early to finish, then gives up", async () => {
    const { platform, manager } = setup();
    const run = manager.create("What is RAG?");
    const session = await lead(platform);
    session.emit(event("session.idle"));
    await until(() => session.sent.length === 2, "the first nudge");
    expect(session.sent[1]!.prompt).toBe(NUDGE);
    session.emit(event("session.idle"));
    await until(() => session.sent.length === 3, "the second nudge");
    session.emit(event("session.idle"));
    await until(() => manager.get(run.id).status === "failed", "the run to fail");
    expect(manager.get(run.id)).toMatchObject({ error: "The lead finished without writing a report.", cleanedUp: true });
    expect(platform.deleted).toEqual(["lead-1"]);
  });

  it("fails with the lead's error instead of nudging it", async () => {
    const { platform, manager } = setup();
    const run = manager.create("What is RAG?");
    const session = await lead(platform);
    session.emit(event("session.error", { errorType: "quota", message: "You're out of premium requests." }));
    session.emit(event("session.idle"));
    await until(() => manager.get(run.id).status === "failed", "the run to fail");
    expect(manager.get(run.id).error).toBe("The lead stopped with an error: You're out of premium requests.");
    expect(session.sent).toHaveLength(1);
  });

  it("stops on request: the lead's turn ends and its session is deleted", async () => {
    const { platform, manager } = setup();
    const run = manager.create("What is RAG?");
    const session = await lead(platform);
    await session.call("plan_research", { subQuestions: ["What is it?", "Where does it fail?"] });
    const stopped = await manager.stop(run.id);
    expect(stopped).toMatchObject({ status: "stopped", cleanedUp: true, researchers: [{ state: "stopped" }, { state: "stopped" }] });
    expect(session.aborted).toBe(true);
    expect(platform.deleted).toEqual(["lead-1"]);
    expect(await session.ask(startWorker({ name: "r1", task: "x" }))).toMatchObject({ kind: "reject" });
  });

  it("says why a run couldn't start", async () => {
    const { platform, manager } = setup();
    platform.createError = new Error("The model isn't available.");
    const run = manager.create("What is RAG?");
    await until(() => manager.get(run.id).status === "failed", "the run to fail");
    expect(manager.get(run.id).error).toBe("Couldn't start the research: The model isn't available.");
    expect(platform.deleted).toEqual([]);
    await manager.remove(run.id);
    expect(() => manager.get(run.id)).toThrow("isn't here anymore");
  });

  it("deletes a run removed while its lead was being created, once the lead exists", async () => {
    const { platform, manager, store } = setup();
    let release = () => {};
    platform.createGate = new Promise<void>((resolve) => (release = resolve));
    const run = manager.create("What is RAG?");
    await manager.remove(run.id);
    expect(store.get(run.id)).toBeUndefined();
    release();
    await until(() => platform.deleted.length === 1, "the lead's session to be deleted");
    expect(platform.deleted).toEqual(["lead-1"]);
    expect(platform.sessions[0]!.sent).toEqual([]);
    expect(store.get(run.id)).toBeUndefined();
  });

  it("turns away empty, long, and extra questions, and questions while disconnected", () => {
    const { platform, manager } = setup();
    expect(() => manager.create("   ")).toThrow("Write a question first.");
    expect(() => manager.create("x".repeat(501))).toThrow("under 500 characters");
    manager.create("One");
    manager.create("Two");
    expect(() => manager.create("Three")).toThrow("2 research runs are in progress");
    platform.setStatus({ state: "reconnecting", message: "Reconnecting to Managed Copilot…" });
    expect(() => manager.create("Four")).toThrow("Reconnecting to Managed Copilot…");
  });

  it("fails runs when the connection is lost, and deletes their sessions once it's back", async () => {
    const { platform, manager } = setup();
    const run = manager.create("What is RAG?");
    await lead(platform);
    platform.deleteError = new Error("Managed Copilot isn't connected yet.");
    platform.setStatus({ state: "reconnecting" });
    await until(() => manager.get(run.id).status === "failed", "the run to fail");
    expect(manager.get(run.id).error).toContain("Lost the connection");
    expect(manager.get(run.id).cleanedUp).toBeUndefined();
    platform.deleteError = undefined;
    platform.setStatus({ state: "connected" });
    await until(() => manager.get(run.id).cleanedUp === true, "the sweep");
    expect(platform.deleted).toEqual(["lead-1"]);
  });

  it("stops runs an earlier process left unfinished and deletes their sessions", async () => {
    const at = "2026-11-04T06:00:00.000Z";
    const { platform, manager } = setup([
      { id: "old", question: "Q", status: "researching", researchers: [], sessionId: "lead-old", model: "m", createdAt: at, updatedAt: at },
      { id: "done", question: "Q2", status: "done", researchers: [], sessionId: "lead-done", cleanedUp: true, model: "m", createdAt: at, updatedAt: at },
    ]);
    expect(manager.get("old")).toMatchObject({ status: "stopped", error: expect.stringContaining("restarted") });
    platform.setStatus({ ...platform.status, state: "connected" });
    await until(() => manager.get("old").cleanedUp === true, "the sweep");
    expect(platform.deleted).toEqual(["lead-old"]);
  });
});
