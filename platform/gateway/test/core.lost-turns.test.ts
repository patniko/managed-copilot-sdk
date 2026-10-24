// Turns a lost runtime connection cut. On stock runtime 1.0.103 a sandbox runtime keeps the inference-provider
// registration of a closed connection forever, so a turn cannot finish once the gateway's connection is gone (and a
// restarted runtime loses its turns): core ends such turns visibly, unless durable's pending work carries them, and
// opens a sandbox runtime again after its sandbox restarted it to free the registration.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManagedCopilotError, type PlatformEvent } from "@managed-copilot/protocol";
import type { SessionManager } from "../src/modules/core/sessions.js";
import { FakeRuntime, FakeSandboxes, RawClient, sleep, startGitHubStub, startTestGateway, type TestGateway } from "./harness.js";

const ALICE = "alice-token";

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await sleep(10);
  }
}

describe("turns a lost runtime connection cut", () => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  let gateway: TestGateway;
  let sandboxes: FakeSandboxes;
  const clients: RawClient[] = [];

  const sessions = () => gateway.gateway.app.service("sessions") as unknown as SessionManager;
  const install = () => {
    sandboxes = new FakeSandboxes(runtime);
    (gateway.gateway.app.services as Record<string, unknown>)["sandboxes"] = sandboxes;
  };
  const connect = async (environment = "coder", answer?: RawClient["answer"]) => {
    const client = await RawClient.connect(gateway.url, ALICE, environment);
    if (answer) client.answer = answer;
    clients.push(client);
    return client;
  };
  const record = (sessionId: string) => sessions().get(sessionId)!;
  const watch = (sessionId: string) => {
    const observed: string[] = [];
    const platform: string[] = [];
    const off = sessions().subscribeSession(sessionId, (_id, event) => observed.push(event.type));
    const offPlatform = gateway.gateway.app.service("events").subscribe((event: PlatformEvent) => {
      if (event.sessionId === sessionId) platform.push(`${event.type}${event.type === "session.idle" ? `:${String(event.data["status"])}` : ""}`);
    });
    return {
      observed,
      platform,
      stop: () => {
        off();
        offPlatform();
      },
    };
  };

  beforeAll(async () => {
    runtime = new FakeRuntime();
    await runtime.start();
    github = await startGitHubStub({ [ALICE]: { id: 1001, login: "alice" } });
    gateway = await startTestGateway({ runtime, githubUrl: github.url });
    install();
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await gateway?.close();
    await runtime?.close();
    await github?.close();
  });

  it("ends a turn its runtime connection took with it, for waiting clients, observers, and the ledger", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, requestPermission: true });
    const seen = watch(sessionId);
    try {
      const waiting = client.request("session.sendAndWait", { sessionId, prompt: "stall" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await waitUntil(() => record(sessionId).lastTurn?.status === "running");
      const turnId = record(sessionId).lastTurn!.turnId;
      // The runtime connection is lost mid-inference (a gateway handover, a relay drop, a runtime restart).
      runtime.dropConnections();
      // The caller's wait settles with what happened, not with a closed connection.
      expect(await waiting).toMatchObject({ message: expect.stringContaining("This turn was interrupted"), data: { code: "capability_unavailable" } });
      await waitUntil(() => record(sessionId).lastTurn?.status === "failed");
      expect(record(sessionId)).toMatchObject({ state: "idle", lastTurn: { turnId, status: "failed" } });
      const error = client.events("session.error").find((event) => (event["data"] as Record<string, unknown>)["originatingMessageId"] === turnId);
      expect(error).toMatchObject({ ephemeral: true, data: { errorType: "interrupted", message: expect.stringContaining("Send your message again") } });
      expect(client.events("session.idle").length).toBeGreaterThan(0);
      expect(seen.observed.slice(-2)).toEqual(["session.error", "session.idle"]);
      expect(seen.platform).toEqual(expect.arrayContaining(["session.failed", "session.idle:failed"]));

      // The session is resumable: the next turn restores it and runs.
      await expect(client.request("session.sendAndWait", { sessionId, prompt: "again" })).resolves.toMatchObject({ response: { data: { content: "echo: again" } } });
      expect(record(sessionId).lastTurn?.status).toBe("completed");
    } finally {
      seen.stop();
    }
  });

  it("keeps a turn waiting on a pending tool call, which continues once the call is answered", async () => {
    const client = await connect("coder", (method) => (method === "hooks.invoke" ? { output: {} } : {}));
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, tools: [{ name: "lookup_order" }], requestPermission: true });
    await client.request("session.send", { sessionId, prompt: "tool:lookup_order" });
    const requested = await client.waitForEvent("external_tool.requested");
    runtime.dropConnections();
    await sleep(100);
    // Durable owns the pending call: the turn survives the lost connection (continuePendingWork).
    expect(record(sessionId).lastTurn?.status).toBe("running");
    expect(client.events("session.error")).toHaveLength(0);
    // A restore finds the runtime still waiting for it and keeps the turn; answering it completes the turn.
    await sessions().request(sessionId, "session.getMessages", {});
    expect(record(sessionId).lastTurn?.status).toBe("running");
    runtime.answerTool(String((requested["data"] as Record<string, unknown>)["requestId"]), "Order 1234 shipped yesterday.");
    await waitUntil(() => record(sessionId).lastTurn?.status === "completed");
  });

  it("ends a turn a stopped gateway was running when it starts again", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, requestPermission: true });
    await client.request("session.send", { sessionId, prompt: "stall" });
    await waitUntil(() => record(sessionId).lastTurn?.status === "running");
    const turnId = record(sessionId).lastTurn!.turnId;
    for (const connected of clients.splice(0)) await connected.close();
    const dataDir = gateway.dataDir;
    await gateway.close({ keepData: true });
    // The stopped gateway's runtime connections are gone with it (the fake keeps the turn "running", as a sandbox
    // runtime would whose inference provider left).
    gateway = await startTestGateway({ runtime, githubUrl: github.url, dataDir });
    install();
    await waitUntil(() => sessions().get(sessionId)?.lastTurn?.status === "failed");
    expect(record(sessionId)).toMatchObject({ state: "idle", lastTurn: { turnId, status: "failed" } });
    const info = await (await fetch(`${gateway.url}/v1/sessions/${sessionId}`, { headers: { authorization: `Bearer ${ALICE}` } })).json();
    expect(info).toMatchObject({ state: "idle", lastTurn: { turnId, status: "failed" } });
  });

  it("settles a turn an external shared runtime finished while the connection was lost, without an error", async () => {
    const client = await connect("chat");
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, requestPermission: true });
    await client.request("session.send", { sessionId, prompt: "stall" });
    await waitUntil(() => record(sessionId).lastTurn?.status === "running");
    runtime.dropConnections();
    await sleep(100);
    // An external runtime keeps its turns: nothing ends while the connection is down.
    expect(record(sessionId).lastTurn?.status).toBe("running");
    // Restored, it reports the turn is no longer running: it finished unseen, so it is settled quietly.
    await sessions().request(sessionId, "session.getMessages", {});
    await waitUntil(() => record(sessionId).lastTurn?.status === "completed");
    expect(client.events("session.error")).toHaveLength(0);
  });

  it("opens a sandbox runtime again after its sandbox restarted it to free the inference provider", async () => {
    const client = await connect();
    const reopen = () => new ManagedCopilotError("capability_unavailable", "The sandbox restarted its runtime to release a lost connection's inference registration.", { reopen: true });
    const first = crypto.randomUUID();
    sandboxes.initializeFailures.push(reopen());
    await client.request("session.create", { sessionId: first, requestPermission: true });
    expect(sandboxes.ops(first).filter((op) => op === "initialize")).toHaveLength(2);
    await expect(client.request("session.sendAndWait", { sessionId: first, prompt: "hello" })).resolves.toMatchObject({ response: { data: { content: "echo: hello" } } });

    // Bounded: a runtime that keeps asking to be reopened fails the open.
    const second = crypto.randomUUID();
    sandboxes.initializeFailures.push(reopen(), reopen(), reopen());
    await expect(client.request("session.create", { sessionId: second, requestPermission: true })).rejects.toMatchObject({ data: { code: "capability_unavailable" } });
    expect(sandboxes.ops(second).filter((op) => op === "initialize")).toHaveLength(3);
    sandboxes.initializeFailures.length = 0;

    // A real second provider is not reopened.
    const third = crypto.randomUUID();
    sandboxes.initializeFailures.push(new ManagedCopilotError("conflict", "Another connection of this gateway is the sandbox runtime's inference provider."));
    await expect(client.request("session.create", { sessionId: third, requestPermission: true })).rejects.toMatchObject({ data: { code: "conflict" } });
    expect(sandboxes.ops(third).filter((op) => op === "initialize")).toHaveLength(1);
  });
});
