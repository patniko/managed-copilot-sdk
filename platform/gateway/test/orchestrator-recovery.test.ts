// Orchestrator recovery: a gateway restarted on the same data directory settles the workers the stopped one left
// working or half started, so waits end and slots free up, and finishes deleting stopped workers' sessions.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ManagedCopilotError, type WorkerInfo } from "@managed-copilot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../src/http.js";
import { FakeRuntime, FakeSandboxes, RawClient, sleep, startGitHubStub, startTestGateway, type TestGateway } from "./harness.js";

const ALICE = "alice-token";
const ALICE_PRINCIPAL: Principal = { accountId: 1001, login: "alice", token: ALICE };
const DEPLOYMENT = {
  name: "copilot",
  environments: {
    team: { type: "orchestrator", workers: ["coder"], maxWorkers: 2 },
    coder: { type: "isolated", size: "small" },
  },
};

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await sleep(10);
  }
}

describe("orchestrator recovery", () => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  const dataDir = mkdtempSync(join(tmpdir(), "mc-orchestrator-recovery-"));

  const start = async () => {
    const gateway = await startTestGateway({ runtime, githubUrl: github.url, dataDir, deployment: DEPLOYMENT });
    const sandboxes = new FakeSandboxes(runtime);
    sandboxes.reportSandboxes = true;
    (gateway.gateway.app.services as Record<string, unknown>)["sandboxes"] = sandboxes;
    return { gateway, sandboxes };
  };
  const workers = (gateway: TestGateway, coordinatorId: string): WorkerInfo[] => gateway.gateway.app.service("orchestrator").listFor(ALICE_PRINCIPAL, coordinatorId);
  /** Runs one coordinator turn that calls `name`, and returns what the tool told the model. */
  const tool = async (client: RawClient, sessionId: string, name: string, args: Record<string, unknown>) => {
    const reply = await client.request<{ response?: { data?: { content?: string } } }>("session.sendAndWait", { sessionId, prompt: `tool:${name} ${JSON.stringify(args)}` });
    return String(reply.response?.data?.content ?? "");
  };
  const coordinator = async (gateway: TestGateway) => {
    const client = await RawClient.connect(gateway.url, ALICE, "team");
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, requestPermission: true });
    return { client, sessionId };
  };

  beforeAll(async () => {
    runtime = new FakeRuntime();
    await runtime.start();
    github = await startGitHubStub({ [ALICE]: { id: 1001, login: "alice" } });
  });

  afterAll(async () => {
    await runtime?.close();
    await github?.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("ends a worker turn a restart cut, and fails a start a restart interrupted without holding a slot", async () => {
    const first = await start();
    const client = await RawClient.connect(first.gateway.url, ALICE, "team");
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, requestPermission: true });
    await client.request("session.sendAndWait", { sessionId, prompt: `tool:start_worker ${JSON.stringify({ name: "busy", task: "stall" })}` });
    await waitUntil(() => workers(first.gateway, sessionId)[0]?.state === "working");
    // The next worker's sandbox runtime never opens before the gateway stops.
    const held = first.sandboxes.holdNextOpen();
    await client.request("session.sendAndWait", { sessionId, prompt: `tool:start_worker ${JSON.stringify({ name: "late", task: "hello" })}` });
    await held.held;
    await client.close();
    const closing = first.gateway.close({ keepData: true });
    held.release();
    await closing;

    const second = await start();
    try {
      await waitUntil(() => workers(second.gateway, sessionId).every((worker) => worker.state === "failed"));
      const [busy, late] = workers(second.gateway, sessionId);
      expect(busy).toMatchObject({ name: "busy", state: "failed" });
      expect(late).toMatchObject({ name: "late", state: "failed" });
      expect(late!.error).toMatch(/restarted/);
      // A start that never got a session holds no slot, and its name is free again.
      const again = await RawClient.connect(second.gateway.url, ALICE, "team");
      try {
        await again.request("session.resume", { sessionId, requestPermission: true });
        const reply = await again.request<{ response?: { data?: { content?: string } } }>("session.sendAndWait", { sessionId, prompt: `tool:start_worker ${JSON.stringify({ name: "late", task: "hello again" })}` });
        expect(reply.response?.data?.content).toMatch(/Started worker "late"/);
        await waitUntil(() => workers(second.gateway, sessionId).some((worker) => worker.name === "late" && worker.state === "idle"));
      } finally {
        await again.close();
      }
    } finally {
      await second.gateway.close({ keepData: true });
    }
  });

  it("settles a worker left working by its last recorded turn, and keeps its earlier report when the message never ran", async () => {
    const first = await start();
    const { client, sessionId } = await coordinator(first.gateway);
    await tool(client, sessionId, "start_worker", { name: "ran", task: "hello" });
    await tool(client, sessionId, "start_worker", { name: "unsent", task: "hello" });
    await waitUntil(() => workers(first.gateway, sessionId).length === 2 && workers(first.gateway, sessionId).every((worker) => worker.state === "idle"));
    const [ran, unsent] = workers(first.gateway, sessionId);
    await client.close();
    await first.gateway.close({ keepData: true });
    // As if each gateway had stopped right after recording a new message: one sent before the worker's last turn
    // ended (that turn ran it), one after (it never started a run).
    const db = new DatabaseSync(join(dataDir, "gateway.db"));
    try {
      const working = db.prepare("UPDATE orchestrator_workers SET state = 'working', messages = messages + 1, sent_at = ? WHERE id = ?");
      working.run("2000-01-01T00:00:00.000Z", ran!.id);
      working.run(new Date().toISOString(), unsent!.id);
    } finally {
      db.close();
    }

    const second = await start();
    try {
      await waitUntil(() => workers(second.gateway, sessionId).every((worker) => worker.state !== "working"));
      const [settledRan, settledUnsent] = workers(second.gateway, sessionId);
      expect(settledRan).toMatchObject({ state: "idle", messages: 2 });
      expect(settledRan!.result).toBeUndefined();
      expect(settledRan!.error).toMatch(/reply wasn't captured/);
      expect(settledUnsent).toMatchObject({ state: "failed", result: "echo: hello" });
      expect(settledUnsent!.error).toMatch(/before it received your last message/);
    } finally {
      await second.gateway.close({ keepData: true });
    }
  });

  it("finishes deleting a stopped worker's session after a restart", async () => {
    const first = await start();
    const { client, sessionId } = await coordinator(first.gateway);
    await tool(client, sessionId, "start_worker", { name: "leftover", task: "hello" });
    await waitUntil(() => workers(first.gateway, sessionId)[0]?.state === "idle");
    const workerId = workers(first.gateway, sessionId)[0]!.id;
    first.sandboxes.failNextDelete = new ManagedCopilotError("internal", "The sandbox backend is not responding");
    expect(await tool(client, sessionId, "stop_worker", { worker: "leftover" })).toMatch(/couldn't be deleted yet/);
    expect(first.gateway.gateway.app.service("sessions").get(workerId)).toBeDefined();
    await client.close();
    await first.gateway.close({ keepData: true });

    const second = await start();
    try {
      // Recovery runs as the gateway starts (with its own sandbox service): the session goes, and the worker stays stopped.
      await waitUntil(() => second.gateway.gateway.app.service("sessions").get(workerId) === undefined);
      expect(workers(second.gateway, sessionId)[0]).toMatchObject({ state: "stopped" });
    } finally {
      await second.gateway.close({ keepData: true });
    }
  });
});
