import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManagedCopilotError } from "@managed-copilot/protocol";
import { FakeRuntime, FakeSandboxes, RawClient, sleep, startGitHubStub, startTestGateway, type TestGateway } from "./harness.js";

const ALICE = "alice-token";
const MOUNT = "/opt/managed-copilot/customizations";
describe("isolated placement through the sandboxes port", () => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  let gateway: TestGateway;
  let sandboxes: FakeSandboxes;
  let apphost: string;
  const clients: RawClient[] = [];

  const connect = async (environment: string) => {
    const client = await RawClient.connect(gateway.url, ALICE, environment);
    clients.push(client);
    return client;
  };
  const agentSelections = (sessionId: string) => runtime.calls("session.agent.select").filter((call) => call.params["sessionId"] === sessionId).map((call) => call.params["name"]);

  beforeAll(async () => {
    runtime = new FakeRuntime();
    await runtime.start();
    github = await startGitHubStub({ [ALICE]: { id: 1001, login: "alice" } });
    apphost = mkdtempSync(join(tmpdir(), "mc-apphost-"));
    mkdirSync(join(apphost, "customizations", "agents"), { recursive: true });
    writeFileSync(join(apphost, "customizations", "agents", "builder.agent.md"), "---\nname: builder\ndescription: Builds\n---\nBuild things.\n");
    writeFileSync(join(apphost, "customizations", "agents", "reviewer.agent.md"), "---\nname: reviewer\ndescription: Reviews\n---\nReview things.\n");
    gateway = await startTestGateway({
      runtime,
      githubUrl: github.url,
      deployment: {
        name: "copilot",
        environments: {
          chat: { type: "shared", customizations: "./customizations" },
          coder: { type: "isolated", size: "small", customizations: "./customizations" },
        },
      },
      env: { MANAGED_COPILOT_APPHOST_DIR: apphost },
    });
    sandboxes = new FakeSandboxes(runtime);
    // Core looks the placement service up per use, so the fake stands in for (or replaces) the sandbox module.
    (gateway.gateway.app.services as Record<string, unknown>)["sandboxes"] = sandboxes;
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await gateway?.close();
    await runtime?.close();
    await github?.close();
    if (apphost) rmSync(apphost, { recursive: true, force: true });
  });

  it("opens the session on its sandbox before replying, passing the requested agent to the sandbox", async () => {
    const client = await connect("coder");
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, agent: "builder" });
    expect(sandboxes.ops(sessionId)).toEqual(["create", "openRuntime", "initialize", "prepare session.create", "sessionOpened"]);
    const prepared = sandboxes.detail(sessionId, "prepare session.create");
    expect(prepared).toMatchObject({ agent: "builder", workingDirectory: "/workspace", agentDirectories: [`${MOUNT}/agents`] });
    expect(prepared).not.toHaveProperty("gitHubTokenProviderRegistrationId");
    const order = runtime.requests.filter((request) => request.params["sessionId"] === sessionId).map((request) => request.method);
    expect(order.slice(0, 3)).toEqual(["session.create", "session.gitHubAuth.setCredentials", "session.agent.select"]);
    expect(await client.request("session.agent.getCurrent", { sessionId })).toMatchObject({ agent: { name: "builder", path: `${MOUNT}/agents/builder.agent.md` } });
  });

  it("selects agents at create in shared placement and reports their paths as the sandbox mount", async () => {
    const client = await connect("chat");
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, agent: "builder" });
    expect(runtime.sessions.get(sessionId)!.createParams["agent"]).toBe("builder");
    const current = await client.request("session.agent.getCurrent", { sessionId });
    expect(current).toEqual({ agent: expect.objectContaining({ name: "builder", path: `${MOUNT}/agents/builder.agent.md` }) });
  });

  it("restores a stopped sandbox with the agent the session last had", async () => {
    const client = await connect("coder");
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, agent: "builder" });
    await client.request("session.agent.select", { sessionId, name: "reviewer" });
    // The sandbox stops (idle): its runtime stream ends. The next request restores it.
    sandboxes.streams.get(sessionId)!.destroy();
    await sleep(100);
    expect(await client.request("session.agent.getCurrent", { sessionId })).toMatchObject({ agent: { name: "reviewer" } });
    expect(sandboxes.ops(sessionId).slice(-5)).toEqual(["ensureRunning", "openRuntime", "initialize", "prepare session.resume", "sessionOpened"]);
    // The restore asks for the agent the session last had, not the one it was created with.
    expect(sandboxes.detail(sessionId, "prepare session.resume")).toMatchObject({ agent: "reviewer" });
    expect(agentSelections(sessionId)).toEqual(["builder", "reviewer", "reviewer"]);
  });

  it("gives sandbox MCP servers their vault placeholder headers on every open, never storing them", async () => {
    const services = gateway.gateway.app.services as Record<string, unknown>;
    const original = services["vaults"];
    const placeholder = "Bearer mcvp_placeholder";
    let granted = true;
    const asked: string[] = [];
    services["vaults"] = {
      mcpHeaders: (_sessionId: string, url: string, placement: string) => {
        asked.push(`${placement} ${url}`);
        if (url === "https://mcp.example.com:8443/mcp") throw new ManagedCopilotError("capability_unavailable", "the egress proxy substitutes vault credentials only for host names on port 443");
        return granted && placement === "sandbox" && url === "https://mcp.example.com/mcp" ? { Authorization: placeholder } : undefined;
      },
    };
    try {
      const client = await connect("coder");
      const sessionId = crypto.randomUUID();
      const docs = { type: "http", url: "https://mcp.example.com/mcp", headers: { authorization: "Bearer caller", "x-team": "docs" }, tools: ["*"] };
      await client.request("session.create", {
        sessionId,
        mcpServers: { docs, other: { type: "http", url: "https://elsewhere.example.com/mcp", tools: ["*"] } },
        customAgents: [{ name: "helper", prompt: "Help.", mcpServers: { inner: { type: "http", url: "https://mcp.example.com/mcp", tools: ["*"] } } }],
      });
      const created = sandboxes.detail(sessionId, "prepare session.create") as { mcpServers: Record<string, { headers?: Record<string, string> }>; customAgents: { mcpServers: Record<string, { headers?: Record<string, string> }> }[] };
      // The vault header replaces the caller's header of the same name; other headers and servers are untouched.
      expect(created.mcpServers["docs"]!.headers).toEqual({ "x-team": "docs", Authorization: placeholder });
      expect(created.mcpServers["other"]!.headers).toBeUndefined();
      expect(created.customAgents[0]!.mcpServers["inner"]!.headers).toEqual({ Authorization: placeholder });
      const row = gateway.gateway.app.db.prepare("SELECT admitted FROM core_sessions WHERE id = ?").get(sessionId) as { admitted: string };
      expect(row.admitted).not.toContain("mcvp_placeholder");

      // Restores ask again: a revoked credential's header is gone (the caller's own header is what remains).
      granted = false;
      sandboxes.streams.get(sessionId)!.destroy();
      await sleep(100);
      await client.request("session.getMessages", { sessionId });
      const restored = sandboxes.detail(sessionId, "prepare session.resume") as typeof created;
      expect(restored.mcpServers["docs"]!.headers).toEqual({ authorization: "Bearer caller", "x-team": "docs" });
      expect(restored.customAgents[0]!.mcpServers["inner"]!.headers).toBeUndefined();

      // A vault credential the egress proxy cannot substitute fails admission explicitly.
      const refused = await client
        .request("session.create", { sessionId: crypto.randomUUID(), mcpServers: { odd: { type: "http", url: "https://mcp.example.com:8443/mcp", tools: ["*"] } } })
        .catch((error: unknown) => error);
      expect(refused).toMatchObject({ data: { code: "capability_unavailable" } });
      expect(asked.every((entry) => entry.startsWith("sandbox "))).toBe(true);
    } finally {
      services["vaults"] = original;
    }
  });

  it("restores a stopped sandbox for an attaching Copilot CLI with the CLI's own credential", async () => {
    const client = await connect("coder");
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId });
    await client.close();
    sandboxes.streams.get(sessionId)!.destroy();
    await sleep(100);
    const sessions = gateway.gateway.app.service("sessions");
    const alice = await gateway.gateway.app.service("auth").authenticate(ALICE);
    // No connected client and no background sign-in: only the CLI's credential can open the sandbox again.
    const cli = await sessions.attachCli!(1001, sessionId, { connectionId: `cli_${sessionId}`, notify: () => undefined, principal: alice });
    expect(sandboxes.ops(sessionId).slice(-5)).toEqual(["ensureRunning", "openRuntime", "initialize", "prepare session.resume", "sessionOpened"]);
    expect(sessions.attached(sessionId)).toEqual([expect.objectContaining({ connectionId: `cli_${sessionId}`, kind: "cli" })]);
    cli.close();
  });

  it("runs each isolated session of one client on its own runtime connection", async () => {
    const client = await connect("coder");
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await client.request("session.create", { sessionId: first });
    await client.request("session.create", { sessionId: second });
    const sessions = gateway.gateway.app.service("sessions");
    const [a, b] = await Promise.all([sessions.runtime(first), sessions.runtime(second)]);
    expect(a.connectionId).not.toBe(b.connectionId);
    expect(sandboxes.streams.get(first)).not.toBe(sandboxes.streams.get(second));
    await client.request("session.sendAndWait", { sessionId: first, prompt: "hello first" });
    await client.request("session.sendAndWait", { sessionId: second, prompt: "hello second" });
    expect(runtime.sessions.get(first)!.events.some((event) => event.data["content"] === "echo: hello first")).toBe(true);
    expect(runtime.sessions.get(second)!.events.some((event) => event.data["content"] === "echo: hello second")).toBe(true);
  });

  it("advertises isolated sandboxes, files, and promotion only while the sandbox backend is available", async () => {
    const capabilities = async () => ((await (await fetch(`${gateway.url}/v1/info`, { headers: { authorization: `Bearer ${ALICE}` } })).json()) as { capabilities: string[] }).capabilities;
    const moduleCapabilities = gateway.gateway.app.capabilities;
    const hadPromotion = moduleCapabilities.has("promotion");
    moduleCapabilities.add("promotion");
    try {
      expect(await capabilities()).toEqual(expect.arrayContaining(["isolated", "files", "promotion"]));
      sandboxes.available = false;
      const unavailable = await capabilities();
      for (const capability of ["isolated", "files", "promotion"]) expect(unavailable).not.toContain(capability);
      expect(unavailable).toContain("shared");
    } finally {
      sandboxes.available = true;
      if (!hadPromotion) moduleCapabilities.delete("promotion");
    }
  });

  it("cleans up when the sandbox cannot be prepared, and deletes it with the session", async () => {
    const client = await connect("coder");
    const sessionId = crypto.randomUUID();
    sandboxes.failCreate = new ManagedCopilotError("setup_failed", "Environment setup failed at step packages (exit 1)", { step: "packages" });
    try {
      await expect(client.request("session.create", { sessionId })).rejects.toMatchObject({ data: { code: "setup_failed" } });
    } finally {
      sandboxes.failCreate = undefined;
    }
    expect(sandboxes.ops(sessionId)).toEqual(["create", "delete"]);
    expect(gateway.gateway.app.service("sessions").get(sessionId)).toBeUndefined();

    await client.request("session.create", { sessionId });
    const lifecycle: string[] = [];
    const off = gateway.gateway.app.service("sessions").onLifecycle((event) => {
      if (event.sessionId === sessionId) lifecycle.push(event.type);
    });
    try {
      await client.request("session.delete", { sessionId });
      await sleep(50);
    } finally {
      off();
    }
    expect(sandboxes.ops(sessionId).at(-1)).toBe("delete");
    expect(gateway.gateway.app.service("sessions").get(sessionId)).toBeUndefined();
    // Closing the sandbox's runtime connection during the delete is not the session stopping.
    expect(lifecycle).toEqual(["deleted"]);
  });
});
