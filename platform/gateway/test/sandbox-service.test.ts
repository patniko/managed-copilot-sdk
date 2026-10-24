import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isManagedCopilotError, NETWORK_DISABLED, type SandboxSetupRecord } from "@managed-copilot/protocol";
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
  async ready(): Promise<void> {}
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
  let service: SandboxService;

  beforeEach(() => {
    store = new SandboxStore(openDatabase(":memory:"));
    provider = new FakeProvider();
    services = {};
    const app = { services, config: { deployment: { environments: {} }, githubApiUrl: "https://api.github.test" } } as unknown as GatewayApp;
    service = new SandboxService({ app, store, provider, log: createLogger("test", "error"), defaultIdleSeconds: 1, prepareOnStart: false });
  });

  afterEach(async () => {
    await service.shutdown();
    vi.useRealTimers();
  });

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
      setup: SUCCEEDED,
    });
    provider.existing.add(row.id);
    if (options.running) provider.running.add(row.id);
    return row;
  }

  it("never sweeps a sandbox that was created while reconciliation ran", async () => {
    sandbox("running", { running: true });
    let created: SandboxRow | undefined;
    provider.onInventory = () => {
      created = sandbox("running", { running: true });
    };
    await service.reconcile();
    expect(created).toBeDefined();
    expect(provider.removed).not.toContain(created!.id);
    provider.existing.add("sbx_ffffffffffffffffffffffff");
    provider.onInventory = undefined;
    await service.reconcile();
    expect(provider.removed).toEqual(["sbx_ffffffffffffffffffffffff"]);
  });

  it("finishes a stop that a gateway restart interrupted", async () => {
    const row = sandbox("stopping", { running: true });
    await service.reconcile();
    expect(provider.stopped).toContain(row.id);
    expect(store.bySession(row.sessionId)?.state).toBe("stopped");
  });

  it("keeps sandboxes with open durable actions running through idle sweeps", async () => {
    vi.useFakeTimers();
    const waiting = sandbox("running", { running: true });
    const idle = sandbox("running", { running: true });
    services["actions"] = { list: (sessionId: string) => (sessionId === waiting.sessionId ? [{ id: "act_1" }] : []) };
    await service.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(provider.stopped).toEqual([idle.id]);
    expect(store.bySession(waiting.sessionId)?.state).toBe("running");
  });

  it("protects a recovered sandbox while the ledger says its turn is still running", async () => {
    vi.useFakeTimers();
    const row = sandbox("running", { running: true });
    services["sessions"] = { get: () => ({ id: row.sessionId, ownerId: 1, lastTurn: { turnId: "m1", status: "running" } }), subscribe: () => () => undefined };
    await service.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(provider.stopped).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(provider.stopped).toEqual([row.id]);
  });

  it("refuses an empty runtime state import before touching the sandbox", async () => {
    const row = sandbox("running", { running: true });
    const empty = mkdtempSync(join(tmpdir(), "mc-import-empty-"));
    try {
      await expect(service.importRuntimeState(row.sessionId, { sessionStateDir: empty })).rejects.toSatisfy(
        (error: unknown) => isManagedCopilotError(error, "invalid_request") && /no files to import/.test((error as Error).message),
      );
      await expect(service.importRuntimeState(row.sessionId, { sessionStateDir: join(empty, "missing") })).rejects.toSatisfy((error: unknown) => isManagedCopilotError(error, "invalid_request"));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    const stopped = sandbox("stopped");
    await expect(service.importRuntimeState(stopped.sessionId, { sessionStateDir: tmpdir() })).rejects.toSatisfy((error: unknown) => isManagedCopilotError(error, "capability_unavailable"));
  });
});
