// Platform tool plumbing through the real gateway (fake runtime, GitHub stub), on both paths that run handlers: the
// actions ledger (durable) and core alone. Handlers learn the calling agent (`agentId`, undefined for the root agent)
// and get a signal that aborts when the runtime stops waiting for the call or the session is deleted.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlatformToolCallContext } from "../src/modules/core/contracts.js";
import { FakeRuntime, RawClient, sleep, startGitHubStub, startTestGateway, type TestGateway } from "./harness.js";

const ALICE = "alice-token";
const ALICE_ID = 1001;

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await sleep(10);
  }
}

describe.each([
  ["with the actions ledger", true],
  ["core alone (no ledger)", false],
])("platform tools %s", (_label, ledger) => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  let gateway: TestGateway;
  const clients: RawClient[] = [];
  /** Calls of `held_tool`: each waits until released or aborted. */
  const runs: { context: PlatformToolCallContext; release: (value: string) => void; aborted: Promise<unknown> }[] = [];

  const connect = async () => {
    const client = await RawClient.connect(gateway.url, ALICE, "chat");
    clients.push(client);
    return client;
  };
  const answers = (sessionId: string) => runtime.calls("session.tools.handlePendingToolCall").filter((call) => call.params["sessionId"] === sessionId);

  beforeAll(async () => {
    runtime = new FakeRuntime();
    await runtime.start();
    github = await startGitHubStub({ [ALICE]: { id: ALICE_ID, login: "alice" } });
    gateway = await startTestGateway({ runtime, githubUrl: github.url });
    if (!ledger) delete (gateway.gateway.app.services as Record<string, unknown>)["actions"];
    gateway.gateway.app.service("platformTools").register({
      name: "held_tool",
      description: "Waits until the test releases it",
      parameters: { type: "object", properties: {} },
      replay: "never",
      recover: () => "recovered",
      handler: (_args, context) =>
        new Promise<string>((resolve, reject) => {
          const aborted = new Promise<unknown>((settle) => context.signal?.addEventListener("abort", () => settle(context.signal!.reason), { once: true }));
          context.signal?.addEventListener("abort", () => reject(context.signal!.reason), { once: true });
          runs.push({ context, release: resolve, aborted });
        }),
    });
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await gateway?.close();
    await runtime?.close();
    await github?.close();
  });

  it("tells the handler which sub-agent called it, and that the root agent's call has none", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId });
    const before = runs.length;
    const sub = client.request<{ response?: { data?: { content?: string } } }>("session.sendAndWait", { sessionId, prompt: "agent:task-42 tool:held_tool" });
    await waitUntil(() => runs.length === before + 1);
    const run = runs[before]!;
    expect(run.context).toMatchObject({ sessionId, agentId: "task-42", ownerId: ALICE_ID, environment: "chat" });
    expect(run.context.idempotencyKey).toBe(`${sessionId}:${run.context.toolCallId}`);
    expect(run.context.actionId !== undefined).toBe(ledger);
    expect(run.context.signal?.aborted).toBe(false);
    run.release("from the sandbox");
    expect((await sub).response?.data?.content).toBe("tool said: from the sandbox");
    expect(run.context.signal?.aborted).toBe(false);

    const root = client.request<{ response?: { data?: { content?: string } } }>("session.sendAndWait", { sessionId, prompt: "tool:held_tool" });
    await waitUntil(() => runs.length === before + 2);
    expect(runs[before + 1]!.context.agentId).toBeUndefined();
    runs[before + 1]!.release("root");
    expect((await root).response?.data?.content).toBe("tool said: root");
  });

  it("aborts the handler when the turn is cancelled, and does not answer the call", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId });
    const before = runs.length;
    await client.request("session.send", { sessionId, prompt: "tool:held_tool" });
    await waitUntil(() => runs.length === before + 1);
    await client.request("session.abort", { sessionId });
    expect(await runs[before]!.aborted).toMatchObject({ code: "conflict", message: expect.stringContaining("stopped waiting") });
    await sleep(50);
    expect(answers(sessionId)).toEqual([]);
  });

  it("aborts the handler when the session is deleted", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId });
    const before = runs.length;
    await client.request("session.send", { sessionId, prompt: "agent:task-7 tool:held_tool" });
    await waitUntil(() => runs.length === before + 1);
    await gateway.gateway.app.service("sessions").delete(ALICE_ID, sessionId);
    expect(await runs[before]!.aborted).toMatchObject({ code: "not_found" });
  });
});

describe("platform tool registration", () => {
  it('refuses a recover hook without replay: "never"', async () => {
    const { PlatformTools } = await import("../src/modules/core/registries.js");
    const registry = new PlatformTools();
    expect(() => registry.register({ name: "x", description: "", handler: () => "", recover: () => "" })).toThrow(/replay: "never"/);
    registry.register({ name: "y", description: "", replay: "never", handler: () => ({ a: 1 }), recover: () => ({ b: 2 }) });
    const tool = registry.get("y")!;
    expect(tool.replay).toBe("never");
    expect(await tool.recover!({}, { sessionId: "s", ownerId: 1, environment: "e", toolCallId: "t", idempotencyKey: "k" })).toBe('{"b":2}');
  });
});
