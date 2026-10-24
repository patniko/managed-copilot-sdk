import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeRuntime, RawClient, sleep, startGitHubStub, startTestGateway, type TestGateway } from "./harness.js";

const ALICE = "alice-token";
const ALICE_SECOND = "alice-second-token";
const MALLORY = "mallory-token";

describe("core router with a stock-protocol runtime", () => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  let gateway: TestGateway;
  const clients: RawClient[] = [];

  const connect = async (token: string, environment: Parameters<typeof RawClient.connect>[2] = "chat") => {
    const client = await RawClient.connect(gateway.url, token, environment);
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    runtime = new FakeRuntime();
    await runtime.start();
    github = await startGitHubStub({
      [ALICE]: { id: 1001, login: "alice" },
      [ALICE_SECOND]: { id: 1001, login: "alice" },
      [MALLORY]: { id: 2002, login: "mallory" },
    });
    gateway = await startTestGateway({ runtime, githubUrl: github.url });
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await gateway?.close();
    await runtime?.close();
    await github?.close();
  });

  it("rejects unauthenticated upgrades and unknown environments explicitly", async () => {
    await expect(RawClient.connect(gateway.url, "not-a-github-token", "chat")).rejects.toThrow(/HTTP 401/);
    const error = (await RawClient.connect(gateway.url, ALICE, "nope").catch((caught: unknown) => caught)) as { code: number; reason: string };
    expect(error.code).toBe(4404);
    expect(error.reason).toMatch(/^environment_not_found: Unknown environment "nope"/);
  });

  it("answers connection-level calls for the caller and virtualizes shutdown", async () => {
    const client = await connect(ALICE);
    expect(client.welcome).toMatchObject({ type: "managed-copilot/welcome", environment: "chat" });
    expect(await client.request("connect", {})).toMatchObject({ ok: true, protocolVersion: 3 });
    expect(await client.request("auth.getStatus", {})).toMatchObject({ isAuthenticated: true, login: "alice" });
    // models.list uses the caller's token and the environment's model ceiling.
    expect(await client.request("models.list", {})).toEqual({ models: [{ id: "claude-haiku-4.5", name: "Claude Haiku 4.5" }] });
    expect(runtime.calls("models.list").at(-1)?.params["gitHubToken"]).toBe(ALICE);
    expect(await client.request("runtime.shutdown", {})).toEqual({});
    expect(runtime.calls("runtime.shutdown")).toHaveLength(0);
    for (const method of ["host.start", "session.getForeground", "sessionFs.setProvider", "llmInference.setProvider", "account.login", "user.settings.set"]) {
      await expect(client.request(method, {}), method).rejects.toMatchObject({ code: -32601 });
    }
  });

  it("creates shared sessions with admitted configuration and the owner's credential", async () => {
    const client = await connect(ALICE);
    const sessionId = crypto.randomUUID();
    const result = await client.request("session.create", {
      sessionId,
      model: "claude-haiku-4.5",
      tools: [{ name: "lookup_order", description: "Look up an order", parameters: { type: "object" } }],
      availableTools: ["bash", "view", "lookup_order", "builtin:ask_user"],
      requestPermission: true,
      streaming: true,
      gitHubToken: ALICE_SECOND,
    });
    expect(result).toMatchObject({ sessionId });
    expect(result).not.toHaveProperty("workspacePath");
    const forwarded = runtime.sessions.get(sessionId)!.createParams;
    expect(forwarded["gitHubToken"]).toBeUndefined();
    expect(String(forwarded["gitHubTokenProviderRegistrationId"])).toMatch(/^mc-/);
    expect(forwarded["availableTools"]).toEqual(["custom:bash", "custom:view", "custom:lookup_order", "builtin:ask_user"]);
    expect(forwarded["enableConfigDiscovery"]).toBe(false);
    expect(forwarded["memory"]).toEqual({ enabled: false });
    expect(forwarded["allowedModels"]).toEqual(["claude-haiku-4.5"]);
    expect(String(forwarded["workingDirectory"])).toContain(sessionId);
    expect(forwarded["systemMessage"]).toMatchObject({ mode: "customize", sections: { environment_context: { action: "remove" } } });
    // The runtime asked the gateway for the session owner's token (never a shared service token).
    expect([ALICE, ALICE_SECOND]).toContain(runtime.sessions.get(sessionId)!.token);
    const lockdown = runtime.calls("session.options.update").find((call) => call.params["sessionId"] === sessionId);
    expect(lockdown?.params).toMatchObject({ customAgentsLocalOnly: true, installedPlugins: [], manageScheduleEnabled: false });
    // Host paths never reach the client.
    const start = await client.waitForEvent("session.start");
    expect(start["data"]).not.toHaveProperty("context");
    const info = await client.waitForEvent("session.info");
    expect(info["data"]).toMatchObject({ message: "Working in /workspace" });
    const history = await client.request<{ events: Record<string, unknown>[] }>("session.getMessages", { sessionId });
    expect(JSON.stringify(history)).not.toContain(gateway.dataDir.replace(/\\/g, "\\\\"));
    expect(JSON.stringify(history)).toContain("Working in /workspace");
  });

  it("rejects shell, file, local MCP, hooks, and nested custom-agent capabilities in shared placement", async () => {
    const client = await connect(ALICE);
    const attempt = (params: Record<string, unknown>) => client.request("session.create", { sessionId: crypto.randomUUID(), ...params });
    await expect(attempt({ mcpServers: { local: { command: "node", args: ["server.js"] } } })).rejects.toMatchObject({ data: { code: "policy_violation" } });
    await expect(attempt({ customAgents: [{ name: "x", prompt: "p", mcpServers: { local: { type: "stdio", command: "sh" } } }] })).rejects.toMatchObject({ data: { code: "policy_violation" } });
    await expect(attempt({ customAgents: [{ name: "y", prompt: "p", hooks: { preToolUse: [{ type: "command", command: "rm -rf /" }] } }] })).rejects.toMatchObject({ data: { code: "policy_violation" } });
    await expect(attempt({ workingDirectory: "C:\\Users\\someone" })).rejects.toMatchObject({ data: { code: "policy_violation" } });
    await expect(attempt({ enableFileHooks: true })).rejects.toMatchObject({ data: { code: "policy_violation" } });
    await expect(attempt({ pluginDirectories: ["/plugins"] })).rejects.toMatchObject({ data: { code: "policy_violation" } });
    await expect(attempt({ provider: { type: "openai", baseUrl: "https://example.com" } })).rejects.toMatchObject({ data: { code: "policy_violation" } });
    await expect(attempt({ model: "gpt-5.4" })).rejects.toMatchObject({ data: { code: "policy_violation" } });
    await expect(attempt({ mcpServers: { remote: { type: "http", url: "https://mcp.example.com" } } })).rejects.toMatchObject({ data: { code: "capability_unavailable" } });
    await expect(attempt({ someFutureOption: true })).rejects.toMatchObject({ data: { code: "capability_unavailable" } });
    await expect(attempt({ tools: [{ name: "schedule_task" }] })).rejects.toMatchObject({ data: { code: "conflict" } });

    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId });
    const update = (params: Record<string, unknown>) => client.request("session.options.update", { sessionId, ...params });
    await expect(update({ shell: "bash" })).rejects.toMatchObject({ data: { code: "policy_violation" } });
    await expect(update({ installedPlugins: [{ name: "evil" }] })).rejects.toMatchObject({ data: { code: "policy_violation" } });
    await expect(update({ workingDirectory: "/etc" })).rejects.toMatchObject({ data: { code: "policy_violation" } });
    await expect(update({ model: "gpt-5.4" })).rejects.toMatchObject({ data: { code: "policy_violation" } });
    expect(await update({ reasoningEffort: "high", skipCustomInstructions: true })).toEqual({ success: true });
    await expect(client.request("session.model.switchTo", { sessionId, modelId: "gpt-5.4" })).rejects.toMatchObject({ data: { code: "policy_violation" } });
    for (const method of ["session.shell.exec", "session.workspaces.readFile", "session.plugins.install", "session.gitHubAuth.setCredentials", "session.permissions.setApproveAll"]) {
      await expect(client.request(method, { sessionId }), method).rejects.toMatchObject({ code: -32601 });
    }
  });

  it("routes tool calls to exactly one client, fans out progress, and keeps sessions alive across detach", async () => {
    const first = await connect(ALICE);
    const sessionId = crypto.randomUUID();
    await first.request("session.create", { sessionId, tools: [{ name: "lookup_order" }], requestPermission: true });
    first.answer = () => ({});

    // A tool call goes to the client that registered it; the answer reaches the runtime.
    await first.request("session.send", { sessionId, prompt: "tool:lookup_order please" });
    const requested = await first.waitForEvent("external_tool.requested");
    expect(requested["data"]).not.toHaveProperty("workingDirectory");
    await first.request("session.tools.handlePendingToolCall", { sessionId, requestId: (requested["data"] as Record<string, unknown>)["requestId"], result: "shipped" });
    const message = await first.waitForEvent("assistant.message");
    expect((message["data"] as Record<string, unknown>)["content"]).toBe("tool said: shipped");

    // Detaching (SDK session.disconnect / client.stop) never reaches the runtime.
    expect(await first.request("session.detach", { sessionId })).toEqual({ success: true });
    expect(runtime.calls("session.detach")).toHaveLength(0);
    await expect(first.request("session.send", { sessionId, prompt: "after detach" })).rejects.toMatchObject({ data: { code: "invalid_request" } });
    await first.close();

    // A second process resumes the same session; the runtime still has it.
    const second = await connect(ALICE_SECOND);
    const observer = await connect(ALICE);
    await observer.request("session.resume", { sessionId });
    await second.request("session.resume", { sessionId, tools: [{ name: "lookup_order" }] });
    second.answer = () => ({});
    await second.request("session.send", { sessionId, prompt: "tool:lookup_order again" });
    const again = await second.waitForEvent("external_tool.requested");
    await second.request("session.tools.handlePendingToolCall", { sessionId, requestId: (again["data"] as Record<string, unknown>)["requestId"], result: "delivered" });
    await second.waitForEvent("session.idle");
    await observer.waitForEvent("session.idle");
    // The observer registered no tools, so it cannot execute the request; it still sees the turn's progress.
    expect(observer.events("assistant.message").map((event) => (event["data"] as Record<string, unknown>)["content"])).toContain("tool said: delivered");
    expect(runtime.calls("session.resume").filter((call) => call.params["sessionId"] === sessionId)).toHaveLength(2);
  });

  it("withholds actionable events from other clients able to execute them", async () => {
    const a = await connect(ALICE);
    const b = await connect(ALICE);
    const sessionId = crypto.randomUUID();
    await a.request("session.create", { sessionId, tools: [{ name: "lookup_order" }] });
    await b.request("session.resume", { sessionId, tools: [{ name: "lookup_order" }] });
    await b.request("session.send", { sessionId, prompt: "tool:lookup_order" });
    const requested = await b.waitForEvent("external_tool.requested");
    await b.request("session.tools.handlePendingToolCall", { sessionId, requestId: (requested["data"] as Record<string, unknown>)["requestId"], result: "ok" });
    await a.waitForEvent("session.idle");
    expect(a.events("external_tool.requested")).toHaveLength(0);
    expect(a.events("assistant.message")).toHaveLength(1);
  });

  it("keeps request IDs apart for concurrent clients and relays cancellation", async () => {
    const a = await connect(ALICE);
    const b = await connect(MALLORY);
    const results = await Promise.all([a.request("ping", { message: "a" }), b.request("ping", { message: "b" }), a.request("status.get", {}), b.request("auth.getStatus", {})]);
    expect(results[0]).toMatchObject({ message: "a" });
    expect(results[1]).toMatchObject({ message: "b" });
    expect(results[3]).toMatchObject({ login: "mallory" });

    const sessionId = crypto.randomUUID();
    await a.request("session.create", { sessionId });
    const controller = new AbortController();
    const waiting = a.endpoint.request("session.sendAndWait", { sessionId, prompt: "slow" }, { signal: controller.signal });
    await sleep(100);
    controller.abort();
    // The runtime observed the relayed $/cancelRequest and answered the original request as cancelled.
    await expect(waiting).rejects.toMatchObject({ code: -32800, message: "Request cancelled" });
  });

  it("rejects host-path attachments and platform model headers in shared sends", async () => {
    const client = await connect(ALICE);
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId });
    for (const attachment of [{ type: "file", path: "C:\\Windows\\win.ini" }, { type: "directory", path: "/etc" }, { type: "selection", filePath: "/etc/passwd", displayName: "x" }]) {
      await expect(client.request("session.send", { sessionId, prompt: "read it", attachments: [attachment] }), attachment.type).rejects.toMatchObject({ data: { code: "policy_violation" } });
    }
    await expect(client.request("session.send", { sessionId, prompt: "x", requestHeaders: { Authorization: "Bearer other" } })).rejects.toMatchObject({ data: { code: "policy_violation" } });
    await expect(client.request("session.send", { sessionId, prompt: "x", agentMode: "shell" })).rejects.toMatchObject({ data: { code: "policy_violation" } });
    const inline = await client.request<{ messageId: string }>("session.send", { sessionId, prompt: "inline", attachments: [{ type: "blob", data: "aGk=", mimeType: "text/plain" }] });
    expect(inline.messageId).toBeDefined();
    expect(runtime.calls("session.send").some((call) => JSON.stringify(call.params).includes("win.ini"))).toBe(false);
  });

  it("keeps every attached client's tools registered when another client resumes", async () => {
    const owner = await connect(ALICE);
    const sessionId = crypto.randomUUID();
    await owner.request("session.create", { sessionId, tools: [{ name: "lookup_order" }], requestPermission: true, hooks: true });
    const observer = await connect(ALICE);
    await observer.request("session.resume", { sessionId, tools: [{ name: "list_orders" }] });
    const resumed = runtime.calls("session.resume").filter((call) => call.params["sessionId"] === sessionId).at(-1)!;
    expect((resumed.params["tools"] as { name: string }[]).map((tool) => tool.name).sort()).toEqual(["list_orders", "lookup_order"]);
    expect(resumed.params).toMatchObject({ requestPermission: true, hooks: true });
    // The owner's tool still reaches the owner.
    owner.answer = () => ({});
    await owner.request("session.send", { sessionId, prompt: "tool:lookup_order" });
    const requested = await owner.waitForEvent("external_tool.requested");
    await owner.request("session.tools.handlePendingToolCall", { sessionId, requestId: (requested["data"] as Record<string, unknown>)["requestId"], result: "still mine" });
    expect((await owner.waitForEvent("assistant.message"))["data"]).toMatchObject({ content: "tool said: still mine" });
    expect(observer.events("external_tool.requested")).toHaveLength(1);
  });

  it("serializes concurrent creates of the same session ID", async () => {
    const sessionId = crypto.randomUUID();
    const sessions = gateway.gateway.app.service("sessions");
    const principal = await gateway.gateway.app.service("auth").authenticate(ALICE);
    const results = await Promise.all([sessions.create(principal, { sessionId, environment: "chat" }), sessions.create(principal, { sessionId, environment: "chat" })]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(runtime.calls("session.create").filter((call) => call.params["sessionId"] === sessionId)).toHaveLength(1);
    const intruder = await gateway.gateway.app.service("auth").authenticate(MALLORY);
    await expect(sessions.create(intruder, { sessionId, environment: "chat" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("replays more than one page of missed platform events", async () => {
    const events = gateway.gateway.app.service("events");
    const first = events.emit("session.idle", { ownerId: 2002, data: { n: 0 } });
    for (let n = 1; n <= 600; n++) events.emit("session.idle", { ownerId: 2002, data: { n } });
    const controller = new AbortController();
    const response = await fetch(`${gateway.url}/v1/events?types=session.idle`, { headers: { authorization: `Bearer ${MALLORY}`, "last-event-id": first.id }, signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while ((text.match(/^id: /gm)?.length ?? 0) < 600) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();
    expect(text.match(/^id: /gm)?.length).toBe(600);
    expect(text).toContain('"n":600');
  });

  it("scopes sessions to their owner", async () => {
    const alice = await connect(ALICE);
    const sessionId = crypto.randomUUID();
    await alice.request("session.create", { sessionId });
    const mallory = await connect(MALLORY);
    await expect(mallory.request("session.resume", { sessionId })).rejects.toMatchObject({ data: { code: "not_found" } });
    await expect(mallory.request("session.send", { sessionId, prompt: "hi" })).rejects.toMatchObject({ data: { code: "not_found" } });
    await expect(mallory.request("session.delete", { sessionId })).rejects.toMatchObject({ data: { code: "not_found" } });
    await expect(mallory.request("session.create", { sessionId })).rejects.toMatchObject({ data: { code: "conflict" } });
    expect(await mallory.request("session.getMetadata", { sessionId })).toEqual({});
    const listed = (await mallory.request<{ sessions: { sessionId: string }[] }>("session.list", {})).sessions;
    expect(listed.map((session) => session.sessionId)).not.toContain(sessionId);
    const rest = await fetch(`${gateway.url}/v1/sessions/${sessionId}`, { headers: { authorization: `Bearer ${MALLORY}` } });
    expect(rest.status).toBe(404);
    const mine = await fetch(`${gateway.url}/v1/sessions/${sessionId}`, { headers: { authorization: `Bearer ${ALICE}` } });
    expect(await mine.json()).toMatchObject({ id: sessionId, owner: { id: 1001, login: "alice" }, placement: "shared", environment: "chat" });
  });

  it("serves owner-scoped REST and SSE platform events", async () => {
    const info = await (await fetch(`${gateway.url}/v1/info`, { headers: { authorization: `Bearer ${ALICE}` } })).json();
    expect(info).toMatchObject({ name: "copilot", capabilities: expect.arrayContaining(["shared", "events"]) });
    expect(info.environments.map((environment: { name: string }) => environment.name)).toEqual(["chat", "open", "coder"]);
    expect(await (await fetch(`${gateway.url}/v1/me`, { headers: { authorization: `Bearer ${ALICE}` } })).json()).toEqual({ id: 1001, login: "alice", name: "alice name" });

    const controller = new AbortController();
    const stream = await fetch(`${gateway.url}/v1/events`, { headers: { authorization: `Bearer ${MALLORY}` }, signal: controller.signal });
    const received: string[] = [];
    const reading = (async () => {
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        received.push(decoder.decode(value));
      }
    })();
    const alice = await connect(ALICE);
    const mallory = await connect(MALLORY, "open");
    const aliceSession = crypto.randomUUID();
    const mallorySession = crypto.randomUUID();
    await alice.request("session.create", { sessionId: aliceSession });
    await mallory.request("session.create", { sessionId: mallorySession });
    await mallory.request("session.send", { sessionId: mallorySession, prompt: "hello" });
    await mallory.waitForEvent("session.idle");
    const deleted = await fetch(`${gateway.url}/v1/sessions/${mallorySession}`, { method: "DELETE", headers: { authorization: `Bearer ${MALLORY}` } });
    expect(deleted.status).toBe(204);
    expect(runtime.calls("session.delete").some((call) => call.params["sessionId"] === mallorySession)).toBe(true);
    await sleep(200);
    controller.abort();
    await reading;
    const text = received.join("");
    expect(text).toContain(`"sessionId":"${mallorySession}"`);
    expect(text).toContain("event: session.created");
    expect(text).toContain("event: session.idle");
    expect(text).toContain("event: session.deleted");
    expect(text).not.toContain(aliceSession);
  });
});

describe("core router across gateway restarts", () => {
  it("resumes a session from the ledger after the gateway restarts", async () => {
    const runtime = new FakeRuntime();
    await runtime.start();
    const github = await startGitHubStub({ [ALICE]: { id: 1001, login: "alice" } });
    let gateway = await startTestGateway({ runtime, githubUrl: github.url });
    try {
      const client = await RawClient.connect(gateway.url, ALICE, "chat");
      const sessionId = crypto.randomUUID();
      await client.request("session.create", { sessionId, tools: [{ name: "lookup_order" }] });
      await client.close();
      const dataDir = gateway.dataDir;
      await gateway.close({ keepData: true });
      gateway = await startTestGateway({ runtime, githubUrl: github.url, dataDir });
      const again = await RawClient.connect(gateway.url, ALICE, "chat");
      await again.request("session.resume", { sessionId, tools: [{ name: "lookup_order" }] });
      await again.request("session.send", { sessionId, prompt: "hello again" });
      const message = await again.waitForEvent("assistant.message");
      expect((message["data"] as Record<string, unknown>)["content"]).toBe("echo: hello again");
      await again.close();
    } finally {
      await gateway.close();
      await runtime.close();
      await github.close();
    }
  });

  it("re-resumes sessions upstream after the shared runtime connection is lost", async () => {
    const runtime = new FakeRuntime();
    await runtime.start();
    const github = await startGitHubStub({ [ALICE]: { id: 1001, login: "alice" } });
    const gateway = await startTestGateway({ runtime, githubUrl: github.url });
    try {
      const client = await RawClient.connect(gateway.url, ALICE, "chat");
      const sessionId = crypto.randomUUID();
      await client.request("session.create", { sessionId });
      runtime.dropConnections();
      await sleep(1500);
      await client.request("session.send", { sessionId, prompt: "still there?" });
      await client.waitForEvent("assistant.message");
      const resumed = runtime.calls("session.resume").filter((call) => call.params["sessionId"] === sessionId);
      expect(resumed).toHaveLength(1);
      expect(resumed[0]!.params["availableTools"]).toBeDefined();
      await client.close();
    } finally {
      await gateway.close();
      await runtime.close();
      await github.close();
    }
  });
});
