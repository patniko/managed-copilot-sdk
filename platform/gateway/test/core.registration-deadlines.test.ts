// Deadlines on a session's registration path: a resume, restore, or tools update its runtime never answers fails with
// `timeout` instead of holding every later registration of the session, and a runtime connection that does not answer
// a `ping` either is closed, so the session's next request connects afresh (a half-open gateway→sandbox stream).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SessionManager } from "../src/modules/core/sessions.js";
import { upstreamTimings } from "../src/modules/core/sessions.js";
import { FakeRuntime, FakeSandboxes, RawClient, startGitHubStub, startTestGateway, type TestGateway } from "./harness.js";

const ALICE = "alice-token";
const defaults = { ...upstreamTimings };

describe("registration path deadlines", () => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  let gateway: TestGateway;
  let sandboxes: FakeSandboxes;
  const clients: RawClient[] = [];

  const connect = async (environment = "coder") => {
    const client = await RawClient.connect(gateway.url, ALICE, environment);
    clients.push(client);
    return client;
  };
  const opens = (sessionId: string) => sandboxes.ops(sessionId).filter((op) => op === "openRuntime").length;
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  beforeAll(async () => {
    runtime = new FakeRuntime();
    await runtime.start();
    github = await startGitHubStub({ [ALICE]: { id: 1001, login: "alice" } });
    gateway = await startTestGateway({ runtime, githubUrl: github.url });
    sandboxes = new FakeSandboxes(runtime);
    (gateway.gateway.app.services as Record<string, unknown>)["sandboxes"] = sandboxes;
  });

  afterEach(() => {
    Object.assign(upstreamTimings, defaults);
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await gateway?.close();
    await runtime?.close();
    await github?.close();
  });

  it("fails a resume its sandbox runtime never answers, closes the silent connection, and serves the resume queued behind it", async () => {
    upstreamTimings.answerMs = 300;
    upstreamTimings.probeMs = 200;
    const owner = await connect();
    const sessionId = crypto.randomUUID();
    await owner.request("session.create", { sessionId, requestPermission: true });
    const opened = opens(sessionId);
    // The gateway→sandbox stream went silent (half-open after a handover): nothing sent on it is answered.
    const resume = runtime.holdNext("session.resume", sessionId);
    const ping = runtime.holdNext("ping");
    const first = await connect();
    const second = await connect();
    const started = Date.now();
    const hung = failure(first.request("session.resume", { sessionId }));
    await resume.held;
    // A client that reconnected and resumes again queues behind it...
    const retried = second.request("session.resume", { sessionId });
    // ...and the unanswered resume fails within its bound instead of holding the session until the gateway restarts.
    expect(await hung).toMatchObject({
      data: { code: "timeout" },
      message: expect.stringContaining(`The runtime of session ${sessionId} did not answer session.resume within 0.3 s and its connection stopped responding`),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    // The retry is served on a fresh connection to the sandbox runtime, and the session works.
    await expect(retried).resolves.toBeDefined();
    expect(opens(sessionId)).toBe(opened + 1);
    await expect(second.request("session.sendAndWait", { sessionId, prompt: "after" })).resolves.toMatchObject({ response: { data: { content: "echo: after" } } });
    resume.release();
    ping.release();
  });

  it("fails a resume a connected runtime is slow to answer, and keeps the connection", async () => {
    upstreamTimings.answerMs = 300;
    upstreamTimings.probeMs = 200;
    const owner = await connect();
    const sessionId = crypto.randomUUID();
    await owner.request("session.create", { sessionId, requestPermission: true });
    const opened = opens(sessionId);
    const resume = runtime.holdNext("session.resume", sessionId);
    const client = await connect();
    const slow = failure(client.request("session.resume", { sessionId }));
    await resume.held;
    expect(await slow).toMatchObject({ data: { code: "timeout" }, message: expect.stringContaining("did not answer session.resume within 0.3 s. Try again shortly.") });
    resume.release();
    // The runtime answers a ping, so its connection stays and serves the next resume.
    await expect(client.request("session.resume", { sessionId })).resolves.toBeDefined();
    expect(opens(sessionId)).toBe(opened);
  });

  it("fails a restore whose sandbox runtime never sets up, so the session's next request starts afresh", async () => {
    upstreamTimings.answerMs = 300;
    upstreamTimings.probeMs = 200;
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, requestPermission: true });
    const sessions = gateway.gateway.app.service("sessions") as unknown as SessionManager;
    const stopped = new Promise<void>((resolve) => {
      const off = sessions.onLifecycle((event) => {
        if (event.sessionId !== sessionId || event.type !== "stopped") return;
        off();
        resolve();
      });
    });
    // The runtime goes away; its next connection never answers the restore's resume or a ping.
    runtime.dropConnections();
    await stopped;
    const resume = runtime.holdNext("session.resume", sessionId);
    const ping = runtime.holdNext("ping");
    expect(await failure(sessions.request(sessionId, "session.getMessages", {}))).toMatchObject({ code: "timeout" });
    resume.release();
    ping.release();
    await expect(sessions.request(sessionId, "session.getMessages", {})).resolves.toMatchObject({ events: expect.any(Array) });
  });

  it("bounds a tools update the runtime never answers, so the session's next registration goes through", async () => {
    upstreamTimings.answerMs = 300;
    upstreamTimings.probeMs = 200;
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, requestPermission: true });
    const set = runtime.holdNext("session.tools.set", sessionId);
    const update = failure(client.request("session.tools.set", { sessionId, tools: [{ name: "lookup_order" }] }));
    await set.held;
    expect(await update).toMatchObject({ data: { code: "timeout" } });
    set.release();
    await expect(client.request("session.tools.set", { sessionId, tools: [{ name: "lookup_order" }] })).resolves.toBeDefined();
  });
});
