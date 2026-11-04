// Direct and mixed orchestrators (spec section 17, proposal "direct execution"): the coordinator and its sub-agents
// act in workspace-only hands sandboxes through the stock shell and file tools' names and shapes, run by the gateway.
// The fake runtime plays the coordinator; the fake sandboxes run commands through a test hook.
import { createHash } from "node:crypto";
import { ManagedCopilotConfigSchema, type PlatformEvent, type WorkerInfo } from "@managed-copilot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../src/http.js";
import { absolutePath, quote } from "../src/modules/orchestrator/hands.js";
import { FakeRuntime, FakeSandboxes, RawClient, sleep, startGitHubStub, startTestGateway, type TestGateway } from "./harness.js";

const ALICE = "alice-token";
const ALICE_PRINCIPAL: Principal = { accountId: 1001, login: "alice", token: ALICE };
const HANDS = ["bash", "read_bash", "write_bash", "stop_bash", "list_bash", "view", "create", "edit", "glob", "grep"];
const WORKER_TOOLS = ["start_worker", "message_worker", "wait_for_workers", "list_workers", "read_worker_file", "copy_worker_files", "stop_worker"];

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await sleep(10);
  }
}

describe("execution styles: configuration", () => {
  const base = { python: { type: "isolated" }, coder: { type: "isolated" } } as const;
  const parse = (environments: Record<string, unknown>) => ManagedCopilotConfigSchema.safeParse({ environments: { ...base, ...environments } });

  it("accepts direct with one worker environment and mixed with several", () => {
    expect(parse({ operator: { type: "orchestrator", workers: ["python"], execution: "direct", subagents: "own" } }).success).toBe(true);
    expect(parse({ lead: { type: "orchestrator", workers: ["python", "coder"], execution: "mixed" } }).success).toBe(true);
    expect(parse({ team: { type: "orchestrator", workers: ["python", "coder"] } }).success).toBe(true);
  });

  it("rejects direct with more than one environment, and the settings where they don't apply", () => {
    const direct = parse({ operator: { type: "orchestrator", workers: ["python", "coder"], execution: "direct" } });
    expect(direct.success).toBe(false);
    expect(JSON.stringify(direct.error?.issues)).toContain('execution \\"direct\\" takes exactly one worker environment');
    expect(parse({ team: { type: "orchestrator", workers: ["python"], subagents: "own" } }).success).toBe(false);
    expect(parse({ chat: { type: "shared", execution: "direct" } }).success).toBe(false);
    expect(parse({ lead: { type: "orchestrator", workers: ["python"], execution: "sideways" } }).success).toBe(false);
  });

  it("keeps hands paths inside /workspace and quotes shell words", () => {
    expect(absolutePath("/workspace/src/../a.py")).toBe("/workspace/a.py");
    expect(absolutePath("notes.md")).toBe("/workspace/notes.md");
    expect(() => absolutePath("/etc/passwd")).toThrow(/outside \/workspace/);
    expect(() => absolutePath("/workspace/../etc")).toThrow(/outside \/workspace/);
    expect(quote("it's $(rm -rf /)")).toBe("'it'\\''s $(rm -rf /)'");
  });
});

describe("direct and mixed orchestrators", () => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  let gateway: TestGateway;
  let sandboxes: FakeSandboxes;
  const clients: RawClient[] = [];
  const events: PlatformEvent[] = [];

  const app = () => gateway.gateway.app;
  const sessions = () => app().service("sessions");
  const workers = (coordinatorId: string): WorkerInfo[] => app().service("orchestrator").listFor(ALICE_PRINCIPAL, coordinatorId);
  const hands = (coordinatorId: string) => workers(coordinatorId).filter((worker) => worker.role === "hands");
  const connect = async (environment: string) => {
    const client = await RawClient.connect(gateway.url, ALICE, environment);
    clients.push(client);
    return client;
  };
  const coordinator = async (environment = "operator", extra: Record<string, unknown> = {}) => {
    const client = await connect(environment);
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, requestPermission: true, ...extra });
    return { client, sessionId };
  };
  /** One coordinator turn that calls `tool` (as sub-agent `agent` when given) and returns what it told the model. */
  const call = async (client: RawClient, sessionId: string, tool: string, args: Record<string, unknown> = {}, agent?: string) => {
    const reply = await client.request<{ response?: { data?: { content?: string } } }>("session.sendAndWait", {
      sessionId,
      prompt: `${agent ? `agent:${agent} ` : ""}tool:${tool} ${JSON.stringify(args)}`,
    });
    const said = String(reply.response?.data?.content ?? "").replace(/^tool said: /, "");
    try {
      const parsed: unknown = JSON.parse(said);
      if (typeof parsed === "string") return parsed;
    } catch {
      // A plain result.
    }
    return said;
  };
  const createParams = (sessionId: string) => runtime.calls("session.create").find((request) => request.params["sessionId"] === sessionId)!.params;
  const execsOf = (sessionId: string) => sandboxes.log.filter((entry) => entry.sessionId === sessionId && entry.op === "exec").map((entry) => entry.detail ?? {});

  beforeAll(async () => {
    runtime = new FakeRuntime();
    await runtime.start();
    github = await startGitHubStub({ [ALICE]: { id: 1001, login: "alice" } });
    gateway = await startTestGateway({
      runtime,
      githubUrl: github.url,
      deployment: {
        name: "copilot",
        environments: {
          operator: { type: "orchestrator", workers: ["python"], execution: "direct", models: ["claude-haiku-4.5"] },
          crew: { type: "orchestrator", workers: ["python"], execution: "direct", subagents: "own", maxWorkers: 2 },
          lead: { type: "orchestrator", workers: ["python", "coder"], execution: "mixed", maxWorkers: 3 },
          team: { type: "orchestrator", workers: ["python"] },
          python: { type: "isolated", size: "small", description: "Python 3 with pandas", network: { access: "disabled" } },
          coder: { type: "isolated", size: "medium", exec: false },
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

  it("gives a direct coordinator the hands tools, overriding the built-ins, and the stock sub-agent tools", async () => {
    const { sessionId } = await coordinator();
    const params = createParams(sessionId);
    const tools = params["tools"] as { name: string; skipPermission?: boolean; overridesBuiltInTool?: boolean }[];
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(HANDS));
    expect(tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["start_worker"]));
    for (const tool of tools.filter((candidate) => HANDS.includes(candidate.name))) {
      expect(tool.overridesBuiltInTool).toBe(true);
      // Commands, input, and writes ask; reads and stops don't.
      expect(tool.skipPermission).toBe(!["bash", "write_bash", "create", "edit"].includes(tool.name));
    }
    const bash = tools.find((tool) => tool.name === "bash") as unknown as { parameters: { properties: Record<string, unknown>; required: string[] } };
    expect(Object.keys(bash.parameters.properties)).toEqual(["command", "description", "shellId", "mode", "initial_wait"]);
    expect(bash.parameters.required).toEqual(["command", "description"]);
    const available = params["availableTools"] as string[];
    expect(available).toEqual(expect.arrayContaining(["builtin:task", "builtin:read_agent", "builtin:write_agent", "builtin:list_agents", "custom:*"]));
    expect(available).not.toContain("builtin:send_inbox");
    const prompt = JSON.stringify(params["systemMessage"]);
    expect(prompt).toContain("works directly in a Linux sandbox");
    expect(prompt).toContain("Your sandbox: python (Python 3 with pandas) · size small · no network");
    expect(prompt).toContain("use the same tools in the same sandbox and files");
    expect(prompt).not.toContain("start_worker");
  });

  it("describes both options to a mixed coordinator and gives it both tool sets", async () => {
    const { sessionId } = await coordinator("lead");
    const params = createParams(sessionId);
    const names = (params["tools"] as { name: string }[]).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([...HANDS, ...WORKER_TOOLS]));
    const prompt = JSON.stringify(params["systemMessage"]);
    expect(prompt).toContain("two ways, and you decide which to use");
    expect(prompt).toContain("- python (default): Python 3 with pandas");
    expect(prompt).toContain("- coder · size medium");
    expect(prompt).toContain('for your own sandbox');
  });

  it("leaves delegate coordinators unchanged and keeps a client's own bash tool elsewhere", async () => {
    const { sessionId } = await coordinator("team");
    const names = (createParams(sessionId)["tools"] as { name: string }[]).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(WORKER_TOOLS));
    expect(names).not.toContain("bash");
    expect(JSON.stringify(createParams(sessionId)["systemMessage"])).toContain("coordinates workers");

    // In a shared session, a tool the app calls `bash` is the app's, and the app runs it.
    const chat = await connect("chat");
    const chatId = crypto.randomUUID();
    await chat.request("session.create", { sessionId: chatId, tools: [{ name: "bash", description: "The app's own bash" }] });
    chat.answer = () => ({});
    await chat.request("session.send", { sessionId: chatId, prompt: 'tool:bash {"command":"ls"}' });
    const requested = await chat.waitForEvent("external_tool.requested");
    expect((requested["data"] as Record<string, unknown>)["toolName"]).toBe("bash");
    await chat.request("session.tools.handlePendingToolCall", { sessionId: chatId, requestId: (requested["data"] as Record<string, unknown>)["requestId"], result: "app ran it" });
    expect(((await chat.waitForEvent("assistant.message"))["data"] as Record<string, unknown>)["content"]).toBe("tool said: app ran it");
    expect(sandboxes.log.some((entry) => entry.op === "exec" && entry.detail?.["command"] === "ls")).toBe(false);
  });

  it("refuses a client tool that would shadow a hands tool", async () => {
    const client = await connect("operator");
    await expect(client.request("session.create", { sessionId: crypto.randomUUID(), tools: [{ name: "view", description: "mine" }] })).rejects.toThrow(/reserved by the platform/);
  });

  it("runs bash in one lazily created hands sandbox, attributed to the agent that called it", async () => {
    const { client, sessionId } = await coordinator();
    expect(hands(sessionId)).toEqual([]);
    const first = await call(client, sessionId, "bash", { command: "python3 -c 'print(42)'", description: "Print" });
    expect(first).toContain("ran: python3 -c 'print(42)'");
    expect(first).toMatch(/<exited with exit code 0; shellId: ex_/);
    const [sandbox] = hands(sessionId);
    expect(sandbox).toMatchObject({ role: "hands", name: "hands", environment: "python", state: "idle" });
    expect(sandbox).not.toHaveProperty("agentId");
    expect(sandboxes.detail(sandbox!.id, "create")).toMatchObject({ runtime: false, environment: "python" });
    expect(sessions().get(sandbox!.id)).toMatchObject({ kind: "workspace", parentSessionId: sessionId });
    expect(events.filter((event) => event.type === "worker.started" && event.sessionId === sessionId).map((event) => event.data)).toEqual([
      expect.objectContaining({ workerId: sandbox!.id, role: "hands", environment: "python" }),
    ]);

    // Sub-agents share it by default; the command records which agent ran it.
    await call(client, sessionId, "bash", { command: "ls", description: "List" }, "sub-1");
    expect(hands(sessionId)).toHaveLength(1);
    const execs = execsOf(sandbox!.id);
    expect(execs.map((exec) => exec["caller"])).toEqual([{ kind: "platform", name: "bash" }, { kind: "platform", name: "bash", agentId: "sub-1" }]);
    expect(execs[0]).toMatchObject({ stdin: "open", background: false, waitMs: 120_000 });
    expect(typeof execs[0]!["actionId"]).toBe("string");

    // Its outputs are published at the end of each coordinator turn.
    await waitUntil(() => sandboxes.published.some((entry) => entry.sessionId === sandbox!.id));

    // The REST listing marks it, and deleting the coordinator deletes it.
    await sessions().delete(1001, sessionId);
    await waitUntil(() => sandboxes.ops(sandbox!.id).includes("delete"));
  });

  it("runs long commands: initial_wait, async, read_bash, write_bash, stop_bash, and list_bash", async () => {
    const { client, sessionId } = await coordinator();
    sandboxes.execHandler = (_session, command) => (command.startsWith("pytest") || command.startsWith("python3 -i") ? { output: "collecting...\n", running: true } : { output: "", exitCode: 0 });
    const started = await call(client, sessionId, "bash", { command: "pytest -q", description: "Tests", initial_wait: 5000 });
    expect(started).toContain("collecting...");
    const shellId = /shellId: (ex_[\w-]+)/.exec(started)?.[1];
    expect(started).toContain(`<command with shellId: ${shellId} is still running after 1800 seconds.`);
    const [sandbox] = hands(sessionId);
    expect(execsOf(sandbox!.id)[0]).toMatchObject({ waitMs: 1_800_000 });

    sandboxes.feedExec(sandbox!.id, shellId!, "12 passed\n", 0);
    const read = await call(client, sessionId, "read_bash", { shellId, delay: 1 });
    expect(read).toBe(`12 passed\n<exited with exit code 0; shellId: ${shellId}>`);

    const repl = await call(client, sessionId, "bash", { command: "python3 -i", description: "REPL", mode: "async", shellId: "repl" });
    expect(repl).toContain("started in the background with shellId:");
    expect(execsOf(sandbox!.id).at(-1)).toMatchObject({ background: true, waitMs: 0 });
    // The name the model gave works too.
    const typed = await call(client, sessionId, "write_bash", { shellId: "repl", input: "print(6 * 7){enter}", delay: 0 });
    expect(typed).toContain("still running");
    const replId = /shellId: (ex_[\w-]+)/.exec(repl)![1]!;
    expect(sandboxes.execs.get(`${sandbox!.id}:${replId}`)?.input).toBe("print(6 * 7)\n");
    expect(await call(client, sessionId, "write_bash", { shellId: "repl", input: "{ctrl+c}" })).toContain("use stop_bash");
    expect(await call(client, sessionId, "stop_bash", { shellId: "repl" })).toBe(`Stopped command ${replId}.`);

    const listed = await call(client, sessionId, "list_bash");
    expect(listed).toContain(`shellId ${shellId} · exited with exit code 0`);
    expect(listed).toContain(`shellId ${replId} · stopped: Stopped with stop_bash.`);
    expect(await call(client, sessionId, "read_bash", { shellId: "nope", delay: 0 })).toContain("has no command nope");
  });

  it("creates, edits (compare-and-replace), and views files", async () => {
    const { client, sessionId } = await coordinator();
    expect(await call(client, sessionId, "create", { path: "/workspace/src/app.py", file_text: "x = 1\ny = 2\n" })).toBe("Created file /workspace/src/app.py with 12 characters.");
    const [sandbox] = hands(sessionId);
    expect(sandboxes.workspace(sandbox!.id).get("src/app.py")?.toString()).toBe("x = 1\ny = 2\n");
    expect(await call(client, sessionId, "create", { path: "/workspace/src/app.py", file_text: "other" })).toContain("Path already exists");
    // The same call again (a replay) finds its own file.
    expect(await call(client, sessionId, "create", { path: "src/app.py", file_text: "x = 1\ny = 2\n" })).toContain("Created file /workspace/src/app.py");
    expect(await call(client, sessionId, "create", { path: "/etc/evil", file_text: "x" })).toContain("outside /workspace");

    expect(await call(client, sessionId, "edit", { path: "/workspace/src/app.py", old_str: "y = 2", new_str: "y = 3" })).toBe("File /workspace/src/app.py updated with changes.");
    expect(sandboxes.workspace(sandbox!.id).get("src/app.py")?.toString()).toBe("x = 1\ny = 3\n");
    expect(await call(client, sessionId, "edit", { path: "/workspace/src/app.py", old_str: "z", new_str: "w" })).toContain("No match found");
    sandboxes.workspace(sandbox!.id).set("src/dup.py", Buffer.from("a\na\n"));
    expect(await call(client, sessionId, "edit", { path: "/workspace/src/dup.py", old_str: "a", new_str: "b" })).toContain("Multiple matches");

    // A file that changed between the edit's read and its write is not overwritten.
    const read = sandboxes.readFile.bind(sandboxes);
    sandboxes.readFile = async (session, path, options) => {
      const download = await read(session, path, options);
      sandboxes.workspace(session).set(path, Buffer.from("x = 9\ny = 3\n"));
      sandboxes.readFile = read;
      return download;
    };
    expect(await call(client, sessionId, "edit", { path: "/workspace/src/app.py", old_str: "y = 3", new_str: "y = 4" })).toContain("changed while it was being edited");
    expect(sandboxes.workspace(sandbox!.id).get("src/app.py")?.toString()).toBe("x = 9\ny = 3\n");

    // view, glob, and grep run as commands that resolve links inside /workspace only.
    sandboxes.execHandler = (_session, command) => {
      if (command.includes("'/workspace/src/app.py'")) return { output: "__MC_FILE__ 12\n1. x = 9\n2. y = 3\n" };
      if (command.includes("'/workspace/link'")) return { output: "__MC_OUTSIDE__\n" };
      if (command.includes("rg --files")) return { output: "/workspace/src/app.py\n" };
      if (command.includes("--regexp")) return { output: "__MC_NOMATCH__\n" };
      return { output: "__MC_NOTFOUND__\n" };
    };
    expect(await call(client, sessionId, "view", { path: "/workspace/src/app.py" })).toBe("1. x = 9\n2. y = 3");
    expect(await call(client, sessionId, "view", { path: "/workspace/link" })).toContain("leads outside /workspace");
    expect(await call(client, sessionId, "view", { path: "/workspace/missing" })).toContain("Path does not exist");
    expect(await call(client, sessionId, "glob", { pattern: "**/*.py" })).toBe("/workspace/src/app.py");
    expect(await call(client, sessionId, "grep", { pattern: "TODO", output_mode: "content", "-n": true })).toBe("No matches found.");
    const grep = execsOf(sandbox!.id).find((exec) => String(exec["command"]).includes("--regexp"))!;
    expect(grep["command"]).toContain("'--line-number'");
    expect(grep["caller"]).toEqual({ kind: "platform", name: "grep" });
    sandboxes.execHandler = (_session, command) => ({ output: `ran: ${command}\n`, exitCode: 0 });
  });

  it("gives each sub-agent its own sandbox with subagents: \"own\", within maxWorkers, and releases it with its outputs", async () => {
    const { client, sessionId } = await coordinator("crew");
    await call(client, sessionId, "bash", { command: "echo root", description: "Root" });
    await call(client, sessionId, "create", { path: "/workspace/outputs/primes.txt", file_text: "9592\n" }, "agent-a");
    const sandboxesOf = () => hands(sessionId);
    expect(sandboxesOf().map((sandbox) => [sandbox.name, sandbox.agentId ?? null])).toEqual([
      ["hands", null],
      ["hands-agent-a", "agent-a"],
    ]);
    // A third sandbox would pass maxWorkers (2).
    const over = await call(client, sessionId, "bash", { command: "echo b", description: "B" }, "agent-b");
    expect(over).toContain("the most it can have at once");
    expect(sandboxesOf()).toHaveLength(2);

    const [root, own] = sandboxesOf();
    runtime.emitEvent(sessionId, "subagent.completed", { toolCallId: "call_task", agentName: "general-purpose", agentDisplayName: "General" }, "agent-a");
    await waitUntil(() => sandboxes.ops(own!.id).includes("delete"));
    expect(sandboxes.workspace(root!.id).get("outputs/agent-a/primes.txt")?.toString()).toBe("9592\n");
    await waitUntil(() => hands(sessionId).find((sandbox) => sandbox.id === own!.id)?.state === "stopped");

    // Its slot is free again.
    expect(await call(client, sessionId, "bash", { command: "echo b", description: "B" }, "agent-b")).toContain("ran: echo b");

    // A sub-agent whose outputs can't all be copied keeps its sandbox rather than lose them.
    const b = hands(sessionId).find((sandbox) => sandbox.agentId === "agent-b")!;
    for (let index = 0; index < 501; index++) sandboxes.workspace(b.id).set(`outputs/f${index}.txt`, Buffer.from("x"));
    runtime.emitEvent(sessionId, "subagent.completed", { toolCallId: "call_task_b", agentName: "general-purpose", agentDisplayName: "General" }, "agent-b");
    await waitUntil(() => hands(sessionId).find((sandbox) => sandbox.id === b.id)?.error?.includes("more than 500 files") === true);
    expect(hands(sessionId).find((sandbox) => sandbox.id === b.id)?.state).toBe("idle");
    expect(sandboxes.ops(b.id)).not.toContain("delete");
  });

  it("refuses a sub-agent's call without attribution under subagents: \"own\"", async () => {
    const { sessionId } = await coordinator("crew");
    // The runtime reported toolCallId call_lost as sub-agent agent-z's, but the call reached the tool without its agentId.
    runtime.emitEvent(sessionId, "tool.execution_start", { toolCallId: "call_lost", toolName: "bash" }, "agent-z");
    await sleep(20);
    const manager = app().service("orchestrator");
    await expect(manager.hands({ sessionId, ownerId: 1001, environment: "crew", toolCallId: "call_lost", idempotencyKey: `${sessionId}:call_lost` })).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(hands(sessionId)).toEqual([]);
  });

  it("never runs an interrupted command again: its recover hook reattaches to it", async () => {
    const { client, sessionId } = await coordinator();
    const first = await call(client, sessionId, "bash", { command: "make deploy", description: "Deploy" });
    const shellId = /shellId: (ex_[\w-]+)/.exec(first)![1]!;
    const [sandbox] = hands(sessionId);
    const bash = app().service("platformTools").get("bash", "operator")!;
    expect(bash.replay).toBe("never");
    expect(app().service("platformTools").get("write_bash", "operator")?.replay).toBe("never");
    expect(app().service("platformTools").get("bash", "chat")).toBeUndefined();
    // The ledger answers an interrupted call with the same idempotency key through `recover`.
    const exec = execsOf(sandbox!.id)[0]!;
    const recovered = await bash.recover!({ command: "make deploy", description: "Deploy" }, { sessionId, ownerId: 1001, environment: "operator", toolCallId: "t", idempotencyKey: String(exec["actionId"]), actionId: "act_1" });
    expect(recovered).toContain("This is the same command (it was not run again)");
    expect(recovered).toContain(shellId);
    expect(execsOf(sandbox!.id).filter((entry) => entry["command"] === "make deploy")).toHaveLength(2);
    expect([...sandboxes.execs.values()].filter((entry) => entry.info.command === "make deploy")).toHaveLength(1);
    const input = await app().service("platformTools").get("write_bash", "operator")!.recover!({ shellId, input: "y" }, { sessionId, ownerId: 1001, environment: "operator", toolCallId: "t2", idempotencyKey: "k" });
    expect(input).toContain("may or may not have been sent");
    const edit = app().service("platformTools").get("edit", "operator")!;
    expect(edit.replay).toBe("never");
    expect(await edit.recover!({ path: "/workspace/a.py" }, { sessionId, ownerId: 1001, environment: "operator", toolCallId: "t3", idempotencyKey: "k3" })).toContain("may or may not have been applied");

    // The sandbox the command ran in is gone: recovery never starts it in a new one.
    await sessions().delete(1001, sandbox!.id);
    await waitUntil(() => hands(sessionId).find((entry) => entry.id === sandbox!.id)?.state === "stopped");
    const execsBefore = sandboxes.log.filter((entry) => entry.op === "exec").length;
    const gone = await bash.recover!({ command: "make deploy", description: "Deploy" }, { sessionId, ownerId: 1001, environment: "operator", toolCallId: "t", idempotencyKey: String(exec["actionId"]), actionId: "act_1" });
    expect(gone).toMatchObject({ resultType: "failure" });
    expect(JSON.stringify(gone)).toContain("may or may not have run");
    expect(sandboxes.log.filter((entry) => entry.op === "exec").length).toBe(execsBefore);
    expect(hands(sessionId).filter((entry) => entry.state !== "stopped")).toEqual([]);
  });

  it("lets a mixed coordinator use its own sandbox beside workers, and copy between them", async () => {
    const { client, sessionId } = await coordinator("lead");
    console.log("A");
    await call(client, sessionId, "create", { path: "/workspace/data.csv", file_text: "a,b\n1,2\n" });
    console.log("B");
    const listed = await call(client, sessionId, "list_workers");
    console.log("C", listed);
    expect(listed).toContain('Your own sandbox (environment python; "self" in copy_worker_files and read_worker_file):');
    expect(listed).toContain("- hands, ID ");
    expect(await call(client, sessionId, "read_worker_file", { worker: "self", path: "data.csv" })).toContain("a,b\n1,2");
    expect(await call(client, sessionId, "wait_for_workers", {})).toBe("This session has no workers. Start one with start_worker.");
    expect(await call(client, sessionId, "message_worker", { worker: "hands", message: "hi" })).toContain("is your own sandbox, not a worker");
    expect(await call(client, sessionId, "stop_worker", { worker: "hands" })).toContain("is your own sandbox, not a worker");
    expect(await call(client, sessionId, "start_worker", { name: "self", task: "x" })).toContain("names your own sandbox");

    client.answer = () => ({ kind: "approve-once" });
    expect(await call(client, sessionId, "start_worker", { name: "analyst", task: "Summarize data.csv" })).toContain('Started worker "analyst"');
    await waitUntil(() => ["working", "idle"].includes(workers(sessionId).find((worker) => worker.name === "analyst")?.state ?? ""));
    const analyst = workers(sessionId).find((worker) => worker.name === "analyst")!;
    expect(analyst.role).toBe("worker");
    expect(await call(client, sessionId, "copy_worker_files", { from: "self", to: "analyst", paths: ["data.csv"] })).toContain('from "hands" to "analyst"');
    expect(sandboxes.workspace(analyst.id).get("data.csv")?.toString()).toBe("a,b\n1,2\n");
  });
});
