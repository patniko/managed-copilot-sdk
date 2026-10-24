// Unit tests for the promotion state machine with fault injection: every port (core's placement cutover, sandboxes,
// network policy, durable actions, events) is a fake that records what promotion asked of it and can fail on demand.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isManagedCopilotError, ManagedCopilotError, type NetworkPolicy, type PendingAction, type PlatformEvent } from "@managed-copilot/protocol";
import { GatewayApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import type { Principal } from "../src/http.js";
import { createLogger } from "../src/log.js";
import type { PlacementCutover, SessionRecord } from "../src/modules/core/contracts.js";
import { PromotionManager, SANDBOX_READY_TEXT } from "../src/modules/promotion/service.js";
import { PromotionStore } from "../src/modules/promotion/store.js";

const OWNER: Principal = { accountId: 101, login: "octo", token: "owner-token-0123456789abcdef" };
const SESSION = "5f0c6b8e-3d1a-4f7e-9c2b-1a2b3c4d5e6f";
const DEPLOYMENT = {
  name: "copilot",
  environments: {
    chat: { type: "shared" },
    coder: { type: "isolated", size: "medium", network: ["pypi.org"], models: ["claude-sonnet-5", "claude-haiku-4.5"] },
    helper: { type: "promotable", promoteTo: "coder", network: false },
  },
};
const DISABLED: NetworkPolicy = { access: "disabled", allowedDomains: [] };
const CREATED_AT = new Date(Date.now() - 3_600_000).toISOString();

type Step = string;

interface Behavior {
  processing?: (fenced: boolean) => boolean;
  sourcePending?: () => Record<string, unknown>[];
  destinationPending?: () => Record<string, unknown>[];
  openFails?: ManagedCopilotError;
  sourceFails?: (method: string) => Error | undefined;
  commitFails?: ManagedCopilotError;
  /** The commit moves the ledger, then reports this error (as if a later commit step failed). */
  commitFailsAfterMove?: ManagedCopilotError;
}

class FakeCutover implements PlacementCutover {
  readonly steps: Step[];
  record: SessionRecord;
  readonly sourceStateDir: string | undefined;
  #fenced = false;
  readonly #behavior: Behavior;
  readonly #sessions: FakeSessions;

  constructor(sessions: FakeSessions, record: SessionRecord, sourceStateDir: string | undefined, behavior: Behavior, steps: Step[]) {
    this.#sessions = sessions;
    this.record = record;
    this.sourceStateDir = sourceStateDir;
    this.#behavior = behavior;
    this.steps = steps;
  }

  async source<T>(method: string): Promise<T> {
    this.steps.push(`source:${method}`);
    const failure = this.#behavior.sourceFails?.(method);
    if (failure) throw failure;
    switch (method) {
      case "session.metadata.isProcessing":
        return { processing: this.#behavior.processing?.(this.#fenced) ?? false } as T;
      case "session.tools.listPendingRequests":
        return { items: this.#behavior.sourcePending?.() ?? [] } as T;
      case "session.permissions.pendingRequests":
        return { items: [] } as T;
      case "session.tasks.list":
        return { tasks: [] } as T;
      case "session.queue.pendingItems":
        return { items: [], steeringMessages: [] } as T;
      default:
        return {} as T;
    }
  }

  fence(): void {
    this.#fenced = true;
    this.steps.push("fence");
  }

  async open(extra?: Record<string, unknown>) {
    this.steps.push(`open:${JSON.stringify(extra ?? {})}`);
    if (this.#behavior.openFails) throw this.#behavior.openFails;
    return {
      request: async <T>(method: string): Promise<T> => {
        this.steps.push(`destination:${method}`);
        return (method === "session.tools.listPendingRequests" ? { items: this.#behavior.destinationPending?.() ?? [] } : {}) as T;
      },
    };
  }

  async commit(): Promise<SessionRecord> {
    this.steps.push("commit");
    if (this.#behavior.commitFails) throw this.#behavior.commitFails;
    const committed: SessionRecord = { ...this.record, placement: "sandbox", generation: this.record.generation + 1, state: "idle" };
    this.#sessions.records.set(committed.id, committed);
    if (this.#behavior.commitFailsAfterMove) throw this.#behavior.commitFailsAfterMove;
    return committed;
  }

  async abort(options?: { resume?: Record<string, unknown> }): Promise<void> {
    this.steps.push(`abort:${JSON.stringify(options ?? {})}`);
  }
}

class FakeSessions {
  readonly records = new Map<string, SessionRecord>();
  readonly steps: Step[] = [];
  behavior: Behavior = {};
  stateDir: (id: string) => string | undefined = () => undefined;
  cutovers = 0;

  get(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  getOwned(accountId: number, id: string): SessionRecord {
    const record = this.records.get(id);
    if (!record || record.ownerId !== accountId) throw new ManagedCopilotError("not_found", `Session ${id} was not found`);
    return record;
  }

  async cutover(id: string, options: { generation: number }): Promise<PlacementCutover> {
    this.cutovers++;
    const record = this.records.get(id);
    if (!record) throw new ManagedCopilotError("not_found", `Session ${id} was not found`);
    if (record.generation !== options.generation) throw new ManagedCopilotError("conflict", "generation moved");
    this.steps.push("cutover");
    return new FakeCutover(this, record, this.stateDir(id), this.behavior, this.steps);
  }
}

interface FakeSandbox {
  readonly id: string;
  readonly size: "medium";
  readonly state: "running" | "failed";
  readonly network: NetworkPolicy;
}

function sandbox(id: string, state: FakeSandbox["state"] = "running"): FakeSandbox {
  return { id, size: "medium", state, network: DISABLED };
}

/** Like the sandbox service: one sandbox per session ID, `conflict` while one is live, a `failed` row after a failed create. */
class FakeSandboxes {
  readonly created: Record<string, unknown>[] = [];
  readonly imports: { sessionId: string; sessionStateDir: string; activeTurnId?: string; files: string[] }[] = [];
  readonly deleted: string[] = [];
  readonly registered = new Map<string, FakeSandbox>();
  /** Starts and ends of creates and deletes, in order. */
  readonly log: string[] = [];
  createFails: ManagedCopilotError | undefined;
  importFails: ManagedCopilotError | undefined;
  createDelayMs = 0;
  deleteDelayMs = 0;
  /** The backend's readiness as the sandbox service reports it, and what a fresh probe finds. */
  available: boolean | undefined = undefined;
  probeFinds = false;
  probes = 0;

  async probe() {
    this.probes++;
    this.available = this.probeFinds;
    return this.probeFinds;
  }

  async create(request: Record<string, unknown>) {
    this.created.push(request);
    this.log.push("create:start");
    if (this.createDelayMs) await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
    this.log.push("create:end");
    const sessionId = request["sessionId"] as string;
    if (this.registered.get(sessionId)?.state === "running") throw new ManagedCopilotError("conflict", `Session ${sessionId} already has a sandbox.`);
    if (this.createFails) {
      this.registered.set(sessionId, sandbox(`sbx_failed_${this.created.length}`, "failed"));
      throw this.createFails;
    }
    this.registered.set(sessionId, sandbox("sbx_test"));
    return { sandboxId: "sbx_test", info: sandbox("sbx_test") };
  }

  async importRuntimeState(sessionId: string, input: { sessionStateDir: string; activeTurnId?: string }) {
    if (this.importFails) throw this.importFails;
    const files = ["events.jsonl", "workspace.yaml"].filter((name) => existsSync(join(input.sessionStateDir, name)));
    this.imports.push({ sessionId, ...input, files });
    return { files: files.length, bytes: 1 };
  }

  async delete(sessionId: string) {
    this.log.push("delete:start");
    if (this.deleteDelayMs) await new Promise((resolve) => setTimeout(resolve, this.deleteDelayMs));
    this.log.push("delete:end");
    this.deleted.push(sessionId);
    this.registered.delete(sessionId);
  }

  get(sessionId: string): FakeSandbox | undefined {
    return this.registered.get(sessionId);
  }
}

class FakePolicy {
  readonly calls: string[] = [];
  promoteSession(sessionId: string, target: string): NetworkPolicy {
    this.calls.push(`promote:${sessionId}:${target}`);
    return DISABLED;
  }
  revertPromotion(sessionId: string) {
    this.calls.push(`revert:${sessionId}`);
    return DISABLED;
  }
  commitPromotion(sessionId: string) {
    this.calls.push(`commit:${sessionId}`);
  }
}

class FakeActions {
  open: PendingAction[] = [];
  readonly generations: { sessionId: string; generation: number; options: unknown }[] = [];
  fail = false;
  list(): PendingAction[] {
    return this.open;
  }
  onGenerationChanged(sessionId: string, generation: number, options?: { carried?: readonly string[] }) {
    if (this.fail) throw new Error("durable is down");
    this.generations.push({ sessionId, generation, options });
  }
}

let temp: string;
let app: GatewayApp;
let sessions: FakeSessions;
let sandboxes: FakeSandboxes;
let policy: FakePolicy;
let actions: FakeActions;
let published: PlatformEvent[];
let publishFails: boolean;
/** What the fake events service reports for each publish (`false`: not stored in the event ledger). */
let publishStores: boolean | undefined;
let manager: PromotionManager;
let store: PromotionStore;
let stateDir: string;

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION,
    ownerId: OWNER.accountId,
    owner: { id: OWNER.accountId, login: OWNER.login },
    environment: "helper",
    type: "promotable",
    placement: "shared",
    state: "idle",
    generation: 0,
    model: "claude-sonnet-5",
    network: DISABLED,
    environmentRequest: { name: "helper", files: { "data/input.csv": "YSxiCg==" } },
    lastTurn: { turnId: "turn-1", status: "completed" },
    // Sessions exist before any promotion attempt of theirs (recovery compares the two).
    createdAt: CREATED_AT,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function writeSourceState(): void {
  const workspace = join(temp, "data", "runtime", "shared", "workspaces", SESSION);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "events.jsonl"), `${JSON.stringify({ type: "session.start", data: { context: { cwd: workspace } } })}\n`);
  writeFileSync(join(stateDir, "workspace.yaml"), `id: ${SESSION}\ncwd: ${workspace}\n`);
  writeFileSync(join(stateDir, ".workspace-fork.lock"), "");
}

function stagedLeftovers(): string[] {
  const root = join(temp, "data", "promotion");
  return existsSync(root) ? readdirSync(root) : [];
}

function toolAction(): PendingAction {
  return { id: "act_1", sessionId: SESSION, kind: "tool", state: "executing", requestId: "req-1", tool: "request_sandbox", toolCallId: "call-1", idempotencyKey: `${SESSION}:call-1`, createdAt: new Date().toISOString() };
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "mc-promo-"));
  const dataDir = join(temp, "data");
  stateDir = join(dataDir, "runtime", "shared", "copilot-home", "session-state", SESSION);
  const config = loadConfig({ PORT: "0", MANAGED_COPILOT_DATA_DIR: dataDir, MANAGED_COPILOT_CONFIG: JSON.stringify(DEPLOYMENT), MANAGED_COPILOT_SHARED_RUNTIME: "0", MANAGED_COPILOT_WRITE_DISCOVERY: "0" });
  app = new GatewayApp(config, openDatabase(":memory:"), createLogger("test", "error"));
  sessions = new FakeSessions();
  sessions.stateDir = () => stateDir;
  sessions.records.set(SESSION, record());
  sandboxes = new FakeSandboxes();
  policy = new FakePolicy();
  actions = new FakeActions();
  published = [];
  publishFails = false;
  publishStores = undefined;
  const services = app.services as Record<string, unknown>;
  services["sessions"] = sessions;
  services["sandboxes"] = sandboxes;
  services["policy"] = policy;
  services["actions"] = actions;
  services["events"] = {
    publish: (event: PlatformEvent) => {
      if (publishFails) throw new Error("bus down");
      published.push(event);
      return publishStores;
    },
  };
  services["environments"] = { forSession: () => ({ customizations: { root: join(temp, "pinned", "helper") } }) };
  services["auth"] = { liveCredential: () => ({ token: OWNER.token }) };
  store = new PromotionStore(app.db);
  manager = new PromotionManager({
    app,
    log: createLogger("promotion-test", "error"),
    store,
    platformRoots: [dataDir],
    stagingRoot: join(dataDir, "promotion"),
    drainTimeoutMs: 300,
    drainPollMs: 20,
  });
  writeSourceState();
});

afterEach(() => {
  app.db.close();
  rmSync(temp, { recursive: true, force: true });
});

function expectError(error: unknown, code: string): void {
  expect(isManagedCopilotError(error), String(error)).toBe(true);
  expect((error as ManagedCopilotError).code).toBe(code);
}

describe("API promotion (managed.promote)", () => {
  it("allocates, quiesces, fences, moves the state, opens, and commits, in that order", async () => {
    const result = await manager.promote(OWNER, SESSION);
    expect(result).toEqual({ sessionId: SESSION, placement: "sandbox", sandboxId: "sbx_test", generation: 1 });
    expect(sessions.steps).toEqual([
      "cutover",
      "source:session.metadata.isProcessing",
      "source:session.tasks.list",
      "source:session.metadata.isProcessing",
      "source:session.tasks.list",
      "fence",
      "source:session.metadata.isProcessing",
      "source:session.tasks.list",
      "source:sessions.close",
      "open:{}",
      "commit",
    ]);
    // The sandbox comes from the target's compute with the source's customizations and the narrowed policy.
    expect(sandboxes.created[0]).toMatchObject({
      sessionId: SESSION,
      ownerId: OWNER.accountId,
      environment: "coder",
      size: "medium",
      network: DISABLED,
      additions: { files: { "data/input.csv": "YSxiCg==" } },
      resolved: { config: { type: "isolated", size: "medium" }, customizations: { root: join(temp, "pinned", "helper") } },
    });
    expect(policy.calls).toEqual([`promote:${SESSION}:coder`, `commit:${SESSION}`]);
    // The imported state: lock files skipped, platform paths rewritten; no active turn for an idle session.
    expect(sandboxes.imports).toHaveLength(1);
    expect(sandboxes.imports[0]!.activeTurnId).toBeUndefined();
    expect(sandboxes.imports[0]!.files).toEqual(["events.jsonl", "workspace.yaml"]);
    expect(actions.generations).toEqual([{ sessionId: SESSION, generation: 1, options: {} }]);
    // session.promoted carries top-level sessionId and sandboxId.
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ type: "session.promoted", sessionId: SESSION, sandboxId: "sbx_test", environment: "helper", data: { generation: 1, placement: "sandbox", target: "coder", trigger: "api", network: DISABLED } });
    // The fenced owner's copy of the state is gone, so nothing can reactivate it; staging is cleaned up.
    expect(existsSync(stateDir)).toBe(false);
    expect(stagedLeftovers()).toEqual([]);
    expect(manager.latest(SESSION)).toMatchObject({ state: "committed", fromGeneration: 0, toGeneration: 1, sandboxId: "sbx_test", sourceCleaned: true, trigger: "api" });
  });

  it("joins concurrent calls into one operation and stays idempotent afterwards", async () => {
    sandboxes.createDelayMs = 50;
    const results = await Promise.all([manager.promote(OWNER, SESSION), manager.promote(OWNER, SESSION), manager.promote(OWNER, SESSION)]);
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(sandboxes.created).toHaveLength(1);
    expect(sessions.cutovers).toBe(1);
    const again = await manager.promote(OWNER, SESSION);
    expect(again).toEqual(results[0]);
    expect(sandboxes.created).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it("returns session_busy for a running turn before allocating anything", async () => {
    sessions.records.set(SESSION, record({ state: "running", lastTurn: { turnId: "turn-2", status: "running" } }));
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "session_busy");
    expect(sandboxes.created).toHaveLength(0);
    expect(sessions.cutovers).toBe(0);
  });

  it("returns session_busy when actions are pending", async () => {
    actions.open = [{ ...toolAction(), tool: "lookup_order", state: "pending" }];
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "session_busy");
    expect(sandboxes.created).toHaveLength(0);
    expect(sessions.steps).toContain("abort:{}");
  });

  it("rolls back when a turn slips in before the fence: the source stays the only owner", async () => {
    sessions.behavior.processing = (fenced) => fenced;
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "session_busy");
    expect(sessions.steps.slice(-2)).toEqual(["source:session.metadata.isProcessing", "abort:{}"]);
    expect(sessions.steps).not.toContain("source:sessions.close");
    expect(policy.calls).toEqual([`promote:${SESSION}:coder`, `revert:${SESSION}`]);
    expect(sandboxes.deleted).toEqual([SESSION]);
    expect(existsSync(stateDir)).toBe(true);
    expect(sessions.get(SESSION)).toMatchObject({ placement: "shared", generation: 0 });
    expect(manager.latest(SESSION)).toMatchObject({ state: "failed", errorCode: "session_busy" });
    expect(published).toHaveLength(0);
  });

  it("keeps the source when the sandbox setup fails, and can be retried", async () => {
    sandboxes.createFails = new ManagedCopilotError("setup_failed", "pip install failed");
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "setup_failed");
    expect(sessions.steps).not.toContain("fence");
    expect(policy.calls).toEqual([`promote:${SESSION}:coder`, `revert:${SESSION}`]);
    expect(sandboxes.deleted).toEqual([SESSION]);
    expect(manager.latest(SESSION)).toMatchObject({ state: "failed", errorCode: "setup_failed", error: "pip install failed" });

    sandboxes.createFails = undefined;
    expect(await manager.promote(OWNER, SESSION)).toMatchObject({ placement: "sandbox", generation: 1 });
  });

  it("never deletes the sandbox of a new session that reused the ID while the move failed", async () => {
    const create = sandboxes.create.bind(sandboxes);
    sandboxes.create = async (request) => {
      // The session is deleted, and a new isolated session with the same ID gets its own sandbox meanwhile.
      sessions.records.set(SESSION, record({ environment: "coder", type: "isolated", placement: "sandbox", createdAt: new Date(Date.now() + 60_000).toISOString() }));
      sandboxes.registered.set(SESSION, sandbox("sbx_replacement"));
      return create(request);
    };
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "conflict");
    expect(sandboxes.deleted).toEqual([]);
    expect(sandboxes.registered.get(SESSION)?.id).toBe("sbx_replacement");
    expect(manager.latest(SESSION)).toMatchObject({ state: "failed", cleanupPending: false });
  });

  it("never touches a session that reused the ID while the attempt waited for its turn", async () => {
    // An interrupted attempt's candidate is being released (slowly) when the promotion arrives.
    store.insert({ id: "prm_j", sessionId: SESSION, ownerId: OWNER.accountId, fromGeneration: 0, trigger: "api", target: "coder" });
    store.update("prm_j", { state: "failed", cleanupPending: true, sandboxId: "sbx_leftover" });
    sandboxes.registered.set(SESSION, sandbox("sbx_leftover"));
    sandboxes.deleteDelayMs = 200;
    const recovering = manager.recover();
    const promoting = manager.promote(OWNER, SESSION).catch((error: unknown) => error);
    // The promotion checked the session and waits behind the release; meanwhile the session is deleted and another
    // owner creates an isolated session with the same ID.
    await vi.waitFor(() => expect(sessions.steps).toContain("source:session.tasks.list"), { interval: 5 });
    sessions.records.set(SESSION, record({ ownerId: 202, owner: { id: 202, login: "other" }, environment: "coder", type: "isolated", placement: "sandbox", createdAt: new Date(Date.now() + 60_000).toISOString() }));
    await recovering;
    expectError(await promoting, "not_found");
    // Its policy was not narrowed, nothing was allocated for it, and only the leftover was released.
    expect(policy.calls).toEqual([]);
    expect(sandboxes.created).toHaveLength(0);
    expect(sandboxes.deleted).toEqual([SESSION]);
  });

  it("releases only its own candidate", async () => {
    // By the time the move fails, the sandbox registered under the ID is no longer the one this attempt created.
    sandboxes.importRuntimeState = async () => {
      sandboxes.registered.set(SESSION, sandbox("sbx_someone_else"));
      throw new ManagedCopilotError("capability_unavailable", "sandbox stopped");
    };
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "capability_unavailable");
    expect(sandboxes.deleted).toEqual([]);
    expect(sandboxes.registered.get(SESSION)?.id).toBe("sbx_someone_else");
    expect(manager.latest(SESSION)).toMatchObject({ state: "failed", sandboxId: "sbx_test", cleanupPending: false });
  });

  it("still releases its own candidate when the session was deleted meanwhile", async () => {
    sandboxes.importRuntimeState = async () => {
      sessions.records.delete(SESSION);
      throw new ManagedCopilotError("not_found", "the session was deleted");
    };
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "not_found");
    expect(sandboxes.deleted).toEqual([SESSION]);
    expect(policy.calls).toEqual([`promote:${SESSION}:coder`, `revert:${SESSION}`]);
  });

  it("aborts after the source closed when the destination cannot open, keeping the source state", async () => {
    sessions.behavior.openFails = new ManagedCopilotError("state_restore_failed", "resume failed");
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "state_restore_failed");
    expect(sessions.steps).toContain("source:sessions.close");
    expect(sessions.steps.at(-1)).toBe("abort:{}");
    expect(sandboxes.deleted).toEqual([SESSION]);
    expect(existsSync(join(stateDir, "events.jsonl"))).toBe(true);
    expect(stagedLeftovers()).toEqual([]);
  });

  it("aborts when the generation moved before commit (a stale owner never commits)", async () => {
    sessions.behavior.commitFails = new ManagedCopilotError("conflict", "The session moved to another generation");
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "conflict");
    expect(sessions.steps.slice(-2)).toEqual(["commit", "abort:{}"]);
    expect(sandboxes.deleted).toEqual([SESSION]);
    expect(existsSync(stateDir)).toBe(true);
    expect(actions.generations).toHaveLength(0);
  });

  it("finishes, and never rolls back, when the commit fails after the ledger moved", async () => {
    sessions.behavior.commitFailsAfterMove = new ManagedCopilotError("internal", "a listener failed");
    expect(await manager.promote(OWNER, SESSION)).toMatchObject({ placement: "sandbox", generation: 1 });
    expect(sessions.steps).not.toContain("abort:{}");
    expect(sandboxes.deleted).toHaveLength(0);
    expect(policy.calls).toEqual([`promote:${SESSION}:coder`, `commit:${SESSION}`]);
    expect(manager.latest(SESSION)).toMatchObject({ state: "committed", toGeneration: 1, finalized: true });
    expect(published).toHaveLength(1);
  });

  it("fails without allocating when the import capability or a local source is missing", async () => {
    sessions.stateDir = () => undefined;
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "capability_unavailable");
    expect(sandboxes.created).toHaveLength(0);
  });

  it("refuses while the sandbox backend is down, after probing it once more", async () => {
    sandboxes.available = false;
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "capability_unavailable");
    expect(sandboxes.probes).toBe(1);
    expect(sessions.cutovers).toBe(0);
    expect(manager.latest(SESSION)).toBeUndefined();

    sandboxes.probeFinds = true;
    expect(await manager.promote(OWNER, SESSION)).toMatchObject({ placement: "sandbox", generation: 1 });
    expect(sandboxes.probes).toBe(2);
  });

  it("rejects sessions that are not promotable, other owners, and targets that would change the billing route", async () => {
    sessions.records.set(SESSION, record({ environment: "chat", type: "shared" }));
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "invalid_request");
    sessions.records.set(SESSION, record());
    expectError(await manager.promote({ ...OWNER, accountId: 202, login: "intruder" }, SESSION).catch((error: unknown) => error), "not_found");
    (app.config.deployment.environments["coder"] as { inference?: { foundry: string } }).inference = { foundry: "contoso-foundry" };
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "capability_unavailable");
    expect(sandboxes.created).toHaveLength(0);
  });

  it("keeps the promotable environment's model policy: the target supplies compute only", async () => {
    sessions.records.set(SESSION, record({ model: "gpt-5.4" }));
    expect(await manager.promote(OWNER, SESSION)).toMatchObject({ placement: "sandbox" });
  });

  it("treats a session the runtime does not hold as idle, but fails closed on any other probe failure", async () => {
    sessions.behavior.sourceFails = (method) => (method === "session.metadata.isProcessing" || method === "session.tasks.list" ? new Error(`Request ${method} failed with message: Session not found for sessionId: ${SESSION}`) : undefined);
    expect(await manager.promote(OWNER, SESSION)).toMatchObject({ placement: "sandbox" });

    sessions.records.set(SESSION, record({ id: SESSION, generation: 1, placement: "shared" }));
    sessions.behavior.sourceFails = (method) => (method === "session.tasks.list" ? new Error("upstream timed out") : undefined);
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "session_busy");
  });

  it("never rolls back after commit, even when recording the commit fails", async () => {
    const update = store.update.bind(store);
    store.update = (id, fields) => {
      if (fields.state === "committed") throw new Error("disk full");
      return update(id, fields);
    };
    expect(await manager.promote(OWNER, SESSION)).toMatchObject({ placement: "sandbox", generation: 1 });
    expect(sessions.steps).not.toContain("abort:{}");
    expect(sandboxes.deleted).toHaveLength(0);
    expect(published).toHaveLength(1);
  });

  it("refuses to carry a GitHub token into the sandbox", async () => {
    writeFileSync(join(stateDir, "events.jsonl"), `${JSON.stringify({ type: "user.message", data: { content: `my token is ${OWNER.token}` } })}\n`);
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "policy_violation");
    expect(sandboxes.imports).toHaveLength(0);
    expect(sandboxes.deleted).toEqual([SESSION]);
  });

  it("never undoes a committed move when post-commit steps fail", async () => {
    actions.fail = true;
    publishFails = true;
    expect(await manager.promote(OWNER, SESSION)).toMatchObject({ placement: "sandbox", generation: 1 });
    expect(manager.latest(SESSION)).toMatchObject({ state: "committed" });
    expect(sessions.steps).not.toContain("abort:{}");
    expect(sandboxes.deleted).toHaveLength(0);
  });
});

describe("agent-initiated promotion (request_sandbox)", () => {
  const context = { sessionId: SESSION, ownerId: OWNER.accountId, environment: "helper", toolCallId: "call-1", idempotencyKey: `${SESSION}:call-1` };
  const own = { requestId: "req-1", toolCallId: "call-1", toolName: "request_sandbox" };

  beforeEach(() => {
    sessions.records.set(SESSION, record({ state: "running", lastTurn: { turnId: "turn-7", status: "running" } }));
    actions.open = [toolAction()];
    sessions.behavior.sourcePending = () => [own];
    sessions.behavior.destinationPending = () => [own];
  });

  it("carries the pending call into the sandbox, where it is answered and the turn continues", async () => {
    expect(await manager.fromTool(context)).toBe(SANDBOX_READY_TEXT);
    const suspend = sessions.steps.indexOf("source:session.suspend");
    expect(suspend).toBeGreaterThan(sessions.steps.indexOf("fence"));
    expect(sessions.steps.indexOf("source:sessions.close")).toBeGreaterThan(suspend);
    expect(sessions.steps).toContain('open:{"continuePendingWork":true}');
    expect(sessions.steps.indexOf("destination:session.tools.listPendingRequests")).toBeLessThan(sessions.steps.indexOf("commit"));
    // The turn that started on shared finishes in the sandbox: its outputs publish there.
    expect(sandboxes.imports[0]).toMatchObject({ activeTurnId: "turn-7" });
    // The carried call stays claimed and is delivered into the new generation.
    expect(actions.generations).toEqual([{ sessionId: SESSION, generation: 1, options: { carried: ["req-1"] } }]);
    expect(published[0]).toMatchObject({ sandboxId: "sbx_test", data: { trigger: "tool", toolCallId: "call-1", generation: 1 } });
    expect(manager.latest(SESSION)).toMatchObject({ state: "committed", requestId: "req-1", toolCallId: "call-1" });
  });

  it("waits for unrelated tool calls to drain before moving", async () => {
    let polls = 0;
    sessions.behavior.sourcePending = () => (++polls < 3 ? [own, { requestId: "req-2", toolCallId: "call-2", toolName: "lookup_order" }] : [own]);
    expect(await manager.fromTool(context)).toBe(SANDBOX_READY_TEXT);
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it("returns promotion_busy to the agent when other work does not drain, and keeps the session on shared", async () => {
    sessions.behavior.sourcePending = () => [own, { requestId: "req-2", toolCallId: "call-2", toolName: "lookup_order" }];
    const result = (await manager.fromTool(context)) as { resultType: string; error: string; textResultForLlm: string };
    expect(result.resultType).toBe("failure");
    expect(result.error).toMatch(/^promotion_busy: /);
    expect(result.textResultForLlm).toContain("Continue without one");
    expect(sessions.steps).not.toContain("fence");
    expect(sessions.steps.at(-1)).toBe("abort:{}");
    expect(sandboxes.deleted).toEqual([SESSION]);
  });

  it("resumes the source with continuePendingWork when the move fails after the source closed", async () => {
    sandboxes.importFails = new ManagedCopilotError("capability_unavailable", "sandbox stopped");
    const result = (await manager.fromTool(context)) as { resultType: string; error: string };
    expect(result).toMatchObject({ resultType: "failure", error: "capability_unavailable: sandbox stopped" });
    expect(sessions.steps.at(-1)).toBe('abort:{"resume":{"continuePendingWork":true}}');
    expect(existsSync(join(stateDir, "events.jsonl"))).toBe(true);
    expect(actions.generations).toHaveLength(0);
  });

  it("resumes with continuePendingWork when the source suspended but closing it failed", async () => {
    sessions.behavior.sourceFails = (method) => (method === "sessions.close" ? new Error("connection reset") : undefined);
    const result = (await manager.fromTool(context)) as { resultType: string };
    expect(result.resultType).toBe("failure");
    expect(sessions.steps).toContain("source:session.suspend");
    expect(sessions.steps.at(-1)).toBe('abort:{"resume":{"continuePendingWork":true}}');
  });

  it("answers a second request_sandbox call at once instead of making it wait for the first", async () => {
    sandboxes.createDelayMs = 60;
    const first = manager.fromTool(context);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = (await manager.fromTool({ ...context, toolCallId: "call-2", idempotencyKey: `${SESSION}:call-2` })) as { error: string };
    expect(second.error).toMatch(/^promotion_busy: /);
    expect(await first).toBe(SANDBOX_READY_TEXT);
  });

  it("fails closed when a quiescence probe fails", async () => {
    sessions.behavior.sourceFails = (method) => (method === "session.tasks.list" ? new Error("upstream timed out") : undefined);
    const result = (await manager.fromTool(context)) as { error: string };
    expect(result.error).toMatch(/^promotion_busy: /);
    expect(sandboxes.created).toHaveLength(0);
    expect(sessions.steps).not.toContain("source:session.suspend");
  });

  it("does not commit when the destination did not carry the pending call", async () => {
    sessions.behavior.destinationPending = () => [];
    const result = (await manager.fromTool(context)) as { error: string };
    expect(result.error).toMatch(/^state_restore_failed: /);
    expect(sessions.steps).not.toContain("commit");
    expect(sessions.steps.at(-1)).toBe('abort:{"resume":{"continuePendingWork":true}}');
  });

  it("stops when the turn that asked ended, and refuses subagents, without allocating anything", async () => {
    sessions.behavior.sourcePending = () => [];
    expect(((await manager.fromTool(context)) as { error: string }).error).toMatch(/^conflict: /);
    sessions.behavior.sourcePending = () => [{ ...own, agentId: "sub-1" }];
    expect(((await manager.fromTool(context)) as { error: string }).error).toMatch(/^invalid_request: /);
    expect(sessions.steps).not.toContain("fence");
    expect(sandboxes.created).toHaveLength(0);
    expect(policy.calls).toHaveLength(0);
  });

  it("answers a retried call (after a gateway restart) without moving again", async () => {
    expect(await manager.fromTool(context)).toBe(SANDBOX_READY_TEXT);
    expect(await manager.fromTool(context)).toBe(SANDBOX_READY_TEXT);
    expect(sandboxes.created).toHaveLength(1);
    // The retry makes sure the carried call is at the new generation before durable delivers the answer.
    expect(actions.generations).toEqual([
      { sessionId: SESSION, generation: 1, options: { carried: ["req-1"] } },
      { sessionId: SESSION, generation: 1, options: { carried: ["req-1"] } },
    ]);
  });

  it("lets an API caller join the agent's promotion", async () => {
    sandboxes.createDelayMs = 50;
    const [tool, api] = await Promise.all([manager.fromTool(context), manager.promote(OWNER, SESSION)]);
    expect(tool).toBe(SANDBOX_READY_TEXT);
    expect(api).toMatchObject({ placement: "sandbox", generation: 1 });
    expect(sandboxes.created).toHaveLength(1);
  });
});

describe("recovery after a restart", () => {
  it("finishes attempts whose commit reached the ledger and releases the others", async () => {
    const created = new Date(Date.now() + 1000).toISOString();
    const committedId = store.insert({ id: "prm_a", sessionId: SESSION, ownerId: OWNER.accountId, fromGeneration: 0, trigger: "tool", toolCallId: "call-1", target: "coder" }).id;
    store.update(committedId, { state: "opening", sandboxId: "sbx_test", sourceStateDir: stateDir, requestId: "req-1" });
    sessions.records.set(SESSION, record({ placement: "sandbox", generation: 1 }));

    const other = "7a7a7a7a-1111-4222-8333-944444444444";
    sessions.records.set(other, record({ id: other }));
    store.insert({ id: "prm_b", sessionId: other, ownerId: OWNER.accountId, fromGeneration: 0, trigger: "tool", toolCallId: "call-9", target: "coder" });
    store.update("prm_b", { state: "transferring", sandboxId: "sbx_other" });
    sandboxes.registered.set(other, sandbox("sbx_other"));

    // Synchronous part (while modules register): the carried call moves before durable replays anything.
    manager.reconcile();
    expect(actions.generations).toEqual([{ sessionId: SESSION, generation: 1, options: { carried: ["req-1"] } }]);
    expect([...policy.calls].sort()).toEqual([`commit:${SESSION}`, `revert:${other}`].sort());
    expect(store.get("prm_b")).toMatchObject({ state: "failed", cleanupPending: true });
    expect(sandboxes.deleted).toEqual([]);

    // Asynchronous part (at start): event, cleanup, candidate release.
    await manager.recover();
    expect(store.get("prm_a")).toMatchObject({ state: "committed", toGeneration: 1, sourceCleaned: true, eventPublished: true, finalized: true });
    expect(existsSync(stateDir)).toBe(false);
    expect(published).toEqual([expect.objectContaining({ id: "evt_promoted_prm_a", type: "session.promoted", sessionId: SESSION, sandboxId: "sbx_test" })]);
    expect(store.get("prm_b")).toMatchObject({ state: "failed", cleanupPending: false });
    expect(sandboxes.deleted).toEqual([other]);
    void created;
  });

  it("never deletes the state of a session that reused a promoted session's ID", async () => {
    store.insert({ id: "prm_c", sessionId: SESSION, ownerId: OWNER.accountId, fromGeneration: 0, trigger: "api", target: "coder" });
    store.update("prm_c", { state: "committed", toGeneration: 1, sandboxId: "sbx_old", sourceStateDir: stateDir, eventPublished: true, committedAt: new Date().toISOString() });
    // The promoted session was deleted; a new shared session now uses the same ID.
    sessions.records.set(SESSION, record({ createdAt: new Date(Date.now() + 60_000).toISOString() }));
    await manager.recover();
    expect(existsSync(join(stateDir, "events.jsonl"))).toBe(true);
    expect(store.get("prm_c")).toMatchObject({ finalized: true });
  });

  it("removes a deleted promoted session's leftover state", async () => {
    store.insert({ id: "prm_d", sessionId: SESSION, ownerId: OWNER.accountId, fromGeneration: 0, trigger: "api", target: "coder" });
    store.update("prm_d", { state: "committed", toGeneration: 1, sandboxId: "sbx_old", sourceStateDir: stateDir, committedAt: new Date().toISOString() });
    sessions.records.delete(SESSION);
    await manager.recover();
    expect(existsSync(stateDir)).toBe(false);
    expect(store.get("prm_d")).toMatchObject({ finalized: true, eventPublished: false });
    expect(published).toHaveLength(0);
  });

  it("moves a committed attempt's carried call during registration even if its commit was recorded before the restart", () => {
    store.insert({ id: "prm_e", sessionId: SESSION, ownerId: OWNER.accountId, fromGeneration: 0, trigger: "tool", toolCallId: "call-1", target: "coder" });
    store.update("prm_e", { state: "committed", toGeneration: 1, requestId: "req-1", sourceStateDir: stateDir, committedAt: new Date().toISOString() });
    sessions.records.set(SESSION, record({ placement: "sandbox", generation: 1 }));
    manager.reconcile();
    expect(actions.generations).toEqual([{ sessionId: SESSION, generation: 1, options: { carried: ["req-1"] } }]);
  });

  it("lets a new attempt release an interrupted attempt's candidate first, and recovery leaves it to that attempt", async () => {
    store.insert({ id: "prm_f", sessionId: SESSION, ownerId: OWNER.accountId, fromGeneration: 0, trigger: "api", target: "coder" });
    store.update("prm_f", { state: "failed", cleanupPending: true, sandboxId: "sbx_old" });
    sandboxes.registered.set(SESSION, sandbox("sbx_old"));
    const created: string[] = [];
    const create = sandboxes.create.bind(sandboxes);
    sandboxes.create = async (request) => {
      created.push(`create after ${sandboxes.deleted.length} deletes`);
      return create(request);
    };
    expect(await manager.promote(OWNER, SESSION)).toMatchObject({ placement: "sandbox" });
    expect(created).toEqual(["create after 1 deletes"]);
    expect(store.get("prm_f")).toMatchObject({ cleanupPending: false });
    // Recovery does not touch the newer attempt's sandbox.
    store.update("prm_f", { cleanupPending: true });
    await manager.recover();
    expect(sandboxes.deleted).toEqual([SESSION]);
  });

  it("finishes releasing an interrupted attempt's candidate before a new attempt allocates", async () => {
    store.insert({ id: "prm_g", sessionId: SESSION, ownerId: OWNER.accountId, fromGeneration: 0, trigger: "api", target: "coder" });
    store.update("prm_g", { state: "failed", cleanupPending: true });
    // Interrupted while creating: no candidate ID was recorded, and the session is still this shared incarnation.
    sandboxes.registered.set(SESSION, sandbox("sbx_leftover"));
    sandboxes.deleteDelayMs = 50;
    const recovering = manager.recover();
    expect(await manager.promote(OWNER, SESSION)).toMatchObject({ placement: "sandbox", generation: 1 });
    await recovering;
    expect(sandboxes.log).toEqual(["delete:start", "delete:end", "create:start", "create:end"]);
    expect(store.get("prm_g")).toMatchObject({ cleanupPending: false });
  });

  it("never releases a newer attempt's candidate from a list read before that attempt allocated", async () => {
    store.insert({ id: "prm_h", sessionId: SESSION, ownerId: OWNER.accountId, fromGeneration: 0, trigger: "api", target: "coder" });
    store.update("prm_h", { state: "failed", cleanupPending: true });
    sandboxes.registered.set(SESSION, sandbox("sbx_leftover"));
    const stale = store.owing();
    sandboxes.createDelayMs = 50;
    const promoting = manager.promote(OWNER, SESSION);
    await vi.waitFor(() => expect(sandboxes.log).toContain("create:start"));
    const owing = store.owing.bind(store);
    store.owing = () => stale;
    await manager.recover();
    store.owing = owing;
    expect(await promoting).toMatchObject({ placement: "sandbox", generation: 1 });
    expect(sandboxes.log).toEqual(["delete:start", "delete:end", "create:start", "create:end"]);
  });

  it("publishes session.promoted again at the next start when the event ledger did not store it", async () => {
    publishStores = false;
    await manager.promote(OWNER, SESSION);
    const operation = manager.latest(SESSION)!;
    expect(operation).toMatchObject({ state: "committed", eventPublished: false, finalized: false });
    publishStores = true;
    await manager.recover();
    expect(published.map((event) => event.id)).toEqual([`evt_promoted_${operation.id}`, `evt_promoted_${operation.id}`]);
    expect(manager.latest(SESSION)).toMatchObject({ eventPublished: true, finalized: true });
  });

  it("stops recovering at shutdown and leaves the rest for the next start", async () => {
    store.insert({ id: "prm_i", sessionId: SESSION, ownerId: OWNER.accountId, fromGeneration: 0, trigger: "api", target: "coder" });
    store.update("prm_i", { state: "failed", cleanupPending: true });
    sandboxes.registered.set(SESSION, sandbox("sbx_leftover"));
    manager.close();
    await manager.recover();
    expect(sandboxes.deleted).toEqual([]);
    expect(store.get("prm_i")).toMatchObject({ cleanupPending: true });
  });

  it("releases an interrupted attempt's candidate without a recorded ID only while the ID names its own session or none", async () => {
    store.insert({ id: "prm_k", sessionId: SESSION, ownerId: OWNER.accountId, fromGeneration: 0, trigger: "api", target: "coder" });
    store.update("prm_k", { state: "failed", cleanupPending: true });
    // The session was deleted and a new shared session reused the ID; what is registered under it is not provably ours.
    sessions.records.set(SESSION, record({ createdAt: new Date(Date.now() + 60_000).toISOString() }));
    sandboxes.registered.set(SESSION, sandbox("sbx_unknown"));
    await manager.recover();
    expect(sandboxes.deleted).toEqual([]);
    expect(store.get("prm_k")).toMatchObject({ cleanupPending: false });

    // With no session under the ID, nothing else can own the sandbox: core records a session before allocating one.
    store.update("prm_k", { cleanupPending: true });
    sessions.records.delete(SESSION);
    await manager.recover();
    expect(sandboxes.deleted).toEqual([SESSION]);
  });

  it("does not revert the policy of a session that reused the ID", () => {
    store.insert({ id: "prm_l", sessionId: SESSION, ownerId: OWNER.accountId, fromGeneration: 0, trigger: "api", target: "coder" });
    store.update("prm_l", { state: "allocating" });
    sessions.records.set(SESSION, record({ createdAt: new Date(Date.now() + 60_000).toISOString() }));
    manager.reconcile();
    expect(policy.calls).toEqual([]);
    expect(store.get("prm_l")).toMatchObject({ state: "failed", cleanupPending: true });
  });
});

describe("promotion store", () => {
  it("upgrades a pre-release version-1 table, keeping what its rows already did", () => {
    const db = openDatabase(":memory:");
    db.exec(`CREATE TABLE promotion_operations (
       id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner_id INTEGER NOT NULL, from_generation INTEGER NOT NULL,
       to_generation INTEGER, trigger TEXT NOT NULL, tool_call_id TEXT, request_id TEXT, target TEXT NOT NULL,
       state TEXT NOT NULL, sandbox_id TEXT, error_code TEXT, error TEXT, source_cleaned INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL, committed_at TEXT)`);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO schema_migrations (module, version, applied_at) VALUES ('promotion', 1, ?)").run(now);
    const insert = db.prepare(
      "INSERT INTO promotion_operations (id, session_id, owner_id, from_generation, to_generation, trigger, target, state, source_cleaned, created_at, updated_at) VALUES (?, ?, 101, 0, ?, 'api', 'coder', ?, ?, ?, ?)",
    );
    insert.run("prm_done", SESSION, 1, "committed", 1, now, now);
    insert.run("prm_dirty", "7a7a7a7a-1111-4222-8333-944444444444", 1, "committed", 0, now, now);
    insert.run("prm_failed", "8b8b8b8b-1111-4222-8333-944444444444", null, "failed", 0, now, now);
    const upgraded = new PromotionStore(db);
    expect(upgraded.get("prm_done")).toMatchObject({ eventPublished: true, finalized: true, cleanupPending: false });
    expect(upgraded.get("prm_dirty")).toMatchObject({ eventPublished: true, finalized: false });
    expect(upgraded.get("prm_failed")).toMatchObject({ eventPublished: false, finalized: false, cleanupPending: false });
    // Only the source cleanup is still owed; opening the store again changes nothing.
    expect(upgraded.owing().map((operation) => operation.id)).toEqual(["prm_dirty"]);
    expect(new PromotionStore(db).owing().map((operation) => operation.id)).toEqual(["prm_dirty"]);
    db.close();
  });
});

describe("state transfer content", () => {
  it("rewrites the shared working directory to /workspace in what the sandbox imports", async () => {
    let staged = "";
    const original = sandboxes.importRuntimeState.bind(sandboxes);
    sandboxes.importRuntimeState = async (sessionId, input) => {
      staged = readFileSync(join(input.sessionStateDir, "workspace.yaml"), "utf8") + readFileSync(join(input.sessionStateDir, "events.jsonl"), "utf8");
      return original(sessionId, input);
    };
    await manager.promote(OWNER, SESSION);
    expect(staged).toContain("cwd: /workspace");
    expect(staged).toContain('"cwd":"/workspace"');
    expect(staged).not.toContain(join(temp, "data"));
  });
});
