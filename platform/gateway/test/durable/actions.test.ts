import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManagedCopilotError, isManagedCopilotError, parseConfig, type PlatformEvent } from "@managed-copilot/protocol";
import { migrate, openDatabase, type Database } from "../../src/db.js";
import { createLogger, type Logger } from "../../src/log.js";
import type { Principal } from "../../src/http.js";
import type {
  AttachedResponder,
  ClientAnswerInput,
  DurableCreateSessionRequest,
  DurableEventsPort,
  DurableSessionView,
  DurableSessionsPort,
  PlatformToolContext,
  PlatformToolDefinition,
  PromptVisibilityInput,
  RuntimeSessionEvent,
} from "../../src/modules/durable/contract.js";
import { DurableActions, needsPerson, type ActionsOptions } from "../../src/modules/durable/actions/service.js";
import { incarnationOf, isGone } from "../../src/modules/durable/ids.js";
import { announcer, ownsPendingDeliveries } from "../../src/modules/durable/index.js";
import { DURABLE_MIGRATIONS, upgradeDurableSchema } from "../../src/modules/durable/migrations.js";
import { DurableWebhooks } from "../../src/modules/durable/webhooks/service.js";

const OWNER: Principal = { accountId: 1, login: "octocat", token: "gho_owner" };
const STRANGER: Principal = { accountId: 2, login: "mallory", token: "gho_other" };
const SESSION = "11111111-1111-4111-8111-111111111111";
const URL = "http://127.0.0.1:7499";
const KEY = Buffer.alloc(32, 7);

class FakeSessions implements DurableSessionsPort {
  readonly views = new Map<string, DurableSessionView>();
  /** Every runtime call, with the placement generation that was current when it was sent. */
  readonly requests: { sessionId: string; method: string; params: Record<string, unknown>; generation: number }[] = [];
  /** The incarnation each runtime call expected (core refuses a call for another one). */
  readonly fences: { method: string; incarnation?: string }[] = [];
  readonly pendingTools = new Map<string, unknown[]>();
  readonly pendingPermissions = new Map<string, unknown[]>();
  /** The session's event log (`session.getMessages`). */
  readonly history = new Map<string, RuntimeSessionEvent[]>();
  failRequests = 0;
  /** Holds the next answer delivery in flight (after it was sent) until this settles. */
  holdNextAnswer: Promise<void> | undefined;

  get(sessionId: string) {
    return this.views.get(sessionId);
  }
  async create(_principal: Principal, request: DurableCreateSessionRequest) {
    return { sessionId: request.sessionId, created: true };
  }
  async send() {
    return { messageId: "m1" };
  }
  /** Like core: with an expected incarnation, a call reaches the runtime only while the session is still that one. */
  #fence(sessionId: string, options: { readonly incarnation?: string } | undefined): void {
    const view = this.views.get(sessionId);
    if (options?.incarnation !== undefined && (isGone(view) || incarnationOf(view!) !== options.incarnation)) {
      throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`);
    }
  }
  async request<T>(sessionId: string, method: string, params: Record<string, unknown>, options?: { readonly incarnation?: string }): Promise<T> {
    this.fences.push({ method, ...(options?.incarnation !== undefined ? { incarnation: options.incarnation } : {}) });
    if (method === "session.tools.listPendingRequests" || method === "session.permissions.pendingRequests" || method === "session.getMessages") this.#fence(sessionId, options);
    if (method === "session.tools.listPendingRequests") return { items: this.pendingTools.get(sessionId) ?? [] } as T;
    if (method === "session.permissions.pendingRequests") return { items: this.pendingPermissions.get(sessionId) ?? [] } as T;
    if (method === "session.getMessages") return { events: this.history.get(sessionId) ?? [] } as T;
    this.requests.push({ sessionId, method, params, generation: this.views.get(sessionId)?.generation ?? 0 });
    const hold = method.includes("handlePending") ? this.holdNextAnswer : undefined;
    if (hold) {
      this.holdNextAnswer = undefined;
      await hold;
    }
    // Checked where the answer is written, after anything that happened while it was in flight.
    this.#fence(sessionId, options);
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

/** An attached Copilot CLI: a person. */
function cli(connectionId: string): AttachedResponder {
  return { connectionId, kind: "cli", tools: [], requestPermission: true, requestElicitation: true };
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

/** A prompt managed policy reserves for a person (`managedApprovalRequired`). */
function managedPermissionEvent(requestId: string): RuntimeSessionEvent {
  const event = permissionEvent(requestId);
  return { ...event, data: { ...event.data, permissionRequest: { ...(event.data.permissionRequest as Record<string, unknown>), managedApprovalRequired: true } } };
}

function completedEvent(type: string, requestId: string): RuntimeSessionEvent {
  return { id: `evt-${++eventCounter}`, type, timestamp: new Date().toISOString(), parentId: null, data: { requestId } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

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

  function build(options: Partial<ActionsOptions> = {}, overrides: { publish?: (event: PlatformEvent, meta: { ownerId: number }) => void; log?: Logger } = {}) {
    return new DurableActions({
      db,
      log: overrides.log ?? createLogger("test", "error"),
      capabilityKey: KEY,
      publicUrl: URL,
      sessions: () => sessions,
      platformTools: () => ({ register: (definition) => tools.set(definition.name, definition), get: (name) => tools.get(name) }),
      publish: overrides.publish ?? ((event) => published.push(event)),
      now: () => now,
      options: { sweepIntervalMs: 0, notifyDebounceMs: 1, ...options },
    });
  }

  function input(event: RuntimeSessionEvent, attached: AttachedResponder[] = [], generation = 0) {
    return { sessionId: SESSION, ownerId: OWNER.accountId, environment: "chat", generation, event, attached };
  }

  const user = (principal: Principal = OWNER) => ({ type: "user" as const, principal });

  /** Core committed a move to `generation`; promotion then tells the ledger which requests the new placement carries. */
  function promote(generation: number, carried?: string[]) {
    sessions.views.set(SESSION, { ...sessions.views.get(SESSION)!, generation });
    actions.onGenerationChanged(SESSION, generation, carried ? { carried } : {});
  }

  /** Holds the runtime's pending-list answers (reconciliation in flight) until the returned function is called. */
  function holdPendingLists(): () => void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const request = sessions.request.bind(sessions);
    sessions.request = (async <T,>(sessionId: string, method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "session.tools.listPendingRequests" || method === "session.permissions.pendingRequests") await gate;
      return request<T>(sessionId, method, params);
    }) as typeof sessions.request;
    return release;
  }

  const states = () => Object.fromEntries(actions.list(SESSION).map((action) => [action.requestId, action.state]));

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db, "durable", DURABLE_MIGRATIONS);
    sessions = new FakeSessions();
    sessions.views.set(SESSION, { id: SESSION, ownerId: OWNER.accountId, environment: "chat", state: "running", generation: 0, incarnation: "inc-1" });
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
      expect(sessions.answers()).toEqual([{ sessionId: SESSION, method: "session.tools.handlePendingToolCall", params: { sessionId: SESSION, requestId: "r1", result: "shipped" }, generation: 0 }]);
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

    it("never claims for a client that detached again while resuming the same session", async () => {
      await actions.onSessionEvent(input(permissionEvent("p1"), [sdk("c1", [])]));
      actions.onDetached("c1", SESSION);
      const first = await actions.onAttached({ sessionId: SESSION, ownerId: OWNER.accountId, environment: "chat", generation: 0, responder: sdk("c1", []) });
      expect(first).toHaveLength(1);
      actions.onDetached("c1", SESSION);
      const release = holdPendingLists();
      const attaching = actions.onAttached({ sessionId: SESSION, ownerId: OWNER.accountId, environment: "chat", generation: 0, responder: sdk("c1", []) });
      actions.onDetached("c1", SESSION);
      release();
      expect(await attaching).toEqual([]);
      expect(actions.list(SESSION)[0]!.state).toBe("pending");
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

    it("keeps an announcement repairable when publishing it fails", async () => {
      let fail = true;
      actions.stop();
      actions = build({}, {
        log: quiet,
        publish: (event) => {
          if (fail) throw new Error("outbox unavailable");
          published.push(event);
        },
      });
      await actions.onSessionEvent(input(toolEvent("r1")));
      await sleep(20);
      expect(published).toHaveLength(0);
      fail = false;
      now += 10_000;
      await actions.sweep();
      await sleep(20);
      expect(published.map((event) => event.type)).toEqual(["session.action_required"]);
    });

    it("keeps a re-offered action repairable when its new announcement fails", async () => {
      let fail = false;
      actions.stop();
      actions = build({}, {
        log: quiet,
        publish: (event) => {
          if (fail) throw new Error("outbox unavailable");
          published.push(event);
        },
      });
      await actions.onSessionEvent(input(toolEvent("r1")));
      await sleep(20);
      expect(published).toHaveLength(1);
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id);
      fail = true;
      await actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, release: true });
      await sleep(20);
      expect(published).toHaveLength(1);
      fail = false;
      now += 10_000;
      await actions.sweep();
      await sleep(20);
      expect(published).toHaveLength(2);
    });

    it("announces only once the webhook outbox has queued it, even behind an event bus that isolates errors", async () => {
      const deployment = parseConfig({
        environments: { chat: { type: "shared" } },
        webhooks: { orders: { url: "http://127.0.0.1:9/hook", environments: ["chat"], events: ["session.action_required"], secret: { secretEnv: "ORDERS_SECRET" } } },
      });
      const webhooks = new DurableWebhooks({ db, log: quiet, deployment, mode: "local", env: { ORDERS_SECRET: "secret" }, actions: () => actions, now: () => now, options: { pollIntervalMs: 0 } });
      await webhooks.stop(); // queue only: nothing is sent in this test
      // Like core's PlatformEvents: a failing subscriber never reaches the publisher.
      const bus: DurableEventsPort = {
        publish: (event, meta) => {
          try {
            webhooks.enqueue(event, meta);
          } catch {
            // isolated
          }
        },
        subscribe: () => () => undefined,
      };
      actions.stop();
      actions = build({}, { log: quiet, publish: announcer(() => webhooks, () => bus) });
      db.exec("CREATE TRIGGER outbox_down BEFORE INSERT ON durable_webhook_deliveries BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END;");
      await actions.onSessionEvent(input(toolEvent("r1")));
      await sleep(20);
      expect(webhooks.deliveries()).toHaveLength(0);
      db.exec("DROP TRIGGER outbox_down");
      now += 10_000;
      await actions.sweep();
      await sleep(20);
      expect(webhooks.deliveries().map((delivery) => delivery.eventType)).toEqual(["session.action_required"]);
    });

    it("names the tool a permission prompt is for", async () => {
      const event = permissionEvent("p1");
      await actions.onSessionEvent(input({ ...event, data: { ...event.data, permissionRequest: { kind: "custom-tool", toolName: "lookup_order", toolDescription: "", toolCallId: "call-1" } } }));
      expect(actions.list(SESSION)[0]).toMatchObject({ kind: "permission", tool: "lookup_order", toolCallId: "call-1" });
    });

    it("releases only one session's live claims when a client detaches from that session", async () => {
      const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
      sessions.views.set(OTHER_SESSION, { id: OTHER_SESSION, ownerId: OWNER.accountId, environment: "chat", state: "running", generation: 0, incarnation: "inc-other" });
      await actions.onSessionEvent(input(toolEvent("r1"), [sdk("c1", ["lookup_order"])]));
      await actions.onSessionEvent({ ...input(toolEvent("r2"), [sdk("c1", ["lookup_order"])]), sessionId: OTHER_SESSION });
      actions.onDetached("c1", SESSION);
      expect(actions.list(SESSION)[0]!.state).toBe("needs_reconciliation");
      expect(actions.list(OTHER_SESSION)[0]!.state).toBe("executing");
    });

    it("replays to the same client when it resumes a session it detached from", async () => {
      await actions.onSessionEvent(input(permissionEvent("p1"), [sdk("c1", [])]));
      actions.onDetached("c1", SESSION);
      expect(actions.list(SESSION)[0]!.state).toBe("pending");
      const replay = await actions.onAttached({ sessionId: SESSION, ownerId: OWNER.accountId, environment: "chat", generation: 0, responder: sdk("c1", []) });
      expect(replay.map((event) => event.data.requestId)).toEqual(["p1"]);
    });

    it("cancels a deleted session's actions, refuses their claims, and stops undeliverable answers", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      await actions.onSessionEvent(input(toolEvent("r2")));
      const [first, second] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, second!.id);
      sessions.failRequests = 1;
      await actions.submit(user(), SESSION, second!.id, { claimToken: claim.claimToken, result: "ok" });
      sessions.views.delete(SESSION);
      actions.onSessionDeleted(SESSION, "inc-1");
      expect(actions.list(SESSION, { incarnation: "inc-1" }).map((action) => [action.state, action.reason])).toEqual([
        ["cancelled", "The session was deleted"],
        ["completed", "Not delivered: the session was deleted"],
      ]);
      await expectCode(actions.claim(user(), SESSION, first!.id), "not_found");
      now += 60_000;
      await actions.sweep();
      await sleep(10);
      expect(sessions.answers()).toHaveLength(1);
    });

    it("stops retrying an answer whose session no longer exists", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id);
      sessions.failRequests = 1;
      await actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: "ok" });
      // Deleted without the lifecycle event reaching the ledger: the next delivery attempt finds nobody to tell.
      sessions.views.delete(SESSION);
      now += 60_000;
      await actions.sweep();
      await sleep(10);
      expect(actions.list(SESSION, { incarnation: "inc-1" })[0]!.reason).toBe("Not delivered: the session no longer exists");
      now += 60_000;
      await actions.sweep();
      await sleep(10);
      expect(sessions.answers()).toHaveLength(1);
    });

    it("moves waiting actions to a new placement generation and fences the old owners", async () => {
      await actions.onSessionEvent(input(toolEvent("waiting")));
      await actions.onSessionEvent(input(toolEvent("running"), [sdk("c1", ["lookup_order"])]));
      await actions.onSessionEvent(input(permissionEvent("prompt"), [sdk("c1", [])]));
      const [waiting, running] = actions.list(SESSION);
      const stale = await actions.claim(user(), SESSION, waiting!.id);
      await actions.submit(user(), SESSION, waiting!.id, { claimToken: stale.claimToken, release: true });

      sessions.views.set(SESSION, { ...sessions.views.get(SESSION)!, generation: 1 });
      actions.onGenerationChanged(SESSION, 1);
      const states = Object.fromEntries(actions.list(SESSION).map((action) => [action.requestId, action.state]));
      expect(states).toEqual({ waiting: "pending", running: "needs_reconciliation", prompt: "pending" });
      // The old live owner's late answer is refused; answers in the new generation are delivered.
      await expectCode(
        actions.onClientAnswer({ sessionId: SESSION, connectionId: "c1", responderKind: "sdk", method: "session.tools.handlePendingToolCall", params: { requestId: "running", result: "late" } }),
        "conflict",
      );
      const fresh = await actions.claim(user(), SESSION, waiting!.id);
      await actions.submit(user(), SESSION, waiting!.id, { claimToken: fresh.claimToken, result: "ok" });
      expect(sessions.answers().map((answer) => answer.params.requestId)).toEqual(["waiting"]);
      void running;
    });

    it("keeps carried claims and the gateway's own platform tool across a move, and answers the new placement", async () => {
      let finish!: (value: string) => void;
      tools.set("request_sandbox", {
        name: "request_sandbox",
        description: "",
        parameters: {},
        enabledFor: () => true,
        handler: () => new Promise<string>((resolve) => (finish = resolve)),
      });
      await actions.onSessionEvent(input(toolEvent("sandbox", "request_sandbox", {})));
      await actions.onSessionEvent(input(toolEvent("carried"), [sdk("c1", ["lookup_order"])]));
      await actions.onSessionEvent(input(toolEvent("fenced")));
      const fenced = actions.list(SESSION).find((action) => action.requestId === "fenced")!;
      const stale = await actions.claim(user(), SESSION, fenced.id);

      promote(1, ["carried"]);
      promote(1); // the session.promoted event that follows the direct call changes nothing
      expect(states()).toEqual({ sandbox: "executing", carried: "executing", fenced: "needs_reconciliation" });

      finish("sandbox ready");
      await sleep(10);
      await actions.onClientAnswer({ sessionId: SESSION, connectionId: "c1", responderKind: "sdk", method: "session.tools.handlePendingToolCall", params: { requestId: "carried", result: "found" } });
      await expectCode(actions.submit(user(), SESSION, fenced.id, { claimToken: stale.claimToken, result: "late" }), "conflict");
      expect(sessions.answers().map((answer) => answer.params.requestId)).toEqual(["sandbox", "carried"]);
      expect(states()).toEqual({ sandbox: "completed", carried: "completed", fenced: "needs_reconciliation" });
    });

    it("voids an uncertain tool's standing claim when the session moves, unless the new placement carries it", async () => {
      await actions.onSessionEvent(input(toolEvent("uncertain")));
      await actions.onSessionEvent(input(toolEvent("kept")));
      const [uncertain, kept] = actions.list(SESSION);
      const first = await actions.claim(user(), SESSION, uncertain!.id, { leaseSeconds: 5 });
      const second = await actions.claim(user(), SESSION, kept!.id, { leaseSeconds: 5 });
      now += 6_000;
      await actions.sweep();
      expect(states()).toEqual({ uncertain: "needs_reconciliation", kept: "needs_reconciliation" });

      promote(1, ["kept"]);
      // The original claimant's late result is the true outcome only within its placement...
      await expectCode(actions.submit(user(), SESSION, uncertain!.id, { claimToken: first.claimToken, result: "late" }), "conflict");
      // ...or for a request the new placement still waits for.
      await actions.submit(user(), SESSION, kept!.id, { claimToken: second.claimToken, result: "late but carried" });
      const reconcile = await actions.claim(user(), SESSION, uncertain!.id, { reconcile: true });
      await actions.submit(user(), SESSION, uncertain!.id, { claimToken: reconcile.claimToken, result: "reconciled" });
      expect(sessions.answers().map((answer) => answer.params.requestId)).toEqual(["kept", "uncertain"]);
    });

    it("refuses a fenced live client's late answer and offers the prompt to someone else", async () => {
      await actions.onSessionEvent(input(permissionEvent("p1"), [sdk("c1", [])]));
      promote(1);
      expect(states()).toEqual({ p1: "pending" });
      const approve = {
        sessionId: SESSION,
        connectionId: "c1",
        responderKind: "sdk" as const,
        method: "session.permissions.handlePendingPermissionRequest",
        params: { requestId: "p1", result: { kind: "approve-once" } },
      };
      await expectCode(actions.onClientAnswer(approve), "conflict");
      expect(await actions.onAttached({ sessionId: SESSION, ownerId: OWNER.accountId, environment: "chat", generation: 1, responder: sdk("c1", []) })).toEqual([]);
      // Asked again by the new placement, the prompt goes to another eligible client and never back to c1.
      const decision = await actions.onSessionEvent(input(permissionEvent("p1"), [sdk("c1", []), sdk("c2", [])], 1));
      expect(decision).toMatchObject({ owner: "c2", withhold: ["c1"] });
      await actions.onClientAnswer({ ...approve, connectionId: "c2" });
      expect(sessions.answers().map((answer) => answer.params.requestId)).toEqual(["p1"]);
    });

    it("delivers an answer recorded before a move only to a placement that still waits for that request", async () => {
      await actions.onSessionEvent(input(toolEvent("awaited")));
      await actions.onSessionEvent(input(permissionEvent("asked-again")));
      const [tool, prompt] = actions.list(SESSION);
      const toolClaim = await actions.claim(user(), SESSION, tool!.id);
      const promptClaim = await actions.claim(user(), SESSION, prompt!.id);
      // Core committed the move; the ledger has not been told yet.
      sessions.views.set(SESSION, { ...sessions.views.get(SESSION)!, generation: 1 });
      sessions.pendingTools.set(SESSION, [{ requestId: "awaited", toolCallId: "call-awaited", toolName: "lookup_order", arguments: {} }]);
      await actions.submit(user(), SESSION, tool!.id, { claimToken: toolClaim.claimToken, result: "ok" });
      await actions.submit(user(), SESSION, prompt!.id, { claimToken: promptClaim.claimToken, result: { kind: "approve-once" } });
      expect(sessions.answers().map((answer) => answer.params.requestId)).toEqual(["awaited"]);
      expect(actions.list(SESSION)[1]!.reason).toMatch(/generation 1, which does not wait/);
      // The new placement asks for the prompt again: it receives the recorded decision, and nobody is asked twice.
      const decision = await actions.onSessionEvent(input(permissionEvent("asked-again"), [sdk("c2", [])], 1));
      expect(decision.owner).toBeUndefined();
      await sleep(10);
      expect(sessions.answers().map((answer) => answer.params.requestId)).toEqual(["awaited", "asked-again"]);
      expect(actions.list(SESSION)[1]!.reason).toBeUndefined();
    });

    it("never records or hands out actions of a session deleted while reconciling", async () => {
      sessions.pendingTools.set(SESSION, [{ requestId: "late", toolCallId: "call-late", toolName: "lookup_order", arguments: {} }]);
      const release = holdPendingLists();
      const reconciling = actions.reconcile(SESSION);
      sessions.views.delete(SESSION);
      actions.onSessionDeleted(SESSION);
      release();
      await reconciling;
      await sleep(10);
      expect(actions.list(SESSION, { incarnation: "inc-1" })).toEqual([]);
      expect(published).toHaveLength(0);
      const decision = await actions.onSessionEvent(input(toolEvent("after"), [sdk("c1", ["lookup_order"])]));
      expect(decision).toEqual({ withhold: ["c1"] });
      expect(actions.list(SESSION, { incarnation: "inc-1" })).toEqual([]);
    });

    it("refuses to hand out an action whose session no longer exists", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const [action] = actions.list(SESSION);
      const capability = actions.verifyCapability(actions.mintCapability(SESSION, [action!.id], "orders")!.token);
      sessions.views.delete(SESSION); // deleted without the lifecycle event reaching the ledger
      await expectCode(actions.claim(user(), SESSION, action!.id), "not_found");
      await expectCode(actions.claim({ type: "capability", capability }, SESSION, action!.id), "conflict");
      expect(await actions.listFor({ type: "capability", capability }, SESSION)).toEqual([]);
    });

    it("never lets a late acknowledgment from the old placement stand in for delivery to the new one", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id);
      let release!: () => void;
      sessions.holdNextAnswer = new Promise<void>((resolve) => (release = resolve));
      const submitting = actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: "ok" });
      await sleep(5); // sent to placement 0, not acknowledged yet
      sessions.failRequests = 1; // the first delivery to placement 1 fails
      promote(1, ["r1"]);
      await sleep(10);
      release(); // placement 0 acknowledges late
      await submitting;
      now += 2_000;
      await actions.sweep();
      await sleep(10);
      expect(sessions.answers().map((answer) => [answer.params.requestId, answer.generation])).toEqual([
        ["r1", 0],
        ["r1", 1],
        ["r1", 1],
      ]);
      expect(actions.store.get(action!.id)).toMatchObject({ generation: 1, forwarded: 1 });
    });

    it("delivers a carried answer to the new placement even after the old one acknowledged it", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id);
      await actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: "ok" });
      promote(1, ["r1"]);
      await sleep(10);
      expect(sessions.answers().map((answer) => [answer.params.requestId, answer.generation])).toEqual([
        ["r1", 0],
        ["r1", 1],
      ]);
    });

    it("never hands a prompt back to a client that held it before the session moved", async () => {
      await actions.onSessionEvent(input(permissionEvent("p1"), [sdk("c1", [])]));
      actions.onDetached("c1", SESSION); // its permission callback may still be running
      promote(1);
      const attach = (connectionId: string) => actions.onAttached({ sessionId: SESSION, ownerId: OWNER.accountId, environment: "chat", generation: 1, responder: sdk(connectionId, []) });
      expect(await attach("c1")).toEqual([]);
      const late = { sessionId: SESSION, connectionId: "c1", responderKind: "sdk" as const, method: "session.permissions.handlePendingPermissionRequest", params: { requestId: "p1", result: { kind: "approve-once" } } };
      await expectCode(actions.onClientAnswer(late), "conflict");
      expect((await attach("c2")).map((event) => event.data.requestId)).toEqual(["p1"]);
      // The fence is ledger state, not an evictable cache.
      actions.stop();
      actions = build();
      await expectCode(actions.onClientAnswer(late), "conflict");
    });

    it("ignores what the old placement reports once the session has moved", async () => {
      await actions.onSessionEvent(input(toolEvent("r1"), [sdk("c1", ["lookup_order"])]));
      now += 5_000;
      const release = holdPendingLists();
      const reconciling = actions.reconcile(SESSION); // asks placement 0, which no longer lists r1
      promote(1, ["r1"]);
      release();
      await reconciling;
      // A completion that placement 0 emitted arrives late.
      await actions.onSessionEvent(input(completedEvent("external_tool.completed", "r1"), [sdk("c1", ["lookup_order"])], 0));
      expect(states()).toEqual({ r1: "executing" });
      await actions.onClientAnswer({ sessionId: SESSION, connectionId: "c1", responderKind: "sdk", method: "session.tools.handlePendingToolCall", params: { requestId: "r1", result: "found" } });
      expect(sessions.answers().map((answer) => [answer.params.requestId, answer.generation])).toEqual([["r1", 1]]);
    });

    it("applies nothing from reconciliation when the ledger moved the session before core's record shows it", async () => {
      await actions.onSessionEvent(input(toolEvent("r1"), [sdk("c1", ["lookup_order"])]));
      now += 5_000;
      // Placement 0's lists no longer include r1 and name a call the destination does not have.
      sessions.pendingTools.set(SESSION, [{ requestId: "ghost", toolCallId: "call-ghost", toolName: "lookup_order", arguments: {} }]);
      const release = holdPendingLists();
      const reconciling = actions.reconcile(SESSION);
      // Promotion told the ledger first; the session record still says placement 0 when reconciliation resumes.
      actions.onGenerationChanged(SESSION, 1, { carried: ["r1"] });
      release();
      await reconciling;
      await sleep(10);
      expect(states()).toEqual({ r1: "executing" });
      expect(published).toHaveLength(0);
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

    /** A platform tool whose runs wait until released (or aborted); records every context it got. */
    function heldTool(name: string, extra: Partial<PlatformToolDefinition> = {}) {
      const runs: { context: PlatformToolContext; release: (value: string) => void; aborted: Promise<unknown> }[] = [];
      tools.set(name, {
        name,
        description: "",
        parameters: {},
        enabledFor: () => true,
        handler: (_args, context) =>
          new Promise<string>((resolve, reject) => {
            const aborted = new Promise<unknown>((settle) => context.signal?.addEventListener("abort", () => settle(context.signal!.reason), { once: true }));
            runs.push({ context, release: resolve, aborted });
            context.signal?.addEventListener("abort", () => reject(context.signal!.reason), { once: true });
          }),
        ...extra,
      });
      return runs;
    }

    const subagentEvent = (requestId: string, toolName: string, agentId: string): RuntimeSessionEvent => ({ ...toolEvent(requestId, toolName, { command: "ls" }), agentId });

    it("tells the handler which agent called it, and keeps that across a gateway restart", async () => {
      const runs = heldTool("bash");
      await actions.onSessionEvent(input(subagentEvent("t1", "bash", "agent-7")));
      await actions.onSessionEvent(input(toolEvent("t2", "bash")));
      await sleep(5);
      const [sub, root] = runs;
      expect(sub!.context).toMatchObject({ agentId: "agent-7", toolCallId: "call-t1", idempotencyKey: `${SESSION}:call-t1` });
      expect(sub!.context.actionId).toBe(actions.list(SESSION).find((action) => action.requestId === "t1")!.id);
      expect(sub!.context.signal?.aborted).toBe(false);
      expect(root!.context.agentId).toBeUndefined();
      // The gateway stops mid-run: the handlers are aborted as shutting down, and nothing is recorded as their outcome.
      actions.stop();
      expect(await sub!.aborted).toMatchObject({ code: "capability_unavailable" });
      await sleep(5);
      expect(states()).toEqual({ t1: "executing", t2: "executing" });
      expect(sessions.answers()).toEqual([]);
      // The next start runs them again (default replay), with the same agent and key.
      actions = build();
      actions.recover();
      await sleep(5);
      expect(runs.slice(2).map((run) => [run.context.agentId, run.context.idempotencyKey])).toEqual([
        ["agent-7", `${SESSION}:call-t1`],
        [undefined, `${SESSION}:call-t2`],
      ]);
      runs[2]!.release("ok");
      await sleep(5);
      expect(sessions.answers().map((sent) => [sent.params.requestId, sent.params.result])).toEqual([["t1", "ok"]]);
    });

    it("aborts the handler when the runtime stops waiting for the call or the session is deleted", async () => {
      const runs = heldTool("bash");
      await actions.onSessionEvent(input(toolEvent("t1", "bash")));
      await actions.onSessionEvent(input(toolEvent("t2", "bash")));
      await sleep(5);
      // The turn is cancelled: the runtime completes its request without the gateway's answer.
      await actions.onSessionEvent(input(completedEvent("external_tool.completed", "t1")));
      expect(await runs[0]!.aborted).toMatchObject({ code: "conflict", message: expect.stringContaining("stopped waiting") });
      expect(runs[1]!.context.signal?.aborted).toBe(false);
      sessions.views.delete(SESSION);
      actions.onSessionDeleted(SESSION, "inc-1");
      expect(await runs[1]!.aborted).toMatchObject({ code: "not_found" });
      await sleep(5);
      expect(sessions.answers()).toEqual([]);
    });

    it("does not abort a call that finished, and keeps today's behavior for handlers that ignore the signal", async () => {
      let seen: AbortSignal | undefined;
      tools.set("schedule_task", {
        name: "schedule_task",
        description: "",
        parameters: {},
        enabledFor: () => true,
        handler: async (_args, context) => {
          seen = context.signal;
          return "done";
        },
      });
      await actions.onSessionEvent(input(toolEvent("t1", "schedule_task")));
      await sleep(5);
      await actions.onSessionEvent(input(completedEvent("external_tool.completed", "t1")));
      expect(seen?.aborted).toBe(false);
      expect(states()).toEqual({ t1: "completed" });
    });

    it('never reruns a replay: "never" tool after a restart: its recover hook answers with the same context', async () => {
      const recovered: PlatformToolContext[] = [];
      const runs = heldTool("bash", {
        replay: "never",
        recover: async (_args, context) => {
          recovered.push(context);
          return "reattached: exit 0";
        },
      });
      await actions.onSessionEvent(input(subagentEvent("t1", "bash", "agent-7")));
      await sleep(5);
      actions.stop();
      actions = build();
      actions.recover();
      await sleep(5);
      expect(runs).toHaveLength(1);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ agentId: "agent-7", idempotencyKey: runs[0]!.context.idempotencyKey, actionId: runs[0]!.context.actionId });
      expect(sessions.answers().map((sent) => [sent.params.requestId, sent.params.result])).toEqual([["t1", "reattached: exit 0"]]);
    });

    it('fails an interrupted replay: "never" tool without a recover hook as "may have run"', async () => {
      const runs = heldTool("bash", { replay: "never" });
      await actions.onSessionEvent(input(toolEvent("t1", "bash")));
      await sleep(5);
      actions.stop();
      actions = build();
      actions.recover();
      await sleep(5);
      expect(runs).toHaveLength(1);
      expect(states()).toEqual({ t1: "failed" });
      const [answer] = sessions.answers();
      expect(answer!.params).toMatchObject({ requestId: "t1", error: expect.stringContaining("may have run") });
      expect(String(answer!.params.error)).toContain("was not run again");
    });

    it('recovers instead of rerunning when a restarted runtime rebuilds a replay: "never" call that was cut off', async () => {
      let recovers = 0;
      const runs = heldTool("bash", {
        replay: "never",
        recover: async () => {
          recovers++;
          return "exit 137 (killed)";
        },
      });
      await actions.onSessionEvent(input(toolEvent("t1", "bash")));
      await sleep(5);
      await actions.onSessionEvent(input(completedEvent("external_tool.completed", "t1")));
      await runs[0]!.aborted;
      const again = toolEvent("t1-rebuilt", "bash");
      await actions.onSessionEvent(input({ ...again, data: { ...again.data, toolCallId: "call-t1" } }));
      await sleep(10);
      expect(runs).toHaveLength(1);
      expect(recovers).toBe(1);
      expect(sessions.answers().map((sent) => [sent.params.requestId, sent.params.result])).toEqual([["t1-rebuilt", "exit 137 (killed)"]]);
    });

    it("keeps an interrupted call uncertain when its tool is not registered at restart, and recovers it once it is", async () => {
      let recovers = 0;
      const runs = heldTool("bash", {
        replay: "never",
        recover: async () => {
          recovers++;
          return "reattached";
        },
      });
      const definition = tools.get("bash")!;
      await actions.onSessionEvent(input(toolEvent("t1", "bash")));
      await sleep(5);
      actions.stop();
      tools.delete("bash");
      actions = build();
      actions.recover();
      expect(states()).toEqual({ t1: "needs_reconciliation" });
      // The restarted runtime asks again before the tool registers: still uncertain, never rerun later.
      const early = toolEvent("t1-early", "bash");
      await actions.onSessionEvent(input({ ...early, data: { ...early.data, toolCallId: "call-t1" } }));
      expect(states()).toEqual({ "t1-early": "needs_reconciliation" });
      tools.set("bash", definition);
      const again = toolEvent("t1-rebuilt", "bash");
      await actions.onSessionEvent(input({ ...again, data: { ...again.data, toolCallId: "call-t1" } }));
      await sleep(10);
      expect(runs).toHaveLength(1);
      expect(recovers).toBe(1);
      expect(sessions.answers().map((sent) => [sent.params.requestId, sent.params.result])).toEqual([["t1-rebuilt", "reattached"]]);
    });

    it("records nothing for a call that settles after shutdown began, even once the ledger is closed", async () => {
      let finish!: () => void;
      tools.set("bash", {
        name: "bash",
        description: "",
        parameters: {},
        enabledFor: () => true,
        // Cleans up after the abort, then resolves.
        handler: (_args, context) => new Promise<string>((resolve) => context.signal?.addEventListener("abort", () => (finish = () => resolve("cleaned up")), { once: true })),
      });
      await actions.onSessionEvent(input(toolEvent("t1", "bash")));
      await sleep(5);
      actions.stop();
      expect(states()).toEqual({ t1: "executing" });
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      const other = openDatabase(":memory:");
      const closed = db;
      db = other;
      closed.close();
      finish();
      await sleep(20);
      process.off("unhandledRejection", onUnhandled);
      expect(unhandled).toEqual([]);
      expect(sessions.answers()).toEqual([]);
    });
  });

  describe("session incarnations", () => {
    const capabilityFor = (actionId: string) => ({ type: "capability" as const, capability: actions.verifyCapability(actions.mintCapability(SESSION, [actionId], "orders")!.token) });

    it("never shows or hands one session's actions to a later session that reuses its ID", async () => {
      await actions.onSessionEvent(input(toolEvent("r1", "lookup_order", { card: "4111-private" })));
      const [old] = actions.list(SESSION);
      const oldCapability = capabilityFor(old!.id);
      // The owner deletes the session; another account creates one with the same ID.
      sessions.views.delete(SESSION);
      actions.onSessionDeleted(SESSION, "inc-1");
      sessions.views.set(SESSION, { id: SESSION, ownerId: STRANGER.accountId, environment: "chat", state: "running", generation: 0, incarnation: "inc-2" });
      expect(await actions.listFor(user(STRANGER), SESSION)).toEqual([]);
      expect(actions.list(SESSION)).toEqual([]);
      await expectCode(actions.claim(user(STRANGER), SESSION, old!.id), "not_found");
      await expectCode(actions.listFor(user(OWNER), SESSION), "not_found");
      expect(await actions.listFor(oldCapability, SESSION)).toEqual([]);
      await expectCode(actions.claim(oldCapability, SESSION, old!.id), "conflict");
      // The new session's requests are recorded and offered normally; nothing from the old one leaks into them.
      await actions.onSessionEvent({ ...input(toolEvent("r2")), ownerId: STRANGER.accountId });
      const listed = await actions.listFor(user(STRANGER), SESSION);
      expect(listed.map((action) => action.requestId)).toEqual(["r2"]);
      expect(JSON.stringify(listed)).not.toContain("4111-private");
      expect(await actions.listFor(capabilityFor(listed[0]!.id), SESSION)).toHaveLength(1);
      // A late deletion notice for the old session leaves the new one alone.
      actions.onSessionDeleted(SESSION, "inc-1");
      expect(actions.list(SESSION).map((action) => action.state)).toEqual(["pending"]);
      // A client of the deleted session never reaches the new session's runtime, even for a request nobody tracks.
      await expectCode(
        actions.onClientAnswer({ sessionId: SESSION, incarnation: "inc-1", connectionId: "old-app", responderKind: "sdk", method: "session.tools.handlePendingToolCall", params: { requestId: "r9", result: "x" } }),
        "conflict",
      );
    });

    it("assigns actions recorded before incarnations to the session that owns them now and retires the rest", async () => {
      await actions.onSessionEvent(input(toolEvent("older")));
      now += 1_000;
      const createdAt = new Date(now).toISOString();
      now += 1_000;
      await actions.onSessionEvent(input(toolEvent("newer")));
      await actions.onSessionEvent({ ...input(toolEvent("foreign")), ownerId: STRANGER.accountId });
      db.exec("UPDATE durable_actions SET incarnation = NULL");
      sessions.views.set(SESSION, { ...sessions.views.get(SESSION)!, incarnation: "inc-2", createdAt });
      actions.assignIncarnations();
      expect(actions.list(SESSION).map((action) => [action.requestId, action.state])).toEqual([["newer", "pending"]]);
      expect(db.prepare("SELECT request_id, incarnation, state FROM durable_actions WHERE incarnation = 'retired' ORDER BY request_id").all()).toEqual([
        { request_id: "foreign", incarnation: "retired", state: "cancelled" },
        { request_id: "older", incarnation: "retired", state: "cancelled" },
      ]);
    });

    it("re-keys actions recorded under a provisional incarnation once core reports the real one", async () => {
      const createdAt = "2026-10-23T11:00:00.000Z";
      sessions.views.set(SESSION, { id: SESSION, ownerId: OWNER.accountId, environment: "chat", state: "running", generation: 0, createdAt });
      await actions.onSessionEvent(input(toolEvent("r1")));
      expect(db.prepare("SELECT incarnation FROM durable_actions").get()).toEqual({ incarnation: `created:${createdAt}` });
      // A later gateway build: core now reports the session's incarnation.
      sessions.views.set(SESSION, { ...sessions.views.get(SESSION)!, incarnation: "inc-real" });
      actions.assignIncarnations();
      expect(actions.list(SESSION).map((action) => [action.requestId, action.state])).toEqual([["r1", "pending"]]);
    });

    it("closes, at startup, the open actions of a session deleted while the ledger could not observe it", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id);
      sessions.failRequests = 1;
      await actions.onSessionEvent(input(toolEvent("r2")));
      await actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: "ok" });
      actions.stop();
      // Deleted (and the ID reused) while the gateway was down.
      sessions.views.set(SESSION, { id: SESSION, ownerId: STRANGER.accountId, environment: "chat", state: "idle", generation: 0, incarnation: "inc-new" });
      const restarted = build();
      restarted.start();
      expect(restarted.list(SESSION, { incarnation: "inc-1" }).map((row) => [row.requestId, row.state, row.reason])).toEqual([
        ["r1", "completed", "Not delivered: the session was deleted"],
        ["r2", "cancelled", "The session was deleted"],
      ]);
      expect(restarted.hasOpenActions(SESSION)).toBe(false);
      restarted.stop();
    });

    it("announces waiting actions to the session's current owner and environment, even after its ID was reused", async () => {
      const owners: number[] = [];
      actions.stop();
      actions = build({ notifyDebounceMs: 20 }, { publish: (event, meta) => (published.push(event), owners.push(meta.ownerId)) });
      await actions.onSessionEvent(input(toolEvent("r1")));
      // Deleted and the ID reused by another account before the announcement went out (the deletion is announced late).
      sessions.views.set(SESSION, { id: SESSION, ownerId: STRANGER.accountId, environment: "other", state: "running", generation: 0, incarnation: "inc-2" });
      await actions.onSessionEvent({ ...input(toolEvent("r2")), ownerId: STRANGER.accountId, environment: "other" });
      await sleep(50);
      expect(owners).toEqual([STRANGER.accountId]);
      expect(published.map((event) => [event.environment, (event.data.actions as { idempotencyKey: string }[]).map((action) => action.idempotencyKey)])).toEqual([
        ["other", [`${SESSION}:call-r2`]],
      ]);
    });

    it("refuses answers and stops deliveries for a session that no longer exists", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id);
      let release!: () => void;
      sessions.holdNextAnswer = new Promise<void>((resolve) => (release = resolve));
      const submitting = actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: "ok" });
      await sleep(5);
      // Deleted and the ID reused while the answer was on its way: core refuses it for the old incarnation.
      sessions.views.set(SESSION, { id: SESSION, ownerId: OWNER.accountId, environment: "chat", state: "running", generation: 0, incarnation: "inc-2" });
      release();
      await submitting;
      expect(actions.store.get(action!.id)).toMatchObject({ forwarded: 1, reason: "Not delivered: the session no longer exists" });
      expect(sessions.fences.filter((call) => call.method.includes("handlePending"))).toEqual([{ method: "session.tools.handlePendingToolCall", incarnation: "inc-1" }]);
      now += 60_000;
      await actions.sweep();
      expect(sessions.answers()).toHaveLength(1);
      // With no session at all, a client's answer is refused rather than passed to a runtime.
      sessions.views.delete(SESSION);
      await expectCode(
        actions.onClientAnswer({ sessionId: SESSION, connectionId: "c1", responderKind: "sdk", method: "session.tools.handlePendingToolCall", params: { requestId: "r9", result: "x" } }),
        "conflict",
      );
    });

    it("drops a deleted session's pending announcements only while its ID names no newer session", () => {
      expect(ownsPendingDeliveries(undefined, "inc-1")).toBe(true);
      expect(ownsPendingDeliveries({ id: SESSION, ownerId: 1, environment: "chat", state: "deleting", generation: 0, incarnation: "inc-1" }, "inc-1")).toBe(true);
      expect(ownsPendingDeliveries({ id: SESSION, ownerId: 1, environment: "chat", state: "idle", generation: 0, incarnation: "inc-1" }, "inc-1")).toBe(true);
      expect(ownsPendingDeliveries({ id: SESSION, ownerId: 2, environment: "chat", state: "idle", generation: 0, incarnation: "inc-2" }, "inc-1")).toBe(false);
      expect(ownsPendingDeliveries({ id: SESSION, ownerId: 2, environment: "chat", state: "idle", generation: 0, incarnation: "inc-2" }, undefined)).toBe(false);
    });
  });

  describe("permission authority", () => {
    const capabilityFor = (actionId: string) => ({ type: "capability" as const, capability: actions.verifyCapability(actions.mintCapability(SESSION, [actionId], "orders")!.token) });
    const answer = (requestId: string, connectionId: string, result: unknown, responderKind: "sdk" | "cli" = "sdk") =>
      actions.onClientAnswer({ sessionId: SESSION, connectionId, responderKind, method: "session.permissions.handlePendingPermissionRequest", params: { requestId, result } });

    it("lets a webhook approve once, reject, or report nobody, but never speak for a person or grant a standing approval", async () => {
      await actions.onSessionEvent(input(permissionEvent("p1")));
      const [action] = actions.list(SESSION);
      const caller = capabilityFor(action!.id);
      const { claimToken } = await actions.claim(caller, SESSION, action!.id);
      for (const result of [
        { kind: "approve-once", approvedInteractively: true },
        { kind: "denied-interactively-by-user" },
        { kind: "approve-for-session", approval: { kind: "commands", commandIdentifiers: ["ls"] } },
        { kind: "approve-for-location", approval: { kind: "commands", commandIdentifiers: ["ls"] }, locationKey: "/repo" },
        { kind: "approve-permanently", domain: "example.com" },
        { kind: "approved" },
      ]) {
        await expectCode(actions.submit(caller, SESSION, action!.id, { claimToken, result }), "forbidden");
      }
      await expectCode(actions.submit(caller, SESSION, action!.id, { claimToken, result: { kind: "approve-sometimes" } }), "forbidden");
      expect(await actions.submit(caller, SESSION, action!.id, { claimToken, result: { kind: "approve-once" } })).toMatchObject({ state: "completed" });
      expect(sessions.answers().map((sent) => sent.params.result)).toEqual([{ kind: "approve-once" }]);
    });

    it("lets only a person approve a prompt that managed policy reserves for one", async () => {
      await actions.onSessionEvent(input(managedPermissionEvent("p1")));
      await actions.onSessionEvent(input(managedPermissionEvent("p2")));
      const [first, second] = actions.list(SESSION);
      // A webhook can refuse it, never approve it.
      const caller = capabilityFor(first!.id);
      const webhook = await actions.claim(caller, SESSION, first!.id);
      await expectCode(actions.submit(caller, SESSION, first!.id, { claimToken: webhook.claimToken, result: { kind: "approve-once" } }), "forbidden");
      expect(await actions.submit(caller, SESSION, first!.id, { claimToken: webhook.claimToken, result: { kind: "reject" } })).toMatchObject({ state: "completed" });
      // The owner's poller approves only by attesting that a person approved it, and only once.
      const poll = await actions.claim(user(), SESSION, second!.id);
      await expectCode(actions.submit(user(), SESSION, second!.id, { claimToken: poll.claimToken, result: { kind: "approve-once" } }), "forbidden");
      await expectCode(actions.submit(user(), SESSION, second!.id, { claimToken: poll.claimToken, result: { kind: "approve-for-session" } }), "forbidden");
      expect(await actions.submit(user(), SESSION, second!.id, { claimToken: poll.claimToken, result: { kind: "approve-once", approvedInteractively: true } })).toMatchObject({
        state: "completed",
      });
    });

    it("applies the same rule to live clients and offers such prompts to an attached person first", async () => {
      const decision = await actions.onSessionEvent(input(managedPermissionEvent("p1"), [sdk("app", []), cli("person")]));
      expect(decision).toMatchObject({ owner: "person", withhold: ["app"] });
      expect(await actions.onSessionEvent(input(permissionEvent("p0"), [sdk("app", []), cli("person")]))).toMatchObject({ owner: "app" });
      await actions.onSessionEvent(input(managedPermissionEvent("p2"), [sdk("app", [])]));
      // The application's policy cannot approve it; the stock SDK's fallback refusal is what gets recorded.
      await expectCode(answer("p2", "app", { kind: "approve-once" }), "forbidden");
      await answer("p2", "app", { kind: "user-not-available" });
      await answer("p1", "person", { kind: "approve-once" }, "cli");
      expect(sessions.answers().map((sent) => [sent.params.requestId, sent.params.result])).toEqual([
        ["p2", { kind: "user-not-available" }],
        ["p1", { kind: "approve-once" }],
      ]);
    });

    it("reads the managed requirement the way the stock SDK documents it", () => {
      expect(needsPerson({ permissionRequest: { kind: "shell", managedApprovalRequired: true }, promptRequest: { kind: "commands", managedApprovalRequired: false } })).toBe(false);
      expect(needsPerson({ permissionRequest: { kind: "custom-tool", managedApprovalRequired: true }, promptRequest: { kind: "custom-tool" } })).toBe(true);
      expect(needsPerson({ permissionRequest: { kind: "shell" } })).toBe(false);
      expect(needsPerson({ promptRequest: { kind: "custom-tool", toolName: "lookup_order" } })).toBe(true);
      // Without the raw request, the derived form alone never proves that no person is needed, whatever its kind.
      for (const kind of ["commands", "read", "write", "url", "workflow"]) expect(needsPerson({ promptRequest: { kind, managedApprovalRequired: false } })).toBe(true);
    });

    it("lets no responder but a person approve a standard prompt known only from its derived form", async () => {
      for (const kind of ["commands", "read", "write", "url", "workflow"]) {
        const requestId = `p-${kind}`;
        sessions.pendingPermissions.set(SESSION, [{ requestId, request: { kind, managedApprovalRequired: false } }]);
        await actions.reconcile(SESSION);
        const action = actions.list(SESSION).find((candidate) => candidate.requestId === requestId)!;
        expect(action).toMatchObject({ kind: "permission", state: "pending" });
        const caller = capabilityFor(action.id);
        const webhook = await actions.claim(caller, SESSION, action.id);
        await expectCode(actions.submit(caller, SESSION, action.id, { claimToken: webhook.claimToken, result: { kind: "approve-once" } }), "forbidden");
        await actions.submit(caller, SESSION, action.id, { claimToken: webhook.claimToken, release: true });
        const poll = await actions.claim(user(), SESSION, action.id);
        await expectCode(actions.submit(user(), SESSION, action.id, { claimToken: poll.claimToken, result: { kind: "approve-once" } }), "forbidden");
        expect(await actions.submit(user(), SESSION, action.id, { claimToken: poll.claimToken, result: { kind: "reject" } })).toMatchObject({ state: "completed" });
      }
      expect(sessions.answers().map((sent) => sent.params.result)).toEqual(Array.from({ length: 5 }, () => ({ kind: "reject" })));
    });

    it("records a waiting prompt the ledger missed from the session's history and replays it to a person who attaches", async () => {
      const missed = managedPermissionEvent("p-missed");
      sessions.history.set(SESSION, [missed]);
      sessions.pendingPermissions.set(SESSION, [{ requestId: "p-missed", request: { kind: "commands", commandIdentifiers: ["ls"], fullCommandText: "ls", intention: "", canOfferSessionApproval: false } }]);
      const replay = await actions.onAttached({ sessionId: SESSION, ownerId: OWNER.accountId, environment: "chat", generation: 0, responder: cli("person") });
      expect(replay.map((event) => event.id)).toEqual([missed.id]);
      expect(actions.list(SESSION)[0]).toMatchObject({ kind: "permission", requestId: "p-missed", state: "executing", payload: { kind: "shell", managedApprovalRequired: true } });
    });

    it("records a missed prompt known only from the pending list as one a person must answer", async () => {
      sessions.pendingPermissions.set(SESSION, [{ requestId: "p-bare", request: { kind: "custom-tool", toolName: "lookup_order", toolCallId: "call-1", toolDescription: "", args: {} } }]);
      await actions.reconcile(SESSION);
      await sleep(10);
      const [action] = actions.list(SESSION);
      expect(action).toMatchObject({ kind: "permission", state: "pending", tool: "lookup_order", toolCallId: "call-1" });
      expect(published.map((event) => event.type)).toEqual(["session.action_required"]);
      const caller = capabilityFor(action!.id);
      const { claimToken } = await actions.claim(caller, SESSION, action!.id);
      await expectCode(actions.submit(caller, SESSION, action!.id, { claimToken, result: { kind: "approve-once" } }), "forbidden");
    });

    it("never replays a prompt without its full request to an application, and keeps the full request once it arrives", async () => {
      sessions.pendingPermissions.set(SESSION, [{ requestId: "p-bare", request: { kind: "custom-tool", toolName: "lookup_order", toolCallId: "call-1", toolDescription: "", args: {} } }]);
      // An application handler would get no request to decide on: it is not offered one.
      expect(await actions.onAttached({ sessionId: SESSION, ownerId: OWNER.accountId, environment: "chat", generation: 0, responder: sdk("app", []) })).toEqual([]);
      expect(actions.list(SESSION)[0]).toMatchObject({ state: "pending" });
      expect(actions.list(SESSION)[0]!.payload).toBeUndefined();
      // The runtime asks again with the full request: it is kept, and the application can now decide.
      const full = permissionEvent("p-bare");
      const decision = await actions.onSessionEvent(input(full, [sdk("app", [])]));
      expect(decision.owner).toBe("app");
      expect(actions.list(SESSION)[0]!.payload).toEqual(full.data.permissionRequest);
    });

    it("accepts only a one-time approval attested as a person's for a prompt reserved for one", async () => {
      await actions.onSessionEvent(input(managedPermissionEvent("p1")));
      const [action] = actions.list(SESSION);
      const { claimToken } = await actions.claim(user(), SESSION, action!.id);
      for (const result of [
        { kind: "approve-for-session", approvedInteractively: true, approval: { kind: "commands", commandIdentifiers: ["ls"] } },
        { kind: "approved", approvedInteractively: true },
      ]) {
        await expectCode(actions.submit(user(), SESSION, action!.id, { claimToken, result }), "forbidden");
      }
      expect(await actions.submit(user(), SESSION, action!.id, { claimToken, result: { kind: "reject", feedback: "not now" } })).toMatchObject({ state: "completed" });
    });
  });

  describe("runtime restarts", () => {
    const rebuilt = (requestId = "r1-rebuilt") => ({ requestId, toolCallId: "call-r1", toolName: "lookup_order", arguments: { id: "1234" } });

    it("keeps one action when a restarted runtime asks for the same tool call under a new request ID", async () => {
      await actions.onSessionEvent(input(toolEvent("r1"), [sdk("c1", ["lookup_order"])]));
      actions.onDetached("c1"); // the tool may have run
      now += 5_000;
      sessions.pendingTools.set(SESSION, [rebuilt()]);
      await actions.reconcile(SESSION);
      expect(actions.list(SESSION).map((action) => [action.requestId, action.state])).toEqual([["r1-rebuilt", "needs_reconciliation"]]);
      // The stopped runtime's completion for the old request ID arrives late: it closes nothing.
      await actions.onSessionEvent(input(completedEvent("external_tool.completed", "r1")));
      expect(states()).toEqual({ "r1-rebuilt": "needs_reconciliation" });
      // Asked again under the new ID, it is offered to nobody.
      const again = toolEvent("r1-rebuilt");
      const decision = await actions.onSessionEvent(input({ ...again, data: { ...again.data, toolCallId: "call-r1" } }, [sdk("c2", ["lookup_order"])]));
      expect(decision.owner).toBeUndefined();
      expect(actions.list(SESSION)).toHaveLength(1);
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id, { reconcile: true });
      await actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: "checked: it ran once" });
      expect(sessions.answers().map((sent) => sent.params.requestId)).toEqual(["r1-rebuilt"]);
    });

    it("keeps one action when the restarted runtime emits the rebuilt request itself", async () => {
      await actions.onSessionEvent(input(toolEvent("r1"), [sdk("c1", ["lookup_order"])]));
      actions.onDetached("c1");
      const again = toolEvent("r1-rebuilt");
      const decision = await actions.onSessionEvent(input({ ...again, data: { ...again.data, toolCallId: "call-r1" } }, [sdk("c2", ["lookup_order"])]));
      expect(decision.owner).toBeUndefined();
      expect(actions.list(SESSION).map((action) => [action.requestId, action.state])).toEqual([["r1-rebuilt", "needs_reconciliation"]]);
    });

    it("delivers a recorded answer again under the new request ID", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id);
      await actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: "shipped" });
      now += 5_000;
      sessions.pendingTools.set(SESSION, [rebuilt()]);
      await actions.reconcile(SESSION);
      await sleep(10);
      expect(sessions.answers().map((sent) => [sent.params.requestId, sent.params.result])).toEqual([
        ["r1", "shipped"],
        ["r1-rebuilt", "shipped"],
      ]);
      expect(actions.list(SESSION)).toHaveLength(1);
    });

    it("brings back an action the stopping runtime cancelled while it was being handled as uncertain, never as new work", async () => {
      await actions.onSessionEvent(input(toolEvent("r1"), [sdk("c1", ["lookup_order"])]));
      // Stopping the runtime ended the waiting call while c1 was running it.
      await actions.onSessionEvent(input(completedEvent("external_tool.completed", "r1")));
      expect(states()).toEqual({ r1: "cancelled" });
      now += 5_000;
      sessions.pendingTools.set(SESSION, [rebuilt()]);
      await actions.reconcile(SESSION);
      await sleep(10);
      expect(states()).toEqual({ "r1-rebuilt": "needs_reconciliation" });
      expect(published).toHaveLength(0);
      // c1's late answer is the true outcome and reaches the runtime under the new ID.
      await actions.onClientAnswer({ sessionId: SESSION, connectionId: "c1", responderKind: "sdk", method: "session.tools.handlePendingToolCall", params: { requestId: "r1", result: "done" } });
      expect(sessions.answers().map((sent) => sent.params.requestId)).toEqual(["r1-rebuilt"]);
      // A completion from the stopped runtime under the old ID changes nothing now.
      await actions.onSessionEvent(input(completedEvent("external_tool.completed", "r1")));
      expect(states()).toEqual({ "r1-rebuilt": "completed" });
    });

    it("tells core whether the runtime may still wait on the ledger", async () => {
      expect(actions.hasOpenActions(SESSION)).toBe(false);
      await actions.onSessionEvent(input(toolEvent("r1")));
      expect(actions.hasOpenActions(SESSION)).toBe(true);
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id);
      sessions.failRequests = 1;
      await actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: "ok" });
      expect(actions.hasOpenActions(SESSION)).toBe(true); // recorded, not delivered yet
      now += 2_000;
      await actions.sweep();
      await sleep(10);
      expect(actions.hasOpenActions(SESSION)).toBe(false);
    });

    it("delivers an answer under a rebuilt request ID even while its delivery under the old one is in flight", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      const [action] = actions.list(SESSION);
      const claim = await actions.claim(user(), SESSION, action!.id);
      let release!: () => void;
      sessions.holdNextAnswer = new Promise<void>((resolve) => (release = resolve));
      const submitting = actions.submit(user(), SESSION, action!.id, { claimToken: claim.claimToken, result: "shipped" });
      await sleep(5); // sent under r1, not acknowledged yet
      // The runtime restarts and rebuilds the call under r2; the first delivery there fails.
      sessions.failRequests = 1;
      now += 5_000;
      sessions.pendingTools.set(SESSION, [rebuilt("r2")]);
      await actions.reconcile(SESSION);
      await sleep(10);
      release(); // r1's late acknowledgment says nothing about r2
      await submitting;
      expect(actions.hasOpenActions(SESSION)).toBe(true);
      expect(actions.store.get(action!.id)).toMatchObject({ forwarded: 0 });
      now += 2_000;
      await actions.sweep();
      await sleep(10);
      expect(sessions.answers().map((sent) => [sent.params.requestId, sent.params.result])).toEqual([
        ["r1", "shipped"],
        ["r2", "shipped"],
        ["r2", "shipped"],
      ]);
      expect(actions.hasOpenActions(SESSION)).toBe(false);
    });

    it("takes a client's answer under any request ID the call had, and delivers it under the latest", async () => {
      await actions.onSessionEvent(input(toolEvent("r1")));
      now += 5_000;
      sessions.pendingTools.set(SESSION, [rebuilt("r2")]);
      await actions.reconcile(SESSION);
      // A client resumes and is handed the call under r2.
      const replay = await actions.onAttached({ sessionId: SESSION, ownerId: OWNER.accountId, environment: "chat", generation: 0, responder: sdk("c1", ["lookup_order"]) });
      expect(replay.map((event) => event.data.requestId)).toEqual(["r2"]);
      // The runtime restarts again while c1 runs the tool, and rebuilds the call under r3.
      now += 5_000;
      sessions.pendingTools.set(SESSION, [rebuilt("r3")]);
      await actions.reconcile(SESSION);
      expect(states()).toEqual({ r3: "executing" });
      await actions.onClientAnswer({ sessionId: SESSION, connectionId: "c1", responderKind: "sdk", method: "session.tools.handlePendingToolCall", params: { requestId: "r2", result: "done" } });
      expect(sessions.answers().map((sent) => [sent.params.requestId, sent.params.result])).toEqual([["r3", "done"]]);
      expect(states()).toEqual({ r3: "completed" });
    });

    it("runs a platform tool again, idempotently, when a restarted runtime rebuilds a call the stopped one ended", async () => {
      const keys: string[] = [];
      /** Holds the next run of the handler until it settles. */
      let gate: Promise<void> | undefined;
      const hold = () => {
        let open!: () => void;
        gate = new Promise<void>((resolve) => (open = resolve));
        return open;
      };
      tools.set("schedule_task", {
        name: "schedule_task",
        description: "",
        parameters: {},
        enabledFor: () => true,
        handler: async (_args, context) => {
          keys.push(context.idempotencyKey);
          const wait = gate;
          gate = undefined;
          if (wait) await wait;
          return `scheduled with ${context.idempotencyKey}`;
        },
      });
      let finish = hold();
      await actions.onSessionEvent(input(toolEvent("t1", "schedule_task", { prompt: "hi" })));
      // The runtime stops without suspending: its waiting call ends while the gateway's handler still runs.
      await actions.onSessionEvent(input(completedEvent("external_tool.completed", "t1")));
      finish(); // that result has nobody to go to
      await sleep(5);
      expect(states()).toEqual({ t1: "cancelled" });
      // The restarted runtime rebuilds the call: nobody else could reconcile it, so the gateway runs it again.
      const again = toolEvent("t1-rebuilt", "schedule_task", { prompt: "hi" });
      const decision = await actions.onSessionEvent(input({ ...again, data: { ...again.data, toolCallId: "call-t1" } }, [sdk("c1", ["schedule_task"])]));
      expect(decision.owner).toBeUndefined();
      await sleep(10);
      expect(keys).toEqual([`${SESSION}:call-t1`, `${SESSION}:call-t1`]);
      expect(states()).toEqual({ "t1-rebuilt": "completed" });
      expect(sessions.answers().map((sent) => [sent.params.requestId, sent.params.result])).toEqual([["t1-rebuilt", `scheduled with ${SESSION}:call-t1`]]);
      // Found by reconciliation instead (the restarted runtime only lists it): the same applies.
      finish = hold();
      await actions.onSessionEvent(input(toolEvent("t2", "schedule_task", { prompt: "later" })));
      await actions.onSessionEvent(input(completedEvent("external_tool.completed", "t2")));
      finish();
      await sleep(5);
      expect(states()).toMatchObject({ t2: "cancelled" });
      now += 5_000;
      sessions.pendingTools.set(SESSION, [{ requestId: "t2-rebuilt", toolCallId: "call-t2", toolName: "schedule_task", arguments: { prompt: "later" } }]);
      await actions.reconcile(SESSION);
      await sleep(10);
      expect(states()).toMatchObject({ "t2-rebuilt": "completed" });
      expect(keys.slice(2)).toEqual([`${SESSION}:call-t2`, `${SESSION}:call-t2`]);
      expect(sessions.answers().at(-1)!.params).toEqual({ sessionId: SESSION, requestId: "t2-rebuilt", result: `scheduled with ${SESSION}:call-t2` });
    });
  });

  describe("attached person (Copilot CLI attach)", () => {
    const visibility = (requestId: string, responder = cli("person"), overrides: Partial<PromptVisibilityInput> = {}) =>
      actions.promptVisibility({ sessionId: SESSION, incarnation: "inc-1", generation: 0, responder, kind: "permission", requestId, waitMs: 50, ...overrides });
    const cliAnswer = (requestId: string, connectionId: string, result: unknown, extra: Partial<ClientAnswerInput> = {}) =>
      actions.onClientAnswer({
        sessionId: SESSION,
        incarnation: "inc-1",
        generation: 0,
        connectionId,
        responderKind: "cli",
        method: "session.permissions.handlePendingPermissionRequest",
        params: { requestId, result },
        requireRecorded: true,
        ...extra,
      });

    it("shows a prompt as answerable only to the CLI that holds it, and read-only to everyone else", async () => {
      await actions.onSessionEvent(input(permissionEvent("p-app"), [sdk("app", []), cli("person")]));
      expect(await visibility("p-app")).toMatchObject({ status: "observe", state: "executing", claimedBy: "live:app" });
      await expectCode(cliAnswer("p-app", "person", { kind: "approve-once" }), "conflict");
      await actions.onSessionEvent(input(permissionEvent("p-person"), [cli("person"), cli("other")]));
      expect(await visibility("p-person")).toMatchObject({ status: "actionable" });
      expect(await visibility("p-person", cli("other"))).toMatchObject({ status: "observe", claimedBy: "cli:person" });
      await expectCode(cliAnswer("p-person", "other", { kind: "approve-once" }), "conflict");
      await cliAnswer("p-person", "person", { kind: "approve-once" });
      expect(sessions.answers().map((sent) => [sent.params.requestId, sent.params.result])).toEqual([["p-person", { kind: "approve-once" }]]);
      expect(await visibility("p-person")).toMatchObject({ status: "hidden", reason: expect.stringMatching(/already answered/) });
    });

    it("waits for core to record a prompt the raw channel showed first, and never treats an unknown one as answerable", async () => {
      const started = Date.now();
      const shown = visibility("p1", cli("person"), { waitMs: 5_000 });
      await sleep(5);
      await actions.onSessionEvent(input(permissionEvent("p1"), [cli("person")]));
      expect(await shown).toMatchObject({ status: "actionable" });
      // Woken as soon as the request is recorded, not when the wait runs out.
      expect(Date.now() - started).toBeLessThan(1_000);
      // Never recorded, and not pending in the runtime either: hidden, and an answer for it is refused, not forwarded.
      expect(await visibility("p-unknown")).toMatchObject({ status: "hidden", reason: expect.stringMatching(/no record/) });
      await expectCode(cliAnswer("p-unknown", "person", { kind: "approve-once" }), "conflict");
      expect(sessions.requests.filter((sent) => sent.params.requestId === "p-unknown")).toHaveLength(0);
    });

    it("gives a waiting prompt to the person who is attached, and accepts a person's approval of a prompt reserved for one", async () => {
      await actions.onSessionEvent(input(managedPermissionEvent("p1")));
      const [action] = actions.list(SESSION);
      expect(await visibility("p1")).toMatchObject({ status: "actionable", actionId: action!.id });
      // Nobody else can take it while the person holds it.
      await expectCode(actions.claim(user(), SESSION, action!.id), "conflict");
      expect(actions.mintCapability(SESSION, [action!.id], "orders")).toBeUndefined();
      await cliAnswer("p1", "person", { kind: "approve-once" });
      expect(sessions.answers().map((sent) => sent.params.result)).toEqual([{ kind: "approve-once" }]);
    });

    it("hides tool calls and other incarnations or placements, and refuses stale or revoked answers", async () => {
      await actions.onSessionEvent(input(toolEvent("t1")));
      expect(await visibility("t1", cli("person"), { kind: "tool" })).toMatchObject({ status: "hidden" });
      await expectCode(
        actions.onClientAnswer({ sessionId: SESSION, connectionId: "person", responderKind: "cli", method: "session.tools.handlePendingToolCall", params: { requestId: "t1", result: "x" } }),
        "forbidden",
      );
      await actions.onSessionEvent(input(permissionEvent("p1"), [cli("person")]));
      expect(await visibility("p1", cli("person"), { incarnation: "inc-old" })).toMatchObject({ status: "hidden", reason: expect.stringMatching(/no longer exists/) });
      expect(await visibility("p1", cli("person"), { generation: 1 })).toMatchObject({ status: "hidden", reason: expect.stringMatching(/moved to another placement/) });
      await expectCode(cliAnswer("p1", "person", { kind: "approve-once" }, { incarnation: "inc-old" }), "conflict");
      // Revoked: the CLI detached, so its claim was released; its late approval is refused rather than taken as a claim.
      actions.onDetached("person", SESSION);
      await expectCode(cliAnswer("p1", "person", { kind: "approve-once" }), "conflict");
      // After a move, an answer for the CLI's old placement is refused.
      promote(1);
      await expectCode(cliAnswer("p1", "person", { kind: "approve-once" }), "conflict");
      expect(sessions.answers()).toHaveLength(0);
    });

    it("never hands a prompt to a CLI that detached while it waited for the prompt to be recorded", async () => {
      for (const [requestId, detach] of [
        ["p1", () => actions.onDetached("person", SESSION)],
        ["p2", () => actions.onDetached("person")],
      ] as const) {
        const shown = visibility(requestId, cli("person"), { waitMs: 5_000 });
        await sleep(5);
        detach();
        await actions.onSessionEvent(input(permissionEvent(requestId)));
        expect(await shown).toMatchObject({ status: "hidden", reason: expect.stringMatching(/detached/) });
        expect(actions.list(SESSION).find((action) => action.requestId === requestId)).toMatchObject({ state: "pending" });
      }
      // Attached again, the person can take it.
      expect(await visibility("p1")).toMatchObject({ status: "actionable" });
    });

    it("never lets a person's attach take a prompt an application holds", async () => {
      await actions.onSessionEvent(input(permissionEvent("p1"), [sdk("app", [])]));
      expect(await actions.onAttached({ sessionId: SESSION, ownerId: OWNER.accountId, environment: "chat", generation: 0, responder: cli("person") })).toEqual([]);
      expect(actions.list(SESSION)[0]).toMatchObject({ state: "executing", claimedBy: "live:app" });
      expect(await visibility("p1")).toMatchObject({ status: "observe" });
    });

    it("refuses an answer for the placement the CLI saw before the session moved", async () => {
      await actions.onSessionEvent(input(permissionEvent("p1"), [cli("person")]));
      promote(1, ["p1"]); // carried: the CLI keeps its claim in the new placement
      await expectCode(cliAnswer("p1", "person", { kind: "approve-once" }), "conflict");
      await cliAnswer("p1", "person", { kind: "approve-once" }, { generation: 1 });
      expect(sessions.answers().map((sent) => [sent.params.requestId, sent.generation])).toEqual([["p1", 1]]);
    });
  });
});
