// Orchestrator recovery: a gateway restarted on the same data directory settles the workers the stopped one left
// working or half started, so waits end and slots free up, and finishes deleting stopped workers' sessions.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ManagedCopilotError, type WorkerInfo } from "@managed-copilot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db.js";
import type { Principal } from "../src/http.js";
import { ORCHESTRATOR_MIGRATIONS, WorkerStore } from "../src/modules/orchestrator/store.js";
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

  it("fails a worker left working in a session whose deletion failed, once the restart ends the run the deletion cut", async () => {
    const first = await start();
    const { client, sessionId } = await coordinator(first.gateway);
    await tool(client, sessionId, "start_worker", { name: "cut", task: "stall" });
    const firstSessions = first.gateway.gateway.app.service("sessions");
    await waitUntil(() => {
      const worker = workers(first.gateway, sessionId)[0];
      return worker?.state === "working" && firstSessions.get(worker.id)?.lastTurn?.status === "running";
    });
    const workerId = workers(first.gateway, sessionId)[0]!.id;
    await client.close();
    await first.gateway.close({ keepData: true });
    // As a gateway left it that stopped right after the owner's deletion of the worker's session failed: the deletion
    // closed the session's runtime connection and cut its run, which had reported an error it went on from.
    const db = new DatabaseSync(join(dataDir, "gateway.db"));
    try {
      const row = db.prepare("SELECT last_turn FROM core_sessions WHERE id = ?").get(workerId) as { last_turn: string };
      const turn = { ...(JSON.parse(row.last_turn) as Record<string, unknown>), status: "failed" };
      db.prepare("UPDATE core_sessions SET state = 'failed', last_turn = ? WHERE id = ?").run(JSON.stringify(turn), workerId);
    } finally {
      db.close();
    }

    const second = await start();
    try {
      await waitUntil(() => workers(second.gateway, sessionId)[0]?.state === "failed");
      expect(workers(second.gateway, sessionId)[0]!.error).toMatch(/interrupted because the platform lost the connection/);
      expect(second.gateway.gateway.app.service("sessions").get(workerId)).toMatchObject({ state: "failed", lastTurn: { status: "failed" } });
    } finally {
      await second.gateway.close({ keepData: true });
    }
  });

  it("leaves a message a shutdown cut unanswered: run again after the restart, it says the message may have arrived", async () => {
    const first = await start();
    const { client, sessionId } = await coordinator(first.gateway);
    await tool(client, sessionId, "start_worker", { name: "cut", task: "hello" });
    await waitUntil(() => workers(first.gateway, sessionId)[0]?.state === "idle");
    const workerId = workers(first.gateway, sessionId)[0]!.id;
    // The message to the worker is still being sent when the gateway stops; the send then fails.
    const sessions = first.gateway.gateway.app.service("sessions");
    const send = sessions.send.bind(sessions);
    let reached!: () => void;
    const sending = new Promise<void>((resolve) => (reached = resolve));
    let cut!: () => void;
    const stopped = new Promise<void>((resolve) => (cut = resolve));
    sessions.send = async (principal, id, input, options) => {
      if (id !== workerId) return send(principal, id, input, options);
      reached();
      await stopped;
      throw new Error("The runtime connection closed");
    };
    const replying = client.request("session.sendAndWait", { sessionId, prompt: `tool:message_worker ${JSON.stringify({ worker: "cut", message: "more" })}` }).catch(() => undefined);
    await sending;
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => void rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      await client.close();
      await first.gateway.close({ keepData: true });
      cut();
      await replying;
      await sleep(200);
      // Nothing was recorded (or attempted) while the database closed.
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    const second = await start();
    try {
      // Its message never started a run, so it fails with its earlier report kept; the message still counts.
      await waitUntil(() => workers(second.gateway, sessionId)[0]?.state === "failed");
      expect(workers(second.gateway, sessionId)[0]).toMatchObject({ result: "echo: hello", messages: 2 });
      expect(workers(second.gateway, sessionId)[0]!.error).toMatch(/before it received your last message/);
      // The tool call ran again and said so, without sending the message a second time.
      const actions = second.gateway.gateway.app.service("actions");
      await waitUntil(() => actions.list(sessionId).some((action) => action.tool === "message_worker" && action.state === "completed"));
      expect(actions.list(sessionId).find((action) => action.tool === "message_worker")!.result).toMatch(/may have reached "cut" before the platform restarted/);
    } finally {
      await second.gateway.close({ keepData: true });
    }
  });

  it("leaves a wait a shutdown cut unanswered, also while it waits for outputs, and runs it again after the restart", async () => {
    const first = await start();
    const { client, sessionId } = await coordinator(first.gateway);
    await tool(client, sessionId, "start_worker", { name: "publisher", task: "hello" });
    await waitUntil(() => workers(first.gateway, sessionId)[0]?.state === "idle");
    const services = first.gateway.gateway.app.services as Record<string, unknown>;
    let asked!: () => void;
    const publishing = new Promise<void>((resolve) => (asked = resolve));
    // Publishing finishes only after the gateway stopped.
    services["artifacts"] = {
      list: () => [],
      waitForPublication: async () => {
        asked();
        await sleep(300);
        return { turnId: "t1", state: "published", artifacts: [] };
      },
    };
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => void rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const replying = client.request("session.sendAndWait", { sessionId, prompt: "tool:wait_for_workers {}" }).catch(() => undefined);
      await publishing;
      await client.close();
      await first.gateway.close({ keepData: true });
      await sleep(500);
      await replying;
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    const second = await start();
    try {
      const actions = second.gateway.gateway.app.service("actions");
      await waitUntil(() => actions.list(sessionId).some((action) => action.tool === "wait_for_workers" && action.state === "completed"));
      expect(actions.list(sessionId).find((action) => action.tool === "wait_for_workers")!.result).toMatch(/echo: hello/);
    } finally {
      await second.gateway.close({ keepData: true });
    }
  });

  it("checks again, after an upgrade, whether stopped workers' sessions outlived them", () => {
    // A ledger from before cleanups and send times were recorded, and one that took migration 2 before it backfilled them.
    const earlierSecond = `ALTER TABLE orchestrator_workers ADD COLUMN sent_at TEXT;
      ALTER TABLE orchestrator_workers ADD COLUMN cleanup INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX orchestrator_workers_cleanup ON orchestrator_workers (cleanup) WHERE cleanup = 1;
      CREATE TABLE orchestrator_stops (key TEXT PRIMARY KEY, worker_id TEXT NOT NULL, created_at TEXT NOT NULL);`;
    for (const applied of [ORCHESTRATOR_MIGRATIONS.slice(0, 1), [ORCHESTRATOR_MIGRATIONS[0]!, earlierSecond]]) {
      const db = openDatabase(":memory:");
      try {
        migrate(db, "orchestrator", applied);
        const insert = db.prepare(
          `INSERT INTO orchestrator_workers (id, coordinator_id, coordinator_incarnation, owner_id, incarnation, name, environment, task, state, messages, start_key, created_at, updated_at)
           VALUES (?, 'coord', 'inc-c', 1001, ?, ?, 'coder', 'task', ?, 1, ?, ?, ?)`,
        );
        insert.run("w-stopped", "inc-1", "stopped", "stopped", "k1", "2026-10-26T00:00:00.000Z", "2026-10-26T00:00:00.000Z");
        insert.run("w-working", "inc-2", "working", "working", "k2", "2026-10-26T00:00:00.000Z", "2026-10-26T01:00:00.000Z");
        insert.run("w-idle", "inc-3", "idle", "idle", "k3", "2026-10-26T00:00:00.000Z", "2026-10-26T02:00:00.000Z");
        const store = new WorkerStore(db);
        expect(store.pendingCleanup().map((worker) => worker.id)).toEqual(["w-stopped"]);
        expect(store.get("w-working")).toMatchObject({ sentAt: "2026-10-26T01:00:00.000Z", cleanup: false });
        expect(store.get("w-idle")?.sentAt).toBeUndefined();
      } finally {
        db.close();
      }
    }
  });
});
