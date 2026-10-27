// Orchestrator environments (spec section 17): a coordinator on shared placement starts workers in their own
// sandboxes through platform tools; the gateway tracks their turns, approves their prompts within the approval the
// owner gave at start, and cleans them up with the coordinator. The fake runtime plays every runtime involved.
import { ManagedCopilotError, type PlatformEvent, type WorkerInfo } from "@managed-copilot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../src/http.js";
import { WORKER_INSTRUCTIONS } from "../src/modules/orchestrator/tools.js";
import { FakeRuntime, FakeSandboxes, RawClient, sleep, startGitHubStub, startTestGateway, type TestGateway } from "./harness.js";

const ALICE = "alice-token";
const BOB = "bob-token";
const ALICE_PRINCIPAL: Principal = { accountId: 1001, login: "alice", token: ALICE };
const BOB_PRINCIPAL: Principal = { accountId: 1002, login: "bob", token: BOB };

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await sleep(10);
  }
}

describe("orchestrator environments", () => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  let gateway: TestGateway;
  let sandboxes: FakeSandboxes;
  const clients: RawClient[] = [];
  const events: PlatformEvent[] = [];

  const app = () => gateway.gateway.app;
  const sessions = () => app().service("sessions");
  const workers = (coordinatorId: string): WorkerInfo[] => app().service("orchestrator").listFor(ALICE_PRINCIPAL, coordinatorId);
  const worker = (coordinatorId: string, name: string): WorkerInfo => app().service("orchestrator").getFor(ALICE_PRINCIPAL, coordinatorId, name);
  /**
   * Waits until the worker's current run started in the runtime. A worker is `working` as soon as its task or message
   * is being sent; events a test emits before the run starts would belong to no run.
   */
  const runStarted = (coordinatorId: string, name: string) =>
    waitUntil(() => {
      const info = worker(coordinatorId, name);
      return info.state === "working" && sessions().get(info.id)?.lastTurn?.status === "running";
    });
  const connect = async (environment = "team", token = ALICE) => {
    const client = await RawClient.connect(gateway.url, token, environment);
    clients.push(client);
    return client;
  };
  const coordinator = async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, requestPermission: true });
    return { client, sessionId };
  };
  /** Runs one coordinator turn that calls `tool` with `args`, and returns what the tool told the model. */
  const call = async (client: RawClient, sessionId: string, tool: string, args: Record<string, unknown> = {}) => {
    const reply = await client.request<{ response?: { data?: { content?: string } } }>("session.sendAndWait", { sessionId, prompt: `tool:${tool} ${JSON.stringify(args)}` });
    const said = String(reply.response?.data?.content ?? "").replace(/^tool said: /, "");
    // The fake runtime quotes a failed tool call's error as JSON.
    try {
      const parsed: unknown = JSON.parse(said);
      if (typeof parsed === "string") return parsed;
    } catch {
      // A plain result.
    }
    return said;
  };
  const createParams = (sessionId: string) => runtime.calls("session.create").find((request) => request.params["sessionId"] === sessionId)!.params;
  const sends = (sessionId: string) => runtime.calls("session.send").filter((request) => request.params["sessionId"] === sessionId).map((request) => request.params["prompt"]);
  const rest = async (path: string, token = ALICE) => {
    const response = await fetch(new URL(path, gateway.url), { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: (await response.json()) as unknown };
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
          team: { type: "orchestrator", workers: ["coder", "reviewer"], maxWorkers: 2, models: ["claude-haiku-4.5"] },
          coder: { type: "isolated", size: "small", description: "Builds things" },
          reviewer: { type: "isolated", size: "small", models: ["gpt-5.4"] },
          chat: { type: "shared" },
        },
      },
    });
    sandboxes = new FakeSandboxes(runtime);
    sandboxes.reportSandboxes = true;
    (app().services as Record<string, unknown>)["sandboxes"] = sandboxes;
    app().service("events").subscribe((event) => void events.push(event));
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await gateway?.close();
    await runtime?.close();
    await github?.close();
  });

  it("gives only orchestrator sessions the worker tools and the coordinator's prompt", async () => {
    const { sessionId } = await coordinator();
    const params = createParams(sessionId);
    const tools = (params["tools"] as { name: string; skipPermission?: boolean }[]).map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["start_worker", "message_worker", "wait_for_workers", "list_workers", "read_worker_file", "copy_worker_files", "stop_worker"]));
    // Starting a worker asks the session's permission; the other tools act within approved workers.
    expect((params["tools"] as { name: string; skipPermission?: boolean }[]).find((tool) => tool.name === "start_worker")?.skipPermission).toBe(false);
    const prompt = JSON.stringify(params["systemMessage"]);
    expect(prompt).toContain("coordinates workers");
    expect(prompt).toContain("wait_for_workers");
    // In-process subagents would have no shell or files here: the coordinator delegates to workers instead.
    expect(params["availableTools"]).not.toContain("builtin:task");

    const chat = await connect("chat");
    const chatId = crypto.randomUUID();
    await chat.request("session.create", { sessionId: chatId, requestPermission: true });
    expect(((createParams(chatId)["tools"] as { name: string }[] | undefined) ?? []).map((tool) => tool.name)).not.toContain("start_worker");
    expect(await rest(`/v1/sessions/${chatId}/workers`)).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
  });

  it("starts a worker in its own sandbox with the task, and wait_for_workers returns its report", async () => {
    const { client, sessionId } = await coordinator();
    const started = await call(client, sessionId, "start_worker", { name: "Counter", task: "count the files" });
    expect(started).toMatch(/Started worker "counter" \(ID [0-9a-f-]+\) in environment "coder"/);
    const [info] = workers(sessionId);
    expect(info).toMatchObject({ name: "counter", coordinatorId: sessionId, environment: "coder", model: "claude-haiku-4.5", task: "count the files" });

    // An ordinary isolated session of its environment, linked to its coordinator.
    await waitUntil(() => worker(sessionId, "counter").state === "idle");
    expect(sessions().get(info!.id)).toMatchObject({ environment: "coder", type: "isolated", placement: "sandbox", parentSessionId: sessionId, ownerId: 1001 });
    expect((await sessions().info(1001, info!.id)).parentSessionId).toBe(sessionId);
    expect(sandboxes.ops(info!.id)).toContain("create");
    const workerParams = createParams(info!.id);
    expect(workerParams["systemMessage"]).toEqual({ mode: "append", content: WORKER_INSTRUCTIONS });
    expect(((workerParams["tools"] as { name: string }[] | undefined) ?? []).map((tool) => tool.name)).not.toContain("start_worker");
    expect(sends(info!.id)).toEqual(["count the files"]);
    expect(worker(sessionId, "counter")).toMatchObject({ state: "idle", result: "echo: count the files", messages: 1 });

    const report = await call(client, sessionId, "wait_for_workers");
    expect(report).toContain("None of this session's workers are working");
    expect(report).toContain('<worker_report worker="counter">\necho: count the files\n</worker_report>');
    const named = await call(client, sessionId, "wait_for_workers", { workers: ["counter"] });
    expect(named).toContain('"counter" is done.');

    const published = events.filter((event) => event.sessionId === sessionId && event.type.startsWith("worker."));
    expect(published.map((event) => event.type)).toEqual(["worker.started", "worker.idle"]);
    expect(published[0]).toMatchObject({ environment: "team", data: { workerId: info!.id, name: "counter", environment: "coder", state: "working" } });

    expect(await rest(`/v1/sessions/${sessionId}/workers`)).toMatchObject({ status: 200, body: [{ id: info!.id, name: "counter", state: "idle" }] });
    expect(await rest(`/v1/sessions/${sessionId}/workers/counter`)).toMatchObject({ status: 200, body: { id: info!.id } });
    expect((await rest(`/v1/sessions/${sessionId}/workers`, BOB)).status).toBe(404);
  });

  it("keeps the coordinator's turn open until its workers finish, without polling", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "slow", task: "stall" });
    await runStarted(sessionId, "slow");
    const workerId = worker(sessionId, "slow").id;

    const timedOut = await call(client, sessionId, "wait_for_workers", { timeoutSeconds: 1 });
    expect(timedOut).toContain("1 of 1 workers is still working after 1 seconds");

    let done = false;
    const waiting = call(client, sessionId, "wait_for_workers").then((text) => {
      done = true;
      return text;
    });
    await sleep(200);
    expect(done).toBe(false);
    runtime.emitEvent(workerId, "assistant.message", { messageId: "m2", content: "finished the slow work" });
    runtime.emitEvent(workerId, "session.idle", {});
    expect(await waiting).toContain("finished the slow work");
    expect(worker(sessionId, "slow").state).toBe("idle");
  });

  it("records a worker turn's error, and a later turn makes it work again", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "flaky", task: "stall" });
    await runStarted(sessionId, "flaky");
    const workerId = worker(sessionId, "flaky").id;
    runtime.emitEvent(workerId, "session.error", { errorType: "model", message: "The model call failed" });
    runtime.emitEvent(workerId, "session.idle", {});
    await waitUntil(() => worker(sessionId, "flaky").state === "failed");
    expect(worker(sessionId, "flaky").error).toBe("The model call failed");
    expect(await call(client, sessionId, "wait_for_workers", { workers: ["flaky"] })).toContain("Error: The model call failed");

    expect(await call(client, sessionId, "message_worker", { worker: "flaky", message: "try again" })).toContain('Sent to "flaky"');
    await waitUntil(() => worker(sessionId, "flaky").state === "idle");
    expect(worker(sessionId, "flaky")).toMatchObject({ result: "echo: try again", messages: 2 });
    expect(sends(workerId)).toEqual(["stall", "try again"]);
  });

  it("messages a worker only between runs, keeps a run's report through steering, and fails a run that reported an error when it ends", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "steady", task: "stall" });
    await runStarted(sessionId, "steady");
    const workerId = worker(sessionId, "steady").id;
    // A working worker is waited for first: nothing is queued behind its run.
    expect(await call(client, sessionId, "message_worker", { worker: "steady", message: "also this" })).toMatch(/is still working\. Call wait_for_workers/);
    // Refusals reach the coordinator's model as the stock SDK shows a failed tool (a thrown error would not).
    expect(app().service("actions").list(sessionId).find((action) => action.tool === "message_worker")).toMatchObject({
      state: "completed",
      result: { resultType: "failure", textResultForLlm: expect.stringMatching(/is still working/) },
    });
    expect(sends(workerId)).toEqual(["stall"]);
    expect(worker(sessionId, "steady").messages).toBe(1);

    // Steering and skill prompts are messages inside the run: its report is still the run's reply.
    runtime.emitEvent(workerId, "assistant.message", { messageId: "a1", content: "half done" });
    runtime.emitEvent(workerId, "user.message", { content: "steer", messageId: "s1", delivery: "steering" });
    runtime.emitEvent(workerId, "user.message", { content: "use the skill", messageId: "k1", source: "skill-pdf" });
    runtime.emitEvent(workerId, "session.idle", {});
    await waitUntil(() => worker(sessionId, "steady").state === "idle");
    expect(worker(sessionId, "steady").result).toBe("half done");

    // A run that reports an error fails when it ends (until then it is still working, and takes no message).
    await call(client, sessionId, "message_worker", { worker: "steady", message: "stall" });
    await runStarted(sessionId, "steady");
    runtime.emitEvent(workerId, "session.error", { errorType: "model", message: "The model call failed" });
    await sleep(100);
    expect(worker(sessionId, "steady").state).toBe("working");
    expect(await call(client, sessionId, "message_worker", { worker: "steady", message: "too early" })).toMatch(/is still working/);
    runtime.emitEvent(workerId, "session.idle", {});
    await waitUntil(() => worker(sessionId, "steady").state === "failed");
    expect(worker(sessionId, "steady")).toMatchObject({ error: "The model call failed", result: "half done", messages: 2 });

    // A run that goes on after an error (a retry) finishes with its reply.
    await call(client, sessionId, "message_worker", { worker: "steady", message: "stall" });
    await runStarted(sessionId, "steady");
    runtime.emitEvent(workerId, "session.error", { errorType: "rate_limit", message: "Rate limited; retrying" });
    runtime.emitEvent(workerId, "assistant.message", { messageId: "a2", content: "recovered" });
    runtime.emitEvent(workerId, "session.idle", {});
    await waitUntil(() => worker(sessionId, "steady").state === "idle");
    expect(worker(sessionId, "steady")).toMatchObject({ result: "recovered", messages: 3 });
    expect(worker(sessionId, "steady").error).toBeUndefined();
  });

  it("fails a working worker whose runtime went away after its run reported an error, before the run ended", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "vanished", task: "stall" });
    await runStarted(sessionId, "vanished");
    const workerId = worker(sessionId, "vanished").id;
    // Core records the turn failed at its error, so it does not end the turn again when the connection closes.
    runtime.emitEvent(workerId, "session.error", { errorType: "model", message: "The model call failed" });
    await waitUntil(() => sessions().get(workerId)?.lastTurn?.status === "failed");
    expect(worker(sessionId, "vanished").state).toBe("working");
    sandboxes.streams.get(workerId)!.destroy();
    // Nothing carries the run, so core ends it as interrupted, and the worker fails when it ends.
    await waitUntil(() => worker(sessionId, "vanished").state === "failed");
    expect(worker(sessionId, "vanished").error).toMatch(/interrupted because the platform lost the connection to the session's runtime/);
    expect(sessions().get(workerId)).toMatchObject({ state: "idle", lastTurn: { status: "failed" } });
    // Nothing is left working: messaging it brings its session back in a new runtime.
    expect(await call(client, sessionId, "message_worker", { worker: "vanished", message: "again" })).toContain('Sent to "vanished"');
    await waitUntil(() => worker(sessionId, "vanished").result === "echo: again");
    expect(worker(sessionId, "vanished").state).toBe("idle");
  });

  it("fails a worker whose runtime went away while the message that started its run was still unanswered", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "midsend", task: "hello" });
    await waitUntil(() => worker(sessionId, "midsend").state === "idle");
    const workerId = worker(sessionId, "midsend").id;
    // The runtime starts the run but has not answered the send yet; the run reports an error; the connection closes.
    const held = runtime.holdNext("session.send", workerId);
    const sending = call(client, sessionId, "message_worker", { worker: "midsend", message: "stall" });
    await held.held;
    await waitUntil(() => worker(sessionId, "midsend").state === "working" && sessions().get(workerId)?.lastTurn?.status === "running");
    runtime.emitEvent(workerId, "session.error", { errorType: "model", message: "The model call failed" });
    await waitUntil(() => sessions().get(workerId)?.lastTurn?.status === "failed");
    sandboxes.streams.get(workerId)!.destroy();
    // The run had started, so the message most likely arrived; core then ends the run, which nothing carries.
    expect(await sending).toMatch(/may have reached "midsend"/);
    held.release();
    await waitUntil(() => worker(sessionId, "midsend").state === "failed");
    expect(worker(sessionId, "midsend").error).toMatch(/interrupted because the platform lost the connection/);
  });

  it("keeps a working worker whose runtime went away while its run waits on a prompt, also after an error it went on from", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "patient", task: "stall" });
    await runStarted(sessionId, "patient");
    const workerId = worker(sessionId, "patient").id;
    // A retried error (core records the turn failed), then a prompt only a person may answer.
    runtime.emitEvent(workerId, "session.error", { errorType: "rate_limit", message: "Rate limited; retrying" });
    runtime.emitEvent(workerId, "assistant.message", { messageId: "a1", content: "retrying worked" });
    runtime.emitEvent(workerId, "permission.requested", { requestId: "perm-wait", permissionRequest: { kind: "shell", fullCommandText: "rm -rf /data", managedApprovalRequired: true } });
    const actions = app().service("actions");
    await waitUntil(() => actions.list(workerId, { open: true }).some((action) => action.requestId === "perm-wait"));
    expect(sessions().get(workerId)?.lastTurn?.status).toBe("failed");
    sandboxes.streams.get(workerId)!.destroy();
    // Durable carries the prompt: the run continues once it is answered, so the worker stays working.
    await sleep(1_500);
    expect(worker(sessionId, "patient").state).toBe("working");
  });

  it("keeps a worker whose run carries on after its runtime came back, and records its reply", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "resumer", task: "stall" });
    await runStarted(sessionId, "resumer");
    const workerId = worker(sessionId, "resumer").id;
    // An error the run goes on from, then a prompt only a person may answer; then the connection is lost.
    runtime.emitEvent(workerId, "session.error", { errorType: "rate_limit", message: "Rate limited; retrying" });
    runtime.emitEvent(workerId, "assistant.message", { messageId: "a1", content: "retrying worked" });
    runtime.emitEvent(workerId, "permission.requested", { requestId: "perm-resume", permissionRequest: { kind: "shell", fullCommandText: "rm -rf /data", managedApprovalRequired: true } });
    const actions = app().service("actions");
    await waitUntil(() => actions.list(workerId, { open: true }).some((action) => action.requestId === "perm-resume"));
    sandboxes.streams.get(workerId)!.destroy();
    // A person approves it at once: delivering the answer brings the session back, and its run carries on there.
    const pending = actions.list(workerId, { open: true }).find((action) => action.requestId === "perm-resume")!;
    const owner = { type: "user", principal: ALICE_PRINCIPAL } as const;
    const { claimToken } = await actions.claim(owner, workerId, pending.id);
    await actions.submit(owner, workerId, pending.id, { claimToken, result: { kind: "approve-once", approvedInteractively: true } });
    await waitUntil(() => runtime.calls("session.permissions.handlePendingPermissionRequest").some((request) => request.params["requestId"] === "perm-resume"));
    // Past the check that follows a lost connection, it is still working, and its reply then finishes it.
    await sleep(1_500);
    expect(worker(sessionId, "resumer").state).toBe("working");
    runtime.emitEvent(workerId, "assistant.message", { messageId: "a2", content: "done after the approval" });
    runtime.emitEvent(workerId, "session.idle", {});
    await waitUntil(() => worker(sessionId, "resumer").state === "idle");
    expect(worker(sessionId, "resumer").result).toBe("done after the approval");
  });

  it("fails a worker whose run its restarted runtime no longer has, once the session is back", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "forgotten", task: "stall" });
    await runStarted(sessionId, "forgotten");
    const workerId = worker(sessionId, "forgotten").id;
    runtime.emitEvent(workerId, "session.error", { errorType: "rate_limit", message: "Rate limited; retrying" });
    runtime.emitEvent(workerId, "assistant.message", { messageId: "a1", content: "retrying worked" });
    runtime.emitEvent(workerId, "permission.requested", { requestId: "perm-gone", permissionRequest: { kind: "shell", fullCommandText: "rm -rf /data", managedApprovalRequired: true } });
    const actions = app().service("actions");
    await waitUntil(() => actions.list(workerId, { open: true }).some((action) => action.requestId === "perm-gone"));
    // The connection is lost with the prompt open, and the runtime that comes back no longer has the run or the prompt.
    sandboxes.streams.get(workerId)!.destroy();
    await sleep(1_500);
    expect(worker(sessionId, "forgotten").state).toBe("working");
    runtime.forgetTurn(workerId);
    await sessions().request(workerId, "session.getMessages", {});
    // The restore finds nothing running or waiting: core ends the run, and the worker fails.
    await waitUntil(() => worker(sessionId, "forgotten").state === "failed");
    expect(worker(sessionId, "forgotten").error).toMatch(/interrupted because the platform lost the connection/);
  });

  it("fails a worker whose runtime accepted its message and went away before starting it", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "accepted", task: "hello" });
    await waitUntil(() => worker(sessionId, "accepted").state === "idle");
    const workerId = worker(sessionId, "accepted").id;
    // The runtime answers the send (it queued the message behind other work), then goes away before starting it.
    expect(await call(client, sessionId, "message_worker", { worker: "accepted", message: "queued" })).toContain('Sent to "accepted"');
    expect(worker(sessionId, "accepted").state).toBe("working");
    expect(sessions().get(workerId)?.lastTurn?.completedAt).toBeDefined();
    sandboxes.streams.get(workerId)!.destroy();
    // Core has no turn of it to end: the worker fails once the close settled, and a new message continues it.
    await waitUntil(() => worker(sessionId, "accepted").state === "failed");
    expect(worker(sessionId, "accepted").error).toBe("Its sandbox stopped before it started on your last message. Message it again to continue.");
    expect(await call(client, sessionId, "message_worker", { worker: "accepted", message: "again" })).toContain('Sent to "accepted"');
    await waitUntil(() => worker(sessionId, "accepted").result === "echo: again");
    expect(worker(sessionId, "accepted").state).toBe("idle");
  });

  it("fails a working worker whose run a failed deletion of its session cut, and stops it once the session is deleted", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "undeleted", task: "stall" });
    await runStarted(sessionId, "undeleted");
    const workerId = worker(sessionId, "undeleted").id;
    // An error the run goes on from (core records the turn failed), then the owner deletes the worker's session: the
    // deletion closes its runtime connection, and then deleting its sandbox fails.
    runtime.emitEvent(workerId, "session.error", { errorType: "rate_limit", message: "Rate limited; retrying" });
    runtime.emitEvent(workerId, "assistant.message", { messageId: "a1", content: "retrying worked" });
    await waitUntil(() => sessions().get(workerId)?.lastTurn?.status === "failed");
    sandboxes.failNextDelete = new ManagedCopilotError("internal", "The sandbox backend is not responding");
    await expect(sessions().delete(1001, workerId)).rejects.toMatchObject({ code: "internal" });
    // Core ends the run the closed connection cut, so the worker fails; the session stays failed, deletable again.
    await waitUntil(() => worker(sessionId, "undeleted").state === "failed");
    expect(worker(sessionId, "undeleted").error).toMatch(/interrupted because the platform lost the connection/);
    expect(sessions().get(workerId)).toMatchObject({ state: "failed", lastTurn: { status: "failed" } });
    await sessions().delete(1001, workerId);
    await waitUntil(() => worker(sessionId, "undeleted").state === "stopped");
  });

  it("takes back a message the runtime refused", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "refused", task: "hello" });
    await waitUntil(() => worker(sessionId, "refused").state === "idle");
    const workerId = worker(sessionId, "refused").id;
    runtime.failNext("session.send", workerId, "The runtime is shutting down");
    // Told to the model as a failed tool, without the runtime's own wording.
    expect(await call(client, sessionId, "message_worker", { worker: "refused", message: "more" })).toBe(`Couldn't deliver your message to "refused": the platform could not complete it`);
    expect(worker(sessionId, "refused")).toMatchObject({ state: "idle", result: "echo: hello", messages: 1 });
    expect(worker(sessionId, "refused").error).toMatch(/Couldn't deliver your last message/);
    expect(await call(client, sessionId, "message_worker", { worker: "refused", message: "more" })).toContain('Sent to "refused"');
    await waitUntil(() => worker(sessionId, "refused").result === "echo: more");
    expect(worker(sessionId, "refused")).toMatchObject({ state: "idle", messages: 2 });
  });

  it("enforces maxWorkers and unique names, and stop_worker frees a slot and deletes the sandbox", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "one", task: "first" });
    expect(await call(client, sessionId, "start_worker", { name: "one", task: "again" })).toMatch(/A worker named "one" already exists/);
    await call(client, sessionId, "start_worker", { name: "two", task: "second", environment: "reviewer" });
    expect(await call(client, sessionId, "start_worker", { name: "three", task: "third" })).toMatch(/the most it can have at once \(2\)/);
    expect(await call(client, sessionId, "start_worker", { name: "four", task: "x", environment: "chat" })).toMatch(/not a worker environment/);
    expect(await call(client, sessionId, "start_worker", { name: "five", task: "x", model: "claude-haiku-4.5", environment: "reviewer" })).toMatch(/not allowed in worker environment "reviewer"/);
    await waitUntil(() => workers(sessionId).every((info) => info.state === "idle"));
    // The reviewer environment does not allow the coordinator's model, so its own applies.
    expect(worker(sessionId, "two")).toMatchObject({ environment: "reviewer" });
    expect(worker(sessionId, "two").model).toBeUndefined();
    expect(createParams(worker(sessionId, "two").id)["model"]).toBe("gpt-5.4");

    const oneId = worker(sessionId, "one").id;
    expect(await call(client, sessionId, "stop_worker", { worker: "one" })).toContain('Stopped worker "one"');
    expect(sandboxes.ops(oneId)).toContain("delete");
    expect(sessions().get(oneId)).toBeUndefined();
    expect(worker(sessionId, "one").state).toBe("stopped");
    expect(events.some((event) => event.type === "worker.stopped" && (event.data as { workerId?: string }).workerId === oneId)).toBe(true);
    expect(await call(client, sessionId, "start_worker", { name: "one", task: "a new one" })).toMatch(/Started worker "one"/);
    expect(await call(client, sessionId, "list_workers")).toMatch(/coder \(the default\): Builds things[\s\S]*Workers \(2 of at most 2 at once\)/);
  });

  it("stops the worker a stop_worker call chose, also when the call runs again after its name was reused", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "dup", task: "hello" });
    await waitUntil(() => worker(sessionId, "dup").state === "idle");
    const first = worker(sessionId, "dup").id;
    const manager = app().service("orchestrator");
    const context = { sessionId, ownerId: 1001, environment: "team", toolCallId: "call-stop", idempotencyKey: `stop-${sessionId}` };
    expect(await manager.stop({ worker: "dup" }, context)).toContain('Stopped worker "dup"');
    await call(client, sessionId, "start_worker", { name: "dup", task: "hello again" });
    await waitUntil(() => worker(sessionId, "dup").state === "idle");
    const second = worker(sessionId, "dup").id;
    expect(second).not.toBe(first);
    // The first call again (a replay after a restart, before its result was recorded).
    expect(await manager.stop({ worker: "dup" }, context)).toContain('Stopped worker "dup"');
    expect(worker(sessionId, second).state).toBe("idle");
    expect(sessions().get(second)).toBeDefined();
    expect(worker(sessionId, first).state).toBe("stopped");
  });

  it("keeps the record of a message whose worker was stopped while it was sent, so running the call again never sends it to a newer worker", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "relay", task: "hello" });
    await waitUntil(() => worker(sessionId, "relay").state === "idle");
    const original = worker(sessionId, "relay").id;
    const manager = app().service("orchestrator");
    const context = { sessionId, ownerId: 1001, environment: "team", toolCallId: "call-relay", idempotencyKey: `msg-${sessionId}` };
    // The message reaches the worker and runs, but its send's answer is lost while the worker is stopped.
    const service = sessions();
    const send = service.send.bind(service);
    let delivered!: () => void;
    const ran = new Promise<void>((resolve) => (delivered = resolve));
    let lose!: () => void;
    const lost = new Promise<void>((resolve) => (lose = resolve));
    service.send = async (principal, id, input, options) => {
      if (id !== original) return send(principal, id, input, options);
      await send(principal, id, input, options);
      delivered();
      await lost;
      throw new Error("The runtime connection closed");
    };
    try {
      const sending = manager.message({ worker: "relay", message: "more" }, context).then(
        () => undefined,
        (error: unknown) => error,
      );
      await ran;
      await waitUntil(() => worker(sessionId, original).result === "echo: more");
      expect(await call(client, sessionId, "stop_worker", { worker: "relay" })).toContain('Stopped worker "relay"');
      lose();
      expect(await sending).toMatchObject({ code: "conflict", message: expect.stringMatching(/was stopped while your message was being sent/) });
    } finally {
      delete (service as { send?: unknown }).send;
    }
    // A newer worker takes the name; the same call again answers from its record instead of sending.
    await call(client, sessionId, "start_worker", { name: "relay", task: "hello again" });
    await waitUntil(() => worker(sessionId, "relay").id !== original && worker(sessionId, "relay").state === "idle");
    const newer = worker(sessionId, "relay").id;
    expect(await manager.message({ worker: "relay", message: "more" }, context)).toMatch(/may have reached "relay"/);
    expect(sends(newer)).toEqual(["hello again"]);
  });

  it("says so when a stopped worker's sandbox could not be deleted, and finishes the cleanup later", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "sticky", task: "hello" });
    await waitUntil(() => worker(sessionId, "sticky").state === "idle");
    const workerId = worker(sessionId, "sticky").id;
    sandboxes.failNextDelete = new ManagedCopilotError("internal", "The sandbox backend is not responding");
    expect(await call(client, sessionId, "stop_worker", { worker: "sticky" })).toMatch(/couldn't be deleted yet \(The sandbox backend is not responding\)\. The platform keeps trying\./);
    expect(worker(sessionId, "sticky").state).toBe("stopped");
    expect(sessions().get(workerId)).toBeDefined();
    // Asking again finishes it.
    expect(await call(client, sessionId, "stop_worker", { worker: "sticky" })).toContain("Its sandbox and files are deleted.");
    expect(sessions().get(workerId)).toBeUndefined();
  });

  it("keeps a stopped worker's cleanup outstanding while another deletion of its session is under way, until it is gone", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "contested", task: "hello" });
    await waitUntil(() => worker(sessionId, "contested").state === "idle");
    const workerId = worker(sessionId, "contested").id;
    // The owner deletes the worker's session; deleting its sandbox is slow, and then fails.
    const held = sandboxes.holdNextDelete();
    const ownerDelete = sessions()
      .delete(1001, workerId)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await held.held;
    expect(await call(client, sessionId, "stop_worker", { worker: "contested" })).toContain("Its sandbox and files are being deleted.");
    held.release(new ManagedCopilotError("internal", "The sandbox backend is not responding"));
    expect(await ownerDelete).toMatchObject({ code: "internal" });
    expect(sessions().get(workerId)?.state).toBe("failed");
    // Nothing recorded the cleanup as done: stopping it again deletes the session.
    expect(await call(client, sessionId, "stop_worker", { worker: "contested" })).toContain("Its sandbox and files are deleted.");
    expect(sessions().get(workerId)).toBeUndefined();
  });

  it("approves a worker's permission prompts once each, and leaves the ones a person must answer", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "shell", task: "stall" });
    await runStarted(sessionId, "shell");
    const workerId = worker(sessionId, "shell").id;
    const answers = () => runtime.calls("session.permissions.handlePendingPermissionRequest").filter((request) => request.params["sessionId"] === workerId);

    runtime.emitEvent(workerId, "permission.requested", { requestId: "perm-1", permissionRequest: { kind: "shell", fullCommandText: "ls", intention: "List files" } });
    await waitUntil(() => answers().length === 1);
    expect(answers()[0]!.params).toMatchObject({ requestId: "perm-1", result: { kind: "approve-once" } });
    const actions = app().service("actions");
    expect(actions.list(workerId).find((action) => action.requestId === "perm-1")).toMatchObject({ state: "completed", claimedBy: "platform:orchestrator" });

    runtime.emitEvent(workerId, "permission.requested", { requestId: "perm-2", permissionRequest: { kind: "shell", fullCommandText: "rm -rf /data", managedApprovalRequired: true } });
    await waitUntil(() => actions.list(workerId, { open: true }).some((action) => action.requestId === "perm-2"));
    await sleep(100);
    expect(answers()).toHaveLength(1);
    expect(actions.list(workerId, { open: true }).find((action) => action.requestId === "perm-2")).toMatchObject({ state: "pending" });
    // The coordinator learns why the worker is still working.
    expect(await call(client, sessionId, "wait_for_workers", { workers: ["shell"], timeoutSeconds: 1 })).toContain(
      `Still working, and waiting for a person to answer a prompt: they can answer it in Copilot CLI with \`npx managed-copilot attach ${workerId}\``,
    );

    // The ledger never lets the platform answer for a person, or answer anything but a permission prompt.
    const caller = { type: "platform", ownerId: 1001, responder: "test" } as const;
    const pending = actions.list(workerId, { open: true }).find((action) => action.requestId === "perm-2")!;
    const claim = await actions.claim(caller, workerId, pending.id);
    await expect(actions.submit(caller, workerId, pending.id, { claimToken: claim.claimToken, result: { kind: "approve-once", approvedInteractively: true } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(actions.submit(caller, workerId, pending.id, { claimToken: claim.claimToken, result: { kind: "approve-once" } })).rejects.toThrow(/requires a person/);
    await actions.submit(caller, workerId, pending.id, { claimToken: claim.claimToken, release: true });
    await expect(actions.claim({ type: "platform", ownerId: 1002, responder: "test" }, workerId, pending.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("approves a prompt once its full request shows no person is required, read as the ledger reads it", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "prompts", task: "stall" });
    await runStarted(sessionId, "prompts");
    const workerId = worker(sessionId, "prompts").id;
    const answered = (requestId: string) =>
      runtime.calls("session.permissions.handlePendingPermissionRequest").some((request) => request.params["sessionId"] === workerId && request.params["requestId"] === requestId);
    const actions = app().service("actions");

    // Known only in its derived form, nothing shows yet whether a person must answer: it waits...
    runtime.emitEvent(workerId, "permission.requested", { requestId: "perm-partial", promptRequest: { kind: "commands", fullCommandText: "ls" } });
    await waitUntil(() => actions.list(workerId, { open: true }).some((action) => action.requestId === "perm-partial"));
    await sleep(100);
    expect(answered("perm-partial")).toBe(false);
    // ...until the runtime asks again with the full request.
    runtime.emitEvent(workerId, "permission.requested", { requestId: "perm-partial", permissionRequest: { kind: "shell", fullCommandText: "ls" }, promptRequest: { kind: "commands", fullCommandText: "ls" } });
    await waitUntil(() => answered("perm-partial"));

    // For standard prompt kinds the derived request decides (stock SDK guidance): this one needs no person.
    runtime.emitEvent(workerId, "permission.requested", {
      requestId: "perm-derived",
      permissionRequest: { kind: "shell", fullCommandText: "npm test", managedApprovalRequired: true },
      promptRequest: { kind: "commands", fullCommandText: "npm test", managedApprovalRequired: false },
    });
    await waitUntil(() => answered("perm-derived"));
  });

  it("serves a worker with its coordinator's connected client, and with nothing once that client is gone", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "creds", task: "hello" });
    await waitUntil(() => worker(sessionId, "creds").state === "idle");
    const workerId = worker(sessionId, "creds").id;
    // Only the same owner's session can be a parent.
    await expect(sessions().create({ accountId: 1002, login: "bob", token: BOB }, { environment: "coder", parentSessionId: sessionId })).rejects.toMatchObject({ code: "not_found" });
    expect(sessions().attached(workerId)).toHaveLength(0);
    expect(await sessions().ownerPrincipal!(workerId)).toMatchObject({ accountId: 1001, login: "alice" });
    await client.close();
    await waitUntil(async () =>
      sessions()
        .ownerPrincipal!(workerId)
        .then(
          () => false,
          (error: { code?: string }) => error.code === "authentication_required",
        ),
    );
  });

  it("starts a worker on its coordinator's live credential, never on one borrowed when the start began", async () => {
    const { client, sessionId } = await coordinator();
    const held = sandboxes.holdNextOpen();
    await call(client, sessionId, "start_worker", { name: "borrowed", task: "hello" });
    await held.held;
    // The coordinator's only client leaves while the worker's sandbox starts (and there is no background sign-in).
    await client.close();
    held.release();
    await waitUntil(() => worker(sessionId, "borrowed").state === "failed");
    expect(worker(sessionId, "borrowed").error).toMatch(/^Couldn't start/);
    expect(sends(worker(sessionId, "borrowed").id)).toEqual([]);
  });

  it("never lends the coordinator's credential to a worker for longer than the coordinator's connection", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "lender", task: "hello" });
    await waitUntil(() => worker(sessionId, "lender").state === "idle");
    const workerId = worker(sessionId, "lender").id;
    const held = runtime.holdNext("session.send", workerId, { before: true });
    const sending = call(client, sessionId, "message_worker", { worker: "lender", message: "more" }).catch(() => undefined);
    await held.held;
    // While the message is being sent, the coordinator's only client leaves (and there is no background sign-in).
    await client.close();
    await waitUntil(async () =>
      sessions()
        .ownerPrincipal!(workerId)
        .then(
          () => false,
          (error: { code?: string }) => error.code === "authentication_required",
        ),
    );
    held.release();
    await sending;
  });

  it("waits for a finished worker's outputs to be published before reporting them", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "publisher", task: "stall" });
    await runStarted(sessionId, "publisher");
    const workerId = worker(sessionId, "publisher").id;
    const services = app().services as Record<string, unknown>;
    const real = services["artifacts"];
    let published = false;
    services["artifacts"] = {
      list: (id: string) => (id === workerId && published ? [{ id: "art-1", path: "report.md" }] : []),
      waitForPublication: async (id: string) => {
        if (id !== workerId) throw new ManagedCopilotError("not_found", "This session has not completed a turn yet.");
        await sleep(200);
        published = true;
        return { turnId: "t1", state: "published", artifacts: [] };
      },
    };
    try {
      const waiting = call(client, sessionId, "wait_for_workers", { workers: ["publisher"] });
      await sleep(100);
      runtime.emitEvent(workerId, "assistant.message", { messageId: "m1", content: "wrote the report" });
      runtime.emitEvent(workerId, "session.idle", {});
      const report = await waiting;
      expect(report).toContain("Published outputs: outputs/report.md");
      expect(report).toContain("wrote the report");
    } finally {
      services["artifacts"] = real;
    }
  });

  it("reads and copies worker files through the sandbox file API", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "builder", task: "build" });
    await call(client, sessionId, "start_worker", { name: "checker", task: "check" });
    await waitUntil(() => workers(sessionId).every((info) => info.state === "idle"));
    const builder = worker(sessionId, "builder").id;
    const checker = worker(sessionId, "checker").id;
    sandboxes.workspace(builder).set("outputs/report.md", Buffer.from("# Report\n42 files\n"));
    sandboxes.workspace(builder).set("src/main.py", Buffer.from("print('hi')\n"));
    sandboxes.workspace(builder).set("bin/tool", Buffer.from([0x7f, 0x45, 0x00, 0x01]));

    const read = await call(client, sessionId, "read_worker_file", { worker: "builder", path: "/workspace/outputs/report.md" });
    expect(read).toContain('<worker_file worker="builder" path="outputs/report.md">\n# Report\n42 files\n\n</worker_file>');
    expect(await call(client, sessionId, "read_worker_file", { worker: "builder", path: "bin/tool" })).toContain("is a binary file");
    expect(await call(client, sessionId, "read_worker_file", { worker: "builder", path: "src" })).toContain("- src/main.py (12 bytes)");
    expect(await call(client, sessionId, "read_worker_file", { worker: "builder", path: "../etc/passwd" })).toContain("must stay inside");

    const copied = await call(client, sessionId, "copy_worker_files", { from: "builder", to: "checker", paths: ["src", "outputs/report.md"], destination: "review" });
    expect(copied).toContain('Copied 2 files');
    expect(sandboxes.workspace(checker).get("review/src/main.py")?.toString()).toBe("print('hi')\n");
    expect(sandboxes.workspace(checker).get("review/outputs/report.md")?.toString()).toBe("# Report\n42 files\n");
    expect(await call(client, sessionId, "copy_worker_files", { from: "builder", to: "builder", paths: ["src"] })).toContain("must be different workers");
  });

  it("never copies into a session that reused a worker's ID, and releases downloads when a copy fails", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "source", task: "build" });
    await call(client, sessionId, "start_worker", { name: "target", task: "check" });
    await waitUntil(() => workers(sessionId).every((info) => info.state === "idle"));
    const source = worker(sessionId, "source").id;
    const target = worker(sessionId, "target").id;
    sandboxes.workspace(source).set("outputs/report.md", Buffer.from("# Report\n"));

    // A copy that fails partway closes what it was reading.
    sandboxes.failNextWrite = new ManagedCopilotError("internal", "The sandbox workspace is out of space.");
    expect(await call(client, sessionId, "copy_worker_files", { from: "source", to: "target", paths: ["outputs/report.md"] })).toContain("out of space");
    expect(sandboxes.downloads.at(-1)?.destroyed).toBe(true);
    expect(await call(client, sessionId, "copy_worker_files", { from: "source", to: "target", paths: ["missing"] })).toContain("does not exist");

    // The target is deleted, and another account's session takes its ID, while a copy is under way.
    const held = sandboxes.holdNextList();
    const copying = call(client, sessionId, "copy_worker_files", { from: "source", to: "target", paths: ["outputs"] });
    await held.held;
    await sessions().delete(1001, target);
    await sessions().create(BOB_PRINCIPAL, { sessionId: target, environment: "coder" });
    held.release();
    expect(await copying).toMatch(/no longer has the sandbox this call was for/);
    expect(sandboxes.workspace(target).size).toBe(0);
    expect(worker(sessionId, "target").state).toBe("stopped");
    expect(sandboxes.downloads.at(-1)?.destroyed).toBe(true);
  });

  it("stops and deletes the workers of a deleted coordinator", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "orphan", task: "stall" });
    await runStarted(sessionId, "orphan");
    const workerId = worker(sessionId, "orphan").id;
    const owned = app().service("orchestrator").listFor(ALICE_PRINCIPAL, sessionId);
    await sessions().delete(1001, sessionId);
    await waitUntil(() => sessions().get(workerId) === undefined);
    expect(sandboxes.ops(workerId)).toContain("delete");
    expect(events.some((event) => event.type === "worker.stopped" && (event.data as { workerId?: string }).workerId === workerId)).toBe(true);
    expect(owned).toHaveLength(1);
  });
});
