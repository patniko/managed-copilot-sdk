// Unit tests for the promotion state machine with fault injection: every port (core's placement cutover, sandboxes,
// network policy, durable actions, events) is a fake that records what promotion asked of it and can fail on demand.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

type Step = string;

interface Behavior {
  processing?: (fenced: boolean) => boolean;
  sourcePending?: () => Record<string, unknown>[];
  destinationPending?: () => Record<string, unknown>[];
  openFails?: ManagedCopilotError;
  commitFails?: ManagedCopilotError;
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

  commit(): SessionRecord {
    this.steps.push("commit");
    if (this.#behavior.commitFails) throw this.#behavior.commitFails;
    const committed: SessionRecord = { ...this.record, placement: "sandbox", generation: this.record.generation + 1, state: "idle" };
    this.#sessions.records.set(committed.id, committed);
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

class FakeSandboxes {
  readonly created: Record<string, unknown>[] = [];
  readonly imports: { sessionId: string; sessionStateDir: string; activeTurnId?: string; files: string[] }[] = [];
  readonly deleted: string[] = [];
  createFails: ManagedCopilotError | undefined;
  importFails: ManagedCopilotError | undefined;
  createDelayMs = 0;

  async create(request: Record<string, unknown>) {
    this.created.push(request);
    if (this.createDelayMs) await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
    if (this.createFails) throw this.createFails;
    return { sandboxId: "sbx_test", info: { id: "sbx_test", size: "medium", state: "running", network: DISABLED } };
  }

  async importRuntimeState(sessionId: string, input: { sessionStateDir: string; activeTurnId?: string }) {
    if (this.importFails) throw this.importFails;
    const files = ["events.jsonl", "workspace.yaml"].filter((name) => existsSync(join(input.sessionStateDir, name)));
    this.imports.push({ sessionId, ...input, files });
    return { files: files.length, bytes: 1 };
  }

  async delete(sessionId: string) {
    this.deleted.push(sessionId);
  }

  get(sessionId: string) {
    return this.created.some((request) => request["sessionId"] === sessionId) && !this.deleted.includes(sessionId)
      ? { id: "sbx_test", size: "medium" as const, state: "running" as const, network: DISABLED }
      : undefined;
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
    createdAt: new Date().toISOString(),
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
  const services = app.services as Record<string, unknown>;
  services["sessions"] = sessions;
  services["sandboxes"] = sandboxes;
  services["policy"] = policy;
  services["actions"] = actions;
  services["events"] = {
    publish: (event: PlatformEvent) => {
      if (publishFails) throw new Error("bus down");
      published.push(event);
    },
  };
  services["environments"] = { forSession: () => ({ customizations: { root: join(temp, "pinned", "helper") } }) };
  services["auth"] = { liveCredential: () => ({ token: OWNER.token }) };
  store = new PromotionStore(app.db);
  manager = new PromotionManager({
    app,
    log: createLogger("promotion-test", "error"),
    store,
    platformRoots: [join(dataDir, "runtime", "shared")],
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

  it("fails without allocating when the import capability or a local source is missing", async () => {
    sessions.stateDir = () => undefined;
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "capability_unavailable");
    expect(sandboxes.created).toHaveLength(0);
  });

  it("rejects sessions that are not promotable, other owners, and incompatible targets", async () => {
    sessions.records.set(SESSION, record({ environment: "chat", type: "shared" }));
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "invalid_request");
    sessions.records.set(SESSION, record());
    expectError(await manager.promote({ ...OWNER, accountId: 202, login: "intruder" }, SESSION).catch((error: unknown) => error), "not_found");
    sessions.records.set(SESSION, record({ model: "gpt-5.4" }));
    expectError(await manager.promote(OWNER, SESSION).catch((error: unknown) => error), "policy_violation");
    expect(sandboxes.created).toHaveLength(0);
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

  it("does not commit when the destination did not carry the pending call", async () => {
    sessions.behavior.destinationPending = () => [];
    const result = (await manager.fromTool(context)) as { error: string };
    expect(result.error).toMatch(/^state_restore_failed: /);
    expect(sessions.steps).not.toContain("commit");
    expect(sessions.steps.at(-1)).toBe('abort:{"resume":{"continuePendingWork":true}}');
  });

  it("stops when the turn that asked ended, and refuses subagents", async () => {
    sessions.behavior.sourcePending = () => [];
    expect(((await manager.fromTool(context)) as { error: string }).error).toMatch(/^conflict: /);
    sessions.behavior.sourcePending = () => [{ ...own, agentId: "sub-1" }];
    expect(((await manager.fromTool(context)) as { error: string }).error).toMatch(/^invalid_request: /);
    expect(sessions.steps).not.toContain("fence");
  });

  it("answers a retried call (after a gateway restart) without moving again", async () => {
    expect(await manager.fromTool(context)).toBe(SANDBOX_READY_TEXT);
    expect(await manager.fromTool(context)).toBe(SANDBOX_READY_TEXT);
    expect(sandboxes.created).toHaveLength(1);
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
    const committedId = store.insert({ id: "prm_a", sessionId: SESSION, ownerId: OWNER.accountId, fromGeneration: 0, trigger: "api", target: "coder" }).id;
    store.update(committedId, { state: "opening", sandboxId: "sbx_test", sourceStateDir: stateDir });
    sessions.records.set(SESSION, record({ placement: "sandbox", generation: 1 }));

    const other = "7a7a7a7a-1111-4222-8333-944444444444";
    sessions.records.set(other, record({ id: other }));
    store.insert({ id: "prm_b", sessionId: other, ownerId: OWNER.accountId, fromGeneration: 0, trigger: "tool", toolCallId: "call-9", target: "coder" });
    store.update("prm_b", { state: "transferring" });

    await manager.recover();
    expect(store.get("prm_a")).toMatchObject({ state: "committed", toGeneration: 1, sourceCleaned: true });
    expect(existsSync(stateDir)).toBe(false);
    expect(store.get("prm_b")).toMatchObject({ state: "failed" });
    expect(policy.calls).toEqual([`revert:${other}`]);
    expect(sandboxes.deleted).toEqual([other]);
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
