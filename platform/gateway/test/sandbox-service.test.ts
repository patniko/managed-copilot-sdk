import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isManagedCopilotError, ManagedCopilotError, NETWORK_DISABLED, type SandboxSetupRecord } from "@managed-copilot/protocol";
import type { GatewayApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createLogger } from "../src/log.js";
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
    this.running.delete(sandboxId);
    this.stopped.push(sandboxId);
  }
  async remove(sandboxId: string): Promise<void> {
    this.running.delete(sandboxId);
    this.existing.delete(sandboxId);
    this.removed.push(sandboxId);
  }
  async isRunning(sandboxId: string): Promise<boolean> {
    return this.running.has(sandboxId);
  }
  async address(): Promise<string | undefined> {
    return undefined;
  }
  async endpoint() {
    return { url: "http://127.0.0.1:9", headers: {} };
  }
  async inventory(): Promise<Set<string>> {
    this.onInventory?.();
    return new Set(this.existing);
  }
}

const SUCCEEDED: SandboxSetupRecord = { state: "succeeded", steps: [], resolved: {}, files: [] };
let counter = 0;

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
