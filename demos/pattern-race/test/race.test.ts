import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRequest } from "@github/copilot-sdk";
import { ManagedCopilotError, type SessionInfo } from "@managed-copilot/sdk";
import { describe, expect, it, vi } from "vitest";
import { expectedValue } from "../src/server/checks.js";
import { RaceError } from "../src/server/errors.js";
import { RaceManager, SESSION_PREFIX } from "../src/server/race.js";
import { RaceStore } from "../src/server/store.js";
import { jobById } from "../src/shared/jobs.js";
import type { LaneId } from "../src/shared/lanes.js";
import type { LaneRun } from "../src/shared/types.js";
import { FakePlatform, worker } from "./fakes.js";

const HASH = expectedValue({ kind: "sha256", text: "Managed Copilot pattern race" });

function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("It didn't throw.");
}

function setup(options: { store?: RaceStore } = {}) {
  const platform = new FakePlatform();
  let clock = 1_000_000;
  const races = new RaceManager({ platform, config: { laneTimeoutMs: 15 * 60_000, pollIntervalMs: 10 }, now: () => clock, ...options });
  const lane = (id: LaneId): LaneRun => races.snapshot()!.lanes.find((run) => run.lane === id)!;
  return { platform, races, lane, tick: (ms: number) => (clock += ms) };
}

describe("a race", () => {
  it("runs every available lane at once, each in its own environment with the same prompt and model", async () => {
    const { platform, races, lane } = setup();
    platform.lanes = platform.lanes.map((availability) => (availability.lane === "mixed" ? { lane: "mixed", available: false, reason: 'This deployment has no "lead" environment.' } : availability));
    races.start("code");
    for (const id of ["shared", "isolated", "promotable", "direct", "delegate"] as const) {
      const session = await platform.session(id);
      expect(session.prompt).toBe(jobById("code").prompt);
      expect(session.config.model).toBe("claude-sonnet-5");
      expect(session.sessionId.startsWith(SESSION_PREFIX)).toBe(true);
      expect(session.sessionId.endsWith(`-${id}`)).toBe(true);
    }
    expect(platform.sessions.has("mixed")).toBe(false);
    expect(lane("mixed")).toMatchObject({ status: "skipped", error: 'This deployment has no "lead" environment.' });
    expect(races.running).toBe(true);
    await races.close();
  });

  it("races the model the person picked, sitting out lanes whose environment doesn't allow it", async () => {
    const { platform, races, lane } = setup();
    platform.lanes = platform.lanes.map((availability) => (availability.lane === "shared" ? { ...availability, models: ["claude-sonnet-5"] } : availability));
    expect(thrown(() => races.start("code", "no-such-model"))).toMatchObject({ code: "invalid_request", status: 400 });
    races.start("code", "gpt-6-sol");
    expect((await platform.session("isolated")).config.model).toBe("gpt-6-sol");
    expect(races.snapshot()!.model).toBe("gpt-6-sol");
    expect(lane("shared")).toMatchObject({ status: "skipped", error: '"chat" doesn\'t allow GPT-6 Sol.' });
    expect(platform.sessions.has("shared")).toBe(false);
    await races.close();
  });

  it("places correct answers in the order they arrived, and judges every answer", async () => {
    const { platform, races, lane, tick } = setup();
    races.start("code");
    const sessions = Object.fromEntries(await Promise.all((["shared", "isolated", "promotable", "direct", "delegate", "mixed"] as const).map(async (id) => [id, await platform.session(id)])));
    const answer = async (id: LaneId, content: string, after: number) => {
      tick(after);
      sessions[id]!.answer(content);
      await vi.waitFor(() => expect(lane(id).status).toBe("done"));
    };
    await answer("direct", `SHA-256: \`${HASH}\``, 9_000);
    await answer("shared", "I don't have a shell here, so I can't compute the hash.", 500);
    await answer("isolated", `The digest is ${HASH.toUpperCase()}.`, 4_000);
    await answer("delegate", `The digest is ${HASH.slice(0, -1)}.`, 0);
    expect(lane("direct")).toMatchObject({ status: "done", verdict: "correct", checks: [true], place: 1, finishedAt: 1_009_000 });
    expect(lane("isolated")).toMatchObject({ verdict: "correct", place: 2 });
    expect(lane("shared")).toMatchObject({ verdict: "missed", checks: [false] });
    expect(lane("shared").place).toBeUndefined();
    expect(lane("delegate")).toMatchObject({ verdict: "missed" });
    sessions.promotable!.answer(HASH);
    sessions.mixed!.answer(HASH);
    await vi.waitFor(() => expect(races.snapshot()!.state).toBe("finished"));
    expect(races.snapshot()!.expected).toEqual([HASH]);
    expect(platform.deleted).toHaveLength(6);
  });

  it("ends a lane the moment its answer arrives, then reads its final usage", async () => {
    const { platform, races, lane, tick } = setup();
    races.start("code");
    const session = await platform.session("direct");
    let release!: () => void;
    session.gate = new Promise((resolve) => (release = resolve));
    session.usage = { ...session.usage, totalPremiumRequestCost: 2, totalUserRequests: 2 };
    tick(8_900);
    session.answer(HASH);
    await vi.waitFor(() => expect(lane("direct")).toMatchObject({ status: "done", place: 1, finishedAt: 1_008_900 }));
    expect(lane("direct").premium.session).not.toBe(2);
    release();
    await vi.waitFor(() => expect(lane("direct").premium.session).toBe(2));
    await races.close();
  });

  it("shows what each lane is doing, from its own session events", async () => {
    const { platform, races, lane } = setup();
    races.start("code");
    const session = await platform.session("direct");
    await vi.waitFor(() => expect(lane("direct").status).toBe("thinking"));
    session.emit("tool.execution_start", { toolName: "report_intent", toolCallId: "t0", arguments: { intent: "Hashing the text" } });
    expect(lane("direct").activity).toBe("Hashing the text");
    session.emit("tool.execution_start", { toolName: "bash", toolCallId: "t1", arguments: { command: "python3 -c 'import hashlib'\necho done" } });
    expect(lane("direct")).toMatchObject({ status: "working", activity: "$ python3 -c 'import hashlib'" });
    session.emit("subagent.started", { agentName: "task" }, "agent-1");
    session.emit("subagent.started", { agentName: "task" }, "agent-1");
    expect(lane("direct").subagents).toBe(1);
    session.emit("tool.execution_complete", { toolCallId: "t1", success: true });
    expect(lane("direct")).toMatchObject({ status: "thinking", activity: "Thinking" });
    await races.close();
  });

  it("counts the sandboxes each lane had: its own, a move into one, hands, and workers", async () => {
    const { platform, races, lane } = setup();
    races.start("split");
    const isolated = await platform.session("isolated");
    expect(lane("isolated").sandboxes).toEqual([
      { id: `sandbox-of-${isolated.sessionId}`, kind: "own", name: "Its own sandbox", state: "working", environment: "coder", cpus: 2, memoryBytes: 4 * 1024 ** 3, appearedAt: 1_000_000, readyAt: 1_000_000 },
    ]);
    expect(lane("isolated").brain).toBe("sandbox");

    const promotable = await platform.session("promotable");
    expect(lane("promotable")).toMatchObject({ brain: "runtime", sandboxes: [] });
    promotable.emit("tool.execution_start", { toolName: "request_sandbox", toolCallId: "move" });
    expect(lane("promotable")).toMatchObject({ brain: "runtime", sandboxes: [{ id: "pending", kind: "own", state: "starting" }] });
    platform.emit({ type: "session.promoted", sessionId: promotable.sessionId, sandboxId: "sbx-moved" });
    promotable.emit("tool.execution_complete", { toolCallId: "move", success: true });
    expect(lane("promotable")).toMatchObject({ brain: "sandbox", sandboxes: [{ id: "sbx-moved", kind: "own", environment: "coder" }] });

    const delegate = await platform.session("delegate");
    platform.emit({ type: "worker.started", sessionId: delegate.sessionId, data: { workerId: "w1", name: "primes", environment: "coder", state: "starting" } });
    platform.workerLists.set(delegate.sessionId, [worker({ id: "w1", name: "primes", messages: 2 }), worker({ id: "w2", name: "collatz", state: "idle" })]);
    const mixed = await platform.session("mixed");
    platform.workerLists.set(mixed.sessionId, [worker({ id: "h1", name: "hands", role: "hands", state: "idle" })]);
    await vi.waitFor(() => expect(lane("delegate").sandboxes.map((token) => [token.name, token.kind, token.state])).toEqual([["primes", "worker", "working"], ["collatz", "worker", "idle"]]));
    await vi.waitFor(() => expect(lane("mixed").sandboxes).toMatchObject([{ id: "h1", kind: "hands", state: "idle" }]));

    // Workers are sessions of their own: one premium request per message, at the rate the coordinator measured.
    await vi.waitFor(() => expect(lane("delegate").premium).toEqual({ session: 1, workers: 3 }));
    expect(lane("mixed").premium).toEqual({ session: 1, workers: 0 });
    expect(lane("delegate").modelCalls).toBe(2);
    await races.close();
    // A lane's session is deleted when it ends, and its sandboxes with it.
    expect(lane("delegate").sandboxes.every((token) => token.state === "stopped")).toBe(true);
  });

  it("measures each lane's sandboxes through the session each belongs to, and what its own session spent", async () => {
    const { platform, races, lane, tick } = setup();
    races.start("split");
    const isolated = await platform.session("isolated");
    platform.usages.set(isolated.sessionId, { cpuMs: 1_200, peakMemoryBytes: 300 * 1024 ** 2 });
    await vi.waitFor(() => expect(lane("isolated").sandboxes[0]!.usage).toEqual({ cpuMs: 1_200, peakMemoryBytes: 300 * 1024 ** 2 }));

    // A worker is read through its own session; its counters only grow, so an older reading never lowers them.
    const delegate = await platform.session("delegate");
    platform.workerLists.set(delegate.sessionId, [worker({ id: "w1", name: "primes" }), worker({ id: "w2", name: "gone", state: "stopped" })]);
    platform.usages.set("w1", { cpuMs: 9_000, peakMemoryBytes: 200 });
    await vi.waitFor(() => expect(lane("delegate").sandboxes[0]!.usage?.cpuMs).toBe(9_000));
    platform.usages.set("w1", { cpuMs: 8_000, peakMemoryBytes: 100 });
    const readsOfW1 = () => platform.measured.filter((id) => id === "w1").length;
    const before = readsOfW1();
    await vi.waitFor(() => expect(readsOfW1()).toBeGreaterThan(before + 1));
    expect(lane("delegate").sandboxes[0]!.usage).toEqual({ cpuMs: 9_000, peakMemoryBytes: 200 });
    expect(platform.measured).not.toContain("w2");

    // A sandbox still starting isn't read.
    const promotable = await platform.session("promotable");
    promotable.emit("tool.execution_start", { toolName: "request_sandbox", toolCallId: "move" });
    expect(lane("promotable").sandboxes).toMatchObject([{ id: "pending", state: "starting", appearedAt: 1_000_000 }]);

    const direct = await platform.session("direct");
    direct.emit("tool.execution_start", { toolName: "report_intent", toolCallId: "t0", arguments: { intent: "Counting primes" } });
    direct.emit("tool.execution_start", { toolName: "bash", toolCallId: "t1", arguments: { command: "python3 primes.py" } });
    direct.usage = {
      ...direct.usage,
      totalApiDurationMs: 4_200,
      modelMetrics: { "claude-sonnet-5": { requests: { count: 3, cost: 1 }, usage: { inputTokens: 9_000, outputTokens: 400, cacheReadTokens: 8_000, cacheWriteTokens: 100 } } },
    } as typeof direct.usage;
    await vi.waitFor(() => expect(lane("direct")).toMatchObject({ toolCalls: 1, modelMs: 4_200, modelCalls: 3, tokens: { input: 9_000, output: 400, cacheRead: 8_000, cacheWrite: 100 } }));
    expect(platform.measured).not.toContain(promotable.sessionId);

    tick(5_000);
    isolated.answer("1. 315948");
    await vi.waitFor(() => expect(platform.deleted).toContain(isolated.sessionId));
    expect(lane("isolated").sandboxes[0]).toMatchObject({ state: "stopped", appearedAt: 1_000_000, endedAt: 1_005_000 });
    // Its history: what it did when, and its sandbox's usage over time, ending with nothing held once it's deleted.
    expect(lane("direct").timeline!.map((phase) => [phase.kind, phase.label])).toEqual([
      ["starting", "Starting its session"],
      ["thinking", "Thinking"],
      ["thinking", "Counting primes"],
      ["command", "$ python3 primes.py"],
    ]);
    expect(lane("isolated").samples!.at(-1)).toEqual({ at: 1_005_000, cpuMs: 1_200, memoryBytes: 0 });
    expect(lane("shared").samples).toBeUndefined();
    await races.close();
  });

  it("measures the shared runtime over the race, across a restart, and says why when it can't", async () => {
    const { platform, races, tick } = setup();
    platform.runtime = { cpuMs: 50_000, memoryBytes: 300, sessions: 2, generation: 1 };
    races.start("answer");
    await vi.waitFor(() => expect(races.snapshot()!.runtime).toMatchObject({ cpuMs: 0, memoryBytes: 300 }));
    tick(2_500);
    platform.runtime = { cpuMs: 51_500, memoryBytes: 500, sessions: 7, generation: 1 };
    await vi.waitFor(() => expect(races.snapshot()!.runtime).toMatchObject({ cpuMs: 1_500, peakMemoryBytes: 500 }));
    // A new runtime process counts from zero: its 200 ms add to the race's total.
    platform.runtime = { cpuMs: 200, memoryBytes: 100, sessions: 1, generation: 2 };
    await vi.waitFor(() => expect(races.snapshot()!.runtime).toMatchObject({ cpuMs: 1_700, memoryBytes: 100, peakMemoryBytes: 500 }));
    // A reading that fails after the first is skipped.
    platform.runtime = new Error("fetch failed");
    for (const id of ["shared", "isolated", "promotable", "direct", "delegate", "mixed"] as const) (await platform.session(id)).answer("$925");
    await vi.waitFor(() => expect(races.snapshot()!.state).toBe("finished"));
    expect(races.snapshot()!.runtime!.cpuMs).toBe(1_700);
    expect(races.snapshot()!.runtimeNote).toBeUndefined();

    const refused = setup();
    refused.platform.runtime = new RaceError("runtime_unavailable", "Only operators of this deployment can see the shared runtime's usage, and @octocat isn't one.");
    refused.races.start("answer");
    await vi.waitFor(() => expect(refused.races.snapshot()!.runtimeNote).toBe("Only operators of this deployment can see the shared runtime's usage, and @octocat isn't one."));
    expect(refused.races.snapshot()!.runtime).toBeUndefined();
    await refused.races.close();
  });

  it("finds a move into a sandbox by the session's placement, and drops a move that failed", async () => {
    const { platform, races, lane } = setup();
    races.start("code");
    const promotable = await platform.session("promotable");
    promotable.emit("tool.execution_start", { toolName: "request_sandbox", toolCallId: "move-1" });
    promotable.emit("tool.execution_complete", { toolCallId: "move-1", success: false });
    expect(lane("promotable")).toMatchObject({ brain: "runtime", sandboxes: [] });
    promotable.emit("tool.execution_start", { toolName: "request_sandbox", toolCallId: "move-2" });
    platform.infos.set(promotable.sessionId, { placement: "sandbox", sandbox: { id: "sbx-2" } as SessionInfo["sandbox"] });
    await vi.waitFor(() => expect(lane("promotable")).toMatchObject({ brain: "sandbox", sandboxes: [{ id: "sbx-2", kind: "own", state: "working" }] }));
    await races.close();
  });

  it("approves each lane's requests and counts them", async () => {
    const { platform, races, lane } = setup();
    races.start("code");
    const session = await platform.session("isolated");
    const result = await session.ask({ kind: "shell", fullCommandText: "python3 hash.py", intention: "Run", commands: [], possiblePaths: [], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: false } as unknown as PermissionRequest);
    expect(result.kind).toBe("approve-once");
    expect(lane("isolated").approvals).toBe(1);
    await races.close();
  });

  it("fails a lane in plain words and still deletes its session", async () => {
    const { platform, races, lane } = setup();
    races.start("answer");
    const session = await platform.session("isolated");
    session.fail("Timeout after 900000ms waiting for session.idle");
    await vi.waitFor(() => expect(lane("isolated").status).toBe("failed"));
    expect(lane("isolated")).toMatchObject({ verdict: "failed", error: "It didn't finish within 15 minutes." });
    expect(session.aborted).toBe(true);
    await vi.waitFor(() => expect(platform.deleted).toContain(session.sessionId));
    await races.close();
  });

  it("fails a lane whose session can't be created, with the platform's words and no sandbox left starting", async () => {
    const { platform, races, lane } = setup();
    platform.refusals.set("isolated", new ManagedCopilotError("setup_failed", "The sandbox couldn't start: no space left on the device."));
    races.start("answer");
    await vi.waitFor(() => expect(lane("isolated").status).toBe("failed"));
    expect(lane("isolated")).toMatchObject({ verdict: "failed", error: "The sandbox couldn't start: no space left on the device.", sandboxes: [] });
    await races.close();
  });

  it("stops: every running lane is cancelled and its session deleted", async () => {
    const { platform, races, lane } = setup();
    races.start("split");
    const shared = await platform.session("shared");
    shared.answer("1. 315948\n2. 5617\n3. 11629");
    await vi.waitFor(() => expect(lane("shared").status).toBe("done"));
    races.stop();
    expect(races.snapshot()!.state).toBe("stopped");
    expect(lane("isolated").status).toBe("stopped");
    expect(lane("shared")).toMatchObject({ status: "done", verdict: "correct", place: 1 });
    await races.close();
    expect(platform.sessions.get("isolated")!.aborted).toBe(true);
    expect(platform.deleted).toHaveLength(6);
    expect(() => races.stop()).toThrowError(RaceError);
  });

  it("refuses a second race while one runs, and any race while the platform is away", async () => {
    const { platform, races } = setup();
    races.start("answer");
    expect(thrown(() => races.start("answer"))).toMatchObject({ code: "race_running", status: 409 });
    await races.close();
    platform.status = { state: "unavailable", message: "Managed Copilot isn't reachable yet." };
    expect(thrown(() => races.start("answer"))).toMatchObject({ code: "platform_unavailable", status: 503, message: "Managed Copilot isn't reachable yet." });
  });

  it("keeps the last race, so the board shows it after a restart", async () => {
    const store = new RaceStore(mkdtempSync(join(tmpdir(), "pattern-race-")));
    const { platform, races } = setup({ store });
    races.start("answer");
    for (const id of ["shared", "isolated", "promotable", "direct", "delegate", "mixed"] as const) (await platform.session(id)).answer("The order total is $925.00.");
    await vi.waitFor(() => expect(races.snapshot()!.state).toBe("finished"));
    const restarted = new RaceManager({ platform: new FakePlatform(), config: { laneTimeoutMs: 1_000, pollIntervalMs: 10 }, store });
    expect(restarted.snapshot()).toEqual(races.snapshot());
    expect(restarted.snapshot()!.lanes.every((run) => run.verdict === "correct")).toBe(true);
  });

  it("deletes the sessions an interrupted race left behind", async () => {
    const { platform, races } = setup();
    platform.leftovers = [`${SESSION_PREFIX}old-shared`, "someone-elses-session"];
    await races.deleteLeftovers();
    expect(platform.deleted).toEqual([`${SESSION_PREFIX}old-shared`]);
  });
});
