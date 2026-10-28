import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Idle sweeps every 100 ms (read when the service module loads).
vi.hoisted(() => {
  process.env.MANAGED_COPILOT_SANDBOX_IDLE_SWEEP_MS = "100";
});
import { ManagedCopilotError, NETWORK_DISABLED, type SandboxExecRecord, type SandboxSetupRecord } from "@managed-copilot/protocol";
import type { GatewayApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createLogger } from "../src/log.js";
import { ArtifactService } from "../src/modules/sandbox/artifacts.js";
import { LOST, UNCONFIRMED } from "../src/modules/sandbox/execs.js";
import type { SandboxProvider, SandboxSpec, SandboxStartResult } from "../src/modules/sandbox/providers/types.js";
import { SandboxService } from "../src/modules/sandbox/service.js";
import { SandboxStore, type SandboxRow } from "../src/modules/sandbox/store.js";

const SUCCEEDED: SandboxSetupRecord = { state: "succeeded", steps: [], resolved: {}, files: [] };

class FakeProvider implements SandboxProvider {
  readonly kind = "fake";
  readonly capabilities = { warm: false, addressPinning: false };
  readonly existing = new Set<string>();
  readonly running = new Set<string>();
  readonly stopped: string[] = [];
  url = "http://127.0.0.1:9";
  async ready(): Promise<void> {}
  async ensureImage() {
    return { ref: "fake:latest", id: "sha256:fake" };
  }
  async hasImage() {
    return true;
  }
  async create(spec: SandboxSpec) {
    this.existing.add(spec.sandboxId);
    this.running.add(spec.sandboxId);
  }
  async start(sandboxId: string): Promise<SandboxStartResult> {
    this.running.add(sandboxId);
    return "started";
  }
  async stop(sandboxId: string) {
    this.running.delete(sandboxId);
    this.stopped.push(sandboxId);
  }
  async remove(sandboxId: string) {
    this.running.delete(sandboxId);
    this.existing.delete(sandboxId);
  }
  async isRunning(sandboxId: string) {
    return this.running.has(sandboxId);
  }
  async address() {
    return undefined;
  }
  async endpoint() {
    return { url: this.url, headers: {} };
  }
  async inventory() {
    return new Set(this.existing);
  }
}

interface FakeExec {
  record: SandboxExecRecord;
  output: string;
  waiters: Set<() => void>;
}

/**
 * A sandboxd whose commands are scripted: `echo <text>` prints and exits 0, `exit <n>` exits n, `run` keeps running
 * (printing what the test `emit`s) until stopped or `finish`ed.
 */
class FakeSandboxd {
  readonly execs = new Map<string, FakeExec>();
  readonly starts: string[] = [];
  readonly stopAll: string[] = [];
  readonly startBodies: Record<string, unknown>[] = [];
  /** Answers the next start by dropping the connection after running it. */
  dropNextStartAnswer = false;
  runtime: "running" | "stopped" = "running";
  server!: Server;
  url = "";

  async listen(): Promise<void> {
    this.server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  emit(id: string, text: string): void {
    const exec = this.execs.get(id)!;
    exec.output += text;
    exec.record = { ...exec.record, outputBytes: Buffer.byteLength(exec.output), lastOutputAt: new Date().toISOString() };
    this.#wake(exec);
  }

  finish(id: string, outcome: Partial<SandboxExecRecord>): void {
    const exec = this.execs.get(id)!;
    exec.record = { ...exec.record, state: "completed", finishedAt: new Date().toISOString(), ...outcome };
    this.#wake(exec);
  }

  #wake(exec: FakeExec): void {
    for (const wake of [...exec.waiters]) wake();
    exec.waiters.clear();
  }

  async #body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const notFound = () => this.#json(res, 404, { error: { code: "not_found", message: "no such command" } });
    if (req.method === "GET" && url.pathname === "/v1/health") {
      return this.#json(res, 200, { sandboxId: "fake", version: "test", state: "ready", runtime: { state: this.runtime, restarts: 0 } });
    }
    if (req.method === "POST" && url.pathname === "/v1/start") {
      this.startBodies.push(await this.#body(req));
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      return void res.end(`${JSON.stringify({ type: "ready", setup: SUCCEEDED, runtimePort: 0 })}\n`);
    }
    if (req.method === "POST" && url.pathname === "/v1/outputs/manifest") return this.#json(res, 200, { files: [], rejected: [] });
    if (req.method === "POST" && url.pathname === "/v1/exec") {
      const body = (await this.#body(req)) as { id: string; command: string; stdin?: "open" | "closed"; timeoutMs?: number };
      let exec = this.execs.get(body.id);
      if (!exec) {
        this.starts.push(body.id);
        exec = { record: { id: body.id, command: body.command, state: "running", stdin: body.stdin ?? "closed", startedAt: new Date().toISOString(), outputBytes: 0 }, output: "", waiters: new Set() };
        this.execs.set(body.id, exec);
        const [verb, ...rest] = body.command.split(" ");
        if (verb === "echo") {
          this.emit(body.id, `${rest.join(" ")}\n`);
          this.finish(body.id, { exitCode: 0 });
        } else if (verb === "exit") this.finish(body.id, { exitCode: Number(rest[0]) });
      }
      if (this.dropNextStartAnswer) {
        this.dropNextStartAnswer = false;
        return void req.socket.destroy();
      }
      return this.#json(res, 200, exec.record);
    }
    if (req.method === "GET" && url.pathname === "/v1/exec") return this.#json(res, 200, [...this.execs.values()].map((exec) => exec.record));
    if (req.method === "POST" && url.pathname === "/v1/exec-stop") {
      const reason = url.searchParams.get("reason") ?? "";
      const stopped: SandboxExecRecord[] = [];
      for (const exec of this.execs.values()) {
        if (exec.record.state !== "running") continue;
        this.stopAll.push(exec.record.id);
        exec.record = { ...exec.record, state: "stopped", reason, finishedAt: new Date().toISOString() };
        this.#wake(exec);
        stopped.push(exec.record);
      }
      return this.#json(res, 200, stopped);
    }
    const match = /^\/v1\/exec\/([^/]+)(?:\/(input|stop))?$/.exec(url.pathname);
    if (!match) return notFound();
    const exec = this.execs.get(decodeURIComponent(match[1]!));
    if (!exec) return notFound();
    if (match[2] === "stop") {
      if (exec.record.state === "running") exec.record = { ...exec.record, state: "stopped", reason: url.searchParams.get("reason") ?? "stopped", finishedAt: new Date().toISOString() };
      this.#wake(exec);
      return this.#json(res, 200, exec.record);
    }
    if (match[2] === "input") {
      const body = (await this.#body(req)) as { data?: string };
      if (body.data) this.emit(exec.record.id, body.data);
      return this.#json(res, 200, exec.record);
    }
    const waitMs = Number(url.searchParams.get("waitMs") ?? 0);
    const outputOnly = url.searchParams.get("output") !== "false";
    let offset = Math.min(Number(url.searchParams.get("offset") ?? 0), exec.record.outputBytes);
    const pending = () => exec.record.state === "running" && (!outputOnly || offset >= exec.record.outputBytes);
    if (pending() && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        exec.waiters.add(() => {
          clearTimeout(timer);
          resolve();
        });
        res.once("close", resolve);
      });
    }
    offset = Math.min(offset, exec.record.outputBytes);
    const output = outputOnly ? Buffer.from(exec.output).subarray(offset).toString("utf8") : "";
    return this.#json(res, 200, { exec: exec.record, output, offset: outputOnly ? exec.record.outputBytes : 0 });
  }
}

describe("SandboxService commands", () => {
  let store: SandboxStore;
  let provider: FakeProvider;
  let sandboxd: FakeSandboxd;
  let services: Record<string, unknown>;
  let service: SandboxService;
  let artifacts: ArtifactService;
  let sessionKind: { kind?: "workspace"; parentSessionId?: string } = {};
  const activity: [string, number][] = [];

  beforeEach(async () => {
    store = new SandboxStore(openDatabase(":memory:"));
    provider = new FakeProvider();
    sandboxd = new FakeSandboxd();
    await sandboxd.listen();
    provider.url = sandboxd.url;
    sessionKind = {};
    activity.length = 0;
    services = {
      sessions: {
        get: (id: string) => ({ id, ownerId: 1, ...sessionKind }),
        subscribe: () => () => undefined,
        execActivity: (id: string, running: number) => void activity.push([id, running]),
      },
    };
    const app = { services, config: { deployment: { environments: { python: { type: "isolated" } } }, githubApiUrl: "https://api.github.test" } } as unknown as GatewayApp;
    service = new SandboxService({ app, store, provider, log: createLogger("test", "error"), defaultIdleSeconds: 1, prepareOnStart: false });
    artifacts = new ArtifactService({
      db: store.db,
      dataDir: ".",
      log: createLogger("test", "error"),
      agentFor: (sessionId) => service.agentFor(sessionId),
      track: (sessionId, work) => service.track(sessionId, work),
      ownerOf: () => 1,
      events: () => undefined,
    });
    service.attachArtifacts(artifacts);
  });

  afterEach(async () => {
    await service.shutdown();
    await sandboxd.close();
  });

  async function create(options: { runtime?: boolean } = {}): Promise<SandboxRow> {
    const sessionId = crypto.randomUUID();
    await service.create({ sessionId, ownerId: 1, environment: "python", size: "small", network: NETWORK_DISABLED, ...(options.runtime === false ? { runtime: false } : {}) });
    return store.bySession(sessionId)!;
  }

  it("starts a workspace-only sandbox without its runtime and refuses to open one", async () => {
    const row = await create({ runtime: false });
    expect(row.runtime).toBe(false);
    expect(sandboxd.startBodies[0]).toMatchObject({ mode: "create", runtime: false });
    sandboxd.runtime = "stopped";
    // Health with no runtime is healthy for it: nothing restarts.
    await service.ensureRunning(row.sessionId);
    expect(provider.stopped).toEqual([]);
    await expect(service.openRuntime(row.sessionId, { resolveToken: async () => "t" })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("runs a command, records its caller, and never runs one ID twice", async () => {
    const row = await create({ runtime: false });
    const result = await service.exec(row.sessionId, "echo hello", { id: "first", caller: { kind: "api", accountId: 1, login: "alice" } });
    expect(result).toMatchObject({ id: "first", state: "completed", exitCode: 0, output: "hello\n", background: false, caller: { kind: "api", login: "alice" } });
    const again = await service.exec(row.sessionId, "echo other", { id: "first" });
    expect(again).toMatchObject({ id: "first", command: "echo hello", output: "hello\n" });
    expect(sandboxd.starts).toEqual(["first"]);
    expect(service.listExecs(row.sessionId).map((exec) => exec.id)).toEqual(["first"]);
    expect((await service.exec(row.sessionId, "exit 7")).exitCode).toBe(7);
  });

  it("derives a stable ID from a durable action, so a replay reattaches", async () => {
    const row = await create();
    const first = await service.exec(row.sessionId, "echo once", { actionId: "tool-call-key-1", caller: { kind: "platform", name: "bash", agentId: "sub-1" } });
    const replay = await service.exec(row.sessionId, "echo once", { actionId: "tool-call-key-1" });
    expect(replay.id).toBe(first.id);
    expect(first.id).toMatch(/^ex_[0-9a-f]{32}$/);
    expect(sandboxd.starts).toEqual([first.id]);
    expect(first.caller).toEqual({ kind: "platform", name: "bash", agentId: "sub-1" });
  });

  it("finds a command whose start answer was lost instead of failing or running it again", async () => {
    const row = await create();
    sandboxd.dropNextStartAnswer = true;
    const result = await service.exec(row.sessionId, "echo survived", { id: "dropped" });
    expect(result).toMatchObject({ state: "completed", output: "survived\n" });
    expect(sandboxd.starts).toEqual(["dropped"]);
  });

  it("reports a never-confirmed start as uncertain and a lost journal entry as uncertain, never rerunning them", async () => {
    const row = await create();
    store.insertExec({ sandboxId: row.id, id: "unconfirmed", sessionId: row.sessionId, ownerId: 1, command: "echo x", background: false, stdin: "closed", state: "starting", startedAt: new Date().toISOString() });
    expect(await service.readExec(row.sessionId, "unconfirmed")).toMatchObject({ state: "uncertain", reason: UNCONFIRMED, output: "" });
    expect(await service.exec(row.sessionId, "echo x", { id: "unconfirmed" })).toMatchObject({ state: "uncertain" });
    store.insertExec({ sandboxId: row.id, id: "forgotten", sessionId: row.sessionId, ownerId: 1, command: "run", background: true, stdin: "open", state: "running", startedAt: new Date().toISOString() });
    expect(await service.readExec(row.sessionId, "forgotten")).toMatchObject({ state: "uncertain", reason: LOST });
    expect(sandboxd.starts).toEqual([]);
  });

  it("runs background commands, reads them from an offset, writes input, and stops them", async () => {
    const row = await create();
    const job = await service.exec(row.sessionId, "run", { id: "job", background: true });
    expect(job).toMatchObject({ state: "running", background: true, output: "", offset: 0 });
    expect(sandboxd.startBodies.length).toBe(1);
    sandboxd.emit("job", "line 1\n");
    const first = await service.readExec(row.sessionId, "job", { offset: 0, waitMs: 1000 });
    expect(first).toMatchObject({ state: "running", output: "line 1\n", offset: 7 });
    await service.writeExec(row.sessionId, "job", { data: "typed\n" });
    expect((await service.readExec(row.sessionId, "job", { offset: first.offset })).output).toBe("typed\n");
    expect(await service.stopExec(row.sessionId, "job", { reason: "Enough." })).toMatchObject({ state: "stopped", reason: "Enough." });
    await expect(service.writeExec(row.sessionId, "job", { data: "late" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("answers a wait that ran out with the output so far, and stops a command whose call was cancelled", async () => {
    const row = await create();
    const started = service.exec(row.sessionId, "run", { id: "slow", waitMs: 300 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    sandboxd.emit("slow", "partial\n");
    expect(await started).toMatchObject({ state: "running", output: "partial\n" });
    const controller = new AbortController();
    const cancelled = service.exec(row.sessionId, "run", { id: "cancel-me", signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    expect(await cancelled).toMatchObject({ state: "stopped", reason: expect.stringContaining("cancelled") });
  });

  it("stops a sandbox's running commands with it", async () => {
    const row = await create({ runtime: false });
    await service.exec(row.sessionId, "run", { id: "chatty", background: true });
    await (service as unknown as { stop(sessionId: string, reason?: string): Promise<void> }).stop(row.sessionId, "requested");
    expect(provider.stopped).toEqual([row.id]);
    expect(sandboxd.stopAll).toEqual(["chatty"]);
    expect(service.listExecs(row.sessionId)[0]).toMatchObject({ state: "stopped", reason: expect.stringContaining("The sandbox stopped") });
  });

  it("holds idle stop while a command writes output, then stops the sandbox and the quiet command", async () => {
    const row = await create({ runtime: false });
    await service.start();
    await service.exec(row.sessionId, "run", { id: "quiet", background: true });
    // The idle timeout is 1 s and sweeps run every 100 ms: steady output keeps it up.
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      sandboxd.emit("quiet", "tick\n");
    }
    expect(provider.stopped).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(provider.stopped).toEqual([row.id]);
    expect(service.listExecs(row.sessionId)[0]).toMatchObject({ state: "stopped", reason: expect.stringContaining("without activity") });
  });

  it("publishes a standalone workspace-only sandbox's outputs after each command and reports its busy count", async () => {
    sessionKind = { kind: "workspace" };
    const row = await create({ runtime: false });
    const result = await service.exec(row.sessionId, "echo done", { id: "pub" });
    const publication = await artifacts.waitForPublication(row.sessionId, { turnId: result.id, timeoutMs: 5000 });
    expect(publication).toMatchObject({ turnId: "pub", state: "published", artifacts: [] });
    expect(activity.filter(([id]) => id === row.sessionId).map(([, running]) => running)).toEqual([1, 0]);
  });

  it("publishes nothing for a worker's or an orchestrator's hands sandbox by itself", async () => {
    sessionKind = { kind: "workspace", parentSessionId: "coordinator" };
    const row = await create({ runtime: false });
    await service.exec(row.sessionId, "echo done", { id: "quiet-pub" });
    await expect(artifacts.waitForPublication(row.sessionId, { turnId: "quiet-pub", timeoutMs: 100 })).rejects.toBeInstanceOf(ManagedCopilotError);
    await service.publishOutputs(row.sessionId, "turn-1");
    expect(await artifacts.waitForPublication(row.sessionId, { turnId: "turn-1", timeoutMs: 5000 })).toMatchObject({ state: "published" });
  });

  it("recovers after a gateway restart: follows running commands and settles those of stopped sandboxes", async () => {
    const running = await create();
    await service.exec(running.sessionId, "run", { id: "survivor", background: true });
    const stopped = await create();
    store.insertExec({ sandboxId: stopped.id, id: "cut", sessionId: stopped.sessionId, ownerId: 1, command: "run", background: true, stdin: "open", state: "running", startedAt: new Date().toISOString() });
    store.update(stopped.sessionId, { state: "stopped" });
    provider.running.delete(stopped.id);
    await service.shutdown();
    // The shutdown stopped running sandboxes and their commands; a new gateway finds them so.
    expect(store.exec(running.id, "survivor")).toMatchObject({ state: "stopped" });
    const app = { services, config: { deployment: { environments: {} }, githubApiUrl: "https://api.github.test" } } as unknown as GatewayApp;
    service = new SandboxService({ app, store, provider, log: createLogger("test", "error"), defaultIdleSeconds: 1, prepareOnStart: false });
    await service.reconcile();
    expect(store.exec(stopped.id, "cut")).toMatchObject({ state: "stopped" });
  });

  it("forgets a deleted session's commands", async () => {
    const row = await create();
    await service.exec(row.sessionId, "echo bye", { id: "gone" });
    await service.delete(row.sessionId);
    expect(store.execs(row.id)).toEqual([]);
    await expect(service.readExec(row.sessionId, "gone")).rejects.toMatchObject({ code: "not_found" });
  });
});
