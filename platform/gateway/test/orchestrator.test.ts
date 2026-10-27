// Orchestrator environments (spec section 17): a coordinator on shared placement starts workers in their own
// sandboxes through platform tools; the gateway tracks their turns, approves their prompts within the approval the
// owner gave at start, and cleans them up with the coordinator. The fake runtime plays every runtime involved.
import type { PlatformEvent, WorkerInfo } from "@managed-copilot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../src/http.js";
import { WORKER_INSTRUCTIONS } from "../src/modules/orchestrator/tools.js";
import { FakeRuntime, FakeSandboxes, RawClient, sleep, startGitHubStub, startTestGateway, type TestGateway } from "./harness.js";

const ALICE = "alice-token";
const BOB = "bob-token";
const ALICE_PRINCIPAL: Principal = { accountId: 1001, login: "alice", token: ALICE };

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
    await waitUntil(() => worker(sessionId, "slow").state === "working");
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
    await waitUntil(() => worker(sessionId, "flaky").state === "working");
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

  it("approves a worker's permission prompts once each, and leaves the ones a person must answer", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "shell", task: "stall" });
    await waitUntil(() => worker(sessionId, "shell").state === "working");
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

    // The ledger never lets the platform answer for a person, or answer anything but a permission prompt.
    const caller = { type: "platform", ownerId: 1001, responder: "test" } as const;
    const pending = actions.list(workerId, { open: true }).find((action) => action.requestId === "perm-2")!;
    const claim = await actions.claim(caller, workerId, pending.id);
    await expect(actions.submit(caller, workerId, pending.id, { claimToken: claim.claimToken, result: { kind: "approve-once", approvedInteractively: true } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(actions.submit(caller, workerId, pending.id, { claimToken: claim.claimToken, result: { kind: "approve-once" } })).rejects.toThrow(/requires a person/);
    await actions.submit(caller, workerId, pending.id, { claimToken: claim.claimToken, release: true });
    await expect(actions.claim({ type: "platform", ownerId: 1002, responder: "test" }, workerId, pending.id)).rejects.toMatchObject({ code: "not_found" });
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

  it("stops and deletes the workers of a deleted coordinator", async () => {
    const { client, sessionId } = await coordinator();
    await call(client, sessionId, "start_worker", { name: "orphan", task: "stall" });
    await waitUntil(() => worker(sessionId, "orphan").state === "working");
    const workerId = worker(sessionId, "orphan").id;
    const owned = app().service("orchestrator").listFor(ALICE_PRINCIPAL, sessionId);
    await sessions().delete(1001, sessionId);
    await waitUntil(() => sessions().get(workerId) === undefined);
    expect(sandboxes.ops(workerId)).toContain("delete");
    expect(events.some((event) => event.type === "worker.stopped" && (event.data as { workerId?: string }).workerId === workerId)).toBe(true);
    expect(owned).toHaveLength(1);
  });
});
