// Deadlines on a session's registration path: a resume, restore, or tools update on a runtime connection that stopped
// responding (a half-open gateway→sandbox stream) fails with `timeout` instead of holding every later registration of
// the session, and the connection is closed, so the session's next request connects afresh. A runtime that still
// answers pings is still working on the step, which may yet apply: it is waited for, with nothing else sent meanwhile.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ManagedCopilotError } from "@managed-copilot/protocol";
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

  it("waits for a resume a connected runtime is slow to answer, sending it nothing else meanwhile, and keeps the connection", async () => {
    upstreamTimings.answerMs = 300;
    upstreamTimings.probeMs = 200;
    const owner = await connect();
    const sessionId = crypto.randomUUID();
    await owner.request("session.create", { sessionId, requestPermission: true });
    const opened = opens(sessionId);
    const resumes = () => runtime.calls("session.resume").filter((call) => call.params["sessionId"] === sessionId).length;
    const before = resumes();
    const resume = runtime.holdNext("session.resume", sessionId);
    const client = await connect();
    let settled = false;
    const slow = client.request("session.resume", { sessionId }).finally(() => {
      settled = true;
    });
    await resume.held;
    // Several answer bounds pass; the runtime answers pings, so it is still working on the resume, which may yet apply.
    // Giving up would let it land after whatever the session is sent next (a resume withdrawing hooks after the
    // registrations that restore them), so nothing else is sent to it and the call keeps waiting.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(settled).toBe(false);
    expect(resumes()).toBe(before + 1);
    resume.release();
    await expect(slow).resolves.toBeDefined();
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

  it("deletes a sandbox session while its runtime is still working on a registration step", async () => {
    upstreamTimings.answerMs = 300;
    upstreamTimings.probeMs = 200;
    const owner = await connect();
    const sessionId = crypto.randomUUID();
    await owner.request("session.create", { sessionId, requestPermission: true });
    const resume = runtime.holdNext("session.resume", sessionId);
    const client = await connect();
    const resuming = failure(client.request("session.resume", { sessionId }));
    await resume.held;
    // The runtime answers pings, so the resume is waited for; deleting the session ends that wait by closing the
    // sandbox's connection (the sandbox goes with the session), instead of waiting for the runtime forever.
    const started = Date.now();
    const deleted = await fetch(`${gateway.url}/v1/sessions/${sessionId}`, { method: "DELETE", headers: { authorization: `Bearer ${ALICE}` } });
    expect(deleted.status).toBe(204);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await resuming).toMatchObject({ data: { code: "not_found" }, message: expect.stringContaining(`Session ${sessionId} was deleted`) });
    expect(sandboxes.ops(sessionId)).toContain("delete");
    resume.release();
  });

  it("keeps a sandbox session whose deletion failed usable", async () => {
    const owner = await connect();
    const sessionId = crypto.randomUUID();
    await owner.request("session.create", { sessionId, requestPermission: true });
    sandboxes.failNextDelete = new ManagedCopilotError("capability_unavailable", "The sandbox backend is unreachable right now");
    const deleted = await fetch(`${gateway.url}/v1/sessions/${sessionId}`, { method: "DELETE", headers: { authorization: `Bearer ${ALICE}` } });
    expect(deleted.ok).toBe(false);
    // The session stays (failed, deletable again) and its owner can still resume it: its sandbox runtime opens again.
    const client = await connect();
    await expect(client.request("session.resume", { sessionId })).resolves.toBeDefined();
    await expect(client.request("session.sendAndWait", { sessionId, prompt: "after" })).resolves.toMatchObject({ response: { data: { content: "echo: after" } } });
  });

  it("bounds a tools update on a connection that stopped responding, so the session's next registration goes through", async () => {
    upstreamTimings.answerMs = 300;
    upstreamTimings.probeMs = 200;
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, requestPermission: true });
    const opened = opens(sessionId);
    const set = runtime.holdNext("session.tools.set", sessionId);
    const ping = runtime.holdNext("ping");
    const update = failure(client.request("session.tools.set", { sessionId, tools: [{ name: "lookup_order" }] }));
    await set.held;
    expect(await update).toMatchObject({ data: { code: "timeout" }, message: expect.stringContaining("did not answer session.tools.set within 0.3 s and its connection stopped responding") });
    set.release();
    ping.release();
    // The session connects afresh and takes the next update.
    await expect(client.request("session.tools.set", { sessionId, tools: [{ name: "lookup_order" }] })).resolves.toBeDefined();
    expect(opens(sessionId)).toBe(opened + 1);
  });
});
