// Core's placement cutover (used by the promotion module): fencing, sealing, buffering, held completions, commit,
// and abort, with the fake runtime as both the shared source and the sandbox destination.
import { join } from "node:path";
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
          await cut.commit();
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
    const delivered: string[] = [];
    const unsubscribe = sessions().subscribe((id, event) => {
      if (id === sessionId && event.type === "assistant.message") delivered.push(String(event.data["content"]));
    });
    let atPromoted: string[] | undefined;
    const off = sessions().onLifecycle((event) => {
      if (event.sessionId === sessionId && event.type === "promoted") atPromoted = [...delivered];
    });
    try {
      const cut = await sessions().cutover!(sessionId, { generation: 0 });
      cut.fence();
      expect(sessions().get(sessionId)!.state).toBe("promoting");
      const hostPath = join(gateway.dataDir, "runtime", "shared", "workspaces", sessionId, "private.txt");
      runtime.emitEvent(sessionId, "assistant.message", { content: `said during the fence, see ${hostPath}` });
      const send = client.request("session.send", { sessionId, prompt: "queued during the move" });
      await sleep(50);
      expect(messages(client, sessionId).some((text) => text.startsWith("said during the fence"))).toBe(false);
      expect(lastCall("session.send", sessionId)).toBeUndefined();

      await cut.source("session.suspend");
      runtime.emitEvent(sessionId, "assistant.message", { content: "artifact after the seal" });
      await cut.open({ continuePendingWork: true });
      await cut.commit();
      // Listeners of `promoted` (promotion's action carry-over) run after every held-back event was processed.
      expect(atPromoted?.some((text) => text.startsWith("said during the fence"))).toBe(true);
      await send;
      await waitUntil(() => messages(client, sessionId).includes("echo: queued during the move"));
      const said = messages(client, sessionId);
      expect(said).not.toContain("artifact after the seal");
      // Buffered shared events keep their shared-placement scrubbing after the session moved.
      const buffered = said.findIndex((text) => text.startsWith("said during the fence"));
      expect(said[buffered]).toBe("said during the fence, see /workspace/private.txt");
      expect(buffered).toBeLessThan(said.indexOf("echo: queued during the move"));
      expect(lastCall("session.send", sessionId)!.connection).not.toBe(sourceConnection(sessionId));
      // The source's handoff never shows up in history either.
      const history = await client.request<{ events: { type: string; data: Record<string, unknown> }[] }>("session.getMessages", { sessionId });
      expect(history.events.map((event) => event.type)).not.toContain("session.shutdown");
      expect(history.events.map((event) => event.type)).not.toContain("agent.interrupted");
      expect(history.events.some((event) => event.data["content"] === "artifact after the seal")).toBe(false);
      // History from the session's shared placement stays scrubbed after the move.
      expect(history.events.find((event) => String(event.data["content"]).startsWith("said during the fence"))?.data["content"]).toBe("said during the fence, see /workspace/private.txt");
      expect(history.events.find((event) => event.type === "session.start")?.data).not.toHaveProperty("context");
      const log = await client.request<{ events: { type: string; data: Record<string, unknown> }[] }>("session.eventLog.read", { sessionId });
      expect(log.events.find((event) => String(event.data["content"]).startsWith("said during the fence"))?.data["content"]).toBe("said during the fence, see /workspace/private.txt");
      expect(log.events.map((event) => event.type)).not.toContain("session.shutdown");
    } finally {
      unsubscribe();
      off();
    }
  });

  it("routes a destination's session-less runtime requests (inference chunks) to its sandbox before commit", async () => {
    sandboxes.handlers.set("llmInference.httpRequestChunk", async (params) => ({ received: (params as Record<string, unknown>)["requestId"] }));
    try {
      const client = await connect();
      const sessionId = crypto.randomUUID();
      await client.request("session.create", { sessionId });
      const cut = await sessions().cutover!(sessionId, { generation: 0 });
      cut.fence();
      await cut.source("session.suspend");
      await cut.open({ continuePendingWork: true });
      const destination = lastCall("session.resume", sessionId)!.connection!;
      expect(destination).not.toBe(sourceConnection(sessionId));
      await expect(runtime.requestOn(destination, "llmInference.httpRequestChunk", { requestId: "r-1", chunk: "e30=" })).resolves.toEqual({ received: "r-1" });
      await cut.commit();
    } finally {
      sandboxes.handlers.delete("llmInference.httpRequestChunk");
    }
  });

  it("never sends to the source after the seal, even a request that already found it", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId });
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    // A service send that has found the ready source but not written its request yet.
    const sending = sessions().request(sessionId, "session.send", { prompt: "raced the seal", mode: "enqueue" });
    cut.fence();
    await cut.source("session.suspend");
    await sleep(50);
    const onSource = runtime.requests.filter((request) => request.params["sessionId"] === sessionId && request.connection === sourceConnection(sessionId)).map((request) => request.method);
    expect(onSource.slice(onSource.indexOf("session.suspend"))).not.toContain("session.send");
    await cut.open({ continuePendingWork: true });
    await cut.commit();
    await sending;
    expect(lastCall("session.send", sessionId)!.connection).not.toBe(sourceConnection(sessionId));
    await waitUntil(() => messages(client, sessionId).includes("echo: raced the seal"));
  });

  it("re-admits a client resume that was in flight on the source when the session moved", async () => {
    const first = await connect();
    const sessionId = crypto.randomUUID();
    await first.request("session.create", { sessionId });
    const second = await connect();
    // The source answers the second client's resume only after the move.
    const hold = runtime.holdNext("session.resume", sessionId);
    const resuming = second.request("session.resume", { sessionId, tools: [{ name: "late_tool" }] });
    await hold.held;
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    cut.fence();
    await cut.source("session.suspend");
    await cut.open({ continuePendingWork: true });
    await cut.commit();
    hold.release();
    await resuming;
    expect(sessions().get(sessionId)).toMatchObject({ placement: "sandbox", generation: 1 });
    // The resume was repeated on the sandbox, and the stored restore configuration is the sandbox's.
    const lastResume = lastCall("session.resume", sessionId)!;
    expect(lastResume.connection).not.toBe(sourceConnection(sessionId));
    expect((lastResume.params["tools"] as { name: string }[]).map((tool) => tool.name)).toContain("late_tool");
    const row = gateway.gateway.app.db.prepare("SELECT admitted FROM core_sessions WHERE id = ?").get(sessionId) as { admitted: string };
    const stored = JSON.parse(row.admitted) as { params: Record<string, unknown> };
    expect(stored.params["workingDirectory"]).toBe("/workspace");
    expect(stored.params).not.toHaveProperty("availableTools");
    expect(stored.params).not.toHaveProperty("systemMessage");
  });

  it("moves remote MCP servers with their original endpoints and carries the caller's option changes", async (ctx) => {
    if (!(gateway.gateway.app.services as Record<string, unknown>)["policy"]) return ctx.skip();
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, mcpServers: { docs: { type: "http", url: "https://140.82.112.21/mcp", headers: { "x-team": "docs" }, tools: ["*"] } } });
    const shared = runtime.sessions.get(sessionId)!.createParams["mcpServers"] as Record<string, Record<string, unknown>>;
    expect(String(shared["docs"]!["url"])).toMatch(/\/internal\/mcp\//);
    await client.request("session.options.update", { sessionId, reasoningEffort: "high" });
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    cut.fence();
    await cut.source("session.suspend");
    await cut.open({ continuePendingWork: true });
    await cut.commit();
    const moved = sandboxes.detail(sessionId, "prepare session.resume")["mcpServers"] as Record<string, Record<string, unknown>>;
    expect(moved["docs"]).toMatchObject({ url: "https://140.82.112.21/mcp", headers: { "x-team": "docs" } });
    expect(JSON.stringify(moved)).not.toContain("x-managed-copilot-mcp");
    const update = runtime.calls("session.options.update").filter((call) => call.params["sessionId"] === sessionId && call.connection !== sourceConnection(sessionId)).at(-1);
    expect(update?.params["reasoningEffort"]).toBe("high");
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

  it("resumes an aborted session on its source with the requested extras right after a seal, hiding the handoff", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId });
    await client.request("session.sendAndWait", { sessionId, prompt: "first" });
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    cut.fence();
    await cut.source("session.suspend");
    await cut.abort({ resume: { continuePendingWork: true } });
    // The session was closed on its source, so it is resumed there at once (its pending work continues).
    await waitUntil(() => lastCall("session.resume", sessionId)?.params["continuePendingWork"] === true);
    expect(lastCall("session.resume", sessionId)!.connection).toBe(sourceConnection(sessionId));
    await client.request("session.sendAndWait", { sessionId, prompt: "back on the source" });
    expect(lastCall("session.sendAndWait", sessionId)!.connection).toBe(sourceConnection(sessionId));
    expect(messages(client, sessionId)).toContain("echo: back on the source");
    expect(sessions().get(sessionId)).toMatchObject({ placement: "shared", generation: 0 });
    const history = await client.request<{ events: { type: string; data: Record<string, unknown> }[] }>("session.getMessages", { sessionId });
    expect(history.events.map((event) => event.type)).not.toContain("session.shutdown");
    expect(history.events.map((event) => event.type)).not.toContain("agent.interrupted");
    expect(history.events.some((event) => event.type === "session.idle" && event.data["aborted"] === true)).toBe(false);
    expect(history.events.some((event) => event.data["content"] === "echo: back on the source")).toBe(true);
  });

  it("fails held completions when the session is deleted or cannot return to its source", async () => {
    const client = await connect();
    const deleted = crypto.randomUUID();
    await client.request("session.create", { sessionId: deleted, tools: [{ name: "lookup_order" }] });
    const waiting = client.request("session.sendAndWait", { sessionId: deleted, prompt: "tool:lookup_order" }).catch((error: unknown) => error);
    await waitUntil(() => client.events("external_tool.requested").some((event) => runtimeSessionOf(event) === deleted));
    const cut = await sessions().cutover!(deleted, { generation: 0 });
    cut.fence();
    await cut.source("session.suspend");
    await sessions().delete(1001, deleted);
    expect(await waiting).toMatchObject({ data: { code: "not_found" } });

    const lost = crypto.randomUUID();
    await client.request("session.create", { sessionId: lost, tools: [{ name: "lookup_order" }] });
    const stranded = client.request("session.sendAndWait", { sessionId: lost, prompt: "tool:lookup_order" }).catch((error: unknown) => error);
    await waitUntil(() => client.events("external_tool.requested").some((event) => runtimeSessionOf(event) === lost));
    const move = await sessions().cutover!(lost, { generation: 0 });
    move.fence();
    await move.source("session.suspend");
    // The source runtime lost the session's state, so the abort cannot put it back there.
    runtime.sessions.delete(lost);
    await move.abort({ resume: { continuePendingWork: true } });
    expect(await stranded).toMatchObject({ data: { code: "state_restore_failed" } });
  });

  it("tells what the suspend caused from output already on its way while the seal is unanswered", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId });
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    cut.fence();
    // The source answers the suspend late: its interruption artifacts are already out, and so is genuine output.
    const hold = runtime.holdNext("session.suspend", sessionId);
    const suspending = cut.source("session.suspend");
    await hold.held;
    runtime.emitEvent(sessionId, "assistant.message", { content: "already on its way" });
    runtime.emitEvent(sessionId, "model.turn_failed", { reason: "suspended" });
    await sleep(50);
    hold.release();
    await suspending;
    runtime.emitEvent(sessionId, "assistant.message", { content: "after the answer" });
    await sleep(50);
    await cut.open({ continuePendingWork: true });
    await cut.commit();
    await waitUntil(() => messages(client, sessionId).includes("already on its way"));
    expect(messages(client, sessionId)).not.toContain("after the answer");
    const history = await client.request<{ events: { type: string; data: Record<string, unknown> }[] }>("session.getMessages", { sessionId });
    const types = history.events.map((event) => event.type);
    expect(history.events.map((event) => event.data["content"])).toContain("already on its way");
    expect(history.events.map((event) => event.data["content"])).not.toContain("after the answer");
    for (const handoff of ["model.turn_failed", "agent.interrupted", "session.shutdown"]) expect(types).not.toContain(handoff);
    expect(history.events.some((event) => event.type === "session.idle" && event.data["aborted"] === true)).toBe(false);
    const log = await sessions().request<{ events: { type: string; data: Record<string, unknown> }[] }>(sessionId, "session.eventLog.read", {});
    expect(log.events.map((event) => event.data["content"])).toContain("already on its way");
    expect(log.events.map((event) => event.data["content"])).not.toContain("after the answer");
    expect(log.events.map((event) => event.type)).not.toContain("model.turn_failed");
  });

  it("delivers a reply whose turn completed on the source just before the seal instead of holding it", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, tools: [{ name: "lookup_order" }] });
    const hold = runtime.holdNext("session.sendAndWait", sessionId);
    const waiting = client.request<{ response?: { data?: { content?: string } }; aborted?: boolean }>("session.sendAndWait", { sessionId, prompt: "tool:lookup_order" });
    await waitUntil(() => client.events("external_tool.requested").some((event) => runtimeSessionOf(event) === sessionId));
    const requested = client.events("external_tool.requested").find((event) => runtimeSessionOf(event) === sessionId)!;
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    cut.fence();
    // The turn ends on the source, but its reply is still on the way when the seal goes out.
    runtime.answerTool(String((requested["data"] as Record<string, unknown>)["requestId"]), "done before the seal");
    await hold.held;
    await cut.source("session.suspend");
    hold.release();
    await sleep(50);
    await cut.abort({ resume: { continuePendingWork: true } });
    const reply = await waiting;
    expect(reply.response?.data?.content).toBe("tool said: done before the seal");
    expect(reply.aborted).toBeUndefined();
    expect(messages(client, sessionId)).toContain("tool said: done before the seal");
  });

  it("completes a call the seal caught from the owner's events, never from what the source said before the seal", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, tools: [{ name: "lookup_order" }] });
    const requestIds = () => client.events("external_tool.requested").filter((event) => runtimeSessionOf(event) === sessionId).map((event) => String((event["data"] as Record<string, unknown>)["requestId"]));
    // One turn is sent, another is awaited; both wait on a tool.
    await client.request("session.send", { sessionId, prompt: "tool:lookup_order" });
    await waitUntil(() => requestIds().length === 1);
    const waiting = client.request<{ response?: { data?: { content?: string } }; aborted?: boolean }>("session.sendAndWait", { sessionId, prompt: "tool:lookup_order" });
    await waitUntil(() => requestIds().length === 2);
    const [first, second] = requestIds();
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    cut.fence();
    // The first turn ends on the source before the seal: its idle is genuine but belongs to the source.
    runtime.answerTool(first!, "first turn");
    await sleep(50);
    await cut.source("session.suspend");
    await cut.open({ continuePendingWork: true });
    await cut.commit();
    await waitUntil(() => messages(client, sessionId).includes("tool said: first turn"));
    // The awaited turn continues in the sandbox and completes there.
    runtime.answerTool(second!, "second turn");
    const reply = await waiting;
    expect(reply.response?.data?.content).toBe("tool said: second turn");
    expect(reply.aborted).toBe(false);
  });

  it("completes a held call whose source reply arrives after the sandbox finished the turn", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, tools: [{ name: "lookup_order" }] });
    const hold = runtime.holdNext("session.sendAndWait", sessionId);
    const waiting = client.request<{ response?: { data?: { content?: string } }; aborted?: boolean; completionEventId?: string }>("session.sendAndWait", { sessionId, prompt: "tool:lookup_order" });
    await waitUntil(() => client.events("external_tool.requested").some((event) => runtimeSessionOf(event) === sessionId));
    const requested = client.events("external_tool.requested").find((event) => runtimeSessionOf(event) === sessionId)!;
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    cut.fence();
    await cut.source("session.suspend");
    // The source's aborted reply is delayed past the whole move and the turn's end in the sandbox.
    await hold.held;
    await cut.open({ continuePendingWork: true });
    await cut.commit();
    runtime.answerTool(String((requested["data"] as Record<string, unknown>)["requestId"]), "finished in the sandbox");
    await waitUntil(() => messages(client, sessionId).includes("tool said: finished in the sandbox"));
    hold.release();
    const reply = await waiting;
    expect(reply.response?.data?.content).toBe("tool said: finished in the sandbox");
    expect(reply.aborted).toBe(false);
    const idles = client.events("session.idle").filter((event) => runtimeSessionOf(event) === sessionId);
    expect(reply.completionEventId).toBe(idles.at(-1)?.["id"]);
  });

  it("keeps a sealed source's late handoff hidden until it answers the session's resume, and refuses its requests", async () => {
    const client = await connect();
    client.answer = () => ({ answer: "from the client" });
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, tools: [{ name: "lookup_order" }], requestUserInput: true });
    const waiting = client.request<{ response?: { data?: { content?: string } }; aborted?: boolean }>("session.sendAndWait", { sessionId, prompt: "tool:lookup_order" });
    await waitUntil(() => client.events("external_tool.requested").some((event) => runtimeSessionOf(event) === sessionId));
    const requested = client.events("external_tool.requested").find((event) => runtimeSessionOf(event) === sessionId)!;
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    cut.fence();
    await cut.source("session.suspend");
    const hold = runtime.holdNext("session.resume", sessionId);
    await cut.abort({ resume: { continuePendingWork: true } });
    await hold.held;
    // Still the suspended instance: a straggling aborted idle and a client-bound request.
    runtime.emitEvent(sessionId, "session.idle", { aborted: true });
    await expect(runtime.requestOn(sourceConnection(sessionId), "userInput.request", { sessionId, question: "still there?" })).rejects.toMatchObject({ data: { code: "promotion_busy" } });
    await sleep(50);
    expect(client.events("session.idle").some((event) => runtimeSessionOf(event) === sessionId && (event["data"] as Record<string, unknown>)["aborted"] === true)).toBe(false);
    hold.release();
    await waitUntil(() => lastCall("session.resume", sessionId)?.params["continuePendingWork"] === true);
    await sleep(50);
    // The resumed session continues the turn on its source.
    runtime.answerTool(String((requested["data"] as Record<string, unknown>)["requestId"]), "after the abort");
    const reply = await waiting;
    expect(reply.response?.data?.content).toBe("tool said: after the abort");
    expect(reply.aborted).toBe(false);
    const history = await client.request<{ events: { type: string; data: Record<string, unknown> }[] }>("session.getMessages", { sessionId });
    expect(history.events.some((event) => event.type === "session.idle" && event.data["aborted"] === true)).toBe(false);
  });

  it("does not leave a client attached when its resume, overtaken by a move, fails where the session moved", async () => {
    const first = await connect();
    const sessionId = crypto.randomUUID();
    await first.request("session.create", { sessionId });
    const second = await connect();
    const hold = runtime.holdNext("session.resume", sessionId);
    const resuming = second.request("session.resume", { sessionId, tools: [{ name: "late_tool" }] }).catch((error: unknown) => error);
    await hold.held;
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    cut.fence();
    await cut.source("session.suspend");
    await cut.open({ continuePendingWork: true });
    await cut.commit();
    sandboxes.failNextPrepare = new Error("The sandbox could not prepare the resume");
    hold.release();
    expect(await resuming).toBeInstanceOf(Error);
    const attached = sessions().attached(sessionId);
    expect(attached.map((responder) => responder.connectionId)).not.toContain(second.welcome.connectionId);
    expect(attached.flatMap((responder) => responder.tools)).not.toContain("late_tool");
  });

  it("sets configuration again on the source an aborted, sealed cutover resumed while the change was in flight", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId });
    const hold = runtime.holdNext("session.options.update", sessionId);
    const updating = client.request("session.options.update", { sessionId, reasoningEffort: "high" });
    await hold.held;
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    cut.fence();
    await cut.source("session.suspend");
    await cut.source("sessions.close");
    await cut.abort({ resume: { continuePendingWork: true } });
    await waitUntil(() => lastCall("session.resume", sessionId)?.params["continuePendingWork"] === true);
    hold.release();
    await updating;
    const calls = runtime.requests.filter((request) => request.params["sessionId"] === sessionId);
    const resumedAt = calls.findLastIndex((call) => call.method === "session.resume");
    expect(calls.slice(resumedAt).some((call) => call.method === "session.options.update" && call.params["reasoningEffort"] === "high")).toBe(true);
    const row = gateway.gateway.app.db.prepare("SELECT admitted FROM core_sessions WHERE id = ?").get(sessionId) as { admitted: string };
    expect((JSON.parse(row.admitted) as { requestedOptions?: Record<string, unknown> }).requestedOptions).toMatchObject({ reasoningEffort: "high" });
  });

  it("lets a resume replace earlier option changes and the configuration a move carries", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, systemMessage: { mode: "append", content: "Old instructions." } });
    await client.request("session.options.update", { sessionId, reasoningEffort: "high" });
    await client.request("session.resume", { sessionId, reasoningEffort: "low" });
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    cut.fence();
    await cut.source("session.suspend");
    await cut.open({ continuePendingWork: true });
    await cut.commit();
    const resumed = sandboxes.detail(sessionId, "prepare session.resume");
    expect(resumed["reasoningEffort"]).toBe("low");
    expect(JSON.stringify(resumed["systemMessage"] ?? null)).not.toContain("Old instructions.");
    const onDestination = runtime.calls("session.options.update").filter((call) => call.params["sessionId"] === sessionId && call.connection !== sourceConnection(sessionId));
    expect(onDestination.some((call) => call.params["reasoningEffort"] === "high")).toBe(false);
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
    await expect(cut.commit()).rejects.toThrow(/already closed/);
    expect(sessions().get(sessionId)).toBeUndefined();
  });

  // Last: it drops the shared runtime's connections.
  it("holds every caller of a restore that a fence overtook until the cutover ends", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId });
    const cut = await sessions().cutover!(sessionId, { generation: 0 });
    let stopped = false;
    const off = sessions().onLifecycle((event) => {
      if (event.sessionId === sessionId && event.type === "stopped") stopped = true;
    });
    const connects = runtime.calls("connect").length;
    runtime.dropConnections();
    await waitUntil(() => stopped);
    off();
    // Both callers find the session not running; the first starts a restore, which waits for the runtime to return.
    const first = sessions().runtime(sessionId);
    let secondSettled = false;
    const second = sessions().runtime(sessionId).finally(() => {
      secondSettled = true;
    });
    cut.fence();
    await waitUntil(() => runtime.calls("connect").length > connects, 10_000);
    await sleep(200);
    expect(secondSettled).toBe(false);
    expect(lastCall("session.resume", sessionId)).toBeUndefined();
    await cut.abort();
    const [restored, joined] = await Promise.all([first, second]);
    expect(joined.connectionId).toBe(restored.connectionId);
    expect(lastCall("session.resume", sessionId)).toBeDefined();
  }, 20_000);
});
