// Orchestrator recovery: a gateway restarted on the same data directory settles the workers the stopped one left
// working or half started, so waits end and slots free up.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerInfo } from "@managed-copilot/protocol";
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
    (gateway.gateway.app.services as Record<string, unknown>)["sandboxes"] = sandboxes;
    return { gateway, sandboxes };
  };
  const workers = (gateway: TestGateway, coordinatorId: string): WorkerInfo[] => gateway.gateway.app.service("orchestrator").listFor(ALICE_PRINCIPAL, coordinatorId);

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
});
