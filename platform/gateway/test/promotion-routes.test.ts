// Promotion through the real gateway (fake runtime, GitHub stub): the REST route, the `request_sandbox` platform tool's
// injection and permission policy, and the `promotion` capability.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeRuntime, RawClient, startGitHubStub, startTestGateway, type TestGateway } from "./harness.js";

const ALICE = "alice-token";
const BOB = "bob-token";

describe("promotion through the gateway", () => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  let gateway: TestGateway;
  const clients: RawClient[] = [];

  const post = async (path: string, token: string) => {
    const response = await fetch(`${gateway.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    runtime = new FakeRuntime();
    await runtime.start();
    github = await startGitHubStub({ [ALICE]: { id: 2001, login: "alice" }, [BOB]: { id: 2002, login: "bob" } });
    gateway = await startTestGateway({
      runtime,
      githubUrl: github.url,
      deployment: {
        name: "copilot",
        environments: {
          chat: { type: "shared" },
          coder: { type: "isolated", size: "small", network: false },
          helper: { type: "promotable", promoteTo: "coder", network: false },
        },
      },
    });
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await gateway?.close();
    await runtime?.close();
    await github?.close();
  });

  it("advertises promotion only with a working sandbox backend, and injects request_sandbox only into promotable sessions, behind the permission policy", async () => {
    const info = (await (await fetch(`${gateway.url}/v1/info`, { headers: { authorization: `Bearer ${ALICE}` } })).json()) as { capabilities: string[] };
    // This gateway's DOCKER_HOST is unreachable: like isolated sessions, promotion is not advertised.
    expect(info.capabilities).not.toContain("isolated");
    expect(info.capabilities).not.toContain("promotion");

    const helper = await RawClient.connect(gateway.url, ALICE, "helper");
    const chat = await RawClient.connect(gateway.url, ALICE, "chat");
    clients.push(helper, chat);
    const promotable = crypto.randomUUID();
    const shared = crypto.randomUUID();
    await helper.request("session.create", { sessionId: promotable, requestPermission: true });
    await chat.request("session.create", { sessionId: shared, requestPermission: true });
    const tools = (id: string) => (runtime.sessions.get(id)!.createParams["tools"] as { name: string; skipPermission?: boolean }[]) ?? [];
    expect(tools(promotable).find((tool) => tool.name === "request_sandbox")).toMatchObject({ skipPermission: false });
    expect(tools(shared).some((tool) => tool.name === "request_sandbox")).toBe(false);
    // The shared environment section points the model at the tool instead of refusing.
    const system = JSON.stringify(runtime.sessions.get(promotable)!.createParams["systemMessage"] ?? {});
    expect(system).toContain("request_sandbox");
  });

  it("serves POST /v1/sessions/:id/promote with owner scoping and explicit errors", async () => {
    const chat = await RawClient.connect(gateway.url, ALICE, "chat");
    clients.push(chat);
    const shared = crypto.randomUUID();
    await chat.request("session.create", { sessionId: shared });

    const notPromotable = await post(`/v1/sessions/${shared}/promote`, ALICE);
    expect(notPromotable.status).toBe(400);
    expect(notPromotable.body).toMatchObject({ error: { code: "invalid_request" } });

    const otherOwner = await post(`/v1/sessions/${shared}/promote`, BOB);
    expect(otherOwner.status).toBe(404);
    expect(otherOwner.body).toMatchObject({ error: { code: "not_found" } });

    const unknown = await post(`/v1/sessions/${crypto.randomUUID()}/promote`, ALICE);
    expect(unknown.status).toBe(404);
  });
});
