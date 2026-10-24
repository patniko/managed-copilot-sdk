import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isManagedCopilotError, type PlatformEvent } from "@managed-copilot/protocol";
import { migrate, openDatabase, type Database } from "../../src/db.js";
import { createLogger } from "../../src/log.js";
import type { Principal } from "../../src/http.js";
import type {
  AttachedResponder,
  DurableCreateSessionRequest,
  DurableSessionView,
  DurableSessionsPort,
  PlatformToolDefinition,
  RuntimeSessionEvent,
} from "../../src/modules/durable/contract.js";
import { DurableActions, type ActionsOptions } from "../../src/modules/durable/actions/service.js";
import { DURABLE_MIGRATIONS, upgradeDurableSchema } from "../../src/modules/durable/migrations.js";

const OWNER: Principal = { accountId: 1, login: "octocat", token: "gho_owner" };
const STRANGER: Principal = { accountId: 2, login: "mallory", token: "gho_other" };
const SESSION = "11111111-1111-4111-8111-111111111111";
const URL = "http://127.0.0.1:7499";
const KEY = Buffer.alloc(32, 7);

class FakeSessions implements DurableSessionsPort {
  readonly views = new Map<string, DurableSessionView>();
  readonly requests: { sessionId: string; method: string; params: Record<string, unknown> }[] = [];
  readonly pendingTools = new Map<string, unknown[]>();
  readonly pendingPermissions = new Map<string, unknown[]>();
  failRequests = 0;

  get(sessionId: string) {
    return this.views.get(sessionId);
  }
  async create(_principal: Principal, request: DurableCreateSessionRequest) {
    return { sessionId: request.sessionId, created: true };
  }
  async send() {
    return { messageId: "m1" };
  }
  async request<T>(sessionId: string, method: string, params: Record<string, unknown>): Promise<T> {
    if (method === "session.tools.listPendingRequests") return { items: this.pendingTools.get(sessionId) ?? [] } as T;
    if (method === "session.permissions.pendingRequests") return { items: this.pendingPermissions.get(sessionId) ?? [] } as T;
    this.requests.push({ sessionId, method, params });
    if (this.failRequests > 0) {
      this.failRequests--;
      throw new Error("runtime unavailable");
    }
    return { success: true } as T;
  }
  subscribe() {
    return () => undefined;
  }
  answers() {
    return this.requests.filter((request) => request.method.includes("handlePending"));
  }
}

function sdk(connectionId: string, tools: string[], requestPermission = true): AttachedResponder {
  return { connectionId, kind: "sdk", tools, requestPermission, requestElicitation: false };
}

let eventCounter = 0;
function toolEvent(requestId: string, toolName = "lookup_order", args: unknown = { id: "1234" }): RuntimeSessionEvent {
  return {
    id: `evt-${++eventCounter}`,
    type: "external_tool.requested",
    timestamp: new Date().toISOString(),
    parentId: null,
    data: { requestId, sessionId: SESSION, toolName, toolCallId: `call-${requestId}`, arguments: args },
  };
}

function permissionEvent(requestId: string): RuntimeSessionEvent {
  return {
    id: `evt-${++eventCounter}`,
    type: "permission.requested",
    timestamp: new Date().toISOString(),
    parentId: null,
    data: { requestId, permissionRequest: { kind: "shell", fullCommandText: "ls", toolCallId: `call-${requestId}` } },
  };
}

function completedEvent(type: string, requestId: string): RuntimeSessionEvent {
  return { id: `evt-${++eventCounter}`, type, timestamp: new Date().toISOString(), parentId: null, data: { requestId } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isManagedCopilotError(error), `expected ${code}, got ${String(error)}`).toBe(true);
  expect((error as { code: string }).code).toBe(code);
}

describe("durable actions ledger", () => {
  let db: Database;
  let sessions: FakeSessions;
  let published: PlatformEvent[];
  let now: number;
  let tools: Map<string, PlatformToolDefinition>;
  let actions: DurableActions;

  function build(options: Partial<ActionsOptions> = {}) {
    return new DurableActions({
      db,
      log: createLogger("test", "error"),
      capabilityKey: KEY,
      publicUrl: URL,
      sessions: () => sessions,
      platformTools: () => ({ register: (definition) => tools.set(definition.name, definition), get: (name) => tools.get(name) }),
      publish: (event) => published.push(event),
      now: () => now,
      options: { sweepIntervalMs: 0, notifyDebounceMs: 1, ...options },
    });
  }

  function input(event: RuntimeSessionEvent, attached: AttachedResponder[] = [], generation = 0) {
    return { sessionId: SESSION, ownerId: OWNER.accountId, environment: "chat", generation, event, attached };
  }

  const user = (principal: Principal = OWNER) => ({ type: "user" as const, principal });

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db, "durable", DURABLE_MIGRATIONS);
    sessions = new FakeSessions();
    sessions.views.set(SESSION, { id: SESSION, ownerId: OWNER.accountId, environment: "chat", state: "running", generation: 0 });
    published = [];
    now = Date.parse("2026-10-23T12:00:00Z");
    tools = new Map();
    actions = build();
  });

  afterEach(() => {
    actions.stop();
    db.close();
  });

  describe("claim before emission", () => {
    it("gives the actionable event to exactly one eligible live client (the creating connection first) and withholds it from the others", async () => {
      const decision = await actions.onSessionEvent(input(toolEvent("r1"), [sdk("c1", ["lookup_order"]), sdk("c2", ["lookup_order"]), sdk("c3", [])]));
      expect(decision.owner).toBe("c1");
      expect(decision.withhold).toEqual(["c2"]);
      expect(decision.claimToken).toMatch(/^mct_/);
      const [action] = actions.list(SESSION);
      expect(action).toMatchObject({ kind: "tool", tool: "lookup_order", state: "executing", claimedBy: "live:c1", idempotencyKey: `${SESSION}:call-r1` });
      expect(published).toHaveLength(0);
    });

    it("never offers a re-emitted event to a second responder", async () => {
      await actions.onSessionEvent(input(toolEvent("r1"), [sdk("c1", ["lookup_order"])]));
      const again = await actions.onSessionEvent(input(toolEvent("r1"), [sdk("c2", ["lookup_order"]), sdk("c1", ["lookup_order"])]));
      expect(again.owner).toBeUndefined();
      expect(again.withhold.sort()).toEqual(["c1", "c2"]);
      expect(actions.list(SESSION)).toHaveLength(1);
    });

    it("prefers the application's permission handler over an attached person", async () => {
      const cli: AttachedResponder = { connectionId: "cli", kind: "cli", tools: [], requestPermission: false, requestElicitation: false };
      const decision = await actions.onSessionEvent(input(permissionEvent("p1"), [cli, sdk("app", [])]));
      expect(decision.owner).toBe("app");
      expect(decision.withhold).toEqual(["cli"]);
    });

    it("does not let a person run an application's tool", async () => {
      const cli: AttachedResponder = { connectionId: "cli", kind: "cli", tools: ["lookup_order"], requestPermission: true, requestElicitation: true };
      const decision = await actions.onSessionEvent(input(toolEvent("r1"), [cli]));
      expect(decision.owner).toBeUndefined();
      expect(actions.list(SESSION)[0]!.state).toBe("pending");
    });

    it("ignores permission requests a hook already resolved", async () => {
      const event = permissionEvent("p1");
      const decision = await actions.onSessionEvent(input({ ...event, data: { ...event.data, resolvedByHook: true } }, [sdk("c1", [])]));
      expect(decision).toEqual({ withhold: [] });
      expect(actions.list(SESSION)).toHaveLength(0);
    });

    it("returns a released live claim to pending and notifies durable responders", async () => {
      const decision = await actions.onSessionEvent(input(toolEvent("r1"), [sdk("c1", ["lookup_order"])]));
      actions.releaseLiveClaim(decision.actionId!, decision.claimToken!);
      expect(actions.list(SESSION)[0]!.state).toBe("pending");
      await sleep(20);
      expect(published.map((event) => event.type)).toEqual(["session.action_required"]);
    });
  });

  describe("live answers", () => {
    it("persists the owner's answer, forwards it once, and treats a duplicate as already recorded", async () => {
      const decision = await actions.onSessionEvent(input(toolEvent("r1"), [sdk("c1", ["lookup_order"])]));
      const answer = { sessionId: SESSION, connectionId: "c1", responderKind: "sdk" as const, method: "session.tools.handlePendingToolCall", params: { sessionId: SESSION, requestId: "r1", result: "shipped" } };
      expect(await actions.onClientAnswer(answer)).toEqual({ kind: "respond", response: { success: true } });
      expect(sessions.answers()).toEqual([{ sessionId: SESSION, method: "session.tools.handlePendingToolCall", params: { sessionId: SESSION, requestId: "r1", result: "shipped" } }]);
      expect(actions.list(SESSION)[0]).toMatchObject({ id: decision.actionId, state: "completed", result: "shipped" });

      expect(await actions.onClientAnswer(answer)).toEqual({ kind: "respond", response: { success: true } });
      expect(sessions.answers()).toHaveLength(1);
      await expectCode(actions.onClientAnswer({ ...answer, params: { ...answer.params, result: "lost" } }), "conflict");
    });

    it("rejects an answer from a client that does not own the action", async () => {
      await actions.onSessionEvent(input(toolEvent("r1"), [sdk("c1", ["lookup_order"]), sdk("c2", ["lookup_order"])]));
      await expectCode(
        actions.onClientAnswer({ sessionId: SESSION, connectionId: "c2", responderKind: "sdk", method: "session.tools.handlePendingToolCall", params: { requestId: "r1", result: "x" } }),
        "conflict",
      );
      expect(sessions.answers()).toHaveLength(0);
    });

    it("forwards answers it does not track", async () => {
      expect(
        await actions.onClientAnswer({ sessionId: SESSION, connectionId: "c1", responderKind: "sdk", method: "session.tools.handlePendingToolCall", params: { requestId: "unknown" } }),
      ).toEqual({ kind: "forward" });
    });

    it("lets an eligible client take a pending action it answers directly", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const response = await actions.onClientAnswer({ sessionId: SESSION, connectionId: "c9", responderKind: "sdk", method: "session.tools.handlePendingToolCall", params: { requestId: "r1", error: "boom" } });
      expect(response.kind).toBe("respond");
      expect(actions.list(SESSION)[0]).toMatchObject({ state: "failed", error: "boom" });
      expect(sessions.answers()[0]!.params).toEqual({ sessionId: SESSION, requestId: "r1", error: "boom" });
    });

    it("acknowledges a recorded live answer even when the runtime is briefly unreachable", async () => {
      await actions.onSessionEvent(input(permissionEvent("p1"), [sdk("c1", [])]));
      sessions.failRequests = 1;
      const answer = { sessionId: SESSION, connectionId: "c1", responderKind: "sdk" as const, method: "session.permissions.handlePendingPermissionRequest", params: { requestId: "p1", result: { kind: "approve-once" } } };
      // A failure here would make the stock SDK send a conflicting "user-not-available" fallback.
      expect(await actions.onClientAnswer(answer)).toEqual({ kind: "respond", response: { success: true } });
      expect(actions.list(SESSION)[0]).toMatchObject({ state: "completed", result: { kind: "approve-once" } });
      now += 2_000;
      await actions.sweep();
      await sleep(10);
      expect(sessions.answers()).toHaveLength(2);
    });
  });

  describe("durable responders (webhooks and polling)", () => {
    it("notifies once for a burst of parallel calls and scopes the capability to pending actions", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      await actions.onSessionEvent(input(toolEvent("r2")));
      await sleep(20);
      expect(published).toHaveLength(1);
      const event = published[0]!;
      expect(event).toMatchObject({ type: "session.action_required", sessionId: SESSION, environment: "chat" });
      const ids = (event.data.actions as { id: string }[]).map((action) => action.id);
      expect(ids).toHaveLength(2);
      const capability = actions.mintCapability(SESSION, ids, "orders")!;
      expect(capability).toMatchObject({ sessionId: SESSION, actionIds: ids, audience: URL });
      expect(actions.verifyCapability(capability.token)).toMatchObject({ sessionId: SESSION, actionIds: ids, webhook: "orders" });
    });

    it("lets exactly one of many racing responders claim, and never executes twice", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const [action] = actions.list(SESSION);
      const capability = actions.mintCapability(SESSION, [action!.id], "orders")!;
      const webhook = { type: "capability" as const, capability: actions.verifyCapability(capability.token) };
      const attempts = await Promise.allSettled([
        actions.claim(webhook, SESSION, action!.id),
        actions.claim(webhook, SESSION, action!.id),
        actions.claim(user(), SESSION, action!.id),
        actions.claim(user(), SESSION, action!.id),
        actions.onClientAnswer({ sessionId: SESSION, connectionId: "late", responderKind: "sdk", method: "session.tools.handlePendingToolCall", params: { requestId: "r1", result: "x" } }),
      ]);
      const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
      expect(winners).toHaveLength(1);
      for (const attempt of attempts) {
        if (attempt.status === "rejected") expect((attempt.reason as { code: string }).code).toBe("conflict");
      }
    });

    it("records a result before acknowledging, returns duplicates, and rejects conflicting results", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id, { responder: "worker-1" });
      expect(claim.action).toMatchObject({ state: "executing", claimedBy: "poll:octocat/worker-1", arguments: { id: "1234" } });

      const result = await actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: { status: "shipped" } });
      expect(result).toEqual({ actionId: action!.id, state: "completed" });
      expect(actions.list(SESSION)[0]!.result).toBe('{"status":"shipped"}');
      expect(sessions.answers()).toHaveLength(1);

      expect(await actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: { status: "shipped" } })).toEqual(result);
      expect(sessions.answers()).toHaveLength(1);
      await expectCode(actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: "different" }), "conflict");
      await expectCode(actions.claim(user(), SESSION, action!.id), "conflict");
    });

    it("renews a slow handler's lease instead of handing the action to someone else", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id, { leaseSeconds: 10 });
      now += 8_000;
      const renewed = await actions.claim(user(), SESSION, action!.id, { claimToken: claim.claimToken, leaseSeconds: 10 });
      expect(Date.parse(renewed.leaseExpiresAt)).toBe(now + 10_000);
      now += 8_000;
      await actions.sweep();
      expect(actions.list(SESSION)[0]!.state).toBe("executing");
      await expectCode(actions.claim(user(), SESSION, action!.id), "conflict");
    });

    it("marks an expired tool claim as needing reconciliation and never re-offers it automatically", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id, { leaseSeconds: 5 });
      now += 6_000;
      await actions.sweep();
      expect(actions.list(SESSION)[0]).toMatchObject({ state: "needs_reconciliation" });
      expect(actions.list(SESSION)[0]!.reason).toMatch(/idempotency key/);
      await expectCode(actions.claim(user(), SESSION, action!.id), "conflict");

      // The original holder finishing late is the true outcome, so it is still accepted.
      expect(await actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: "done late" })).toMatchObject({ state: "completed" });
    });

    it("lets an owner take over an uncertain action only when explicitly reconciling", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const [action] = actions.list(SESSION);
      const first = await actions.claim(user(), SESSION, action!.id, { leaseSeconds: 5 });
      now += 6_000;
      await actions.sweep();
      const takeover = await actions.claim(user(), SESSION, action!.id, { reconcile: true });
      await expectCode(actions.submit(user(), SESSION, action!.id, { claimToken: first.claimToken, result: "stale" }), "conflict");
      expect(await actions.submit(user(), SESSION, action!.id, { claimToken: takeover.claimToken, result: "checked downstream" })).toMatchObject({ state: "completed" });
    });

    it("returns an expired permission claim to pending (prompts have no external effect)", async () => {
      await actions.onSessionEvent(input(permissionEvent("p1")));
      await sleep(20);
      const [action] = actions.list(SESSION);
      expect(action!.payload).toMatchObject({ kind: "shell" });
      expect(action!.requestId).toBe("p1");
      await actions.claim(user(), SESSION, action!.id, { leaseSeconds: 5 });
      now += 6_000;
      await actions.sweep();
      expect(actions.list(SESSION)[0]!.state).toBe("pending");
      await sleep(20);
      expect(published).toHaveLength(2);
    });

    it("releases a claim without answering", async () => {
      await actions.onSessionEvent(input(permissionEvent("p1")));
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id);
      expect(await actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, release: true })).toEqual({ actionId: action!.id, state: "pending" });
      await expectCode(actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: { kind: "approve-once" } }), "conflict");
    });

    it("announces a released action no notification covered yet, but never re-announces to the webhook that released it", async () => {
      // A poller grabs the prompt inside the notification debounce window, so nothing announced it.
      await actions.onSessionEvent(input(permissionEvent("p1")));
      const [action] = actions.list(SESSION);
      const first = await actions.claim(user(), SESSION, action!.id);
      await sleep(20);
      expect(published).toHaveLength(0);
      await actions.submit(user(), SESSION, action!.id, { claimToken: first.claimToken, release: true });
      await sleep(20);
      expect(published).toHaveLength(1);

      // A webhook worker that saw it and could not decide releases it again: no notification loop.
      const capability = actions.verifyCapability(actions.mintCapability(SESSION, [action!.id], "orders")!.token);
      const second = await actions.claim({ type: "capability", capability }, SESSION, action!.id);
      await actions.submit({ type: "capability", capability }, SESSION, action!.id, { claimToken: second.claimToken, release: true });
      await sleep(20);
      expect(published).toHaveLength(1);

      // A poller that held it while the webhook skipped it releases it: webhooks hear about it again.
      const third = await actions.claim(user(), SESSION, action!.id);
      await actions.submit(user(), SESSION, action!.id, { claimToken: third.claimToken, release: true });
      await sleep(20);
      expect(published).toHaveLength(2);
    });

    it("never turns a failing permission handler into an approval", async () => {
      await actions.onSessionEvent(input(permissionEvent("p1")));
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id);
      await actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, error: "handler crashed" });
      expect(sessions.answers()[0]!.params).toEqual({ sessionId: SESSION, requestId: "p1", result: { kind: "user-not-available" } });
      await expectCode(actions.claim(user(), SESSION, action!.id), "conflict");
    });

    it("validates permission and tool answers", async () => {
      await actions.onSessionEvent(input(permissionEvent("p1")));
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id);
      await expectCode(actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: "yes" }), "invalid_request");
      await expectCode(actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: { kind: "no-result" } }), "invalid_request");
      await expectCode(actions.submit(user(), SESSION, action!.id, { claimToken: "" }), "invalid_request");
    });
  });

  describe("scoping", () => {
    it("hides a session's actions from other GitHub accounts", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const [action] = actions.list(SESSION);
      await expectCode(actions.listFor(user(STRANGER), SESSION), "not_found");
      await expectCode(actions.claim(user(STRANGER), SESSION, action!.id), "not_found");
    });

    it("limits a capability to its session's listed actions, deployment, and lifetime", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      await actions.onSessionEvent(input(toolEvent("r2")));
      const [first, second] = actions.list(SESSION);
      const capability = actions.mintCapability(SESSION, [first!.id], "orders")!;
      const caller = { type: "capability" as const, capability: actions.verifyCapability(capability.token) };
      expect((await actions.listFor(caller, SESSION)).map((action) => action.id)).toEqual([first!.id]);
      await expectCode(actions.claim(caller, SESSION, second!.id), "forbidden");
      await expectCode(actions.listFor(caller, "another-session"), "forbidden");

      const elsewhere = new DurableActions({ db, log: createLogger("t", "error"), capabilityKey: KEY, publicUrl: "https://other.example", sessions: () => sessions, platformTools: () => undefined, publish: () => undefined, now: () => now, options: { sweepIntervalMs: 0 } });
      expect(() => elsewhere.verifyCapability(capability.token)).toThrow(/different deployment/);
      now += 16 * 60_000;
      expect(() => actions.verifyCapability(capability.token)).toThrow(/expired/);
      const tampered = `${capability.token.slice(0, -2)}xx`;
      expect(() => actions.verifyCapability(tampered)).toThrow(/not valid/);
    });

    it("mints no capability once nothing is pending", async () => {
      await actions.onSessionEvent(input(toolEvent("r1"), [sdk("c1", ["lookup_order"])]));
      expect(actions.mintCapability(SESSION, actions.list(SESSION).map((action) => action.id), "orders")).toBeUndefined();
    });
  });

  describe("reconnects, restarts, and deadlines", () => {
    it("replays waiting actions to a client that resumes with the matching handler", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      await actions.onSessionEvent(input(toolEvent("r2", "other_tool")));
      now += 10_000;
      sessions.pendingTools.set(SESSION, [
        { requestId: "r1", toolCallId: "call-r1", toolName: "lookup_order" },
        { requestId: "r2", toolCallId: "call-r2", toolName: "other_tool" },
      ]);
      const replay = await actions.onAttached({ sessionId: SESSION, ownerId: OWNER.accountId, environment: "chat", generation: 0, responder: sdk("c1", ["lookup_order"]) });
      expect(replay.map((event) => event.data.requestId)).toEqual(["r1"]);
      expect(actions.list(SESSION).map((action) => action.state)).toEqual(["executing", "pending"]);
      const again = await actions.onAttached({ sessionId: SESSION, ownerId: OWNER.accountId, environment: "chat", generation: 0, responder: sdk("c2", ["lookup_order"]) });
      expect(again).toHaveLength(0);
    });

    it("treats a disconnect during a live tool call as uncertain and re-offers prompts", async () => {
      const changes: string[] = [];
      actions.onChange((change) => changes.push(`${change.type}:${change.actionId}`));
      await actions.onSessionEvent(input(toolEvent("r1"), [sdk("c1", ["lookup_order"])]));
      await actions.onSessionEvent(input(permissionEvent("p1"), [sdk("c1", ["lookup_order"])]));
      actions.onDetached("c1");
      const [tool, permission] = actions.list(SESSION);
      expect(tool).toMatchObject({ state: "needs_reconciliation" });
      expect(permission).toMatchObject({ state: "pending" });
      // Schedule runs follow these changes to show they are waiting on a responder.
      expect(changes).toEqual([`pending:${tool!.id}`, `pending:${permission!.id}`]);
      await sleep(20);
      expect(published).toHaveLength(1);
    });

    it("never claims for a connection that closed while its attach was reconciling", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      let resolveList!: () => void;
      const listed = new Promise<void>((done) => (resolveList = done));
      const request = sessions.request.bind(sessions);
      sessions.request = (async <T>(sessionId: string, method: string, params: Record<string, unknown>) => {
        if (method === "session.tools.listPendingRequests") await listed;
        return request<T>(sessionId, method, params);
      }) as typeof sessions.request;
      const attaching = actions.onAttached({ sessionId: SESSION, ownerId: OWNER.accountId, environment: "chat", generation: 0, responder: sdk("gone", ["lookup_order"]) });
      actions.onDetached("gone");
      resolveList();
      expect(await attaching).toEqual([]);
      expect(actions.list(SESSION)[0]!.state).toBe("pending");
      const replacement = await actions.onAttached({ sessionId: SESSION, ownerId: OWNER.accountId, environment: "chat", generation: 0, responder: sdk("next", ["lookup_order"]) });
      expect(replacement).toHaveLength(1);
    });

    it("announces pending actions whose notification was lost to a crash", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      actions.stop(); // the debounce timer never fires
      const restarted = build();
      restarted.recover();
      await sleep(20);
      expect(published.map((event) => event.type)).toEqual(["session.action_required"]);
      restarted.stop();
    });

    it("recovers orphaned live claims after a gateway restart", async () => {
      await actions.onSessionEvent(input(toolEvent("r1"), [sdk("c1", ["lookup_order"])]));
      actions.stop();
      const restarted = build();
      restarted.recover();
      expect(restarted.list(SESSION)[0]!.state).toBe("needs_reconciliation");
      restarted.stop();
    });

    it("upgrades ledgers from pre-release builds that lack notified_at", () => {
      const legacy = openDatabase(":memory:");
      legacy.exec(DURABLE_MIGRATIONS[0]!.replace(/\s+notified_at INTEGER,/, ""));
      expect((legacy.prepare("PRAGMA table_info(durable_actions)").all() as { name: string }[]).some((column) => column.name === "notified_at")).toBe(false);
      upgradeDurableSchema(legacy);
      upgradeDurableSchema(legacy);
      expect((legacy.prepare("PRAGMA table_info(durable_actions)").all() as { name: string }[]).some((column) => column.name === "notified_at")).toBe(true);
      legacy.close();
    });

    it("expires unanswered actions at the deadline and tells the runtime without approving anything", async () => {
      actions = build({ answerTimeoutMs: 60_000 });
      await actions.onSessionEvent(input(toolEvent("r1")));
      await actions.onSessionEvent(input(permissionEvent("p1")));
      const claim = await actions.claim(user(), SESSION, actions.list(SESSION)[0]!.id);
      now += 61_000;
      await actions.sweep();
      await actions.sweep();
      await sleep(10);
      expect(actions.list(SESSION).map((action) => action.state)).toEqual(["expired", "expired"]);
      const params = sessions.answers().map((answer) => answer.params);
      expect(params).toContainEqual({ sessionId: SESSION, requestId: "r1", error: "No responder answered lookup_order before its deadline" });
      expect(params).toContainEqual({ sessionId: SESSION, requestId: "p1", result: { kind: "user-not-available" } });
      await expectCode(actions.submit(user(), SESSION, actions.list(SESSION)[0]!.id, { claimToken: claim.claimToken, result: "too late" }), "conflict");
    });

    it("cancels an action the runtime stopped waiting for", async () => {
      await actions.onSessionEvent(input(toolEvent("r1"), [sdk("c1", ["lookup_order"])]));
      await actions.onSessionEvent(input(completedEvent("external_tool.completed", "r1"), [sdk("c1", ["lookup_order"])]));
      expect(actions.list(SESSION)[0]).toMatchObject({ state: "cancelled" });
      await expectCode(
        actions.onClientAnswer({ sessionId: SESSION, connectionId: "c1", responderKind: "sdk", method: "session.tools.handlePendingToolCall", params: { requestId: "r1", result: "x" } }),
        "conflict",
      );
    });

    it("keeps a recorded answer and retries delivery when the runtime is unavailable", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id);
      sessions.failRequests = 1;
      expect(await actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: "ok" })).toMatchObject({ state: "completed" });
      expect(sessions.answers()).toHaveLength(1);
      now += 2_000;
      await actions.sweep();
      await sleep(10);
      expect(sessions.answers()).toHaveLength(2);
      now += 10_000;
      await actions.sweep();
      await sleep(10);
      expect(sessions.answers()).toHaveLength(2);
    });

    it("does not deliver an answer into a newer placement generation", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id);
      sessions.views.set(SESSION, { ...sessions.views.get(SESSION)!, generation: 1 });
      await actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: "ok" });
      expect(sessions.answers()).toHaveLength(0);
      expect(actions.list(SESSION)[0]!.reason).toMatch(/generation 1/);
    });

    it("reconciles with the runtime's pending lists", async () => {
      await actions.onSessionEvent(input(toolEvent("gone")));
      await actions.onSessionEvent(input(toolEvent("young")));
      now += 1_000;
      await actions.onSessionEvent(input(toolEvent("fresh")));
      now += 1_500;
      sessions.pendingTools.set(SESSION, [{ requestId: "missed", toolCallId: "call-missed", toolName: "lookup_order", arguments: { id: "9" } }]);
      await actions.reconcile(SESSION);
      // "gone" and "young" are older than the grace window and absent from the runtime; "fresh" may not be listed yet.
      const byRequest = Object.fromEntries(actions.list(SESSION).map((action) => [action.toolCallId, action.state]));
      expect(byRequest).toEqual({ "call-gone": "cancelled", "call-young": "cancelled", "call-fresh": "pending", "call-missed": "pending" });
    });
  });

  describe("platform tools", () => {
    it("executes a gateway-owned tool exactly once and withholds it from clients", async () => {
      let calls = 0;
      tools.set("schedule_task", {
        name: "schedule_task",
        description: "",
        parameters: {},
        enabledFor: () => true,
        handler: async (_args, context) => {
          calls++;
          return `scheduled with ${context.idempotencyKey}`;
        },
      });
      const event = toolEvent("t1", "schedule_task", { prompt: "hi" });
      const decision = await actions.onSessionEvent(input(event, [sdk("c1", ["schedule_task"])]));
      expect(decision.owner).toBeUndefined();
      expect(decision.withhold).toEqual(["c1"]);
      await actions.onSessionEvent(input(event, [sdk("c1", ["schedule_task"])]));
      await sleep(10);
      expect(calls).toBe(1);
      expect(sessions.answers()[0]!.params).toEqual({ sessionId: SESSION, requestId: "t1", result: `scheduled with ${SESSION}:call-t1` });
    });
  });
});
