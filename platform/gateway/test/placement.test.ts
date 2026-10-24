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
    await client.request("session.delete", { sessionId });
    expect(sandboxes.ops(sessionId).at(-1)).toBe("delete");
    expect(gateway.gateway.app.service("sessions").get(sessionId)).toBeUndefined();
  });
});
