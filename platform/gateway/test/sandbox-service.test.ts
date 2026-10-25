import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { isManagedCopilotError, ManagedCopilotError, NETWORK_DISABLED, type SandboxSetupRecord } from "@managed-copilot/protocol";
import type { GatewayApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createLogger, type Logger } from "../src/log.js";
import { ArtifactService } from "../src/modules/sandbox/artifacts.js";
import type { SandboxRuntime } from "../src/modules/sandbox/contract.js";
import type { SandboxProvider, SandboxSpec, SandboxStartResult } from "../src/modules/sandbox/providers/types.js";
import { SandboxService } from "../src/modules/sandbox/service.js";
import { SandboxStore, type SandboxRow } from "../src/modules/sandbox/store.js";

/** An in-memory backend: lifecycle decisions are tested without Docker. */
class FakeProvider implements SandboxProvider {
  readonly kind = "fake";
  readonly capabilities = { warm: false, addressPinning: false };
  readonly existing = new Set<string>();
  readonly running = new Set<string>();
  readonly stopped: string[] = [];
  readonly removed: string[] = [];
  onInventory: (() => void) | undefined;
  reachable = true;
  /** Where every sandbox's sandboxd answers (see `fakeSandboxd`); nothing listens on the default. */
  sandboxdUrl = "http://127.0.0.1:9";
  /** When set, `isRunning` waits for it (to hold a session's operation queue). */
  gate: Promise<void> | undefined;
  onStop: ((sandboxId: string) => void) | undefined;
  async ready(): Promise<void> {
    if (!this.reachable) throw new ManagedCopilotError("capability_unavailable", "The fake backend is down.");
  }
  async ensureImage() {
    return { ref: "fake:latest", id: "sha256:fake" };
  }
  async hasImage(): Promise<boolean> {
    return true;
  }
  async create(spec: SandboxSpec): Promise<void> {
    this.existing.add(spec.sandboxId);
    this.running.add(spec.sandboxId);
  }
  async start(sandboxId: string): Promise<SandboxStartResult> {
    if (!this.existing.has(sandboxId)) return "gone";
    this.running.add(sandboxId);
    return "started";
  }
  async stop(sandboxId: string): Promise<void> {
    this.onStop?.(sandboxId);
    this.running.delete(sandboxId);
    this.stopped.push(sandboxId);
  }
  async remove(sandboxId: string): Promise<void> {
    this.running.delete(sandboxId);
    this.existing.delete(sandboxId);
    this.removed.push(sandboxId);
  }
  async isRunning(sandboxId: string): Promise<boolean> {
    if (this.gate) await this.gate;
    return this.running.has(sandboxId);
  }
  async address(): Promise<string | undefined> {
    return undefined;
  }
  async endpoint() {
    return { url: this.sandboxdUrl, headers: {} };
  }
  async inventory(): Promise<Set<string>> {
    this.onInventory?.();
    return new Set(this.existing);
  }
}

const SUCCEEDED: SandboxSetupRecord = { state: "succeeded", steps: [], resolved: {}, files: [] };
let counter = 0;

/** A fake sandboxd's runtime process: its instance changes when it is restarted (`restartStatus` 404 = an older sandboxd). */
interface FakeRuntime {
  instance: string;
  restarts: number;
  restartStatus?: number;
}

/**
 * The sandboxd routes these tests need: health, a start stream that reports ready at once, and the outputs manifest;
 * with `runtime`, also runtime restarts and runtime WebSockets (`sockets`).
 */
async function fakeSandboxd(options: { manifest?: (res: ServerResponse) => void | Promise<void>; runtime?: FakeRuntime } = {}): Promise<{ server: Server; url: string; sockets?: WebSocketServer }> {
  const runtime = options.runtime;
  const status = () => ({ sandboxId: "fake", version: "test", state: "ready", runtime: { state: "running", restarts: runtime?.restarts ?? 0, ...(runtime ? { instance: runtime.instance } : {}) } });
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/v1/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(status()));
      } else if (req.method === "POST" && req.url === "/v1/start") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end(`${JSON.stringify({ type: "ready", setup: SUCCEEDED, runtimePort: 7790 })}\n`);
      } else if (req.method === "POST" && req.url === "/v1/outputs/manifest") {
        if (options.manifest) return void options.manifest(res);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ files: [], rejected: [] }));
      } else if (req.method === "POST" && req.url === "/v1/runtime/restart" && runtime && runtime.restartStatus === undefined) {
        runtime.restarts++;
        runtime.instance = `instance-${runtime.restarts}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(status()));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "not_found", message: `No route for ${req.method} ${req.url}` } }));
      }
    });
  });
  let sockets: WebSocketServer | undefined;
  if (runtime) {
    const accepting = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => accepting.handleUpgrade(req, socket, head, () => undefined));
    sockets = accepting;
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ...(sockets ? { sockets } : {}) };
}

/** A logger that records what was written at each level. */
function recordingLogger(): { log: Logger; lines: { level: string; message: string }[] } {
  const lines: { level: string; message: string }[] = [];
  const at = (level: string) => (message: string) => void lines.push({ level, message });
  const log: Logger = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), child: () => log };
  return { log, lines };
}

type RuntimeEventListener = (sessionId: string, event: { id: string; type: string; agentId?: string; data?: unknown }) => void;

describe("SandboxService lifecycle", () => {
  let store: SandboxStore;
  let provider: FakeProvider;
  let services: Record<string, unknown>;
  let service: SandboxService | undefined;

  beforeEach(() => {
    store = new SandboxStore(openDatabase(":memory:"));
    provider = new FakeProvider();
    services = {};
    service = undefined;
  });

  afterEach(async () => {
    await service?.shutdown();
    vi.useRealTimers();
  });

  /** Built after the test's rows exist, as at gateway start. */
  function createService(): SandboxService {
    const app = { services, config: { deployment: { environments: {} }, githubApiUrl: "https://api.github.test" } } as unknown as GatewayApp;
    service = new SandboxService({ app, store, provider, log: createLogger("test", "error"), defaultIdleSeconds: 1, prepareOnStart: false });
    return service;
  }

  function sandbox(state: SandboxRow["state"], options: { running?: boolean } = {}): SandboxRow {
    counter++;
    const row = store.insert({
      id: `sbx_${counter.toString(16).padStart(24, "0")}`,
      sessionId: `00000000-0000-0000-0000-${counter.toString().padStart(12, "0")}`,
      ownerId: 1,
      environment: "coder",
      size: "small",
      network: NETWORK_DISABLED,
      vaults: [],
      state,
      key: "key",
      runtimeToken: "token",
      placeholder: "mcrt_placeholder",
      workloadEnv: {},
      idleTimeoutSeconds: 1,
    });
    // Setup records are written by updates during creation, never by the insert.
    store.update(row.sessionId, { setup: SUCCEEDED });
    provider.existing.add(row.id);
    if (options.running) provider.running.add(row.id);
    return store.bySession(row.sessionId)!;
  }

  it("never sweeps a sandbox that was created while reconciliation ran", async () => {
    sandbox("running", { running: true });
    let created: SandboxRow | undefined;
    provider.onInventory = () => {
      created = sandbox("running", { running: true });
    };
    const sandboxes = createService();
    await sandboxes.reconcile();
    expect(created).toBeDefined();
    expect(provider.removed).not.toContain(created!.id);
    provider.existing.add("sbx_ffffffffffffffffffffffff");
    provider.onInventory = undefined;
    await sandboxes.reconcile();
    expect(provider.removed).toEqual(["sbx_ffffffffffffffffffffffff"]);
  });

  it("shows operators sandboxes and the backend without keys, tokens, placeholders, or variables", async () => {
    const running = sandbox("running", { running: true });
    store.update(running.sessionId, { image: "managed-copilot-sandbox:abc", imageId: "sha256:abc" });
    sandbox("stopped");
    const sandboxes = createService();
    await sandboxes.probe();
    const status = await sandboxes.operatorStatus();
    expect(status).toMatchObject({ provider: "fake", available: true, checkedAt: expect.any(String), defaultIdleSeconds: 1, facts: [], counts: { running: 1, stopped: 1 } });
    const listed = sandboxes.operatorSandboxes();
    expect(listed).toHaveLength(2);
    expect(sandboxes.operatorSandboxes({ state: "running" })).toEqual([
      expect.objectContaining({ id: running.id, sessionId: running.sessionId, ownerId: 1, environment: "coder", state: "running", image: "managed-copilot-sandbox:abc", setup: SUCCEEDED }),
    ]);
    const text = JSON.stringify(listed);
    for (const secret of ["mcrt_placeholder", '"key"', '"token"', "workloadEnv", "runtimeToken"]) expect(text, secret).not.toContain(secret);
    provider.reachable = false;
    expect(await sandboxes.probe()).toBe(false);
    expect(await sandboxes.operatorStatus()).toMatchObject({ available: false, lastError: "The fake backend is down." });
  });

  it("stops an idle sandbox for an operator, and refuses while it works", async () => {
    const row = sandbox("running", { running: true });
    let busy = true;
    services["actions"] = { hasOpenActions: () => busy };
    const sandboxes = createService();
    await expect(sandboxes.operatorStop(row.sessionId, "operator @alice")).rejects.toMatchObject({ code: "session_busy" });
    expect(provider.stopped).toEqual([]);
    busy = false;
    expect(await sandboxes.operatorStop(row.sessionId, "operator @alice")).toEqual({ sandboxId: row.id, stopped: true });
    expect(provider.stopped).toEqual([row.id]);
    await expect(sandboxes.operatorStop(row.sessionId, "operator @alice")).rejects.toMatchObject({ code: "conflict" });
    await expect(sandboxes.operatorStop("00000000-0000-0000-0000-999999999999", "operator @alice")).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses an operator's stop while core uses the session's runtime, or right after it did", async () => {
    vi.useFakeTimers();
    const row = sandbox("running", { running: true });
    let activity: { busy?: string; lastRequestAt?: number } | undefined = { busy: "a call to its runtime is in progress", lastRequestAt: Date.now() };
    services["sessions"] = { get: () => ({ id: row.sessionId, ownerId: 1 }), subscribe: () => () => undefined, runtimeActivity: () => activity };
    const sandboxes = createService();
    await expect(sandboxes.operatorStop(row.sessionId, "operator @alice")).rejects.toMatchObject({ code: "session_busy", message: expect.stringContaining("a call to its runtime is in progress") });
    // The call was answered a moment ago: the turn it started may not have reported itself yet.
    activity = { lastRequestAt: Date.now() };
    await expect(sandboxes.operatorStop(row.sessionId, "operator @alice")).rejects.toMatchObject({ code: "session_busy", message: expect.stringContaining("moments ago") });
    expect(provider.stopped).toEqual([]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await sandboxes.operatorStop(row.sessionId, "operator @alice")).toEqual({ sandboxId: row.id, stopped: true });
    expect(provider.stopped).toEqual([row.id]);
  });

  it("shows operators what setup ran and how it ended, never what it printed", async () => {
    const row = sandbox("running", { running: true });
    const failed: SandboxSetupRecord = {
      state: "failed",
      steps: [{ kind: "command", name: "curl https://u:PASSWORD-IN-COMMAND@files.example.com/data", state: "failed", exitCode: 1, output: "PRIVATE-FILE-CONTENT" }],
      resolved: {},
      files: [{ path: "data.csv", size: 12, sha256: "abc" }],
      error: "Setup command 1 failed with exit code 1.",
    };
    store.update(row.sessionId, { state: "failed", setup: failed, errorCode: "setup_failed", error: "Setup command 1 failed with exit code 1.\nLast output:\nPRIVATE-FILE-CONTENT" });
    const [view] = createService().operatorSandboxes({ sessionId: row.sessionId });
    const text = JSON.stringify(view);
    for (const secret of ["PRIVATE-FILE-CONTENT", "PASSWORD-IN-COMMAND"]) expect(text, secret).not.toContain(secret);
    expect(view!.setup).toMatchObject({ state: "failed", steps: [{ kind: "command", state: "failed", exitCode: 1, name: "curl https://***@files.example.com/data" }], files: [{ path: "data.csv" }] });
    expect(view!.error).toEqual({ code: "setup_failed", message: "Setup command 1 failed with exit code 1.\n(Command output is not shown to operators.)" });
  });

  it("finishes a stop that a gateway restart interrupted", async () => {
    const row = sandbox("stopping", { running: true });
    await createService().reconcile();
    expect(provider.stopped).toContain(row.id);
    expect(store.bySession(row.sessionId)?.state).toBe("stopped");
  });

  it("keeps sandboxes with open durable actions running through idle sweeps", async () => {
    vi.useFakeTimers();
    const waiting = sandbox("running", { running: true });
    const idle = sandbox("running", { running: true });
    services["actions"] = { list: (sessionId: string) => (sessionId === waiting.sessionId ? [{ id: "act_1" }] : []) };
    await createService().start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(provider.stopped).toEqual([idle.id]);
    expect(store.bySession(waiting.sessionId)?.state).toBe("running");
  });

  it("protects a recovered sandbox while the ledger says its turn is still running", async () => {
    vi.useFakeTimers();
    const row = sandbox("running", { running: true });
    services["sessions"] = { get: () => ({ id: row.sessionId, ownerId: 1, lastTurn: { turnId: "m1", status: "running" } }), subscribe: () => () => undefined };
    await createService().start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(provider.stopped).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(provider.stopped).toEqual([row.id]);
  });

  it("keeps that protection through the turn's other events until the turn ends", async () => {
    vi.useFakeTimers();
    const row = sandbox("running", { running: true });
    let emit: ((sessionId: string, event: { id: string; type: string; agentId?: string; data?: unknown }) => void) | undefined;
    services["sessions"] = {
      get: () => ({ id: row.sessionId, ownerId: 1, lastTurn: { turnId: "m1", status: "running" } }),
      subscribe: (listener: typeof emit) => {
        emit = listener;
        return () => undefined;
      },
    };
    await createService().start();
    emit!(row.sessionId, { id: "e1", type: "tool.execution_start", data: { toolCallId: "t1" } });
    emit!(row.sessionId, { id: "e2", type: "assistant.message", agentId: "sub-1", data: {} });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(provider.stopped).toEqual([]);
    emit!(row.sessionId, { id: "e3", type: "session.idle", data: {} });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(provider.stopped).toEqual([row.id]);
  });

  it("reports availability only while the backend answers, and keeps it current", async () => {
    vi.useFakeTimers();
    provider.reachable = false;
    const sandboxes = createService();
    expect(sandboxes.available).toBe(false);
    expect(await sandboxes.probe()).toBe(false);
    await sandboxes.start();
    // A backend that comes up later is noticed by the periodic check, without anyone attempting a create.
    provider.reachable = true;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(sandboxes.available).toBe(true);
    // A failing readiness check before an operation withdraws it immediately.
    const row = sandbox("stopped");
    provider.reachable = false;
    await expect(sandboxes.ensureRunning(row.sessionId)).rejects.toSatisfy((error: unknown) => isManagedCopilotError(error, "capability_unavailable"));
    expect(sandboxes.available).toBe(false);
  });

  it("never lets a stale delete remove a newer sandbox that reuses the session ID", async () => {
    const { server, url } = await fakeSandboxd();
    provider.sandboxdUrl = url;
    try {
      const candidate = sandbox("running", { running: true });
      const sandboxes = createService();
      // Queued in this order under the session lock: someone else's delete of the candidate, a new session reusing the
      // ID, then promotion's release of the candidate it saw in get() before queuing.
      const first = sandboxes.delete(candidate.sessionId);
      const recreated = sandboxes.create({ sessionId: candidate.sessionId, ownerId: 1, environment: "inline-isolated-small", size: "small", network: NETWORK_DISABLED, vaults: [] });
      const stale = sandboxes.delete(candidate.sessionId, { sandboxId: candidate.id });
      await first;
      const handle = await recreated;
      await stale;
      expect(handle.sandboxId).not.toBe(candidate.id);
      expect(store.bySession(candidate.sessionId)).toMatchObject({ id: handle.sandboxId, state: "running" });
      expect(provider.removed).not.toContain(handle.sandboxId);
      expect(provider.existing.has(handle.sandboxId)).toBe(true);
      // Naming the current sandbox deletes it.
      await sandboxes.delete(candidate.sessionId, { sandboxId: handle.sandboxId });
      expect(store.bySession(candidate.sessionId)?.state).toBe("deleted");
      expect(provider.removed).toContain(handle.sandboxId);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("leaves artifacts alone for a delete that names a sandbox the session no longer has", async () => {
    const sandboxes = createService();
    const deletedArtifacts: string[] = [];
    sandboxes.attachArtifacts({ deleteSession: async (sessionId: string) => void deletedArtifacts.push(sessionId), drain: async () => true } as unknown as ArtifactService);
    const sessionId = "aaaaaaaa-0000-0000-0000-000000000001";
    await sandboxes.delete(sessionId, { sandboxId: "sbx_000000000000000000000abc" });
    expect(deletedArtifacts).toEqual([]);
    // Without an expected sandbox, a session without a sandbox still has its artifacts removed (unchanged behavior).
    await sandboxes.delete(sessionId);
    expect(deletedArtifacts).toEqual([sessionId]);
  });

  it("finishes an interrupted delete at startup", async () => {
    const row = sandbox("deleting");
    await createService().reconcile();
    expect(provider.removed).toContain(row.id);
    expect(store.bySession(row.sessionId)?.state).toBe("deleted");
  });

  it("tells core's authenticator about an owner token the Copilot API rejected for the sandbox's session", async () => {
    const { server, url } = await fakeSandboxd();
    const runtimes = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => runtimes.handleUpgrade(req, socket, head, () => undefined));
    const capi = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", capi);
    let runtime: SandboxRuntime | undefined;
    try {
      provider.sandboxdUrl = url;
      const invalidated: string[] = [];
      services["auth"] = { authenticate: async () => Promise.reject(new Error("not used")), invalidate: (token: string) => void invalidated.push(token) };
      const row = sandbox("running", { running: true });
      runtime = await createService().openRuntime(row.sessionId, { resolveToken: async () => "gho_rejected_by_the_copilot_api" });
      await runtime.initialize(async () => ({ success: true }));
      await runtime.handlers.get("llmInference.httpRequestStart")!({
        requestId: "r1",
        sessionId: row.sessionId,
        method: "POST",
        transport: "http",
        url: "https://api.githubcopilot.com/v1/messages",
        headers: { authorization: [`Bearer ${row.placeholder}`] },
      });
      await runtime.handlers.get("llmInference.httpRequestChunk")!({ requestId: "r1", data: "{}", end: true });
      await vi.waitFor(() => expect(invalidated).toEqual(["gho_rejected_by_the_copilot_api"]));
      expect(capi).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      runtime?.close();
      for (const client of runtimes.clients) client.terminate();
      runtimes.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe("turns and publications across deletion, shutdown, and runtime replacement", () => {
    let server: Server | undefined;
    let sockets: WebSocketServer | undefined;
    let dataDir: string;

    beforeEach(() => {
      dataDir = mkdtempSync(join(tmpdir(), "mc-sbx-pub-"));
    });

    afterEach(async () => {
      for (const client of sockets?.clients ?? []) client.terminate();
      sockets?.close();
      sockets = undefined;
      server?.closeAllConnections();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
      rmSync(dataDir, { recursive: true, force: true });
    });

    /** Wires an artifact service to the sandbox service the way the module does. */
    function withArtifacts(sandboxes: SandboxService, log: Logger): ArtifactService {
      const artifacts = new ArtifactService({
        db: store.db,
        dataDir,
        log,
        agentFor: (sessionId) => sandboxes.agentFor(sessionId),
        track: (sessionId, work) => sandboxes.track(sessionId, work),
        ownerOf: () => 1,
        sessionGone: (sessionId) => sandboxes.isGone(sessionId),
        settled: (sessionId) => sandboxes.settled(sessionId, 500),
        stopping: () => sandboxes.stoppingCompute,
        events: () => undefined,
      });
      sandboxes.attachArtifacts(artifacts);
      return artifacts;
    }

    /** A sessions service whose state the test controls; returns a function that emits runtime events. */
    function sessionsWith(sessionId: string, state: () => string): () => RuntimeEventListener {
      let listener: RuntimeEventListener | undefined;
      services["sessions"] = {
        get: (id: string) => (id === sessionId ? { id, ownerId: 1, state: state(), incarnation: "inc-1" } : undefined),
        subscribe: (next: RuntimeEventListener) => {
          listener = next;
          return () => undefined;
        },
      };
      return () => listener!;
    }

    function completeTurn(emit: RuntimeEventListener, sessionId: string, turnId: string): void {
      emit(sessionId, { id: `${turnId}-start`, type: "user.message", data: { messageId: turnId } });
      emit(sessionId, { id: `${turnId}-idle`, type: "session.idle", data: {} });
    }

    it("knows a session is gone from its sandbox, a queued delete of that sandbox, or core's session state", async () => {
      ({ server } = await fakeSandboxd());
      provider.sandboxdUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const row = sandbox("running", { running: true });
      let coreState = "running";
      sessionsWith(row.sessionId, () => coreState);
      const sandboxes = createService();
      expect(sandboxes.isGone(row.sessionId)).toBe(false);
      coreState = "deleting";
      expect(sandboxes.isGone(row.sessionId)).toBe(true);
      coreState = "running";

      // Hold the session's operation queue, then queue a stale delete (of another sandbox) and a real one behind it.
      let release!: () => void;
      provider.gate = new Promise((resolve) => (release = resolve));
      const holding = sandboxes.ensureRunning(row.sessionId);
      const stale = sandboxes.delete(row.sessionId, { sandboxId: "sbx_000000000000000000000fff" });
      expect(sandboxes.isGone(row.sessionId)).toBe(false);
      const real = sandboxes.delete(row.sessionId);
      expect(sandboxes.isGone(row.sessionId)).toBe(true);
      const settledState = sandboxes.settled(row.sessionId).then(() => store.bySession(row.sessionId)?.state);
      release();
      provider.gate = undefined;
      await Promise.all([holding, stale, real]);
      expect(await settledState).toBe("deleted");
      expect(sandboxes.isGone(row.sessionId)).toBe(true);
    });

    it("records a publication that fails after core started deleting the session as deleted, before any sandbox delete is queued", async () => {
      let coreState = "running";
      ({ server } = await fakeSandboxd({
        manifest: (res) => {
          // Core marks the session deleting before it closes the runtime or asks for the sandbox's deletion; the
          // sandbox's in-flight work can fail in that window.
          coreState = "deleting";
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "unavailable", message: "The sandbox connection failed." } }));
        },
      }));
      provider.sandboxdUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const row = sandbox("running", { running: true });
      const emitter = sessionsWith(row.sessionId, () => coreState);
      const sandboxes = createService();
      const { log, lines } = recordingLogger();
      const artifacts = withArtifacts(sandboxes, log);
      await sandboxes.start();
      completeTurn(emitter(), row.sessionId, "m1");
      expect(await artifacts.drain(5_000)).toBe(true);
      expect(lines.filter((line) => line.level === "warn")).toEqual([]);
      expect(lines).toContainEqual({ level: "info", message: "Skipped publishing outputs of a session that is being deleted" });
      await expect(artifacts.waitForPublication(row.sessionId, { turnId: "m1" })).rejects.toSatisfy(
        (error: unknown) => isManagedCopilotError(error, "publication_failed") && /deleted before its outputs were published/.test((error as Error).message),
      );
    });

    it("lets a publication under way finish before gateway shutdown stops compute", async () => {
      const order: string[] = [];
      ({ server } = await fakeSandboxd({
        manifest: async (res) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          order.push("outputs read");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ files: [], rejected: [] }));
        },
      }));
      provider.sandboxdUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      provider.onStop = () => void order.push("compute stopped");
      const row = sandbox("running", { running: true });
      const emitter = sessionsWith(row.sessionId, () => "running");
      const sandboxes = createService();
      const { log, lines } = recordingLogger();
      const artifacts = withArtifacts(sandboxes, log);
      await sandboxes.start();
      completeTurn(emitter(), row.sessionId, "m1");
      await sandboxes.shutdown();
      expect(order).toEqual(["outputs read", "compute stopped"]);
      expect((await artifacts.waitForPublication(row.sessionId, { turnId: "m1" })).state).toBe("published");
      expect(lines.filter((line) => line.level === "warn")).toEqual([]);
    });

    /** Starts gateway shutdown while the turn's manifest is being read, then answers the manifest with `answer`. */
    async function failDuringShutdownDrain(answer: (res: ServerResponse) => void): Promise<{ failure: Error | undefined; lines: { level: string; message: string }[]; order: string[] }> {
      const order: string[] = [];
      let sandboxes!: SandboxService;
      let shuttingDown: Promise<void> | undefined;
      ({ server } = await fakeSandboxd({
        manifest: (res) => {
          shuttingDown = sandboxes.shutdown();
          order.push("outputs read");
          answer(res);
        },
      }));
      provider.sandboxdUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      provider.onStop = () => void order.push("compute stopped");
      const row = sandbox("running", { running: true });
      const emitter = sessionsWith(row.sessionId, () => "running");
      sandboxes = createService();
      const { log, lines } = recordingLogger();
      const artifacts = withArtifacts(sandboxes, log);
      await sandboxes.start();
      completeTurn(emitter(), row.sessionId, "m1");
      await vi.waitFor(() => expect(shuttingDown).toBeDefined(), { timeout: 5_000 });
      await shuttingDown;
      const failure = await artifacts.waitForPublication(row.sessionId, { turnId: "m1" }).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      return { failure, lines, order };
    }

    it("keeps a publication's own failure during the shutdown drain, while compute is still up", async () => {
      const { failure, lines, order } = await failDuringShutdownDrain((res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ files: [], rejected: [{ path: "link", reason: "symbolic links are not published" }] }));
      });
      expect(failure?.message).toMatch(/outputs\/link \(symbolic links are not published\)/);
      expect(lines).toContainEqual({ level: "warn", message: "Publication failed" });
      expect(order).toEqual(["outputs read", "compute stopped"]);
    });

    it("reports a sandbox failure during the shutdown drain as such, since shutdown has not touched compute yet", async () => {
      const { failure, lines } = await failDuringShutdownDrain((res) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "unavailable", message: "The sandbox connection failed." } }));
      });
      expect(failure?.message).toBe("The sandbox connection failed.");
      expect(lines).toContainEqual({ level: "warn", message: "Publication failed" });
      expect(lines.some((line) => /gateway is stopping/.test(line.message))).toBe(false);
    });

    /** core's upstream as stock runtime 1.0.103 answers a second `llmInference.setProvider` (the first holder never releases it). */
    const providerHeld = async (method: string): Promise<unknown> => {
      if (method === "llmInference.setProvider") throw new Error("Request llmInference.setProvider failed with message: Another client is already the LLM inference provider.");
      return { success: true };
    };
    const provided = async (): Promise<unknown> => ({ success: true });

    /** A running sandbox whose fake sandboxd has a runtime process, wired to artifacts and a sessions service. */
    async function withRuntime(runtime: FakeRuntime) {
      const fake = await fakeSandboxd({ runtime });
      server = fake.server;
      sockets = fake.sockets;
      provider.sandboxdUrl = fake.url;
      const row = sandbox("running", { running: true });
      const emitter = sessionsWith(row.sessionId, () => "running");
      const sandboxes = createService();
      const { log, lines } = recordingLogger();
      const artifacts = withArtifacts(sandboxes, log);
      await sandboxes.start();
      return {
        row,
        artifacts,
        lines,
        emit: (event: { id: string; type: string; data?: unknown }) => emitter()(row.sessionId, event),
        open: () => sandboxes.openRuntime(row.sessionId, { resolveToken: async () => "gho_test_token" }),
        turnState: (turnId: string) => (store.db.prepare("SELECT state FROM sandbox_turns WHERE session_id = ? AND turn_id = ?").get(row.sessionId, turnId) as { state: string } | undefined)?.state,
      };
    }

    it("restarts a runtime still held by a connection that is gone, ends the turn it was running, and asks the caller to reopen", async () => {
      const runtime: FakeRuntime = { instance: "instance-0", restarts: 0 };
      const { row, artifacts, lines, emit, open } = await withRuntime(runtime);
      const first = await open();
      await first.initialize(provided);
      emit({ id: "m1-start", type: "user.message", data: { messageId: "m1" } });
      // The gateway's link drops mid-turn; the runtime keeps its provider registration with the dead connection.
      first.close();
      const second = await open();
      const refused = await second.initialize(providerHeld).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(isManagedCopilotError(refused, "capability_unavailable"), String(refused)).toBe(true);
      expect((refused as ManagedCopilotError).details).toEqual({ sandboxId: row.id, reopen: true });
      expect(runtime.restarts).toBe(1);
      await expect(artifacts.waitForPublication(row.sessionId, { turnId: "m1", timeoutMs: 1_000 })).rejects.toThrow(/runtime was restarted while this turn was running/);
      expect(lines.filter((line) => line.level === "warn")).toEqual([]);
      // The reopened connection reaches the new process, which takes it as provider: nothing is replaced again.
      second.close();
      const third = await open();
      await third.initialize(provided);
      expect(runtime.restarts).toBe(1);
      third.close();
    });

    for (const [kind, actions] of [
      // An answer recorded but not yet delivered is no longer listed as open, yet the runtime still waits for it.
      ["durable's hasOpenActions", (scopes: (string | undefined)[]) => ({ hasOpenActions: (_sessionId: string, options?: { readonly incarnation?: string }) => (scopes.push(options?.incarnation), true), list: () => [] })],
      ["a list of open actions", (scopes: (string | undefined)[]) => ({ list: (_sessionId: string, options: { readonly incarnation?: string }) => (scopes.push(options.incarnation), [{ id: "act_1" }]) })],
    ] as const) {
      it(`keeps a turn that waits on durable actions across a runtime restart, since continuePendingWork carries them over (${kind})`, async () => {
        const runtime: FakeRuntime = { instance: "instance-0", restarts: 0 };
        const { row, artifacts, emit, open, turnState } = await withRuntime(runtime);
        const scopes: (string | undefined)[] = [];
        services["actions"] = actions(scopes);
        const first = await open();
        await first.initialize(provided);
        emit({ id: "m1-start", type: "user.message", data: { messageId: "m1" } });
        first.close();
        const second = await open();
        await expect(second.initialize(providerHeld)).rejects.toSatisfy((error: unknown) => (error as ManagedCopilotError).details?.["reopen"] === true);
        expect(runtime.restarts).toBe(1);
        expect(turnState("m1")).toBe("running");
        expect(scopes).toContain("inc-1");
        // Answering the action continues the turn in the new process, and its completion publishes as usual.
        second.close();
        const third = await open();
        await third.initialize(provided);
        emit({ id: "m1-idle", type: "session.idle", data: {} });
        expect((await artifacts.waitForPublication(row.sessionId, { turnId: "m1" })).state).toBe("published");
        third.close();
      });
    }

    it("never restarts a runtime that another connection of this gateway holds", async () => {
      const runtime: FakeRuntime = { instance: "instance-0", restarts: 0 };
      const { open } = await withRuntime(runtime);
      const first = await open();
      await first.initialize(provided);
      const second = await open();
      await expect(second.initialize(providerHeld)).rejects.toSatisfy((error: unknown) => isManagedCopilotError(error, "conflict") && (error as ManagedCopilotError).details?.["reopen"] === undefined);
      expect(runtime.restarts).toBe(0);
      second.close();
      first.close();
    });

    it("restarts a sandbox whose sandboxd cannot restart its runtime, so the reopen reaches a fresh runtime", async () => {
      const runtime: FakeRuntime = { instance: "instance-0", restarts: 0, restartStatus: 404 };
      const { row, artifacts, emit, open } = await withRuntime(runtime);
      const first = await open();
      await first.initialize(provided);
      emit({ id: "m1-start", type: "user.message", data: { messageId: "m1" } });
      first.close();
      const second = await open();
      await expect(second.initialize(providerHeld)).rejects.toSatisfy((error: unknown) => isManagedCopilotError(error, "capability_unavailable") && (error as ManagedCopilotError).details?.["reopen"] === true);
      expect(provider.stopped).toEqual([row.id]);
      expect(provider.running.has(row.id)).toBe(true);
      expect(store.bySession(row.sessionId)?.state).toBe("running");
      await expect(artifacts.waitForPublication(row.sessionId, { turnId: "m1", timeoutMs: 1_000 })).rejects.toThrow(/runtime was restarted while this turn was running/);
      // The reopen only opens the runtime again (core does not resume the sandbox between attempts).
      const third = await open();
      await third.initialize(provided);
      third.close();
    });

    it("ends a turn when the runtime process changed between connections (sandboxd recovered a crashed runtime)", async () => {
      const runtime: FakeRuntime = { instance: "instance-0", restarts: 0 };
      const { row, artifacts, emit, open, turnState } = await withRuntime(runtime);
      const first = await open();
      await first.initialize(provided);
      emit({ id: "m1-start", type: "user.message", data: { messageId: "m1" } });
      first.close();
      // The same process: the turn may still be running there.
      const second = await open();
      expect(turnState("m1")).toBe("running");
      second.close();
      runtime.instance = "instance-recovered";
      const third = await open();
      await third.initialize(provided);
      await expect(artifacts.waitForPublication(row.sessionId, { turnId: "m1", timeoutMs: 1_000 })).rejects.toThrow(/runtime was restarted while this turn was running/);
      expect(runtime.restarts).toBe(0);
      third.close();
    });
  });

  it("refuses an empty runtime state import before touching the sandbox", async () => {
    const row = sandbox("running", { running: true });
    const stopped = sandbox("stopped");
    const sandboxes = createService();
    const empty = mkdtempSync(join(tmpdir(), "mc-import-empty-"));
    try {
      await expect(sandboxes.importRuntimeState(row.sessionId, { sessionStateDir: empty })).rejects.toSatisfy(
        (error: unknown) => isManagedCopilotError(error, "invalid_request") && /no files to import/.test((error as Error).message),
      );
      await expect(sandboxes.importRuntimeState(row.sessionId, { sessionStateDir: join(empty, "missing") })).rejects.toSatisfy((error: unknown) => isManagedCopilotError(error, "invalid_request"));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    await expect(sandboxes.importRuntimeState(stopped.sessionId, { sessionStateDir: tmpdir() })).rejects.toSatisfy((error: unknown) => isManagedCopilotError(error, "capability_unavailable"));
  });
});
