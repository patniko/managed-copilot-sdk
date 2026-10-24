// Core's placement cutover (used by the promotion module): fencing, sealing, buffering, held completions, commit,
// and abort, with the fake runtime as both the shared source and the sandbox destination.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeRuntime, FakeSandboxes, RawClient, sleep, startGitHubStub, startTestGateway, type TestGateway } from "./harness.js";

const ALICE = "alice-token";

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await sleep(10);
  }
}

describe("placement cutover", () => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  let gateway: TestGateway;
  let sandboxes: FakeSandboxes;
  const clients: RawClient[] = [];
  const promoted: { sessionId: string; placement?: string; state?: string; connectionId?: string }[] = [];

  const sessions = () => gateway.gateway.app.service("sessions");
  const connect = async () => {
    const client = await RawClient.connect(gateway.url, ALICE, "helper");
    clients.push(client);
    return client;
  };
  const messages = (client: RawClient, sessionId: string) =>
    client
      .events("assistant.message")
      .filter((event) => event["data"] && runtimeSessionOf(event) === sessionId)
      .map((event) => String((event["data"] as Record<string, unknown>)["content"]));
  // RawClient keeps inner events; the fake runtime records which session each event id belongs to.
  const runtimeSessionOf = (event: Record<string, unknown>) => [...runtime.sessions.values()].find((session) => session.events.some((candidate) => candidate.id === event["id"]))?.id;
  const sourceConnection = (sessionId: string) => runtime.calls("session.create").find((call) => call.params["sessionId"] === sessionId)!.connection;
  const lastCall = (method: string, sessionId: string) => runtime.calls(method).filter((call) => call.params["sessionId"] === sessionId).at(-1);

  beforeAll(async () => {
    runtime = new FakeRuntime();
    await runtime.start();
    github = await startGitHubStub({ [ALICE]: { id: 1001, login: "alice" } });
    gateway = await startTestGateway({
      runtime,
      githubUrl: github.url,
      deployment: { name: "copilot", environments: { helper: { type: "promotable", promoteTo: "worker" }, worker: { type: "isolated", size: "small" } } },
    });
    sandboxes = new FakeSandboxes(runtime);
    (gateway.gateway.app.services as Record<string, unknown>)["sandboxes"] = sandboxes;
    // Durable fences actions by placement generation: carrying the moved call over to the new generation is the
    // promotion module's job. These tests cover core's cutover mechanics, so they run without durable's ledger.
    delete (gateway.gateway.app.services as Record<string, unknown>)["actions"];
    sessions().onLifecycle((event) => {
      if (event.type !== "promoted") return;
      const record = sessions().get(event.sessionId);
      promoted.push({ sessionId: event.sessionId, ...(record ? { placement: record.placement, state: record.state } : {}) });
    });
    // What the promotion module's request_sandbox does, reduced to the cutover calls.
    gateway.gateway.app.service("platformTools").register({
      name: "test_move",
      description: "Moves this session into its sandbox",
      parameters: { type: "object", properties: {} },
      appliesTo: ({ type, placement }) => type === "promotable" && placement === "shared",
      handler: async (_args, context) => {
        const cut = await sessions().cutover!(context.sessionId, { generation: sessions().get(context.sessionId)!.generation });
        cut.fence();
        await cut.source("session.suspend");
        await cut.source("sessions.close");
        await cut.open({ continuePendingWork: true });
        cut.commit();
        return "moved";
      },
    });
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await gateway?.close();
    await runtime?.close();
    await github?.close();
  });

  it("moves a session mid-turn: the held sendAndWait completes in the sandbox and the handoff reaches nobody", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, tools: [{ name: "lookup_order" }], requestPermission: true });
    const reply = await client.request<{ response?: { data?: { content?: string } }; aborted?: boolean; completionEventId?: string }>("session.sendAndWait", { sessionId, prompt: "tool:test_move" });
    expect(reply.response?.data?.content).toBe("tool said: moved");
    expect(reply.aborted).toBe(false);
    // The suspend's interruption, aborted idle, and shutdown never reached the client.
    expect(client.events("session.shutdown")).toHaveLength(0);
    expect(client.events("agent.interrupted")).toHaveLength(0);
    expect(client.events("session.idle").some((event) => (event["data"] as Record<string, unknown>)["aborted"] === true)).toBe(false);

    expect(sessions().get(sessionId)).toMatchObject({ placement: "sandbox", generation: 1, state: "idle" });
    expect(promoted).toContainEqual({ sessionId, placement: "sandbox", state: expect.not.stringMatching(/^promoting$/) });
    expect((await sessions().runtime(sessionId)).connectionId).toMatch(new RegExp(`^sandbox:${sessionId}`));

    // The destination got the caller's configuration admitted for sandbox placement, plus the pending-work flag.
    const resumed = sandboxes.detail(sessionId, "prepare session.resume");
    expect(resumed).toMatchObject({ continuePendingWork: true, workingDirectory: "/workspace", requestPermission: true });
    expect(resumed).not.toHaveProperty("systemMessage");
    expect(resumed).not.toHaveProperty("availableTools");
    expect(resumed).not.toHaveProperty("enableConfigDiscovery");
    expect((resumed["tools"] as { name: string }[]).map((tool) => tool.name)).toContain("lookup_order");
    expect((resumed["tools"] as { name: string }[]).map((tool) => tool.name)).not.toContain("test_move");

    // Later turns run in the sandbox.
    await client.request("session.sendAndWait", { sessionId, prompt: "after the move" });
    expect(lastCall("session.sendAndWait", sessionId)!.connection).not.toBe(sourceConnection(sessionId));
    expect(messages(client, sessionId)).toContain("echo: after the move");
  });

  it("delivers what the source said between fence and seal, holds requests, and drops the source's handoff", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId });
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    cut.fence();
    expect(sessions().get(sessionId)!.state).toBe("promoting");
    runtime.emitEvent(sessionId, "assistant.message", { content: "said during the fence" });
    const send = client.request("session.send", { sessionId, prompt: "queued during the move" });
    await sleep(50);
    expect(messages(client, sessionId)).not.toContain("said during the fence");
    expect(lastCall("session.send", sessionId)).toBeUndefined();

    await cut.source("session.suspend");
    runtime.emitEvent(sessionId, "assistant.message", { content: "artifact after the seal" });
    await cut.open({ continuePendingWork: true });
    cut.commit();
    await send;
    await waitUntil(() => messages(client, sessionId).includes("echo: queued during the move"));
    const said = messages(client, sessionId);
    expect(said).not.toContain("artifact after the seal");
    expect(said.indexOf("said during the fence")).toBeGreaterThanOrEqual(0);
    expect(said.indexOf("said during the fence")).toBeLessThan(said.indexOf("echo: queued during the move"));
    expect(lastCall("session.send", sessionId)!.connection).not.toBe(sourceConnection(sessionId));
  });

  it("delivers a reply the source gave before the seal as is", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, tools: [{ name: "lookup_order" }] });
    const waiting = client.request<{ response?: { data?: { content?: string } }; aborted?: boolean }>("session.sendAndWait", { sessionId, prompt: "tool:lookup_order" });
    const requested = await client.waitForEvent("external_tool.requested");
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    cut.fence();
    // The turn finishes on the source inside the fence window: its events and reply are genuine.
    runtime.answerTool(String((requested["data"] as Record<string, unknown>)["requestId"]), "finished before the seal");
    await sleep(50);
    expect(messages(client, sessionId)).not.toContain("tool said: finished before the seal");
    await cut.abort();
    const reply = await waiting;
    expect(reply.response?.data?.content).toBe("tool said: finished before the seal");
    expect(reply.aborted).toBeUndefined();
    expect(messages(client, sessionId)).toContain("tool said: finished before the seal");
    expect(sessions().get(sessionId)).toMatchObject({ placement: "shared", generation: 0 });
    expect(sessions().get(sessionId)!.state).not.toBe("promoting");
  });

  it("keeps an aborted session on its source and resumes it there with the requested extras after a seal", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId });
    await client.request("session.sendAndWait", { sessionId, prompt: "first" });
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    cut.fence();
    await cut.source("session.suspend");
    await cut.abort({ resume: { continuePendingWork: true } });
    await client.request("session.sendAndWait", { sessionId, prompt: "back on the source" });
    const resumed = lastCall("session.resume", sessionId)!;
    expect(resumed.params["continuePendingWork"]).toBe(true);
    expect(resumed.connection).toBe(sourceConnection(sessionId));
    expect(messages(client, sessionId)).toContain("echo: back on the source");
    expect(sessions().get(sessionId)).toMatchObject({ placement: "shared", generation: 0 });
  });

  it("refuses stale generations and a second cutover, and ends an open cutover when the session is deleted", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId });
    await expect(sessions().cutover!(sessionId, { generation: 7 })).rejects.toMatchObject({ code: "conflict" });
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    await expect(sessions().cutover!(sessionId, { generation: 0 })).rejects.toMatchObject({ code: "promotion_busy" });
    cut.fence();
    await sessions().delete(1001, sessionId);
    expect(() => cut.commit()).toThrow(/already closed/);
    expect(sessions().get(sessionId)).toBeUndefined();
  });
});
