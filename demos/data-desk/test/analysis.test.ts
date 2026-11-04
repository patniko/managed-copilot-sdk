import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DECLINED, NOT_AVAILABLE } from "../src/server/analysis.js";
import { Datasets, type UploadLimits } from "../src/server/datasets.js";
import { EventHub } from "../src/server/hub.js";
import { AnalysisManager } from "../src/server/manager.js";
import { Store } from "../src/server/store.js";
import { event, FakePlatform, testConfig, type FakeSession } from "./fakes.js";

const DATASET = "sample-coffee-sales";
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Whether a promise is still pending after the event loop has had a chance to run. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  return (await Promise.race([promise, settle().then(() => marker)])) === marker;
}

let dataDir: string;
let hubs: EventHub[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "desk-"));
});

afterEach(() => {
  for (const hub of hubs) hub.close();
  hubs = [];
});

function desk(platform = new FakePlatform(), store = new Store(dataDir), limits: Partial<UploadLimits> = {}) {
  const config = testConfig(dataDir);
  const datasets = new Datasets(config.samplesDir, dataDir, config.maxUploadBytes, limits);
  datasets.load();
  const hub = new EventHub();
  hubs.push(hub);
  const manager = new AnalysisManager(platform, config, store, datasets, hub);
  manager.start();
  return { platform, manager, store, datasets };
}

async function started() {
  const parts = desk();
  const view = await parts.manager.create(DATASET);
  const session = parts.platform.sessions.get(view.id)!;
  return { ...parts, id: view.id, session };
}

/** The agent calls `request_sandbox` and the runtime asks the session's permission handler. */
function askToMove(session: FakeSession, reason = "Need Python for a chart") {
  session.emit(event("user.message", { content: "Chart monthly revenue" }));
  session.emit(event("tool.execution_start", { toolCallId: "move-1", toolName: "request_sandbox", arguments: { reason } }));
  return session.ask({ kind: "custom-tool", toolName: "request_sandbox", toolCallId: "move-1", args: { reason } });
}

describe("an analysis", () => {
  it("starts on the shared runtime with Data Desk's tools and instructions", async () => {
    const { manager, id, session } = await started();
    const view = await manager.view(id);
    expect(view).toMatchObject({ placement: "shared", title: "Coffee shop sales", datasetId: DATASET, busy: false, needsYou: false });
    const config = session.config as { model?: string; tools?: { name: string; skipPermission?: boolean }[]; systemMessage?: { content: string } };
    expect(config.model).toBe("claude-sonnet-5");
    expect(config.tools?.map((tool) => [tool.name, tool.skipPermission])).toEqual([
      ["describe_dataset", true],
      ["query_rows", true],
      ["aggregate", true],
    ]);
    expect(config.systemMessage?.content).toContain("call request_sandbox first");
    expect(config.systemMessage?.content).toContain("/workspace/data/coffee-sales.csv");
  });

  it("asks the person before moving, then copies the dataset in before the agent's first command", async () => {
    const { manager, platform, id, session } = await started();
    session.premiumRequests = 2;
    const answer = askToMove(session);
    await settle();
    await expect(manager.view(id)).resolves.toMatchObject({ needsYou: true, moveRequest: { id: "move-1", reason: "Need Python for a chart" } });
    await expect(manager.send(id, "Anything else?")).rejects.toThrow(/waiting for your answer/);

    const view = manager.answerMove(id, true);
    await expect(answer).resolves.toEqual({ kind: "approve-once", approvedInteractively: true });
    expect(view).toMatchObject({ placement: "moving", needsYou: false });
    expect(view.movingSince).toBeDefined();

    // The platform moves the same session; the copy is slow, so the agent's first command waits for it.
    let release!: () => void;
    platform.writeGate = new Promise<void>((resolve) => (release = resolve));
    platform.promote(id, "sbx_1");
    platform.publish({ type: "session.promoted", sessionId: id, sandboxId: "sbx_1", data: { durationMs: 4200 } });
    const command = session.ask({ kind: "shell", fullCommandText: "python3 chart.py" });
    expect(await pending(command)).toBe(true);
    release();
    await expect(command).resolves.toEqual({ kind: "approve-once" });
    expect(platform.written).toEqual([{ sessionId: id, path: "data/coffee-sales.csv", bytes: expect.any(Number) }]);

    // Later commands and files don't copy it again.
    await expect(session.ask({ kind: "write", fileName: "chart.py" })).resolves.toEqual({ kind: "approve-once" });
    expect(platform.written).toHaveLength(1);
    await settle();
    expect(await manager.view(id)).toMatchObject({ placement: "sandbox", sandboxId: "sbx_1", moveMs: 4200, usage: { premiumRequests: 2, beforeMove: 2 } });
  });

  it("keeps the session on the shared runtime when the person says not now", async () => {
    const { manager, id, session } = await started();
    const answer = askToMove(session);
    await settle();
    expect(manager.answerMove(id, false)).toMatchObject({ placement: "shared", needsYou: false });
    await expect(answer).resolves.toEqual({ kind: "reject", feedback: DECLINED });
    expect(() => manager.answerMove(id, true)).toThrow(/no sandbox request waiting/);
  });

  it("lets go of a move request answered in Copilot CLI", async () => {
    const { manager, id, session } = await started();
    const answer = askToMove(session);
    await settle();
    session.emit(event("permission.requested", { requestId: "p1", permissionRequest: { kind: "custom-tool", toolName: "request_sandbox", toolCallId: "move-1" } }));
    session.emit(event("permission.completed", { requestId: "p1", toolCallId: "move-1", result: { kind: "approved" } }));
    await expect(answer).resolves.toEqual({ kind: "no-result" });
    expect((await manager.view(id)).needsYou).toBe(false);
  });

  it("refuses what the sandbox can't serve", async () => {
    const { session } = await started();
    await expect(session.ask({ kind: "url", url: "https://example.com" })).resolves.toEqual({ kind: "reject", feedback: NOT_AVAILABLE });
  });

  it("retries copying the dataset, and says so when it can't", async () => {
    const { manager, platform, id, session } = await started();
    platform.writeFailures = 3;
    platform.promote(id, "sbx_1");
    platform.publish({ type: "session.promoted", sessionId: id, sandboxId: "sbx_1", data: {} });
    await expect(session.ask({ kind: "shell", fullCommandText: "ls" })).resolves.toEqual({ kind: "approve-once" });
    expect((await manager.view(id)).problem).toBe("Couldn't copy the dataset into the sandbox.");
    // The next command tries again.
    await session.ask({ kind: "shell", fullCommandText: "ls data" });
    expect(platform.written).toHaveLength(1);
    expect((await manager.view(id)).problem).toBeUndefined();
  }, 15_000);

  it("shows published charts and serves only its own outputs", async () => {
    const { manager, platform, id } = await started();
    platform.promote(id, "sbx_1");
    platform.publish({ type: "session.promoted", sessionId: id, sandboxId: "sbx_1", data: {} });
    platform.artifacts.set(id, [
      { id: "a1", path: "revenue.svg", size: 120, digest: "d1", turnId: "t1", version: 2, state: "published", publishedAt: "2026-11-04T10:01:00.000Z" },
      { id: "a2", path: "summary.csv", size: 40, digest: "d2", turnId: "t1", version: 1, state: "published", publishedAt: "2026-11-04T10:00:00.000Z" },
      { id: "a3", path: "draft.svg", size: 40, digest: "d3", turnId: "t2", version: 1, state: "pending" },
    ]);
    platform.publish({ type: "artifact.published", sessionId: id, data: {} });
    await settle();
    const view = await manager.view(id);
    expect(view.outputs).toEqual([
      { path: "revenue.svg", version: 2, size: 120, publishedAt: "2026-11-04T10:01:00.000Z", kind: "chart" },
      { path: "summary.csv", version: 1, size: 40, publishedAt: "2026-11-04T10:00:00.000Z", kind: "file" },
    ]);
    expect(view.charts).toBe(1);
    const { bytes } = await manager.readOutput(id, "revenue.svg");
    expect(new TextDecoder().decode(bytes)).toContain("<svg");
    await expect(manager.readOutput(id, "../secrets")).rejects.toThrow(/isn't one of this analysis's outputs/);
  });

  it("sends the person's messages and stops a turn", async () => {
    const { manager, id, session } = await started();
    await manager.send(id, "  Which store sold the most?  ");
    expect(session.sent).toEqual([{ prompt: "Which store sold the most?" }]);
    session.emit(event("user.message", { content: "Which store sold the most?" }));
    expect((await manager.view(id)).items[0]).toMatchObject({ kind: "user", via: "app" });
    await manager.stop(id);
    expect(session.aborted).toBe(1);
    await expect(manager.send(id, " ")).rejects.toThrow(/Write a message/);
  });
});

describe("analyses across restarts", () => {
  it("resume from their session's history, with the tables Data Desk's tools returned", async () => {
    const first = await started();
    await first.manager.send(first.id, "Which store sold the most?");
    first.session.emit(event("user.message", { content: "Which store sold the most?" }));
    first.session.emit(event("tool.execution_start", { toolCallId: "call-1", toolName: "aggregate", arguments: { title: "Revenue by store" } }));
    first.session.emit(event("tool.execution_complete", { toolCallId: "call-1", success: true, result: { content: JSON.stringify({ title: "Revenue by store", matched: 1, columns: ["store"], rows: [["Downtown"]] }) } }));
    first.store.flush();

    const second = desk(first.platform, new Store(dataDir));
    second.platform.connect();
    await settle();
    const view = await second.manager.view(first.id);
    expect(view.items.map((item) => item.kind)).toEqual(["user", "step"]);
    expect(view.items[0]).toMatchObject({ via: "app" });
    expect(view.results.map((result) => result.title)).toEqual(["Revenue by store"]);
    const resumed = second.platform.sessions.get(first.id)!;
    expect(resumed).not.toBe(first.session);
    expect(resumed.config).toMatchObject({ continuePendingWork: true, suppressResumeEvent: true });
  });

  it("are dropped when their session was deleted elsewhere", async () => {
    const first = await started();
    first.store.flush();
    first.platform.deleted.push(first.id);
    const second = desk(first.platform, new Store(dataDir));
    second.platform.connect();
    await settle();
    expect(second.manager.summaries()).toEqual([]);
    expect(second.store.get(first.id)).toBeUndefined();
  });

  it("are deleted with their session", async () => {
    const { manager, platform, id, store } = await started();
    await manager.delete(id);
    expect(platform.deleted).toEqual([id]);
    expect(store.get(id)).toBeUndefined();
    await expect(manager.view(id)).rejects.toThrow(/no such analysis/);
  });
});

describe("an analysis whose upload was dropped for newer ones", () => {
  it("says so to the agent and the person, and can still be deleted", async () => {
    const { manager, platform } = desk(undefined, undefined, { maxUploads: 1 });
    const first = manager.upload("first.csv", Buffer.from("store,revenue\nDowntown,10\n"));
    const { id } = await manager.create(first.id);
    const session = platform.sessions.get(id)!;
    manager.upload("second.csv", Buffer.from("store,revenue\nHarbor,12\n"));

    const query = session.config.tools!.find((tool) => tool.name === "query_rows")!;
    const result = await query.handler?.({ title: "All rows" }, { sessionId: id, toolCallId: "call-1", toolName: "query_rows", arguments: { title: "All rows" } });
    expect(result).toEqual({ error: "That dataset isn't available anymore. Pick another one." });
    expect((await manager.view(id)).dataset).toBeUndefined();
    expect(() => manager.rows(first.id, 0, 10)).toThrow(/isn't available/);
    platform.publish({ type: "session.promoted", sessionId: id, sandboxId: "sbx_1", data: {} });
    await settle();
    expect((await manager.view(id)).problem).toBe("This analysis's dataset isn't available anymore.");
    expect(platform.written).toEqual([]);

    platform.connect();
    await settle();
    expect((await manager.view(id)).problem).toBe("This analysis's dataset isn't available anymore.");
    await expect(manager.send(id, "Anything else?")).rejects.toThrow(/isn't available anymore/);
    await manager.delete(id);
    expect(platform.deleted).toEqual([id]);
  });
});
