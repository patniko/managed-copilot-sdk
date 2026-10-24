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

/** The sandboxd routes these tests need: health, a start stream that reports ready at once, and the outputs manifest. */
async function fakeSandboxd(options: { manifest?: (res: ServerResponse) => void | Promise<void> } = {}): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/v1/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sandboxId: "fake", version: "test", state: "ready", runtime: { state: "running", restarts: 0 } }));
      } else if (req.method === "POST" && req.url === "/v1/start") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end(`${JSON.stringify({ type: "ready", setup: SUCCEEDED, runtimePort: 7790 })}\n`);
      } else if (req.method === "POST" && req.url === "/v1/outputs/manifest") {
        if (options.manifest) return void options.manifest(res);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ files: [], rejected: [] }));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "not_found", message: `No route for ${req.method} ${req.url}` } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
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

  describe("publications interrupted by deletion or shutdown", () => {
    let server: Server | undefined;
    let dataDir: string;

    beforeEach(() => {
      dataDir = mkdtempSync(join(tmpdir(), "mc-sbx-pub-"));
    });

    afterEach(async () => {
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
        get: (id: string) => (id === sessionId ? { id, ownerId: 1, state: state() } : undefined),
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
