import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeploymentInfo, SessionInfo } from "@managed-copilot/protocol";
import { FakeRuntime, FakeSandboxes, RawClient, startGitHubStub, startTestGateway, type TestGateway } from "./harness.js";

const ALICE = "alice-token";
const BOB = "bob-token";

describe("workspace-only sessions", () => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  let gateway: TestGateway;
  let sandboxes: FakeSandboxes;
  const clients: RawClient[] = [];

  const rest = async (token: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${gateway.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : undefined };
  };
  const sessions = () =>
    gateway.gateway.app.service("sessions") as unknown as {
      send(principal: unknown, sessionId: string, input: { prompt: string }): Promise<unknown>;
      execActivity(sessionId: string, running: number): void;
      get(sessionId: string): { state: string; kind?: string } | undefined;
    };

  beforeAll(async () => {
    runtime = new FakeRuntime();
    await runtime.start();
    github = await startGitHubStub({ [ALICE]: { id: 1001, login: "alice" }, [BOB]: { id: 1002, login: "bob" } });
    gateway = await startTestGateway({
      runtime,
      githubUrl: github.url,
      deployment: {
        name: "copilot",
        environments: {
          chat: { type: "shared" },
          python: { type: "isolated", size: "small" },
          locked: { type: "isolated", size: "small", exec: false },
        },
        inline: { types: ["isolated"], sizes: ["small"] },
      },
    });
    sandboxes = new FakeSandboxes(runtime);
    (gateway.gateway.app.services as Record<string, unknown>)["sandboxes"] = sandboxes;
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await gateway?.close();
    await runtime?.close();
    await github?.close();
  });

  it("reports exec per isolated environment and the exec capability", async () => {
    const info = (await rest(ALICE, "GET", "/v1/info")).body as unknown as DeploymentInfo;
    const byName = Object.fromEntries(info.environments.map((environment) => [environment.name, environment]));
    expect(byName["python"]?.exec).toBe(true);
    expect(byName["locked"]?.exec).toBe(false);
    expect(byName["chat"]).not.toHaveProperty("exec");
  });

  it("creates a sandbox without a runtime, owned by the caller, and never opens one", async () => {
    const created = await rest(ALICE, "POST", "/v1/sandboxes", { environment: "python" });
    expect(created.status).toBe(201);
    const info = created.body as unknown as SessionInfo;
    expect(info).toMatchObject({ kind: "workspace", environment: "python", type: "isolated", placement: "sandbox", state: "ready", owner: { login: "alice" } });
    expect(sandboxes.ops(info.id)).toEqual(["create"]);
    expect(sandboxes.detail(info.id, "create")).toMatchObject({ runtime: false, environment: "python" });
    expect(runtime.requests.filter((request) => request.params["sessionId"] === info.id)).toEqual([]);

    // Another owner never sees it; the same ID again answers with it.
    expect((await rest(BOB, "GET", `/v1/sessions/${info.id}`)).status).toBe(404);
    const again = await rest(ALICE, "POST", "/v1/sandboxes", { environment: "python", sessionId: info.id });
    expect(again).toMatchObject({ status: 200, body: { id: info.id, kind: "workspace" } });
    expect(sandboxes.ops(info.id)).toEqual(["create"]);
  });

  it("refuses prompts, resume, and agent creates on it", async () => {
    const { body } = await rest(ALICE, "POST", "/v1/sandboxes", { environment: "python" });
    const sessionId = body!["id"] as string;
    const principal = { accountId: 1001, login: "alice", token: ALICE };
    await expect(sessions().send(principal, sessionId, { prompt: "hi" })).rejects.toMatchObject({ code: "invalid_request", message: expect.stringContaining("workspace-only") });
    const client = await RawClient.connect(gateway.url, ALICE, "python");
    clients.push(client);
    await expect(client.request("session.resume", { sessionId })).rejects.toThrow(/workspace-only/);
    await expect(client.request("session.create", { sessionId })).rejects.toThrow(/already exists/);
    expect(sandboxes.ops(sessionId)).toEqual(["create"]);
  });

  it("tracks busy from its running commands", async () => {
    const { body } = await rest(ALICE, "POST", "/v1/sandboxes", { environment: "python" });
    const sessionId = body!["id"] as string;
    sessions().execActivity(sessionId, 2);
    expect(sessions().get(sessionId)?.state).toBe("running");
    sessions().execActivity(sessionId, 0);
    expect(sessions().get(sessionId)?.state).toBe("idle");
  });

  it("deletes it with its sandbox", async () => {
    const { body } = await rest(ALICE, "POST", "/v1/sandboxes", { environment: "python" });
    const sessionId = body!["id"] as string;
    expect((await rest(ALICE, "DELETE", `/v1/sessions/${sessionId}`)).status).toBe(204);
    expect(sandboxes.ops(sessionId)).toEqual(["create", "delete"]);
    expect((await rest(ALICE, "GET", `/v1/sessions/${sessionId}`)).status).toBe(404);
  });

  it("needs an isolated environment that allows exec", async () => {
    expect(await rest(ALICE, "POST", "/v1/sandboxes", { environment: "chat" })).toMatchObject({ status: 400, body: { error: { code: "invalid_request", message: expect.stringContaining("isolated") } } });
    expect(await rest(ALICE, "POST", "/v1/sandboxes", { environment: "locked" })).toMatchObject({
      status: 422,
      body: { error: { code: "policy_violation", message: "Running commands directly is turned off for environment locked." } },
    });
    expect(await rest(ALICE, "POST", "/v1/sandboxes", {})).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    const inline = await rest(ALICE, "POST", "/v1/sandboxes", { environment: { type: "isolated", size: "small" } });
    expect(inline).toMatchObject({ status: 201, body: { kind: "workspace", type: "isolated" } });
  });

  it("refuses exec routes where the operator turned exec off, and on shared sessions", async () => {
    const client = await RawClient.connect(gateway.url, ALICE, "locked");
    clients.push(client);
    const locked = crypto.randomUUID();
    await client.request("session.create", { sessionId: locked });
    expect(await rest(ALICE, "POST", `/v1/sessions/${locked}/exec`, { command: "ls" })).toMatchObject({ status: 422, body: { error: { code: "policy_violation" } } });
    expect(await rest(ALICE, "GET", `/v1/sessions/${locked}/exec`)).toMatchObject({ status: 422 });

    const chat = await RawClient.connect(gateway.url, ALICE, "chat");
    clients.push(chat);
    const shared = crypto.randomUUID();
    await chat.request("session.create", { sessionId: shared });
    expect(await rest(ALICE, "POST", `/v1/sessions/${shared}/exec`, { command: "ls" })).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect(await rest(BOB, "POST", `/v1/sessions/${shared}/exec`, { command: "ls" })).toMatchObject({ status: 404 });
  });
});
