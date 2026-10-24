// Cross-module paths through core's router with a stock-protocol runtime. Each block runs when the module that
// provides it is loaded, so this file runs on core's branch and is fully exercised once every module is merged.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActionClaim, PendingAction, PlatformEvent } from "@managed-copilot/protocol";
import { FakeRuntime, RawClient, sleep, startGitHubStub, startTestGateway, type TestGateway } from "./harness.js";

const ALICE = "alice-token";
const MALLORY = "mallory-token";

const DEPLOYMENT = {
  name: "copilot",
  environments: {
    chat: { type: "shared" },
    offline: { type: "shared", network: false },
    planner: { type: "shared", scheduling: true },
  },
};

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await sleep(10);
  }
}

describe("cross-module integration through the core router", () => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  let gateway: TestGateway;
  const clients: RawClient[] = [];

  const service = <T>(name: string): T | undefined => (gateway.gateway.app.services as Record<string, unknown>)[name] as T | undefined;
  const connect = async (token: string, environment = "chat") => {
    const client = await RawClient.connect(gateway.url, token, environment);
    clients.push(client);
    return client;
  };
  const rest = async <T>(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${gateway.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json().catch(() => undefined)) as T };
  };
  const forwardedTools = (sessionId: string) => (runtime.sessions.get(sessionId)!.createParams["tools"] as Record<string, unknown>[]).map((tool) => String(tool["name"]));
  const assistantText = (sessionId: string) =>
    runtime.sessions
      .get(sessionId)!
      .events.filter((event) => event.type === "assistant.message")
      .map((event) => String(event.data["content"]));

  beforeAll(async () => {
    runtime = new FakeRuntime();
    await runtime.start();
    github = await startGitHubStub({ [ALICE]: { id: 1001, login: "alice" }, [MALLORY]: { id: 2002, login: "mallory" } });
    gateway = await startTestGateway({ runtime, githubUrl: github.url, deployment: DEPLOYMENT });
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await gateway?.close();
    await runtime?.close();
    await github?.close();
  });

  describe("durable actions", () => {
    interface Actions {
      list(sessionId: string, options?: { open?: boolean }): PendingAction[];
    }

    it("keeps a tool call waiting while no client is attached and replays it to the client that resumes", async (ctx) => {
      const actions = service<Actions>("actions");
      if (!actions) return ctx.skip();
      const creator = await connect(ALICE);
      const sessionId = crypto.randomUUID();
      await creator.request("session.create", { sessionId, tools: [{ name: "lookup_order" }] });
      await creator.close();
      await sleep(50);

      const sessions = gateway.gateway.app.service("sessions");
      const principal = await gateway.gateway.app.service("auth").authenticate(ALICE);
      await sessions.send(principal, sessionId, { prompt: "tool:lookup_order" });
      await waitUntil(() => actions.list(sessionId).some((action) => action.kind === "tool" && action.state === "pending"));

      const resumer = await connect(ALICE);
      await resumer.request("session.resume", { sessionId, tools: [{ name: "lookup_order" }] });
      const requested = await resumer.waitForEvent("external_tool.requested");
      expect(requested["data"]).toMatchObject({ toolName: "lookup_order", arguments: { id: "1234" } });
      expect(JSON.stringify(requested)).not.toContain("/platform/host/path");
      await resumer.request("session.tools.handlePendingToolCall", { sessionId, requestId: (requested["data"] as Record<string, unknown>)["requestId"], result: "replayed" });
      await waitUntil(() => assistantText(sessionId).includes("tool said: replayed"));
      expect(actions.list(sessionId).find((action) => action.tool === "lookup_order")?.state).toBe("completed");
    });

    it("lets the owner answer a waiting action over REST, and nobody else", async (ctx) => {
      if (!service("actions")) return ctx.skip();
      const client = await connect(ALICE);
      const sessionId = crypto.randomUUID();
      await client.request("session.create", { sessionId, tools: [{ name: "ship_order" }] });
      await client.request("session.detach", { sessionId });
      const principal = await gateway.gateway.app.service("auth").authenticate(ALICE);
      await gateway.gateway.app.service("sessions").send(principal, sessionId, { prompt: "tool:ship_order" });

      let pending: PendingAction | undefined;
      await waitUntil(async () => {
        const listed = await rest<PendingAction[]>("GET", `/v1/sessions/${sessionId}/actions?open=1`, ALICE);
        pending = listed.body.find((action) => action.tool === "ship_order" && action.state === "pending");
        return Boolean(pending);
      });
      expect(pending).toMatchObject({ kind: "tool", idempotencyKey: expect.stringContaining(sessionId) });
      expect((await rest("GET", `/v1/sessions/${sessionId}/actions`, MALLORY)).status).toBe(404);

      const claim = await rest<ActionClaim>("POST", `/v1/sessions/${sessionId}/actions/${pending!.id}/claim`, ALICE, {});
      expect(claim.status).toBe(200);
      const submitted = await rest<{ state: string }>("POST", `/v1/sessions/${sessionId}/actions/${pending!.id}/result`, ALICE, { claimToken: claim.body.claimToken, result: "shipped by poller" });
      expect(submitted.body.state).toBe("completed");
      await waitUntil(() => assistantText(sessionId).includes("tool said: shipped by poller"));
    });

    it("injects scheduling tools only where the AppHost enables them, and runs them in the gateway", async (ctx) => {
      if (!service("schedules")) return ctx.skip();
      const planner = await connect(ALICE, "planner");
      const sessionId = crypto.randomUUID();
      await planner.request("session.create", { sessionId });
      expect(forwardedTools(sessionId)).toEqual(expect.arrayContaining(["schedule_task", "list_schedules", "cancel_schedule"]));
      await planner.request("session.send", { sessionId, prompt: "tool:list_schedules {}" });
      await waitUntil(() => assistantText(sessionId).some((text) => text.startsWith("tool said:")));
      // The gateway answered it; the client was never asked to run a platform tool.
      const answered = runtime.calls("session.tools.handlePendingToolCall").filter((call) => call.params["sessionId"] === sessionId);
      expect(answered).toHaveLength(1);
      expect(planner.requests.filter((request) => request.method !== "gitHubToken.getToken")).toHaveLength(0);

      const chat = await connect(ALICE, "chat");
      const plain = crypto.randomUUID();
      await chat.request("session.create", { sessionId: plain });
      expect(forwardedTools(plain)).not.toContain("schedule_task");
    });
  });

  describe("network policy", () => {
    interface Policy {
      session(sessionId: string): { ownerId: number; policy: { access: string } } | undefined;
    }

    it("binds shared sessions to their network policy, injects the gateway web_fetch, and releases on delete", async (ctx) => {
      const policy = service<Policy>("policy");
      if (!policy) return ctx.skip();
      const client = await connect(ALICE);
      const sessionId = crypto.randomUUID();
      await client.request("session.create", { sessionId });
      expect(policy.session(sessionId)).toMatchObject({ ownerId: 1001, policy: { access: "enabled" } });
      const webFetch = (runtime.sessions.get(sessionId)!.createParams["tools"] as Record<string, unknown>[]).find((tool) => tool["name"] === "web_fetch");
      expect(webFetch).toMatchObject({ overridesBuiltInTool: true });
      expect(runtime.sessions.get(sessionId)!.createParams["availableTools"]).not.toContain("builtin:web_fetch");

      const offline = await connect(ALICE, "offline");
      const isolated = crypto.randomUUID();
      await offline.request("session.create", { sessionId: isolated });
      expect(forwardedTools(isolated)).not.toContain("web_fetch");
      expect(policy.session(isolated)).toMatchObject({ policy: { access: "disabled" } });

      await client.request("session.delete", { sessionId });
      expect(policy.session(sessionId)).toBeUndefined();
    });

    it("executes web_fetch in the gateway under the session's policy and reports blocked destinations", async (ctx) => {
      if (!service("policy")) return ctx.skip();
      const events: PlatformEvent[] = [];
      const unsubscribe = gateway.gateway.app.service("events").subscribe((event) => events.push(event));
      try {
        const client = await connect(ALICE);
        const sessionId = crypto.randomUUID();
        await client.request("session.create", { sessionId });
        await client.request("session.send", { sessionId, prompt: 'tool:web_fetch {"url":"http://127.0.0.1:9/secret"}' });
        await waitUntil(() => assistantText(sessionId).some((text) => text.startsWith("tool said:")));
        const [answer] = assistantText(sessionId);
        expect(answer).toMatch(/loopback|not allowed|blocked/i);
        await waitUntil(() => events.some((event) => event.type === "network.blocked" && event.sessionId === sessionId));
        expect(JSON.stringify(events.filter((event) => event.sessionId === sessionId))).not.toContain(ALICE);
      } finally {
        unsubscribe();
      }
    });

    it("routes shared remote MCP servers through the gateway adapter", async (ctx) => {
      if (!service("policy")) return ctx.skip();
      const client = await connect(ALICE);
      const sessionId = crypto.randomUUID();
      // A public IP literal: admission evaluates policy without DNS and never connects.
      await client.request("session.create", { sessionId, mcpServers: { docs: { type: "http", url: "https://140.82.112.21/mcp", headers: { "x-team": "docs" }, tools: ["*"] } } });
      const forwarded = runtime.sessions.get(sessionId)!.createParams;
      const docs = (forwarded["mcpServers"] as Record<string, Record<string, unknown>>)["docs"]!;
      expect(String(docs["url"])).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/internal\/mcp\//);
      expect(docs["headers"]).toMatchObject({ "x-team": "docs", "x-managed-copilot-mcp": expect.any(String) });
      expect(JSON.stringify(forwarded)).not.toContain("140.82.112.21");
      expect(forwarded["availableTools"]).toContain("mcp:*");
    });
  });
});
