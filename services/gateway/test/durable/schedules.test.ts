import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManagedCopilotError, isManagedCopilotError, parseConfig, type ManagedCopilotConfig, type PendingAction, type PlatformEvent } from "@managed-copilot/protocol";
import { migrate, openDatabase, type Database } from "../../src/db.js";
import type { Principal } from "../../src/http.js";
import { createLogger } from "../../src/log.js";
import type { ActionChange } from "../../src/modules/durable/actions/service.js";
import type {
  CredentialsService,
  DurableCreateSessionRequest,
  DurableSessionView,
  DurableSessionsPort,
  PlatformToolDefinition,
  RuntimeSessionEvent,
} from "../../src/modules/durable/contract.js";
import { incarnationOf, isGone } from "../../src/modules/durable/ids.js";
import { DURABLE_MIGRATIONS } from "../../src/modules/durable/migrations.js";
import { DurableSchedules, type SchedulesOptions } from "../../src/modules/durable/schedules/service.js";
import { scheduleToolDefinitions } from "../../src/modules/durable/schedules/tools.js";

const OWNER: Principal = { accountId: 1, login: "octocat", token: "gho_owner" };
const OTHER: Principal = { accountId: 2, login: "hubot", token: "gho_other" };
const START = Date.parse("2026-10-26T15:00:00Z"); // Monday 08:00 in Los Angeles (PDT)
/** When the tests' pre-existing sessions were created (core always reports a creation time). */
const EARLIER = new Date(START - 60 * 60_000).toISOString();

/** Core's ledger always reports when a session was created: views set without one were created `EARLIER`. */
class Views extends Map<string, DurableSessionView> {
  override set(sessionId: string, view: DurableSessionView): this {
    return super.set(sessionId, view.createdAt ? view : { ...view, createdAt: EARLIER });
  }
}

/** Like core: with an expected incarnation, a call reaches the runtime only while the session is still that one. */
function fence(view: DurableSessionView | undefined, options: { readonly incarnation?: string } | undefined): void {
  if (options?.incarnation !== undefined && (isGone(view) || incarnationOf(view!) !== options.incarnation)) {
    throw new ManagedCopilotError("not_found", "Session was not found");
  }
}

/** A runtime stand-in that remembers sessions and the user messages they received, and can fail on cue. */
class FakeSessions implements DurableSessionsPort {
  readonly views: Map<string, DurableSessionView> = new Views();
  readonly history = new Map<string, RuntimeSessionEvent[]>();
  /** Prompts the runtime accepted but has not started yet (queued behind a turn); `system` ones are not listed. */
  readonly queued = new Map<string, { messageId: string; prompt: string; source?: string }[]>();
  readonly creates: DurableCreateSessionRequest[] = [];
  readonly sends: { sessionId: string; prompt: string; source?: string }[] = [];
  /** The incarnation each send and request expected (core refuses a call for another one). */
  readonly fences: { method: string; incarnation?: string }[] = [];
  createFailures: ("before" | "after")[] = [];
  /** `lost`: consumed at once, reply lost. `queued-lost`: accepted into the queue (not started), reply lost. */
  sendFailures: ("lost" | "queued-lost" | "refused-transient" | "refused-final" | "callback-unsupported")[] = [];
  historyUnavailable = false;
  queueUnavailable = false;
  /** Runs once, inside the next send, before the prompt is written (a concurrent change core's fence must catch). */
  beforeWrite: (() => void) | undefined;
  /** Runs after each runtime request is answered, before the gateway sees the answer. */
  afterRequest: ((method: string) => void) | undefined;
  listeners = new Set<(sessionId: string, event: RuntimeSessionEvent) => void>();
  #messages = 0;

  constructor(readonly now: () => number) {}

  get(sessionId: string) {
    return this.views.get(sessionId);
  }

  async create(principal: Principal, request: DurableCreateSessionRequest) {
    this.creates.push(request);
    const failure = this.createFailures.shift();
    if (failure === "before") throw new Error("connection reset");
    const existing = this.views.get(request.sessionId);
    if (existing && existing.ownerId !== principal.accountId) throw Object.assign(new Error("taken"), {});
    const created = !existing;
    if (created) {
      this.views.set(request.sessionId, {
        id: request.sessionId,
        ownerId: principal.accountId,
        environment: request.environment,
        state: "idle",
        generation: 0,
        createdAt: new Date(this.now()).toISOString(),
        // Like core: only its server-side create records the schedule.
        ...(request.scheduleId ? { scheduleId: request.scheduleId } : {}),
      });
      this.history.set(request.sessionId, []);
    }
    if (failure === "after") throw new Error("gateway crashed after the runtime created the session");
    return { sessionId: request.sessionId, created };
  }

  async send(_principal: Principal, sessionId: string, input: { prompt: string; source?: string }, options?: { readonly incarnation?: string }) {
    this.fences.push({ method: "send", ...(options?.incarnation !== undefined ? { incarnation: options.incarnation } : {}) });
    fence(this.views.get(sessionId), options);
    const failure = this.sendFailures.shift();
    if (failure === "refused-transient") throw new Error("runtime unavailable");
    if (failure === "refused-final") {
      throw new ManagedCopilotError("policy_violation", "The prompt was refused");
    }
    if (failure === "callback-unsupported") {
      throw new ManagedCopilotError("background_callback_unsupported", "This session's SDK hooks have no connected handler");
    }
    const hook = this.beforeWrite;
    this.beforeWrite = undefined;
    hook?.();
    // Checked again where the prompt is written, like core.
    fence(this.views.get(sessionId), options);
    const messageId = `msg-${++this.#messages}`;
    this.sends.push({ sessionId, prompt: input.prompt, ...(input.source ? { source: input.source } : {}) });
    if (failure === "queued-lost") {
      const queue = this.queued.get(sessionId) ?? [];
      queue.push({ messageId, prompt: input.prompt, ...(input.source ? { source: input.source } : {}) });
      this.queued.set(sessionId, queue);
      throw new Error("the response was lost");
    }
    const event: RuntimeSessionEvent = { id: `e-${messageId}`, type: "user.message", timestamp: new Date(this.now()).toISOString(), parentId: null, data: { content: input.prompt, messageId, source: input.source } };
    this.history.get(sessionId)?.push(event);
    if (failure === "lost") throw new Error("the response was lost");
    return { messageId };
  }

  async request<T>(sessionId: string, method: string, _params?: Record<string, unknown>, options?: { readonly incarnation?: string }): Promise<T> {
    this.fences.push({ method, ...(options?.incarnation !== undefined ? { incarnation: options.incarnation } : {}) });
    fence(this.views.get(sessionId), options);
    const answer = this.#answer<T>(sessionId, method);
    // Whatever happens while the answer travels back (the gateway awaits it).
    this.afterRequest?.(method);
    return answer;
  }

  #answer<T>(sessionId: string, method: string): T {
    if (method === "session.getMessages") {
      if (this.historyUnavailable) throw new Error("runtime unavailable");
      return { events: this.history.get(sessionId) ?? [] } as T;
    }
    if (method === "session.queue.hasPending" || method === "session.queue.pendingItems") {
      if (this.queueUnavailable) throw new Error("runtime unavailable");
      const queue = this.queued.get(sessionId) ?? [];
      if (method === "session.queue.hasPending") return { hasPending: queue.length > 0 } as T;
      // Like the runtime: `system` items are not listed.
      const visible = queue.filter((item) => item.source !== "system").map((item) => ({ id: `q-${item.messageId}`, messageId: item.messageId, kind: "message", displayText: item.prompt, agentMode: "interactive" }));
      return { items: visible, steeringMessages: [] } as T;
    }
    throw new Error(`unexpected ${method}`);
  }

  /** The runtime starts the queued prompts: each gets its `user.message` (and the turn then runs). */
  drainQueue(sessionId: string) {
    for (const item of (this.queued.get(sessionId) ?? []).splice(0)) {
      const event: RuntimeSessionEvent = { id: `e-${item.messageId}`, type: "user.message", timestamp: new Date(this.now()).toISOString(), parentId: null, data: { content: item.prompt, messageId: item.messageId, source: item.source } };
      this.history.get(sessionId)?.push(event);
      for (const listener of this.listeners) listener(sessionId, event);
    }
  }

  subscribe(listener: (sessionId: string, event: RuntimeSessionEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(sessionId: string, type: string, data: Record<string, unknown> = {}) {
    const event: RuntimeSessionEvent = { id: `ev-${Math.random()}`, type, timestamp: new Date(this.now()).toISOString(), parentId: null, data };
    for (const listener of this.listeners) listener(sessionId, event);
  }

  /** The runtime consumes a queued prompt and finishes its turn. */
  finishTurn(sessionId: string, messageId: string) {
    this.emit(sessionId, "user.message", { messageId, content: "..." });
    this.emit(sessionId, "session.idle", {});
  }
}

class FakeCredentials implements CredentialsService {
  readonly active = new Set<number>([OWNER.accountId, OTHER.accountId]);
  revokedReason: string | undefined;
  store(): never {
    throw new Error("unused");
  }
  status(): never {
    throw new Error("unused");
  }
  revoke(): void {}
  has(accountId: number) {
    return this.active.has(accountId);
  }
  async principalFor(accountId: number): Promise<Principal> {
    if (!this.active.has(accountId)) {
      const { ManagedCopilotError } = await import("@managed-copilot/protocol");
      throw new ManagedCopilotError("authentication_required", this.revokedReason ?? "No background sign-in");
    }
    return accountId === OWNER.accountId ? OWNER : OTHER;
  }
}

const deployment: ManagedCopilotConfig = parseConfig({
  environments: { chat: { type: "shared", scheduling: true }, plain: { type: "shared" } },
  webhooks: {
    orders: { url: "https://orders.example/hook", environments: ["chat"], events: ["session.action_required", "session.idle"], secret: { secretEnv: "ORDERS_SECRET" } },
    audit: { url: "https://audit.example/hook", environments: ["chat"], events: ["session.idle"], secret: { secretEnv: "AUDIT_SECRET" } },
  },
});

async function expectCode(promise: Promise<unknown> | (() => unknown), code: string, message?: RegExp) {
  const error = await (typeof promise === "function" ? Promise.resolve().then(promise) : promise).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isManagedCopilotError(error), `expected ${code}, got ${String(error)}`).toBe(true);
  expect((error as { code: string }).code).toBe(code);
  if (message) expect((error as Error).message).toMatch(message);
}

describe("durable schedules", () => {
  let db: Database;
  let now: number;
  let sessions: FakeSessions;
  let credentials: FakeCredentials;
  let published: PlatformEvent[];
  let openActions: PendingAction[];
  let actionListeners: Set<(change: ActionChange) => void>;
  let schedules: DurableSchedules;

  function build(options: Partial<SchedulesOptions> = {}) {
    const service = new DurableSchedules({
      db,
      log: createLogger("test", "error"),
      deployment,
      sessions: () => sessions,
      credentials: () => credentials,
      actions: () =>
        ({
          list: () => openActions,
          onChange: (listener: (change: ActionChange) => void) => {
            actionListeners.add(listener);
            return () => actionListeners.delete(listener);
          },
        }) as never,
      publish: (event) => published.push(event),
      now: () => now,
      options: { tickIntervalMs: 0, dispatchRetryBaseMs: 1_000, ...options },
    });
    service.start();
    return service;
  }

  async function tick(service = schedules) {
    await service.tick();
    await service.idle();
  }

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db, "durable", DURABLE_MIGRATIONS);
    now = START;
    sessions = new FakeSessions(() => now);
    credentials = new FakeCredentials();
    published = [];
    openActions = [];
    actionListeners = new Set();
    schedules = build();
  });

  afterEach(async () => {
    await schedules.stop();
    db.close();
  });

  describe("creating", () => {
    it("computes the next weekday run in the schedule's time zone", async () => {
      const schedule = await schedules.create(OWNER, { name: "weekday-triage", cron: "0 9 * * 1-5", timeZone: "America/Los_Angeles", environment: "chat", prompt: "Triage the issues" });
      expect(schedule).toMatchObject({ name: "weekday-triage", state: "active", createdBy: "user", timeZone: "America/Los_Angeles", nextRunAt: "2026-10-26T16:00:00.000Z" });
      expect(schedules.list(OWNER.accountId)).toHaveLength(1);
      expect(schedules.list(OTHER.accountId)).toHaveLength(0);
      await expectCode(() => schedules.get(OTHER.accountId, schedule.id), "not_found");
    });

    it("stores tool declarations only with an authorized webhook route", async () => {
      const tools = [{ name: "lookup_order", description: "Look up an order", parameters: { type: "object" }, revision: "abc" }];
      await expectCode(schedules.create(OWNER, { name: "a", cron: "0 9 * * *", environment: "chat", prompt: "p", session: { tools } }), "background_callback_unsupported", /lookup_order/);
      await expectCode(schedules.create(OWNER, { name: "a", cron: "0 9 * * *", environment: "chat", prompt: "p", session: { tools }, webhook: "audit" }), "invalid_request", /session.action_required/);
      await expectCode(schedules.create(OWNER, { name: "a", cron: "0 9 * * *", environment: "plain", prompt: "p", session: { tools }, webhook: "orders" }), "policy_violation", /not authorized/);
      await expectCode(schedules.create(OWNER, { name: "a", cron: "0 9 * * *", environment: "chat", prompt: "p", webhook: "nope" }), "invalid_request", /Unknown webhook/);
      const created = await schedules.create(OWNER, { name: "a", cron: "0 9 * * *", environment: "chat", prompt: "p", session: { agent: "triage", tools }, webhook: "orders" });
      expect(created.session).toEqual({ agent: "triage", tools });
    });

    it("validates timing, environments, targets, and sign-in", async () => {
      await expectCode(schedules.create(OWNER, { name: "a", environment: "chat", prompt: "p" }), "invalid_request", /exactly one/);
      await expectCode(schedules.create(OWNER, { name: "a", cron: "0 9 * * *", runAt: "2026-10-27T00:00:00Z", environment: "chat", prompt: "p" }), "invalid_request", /exactly one/);
      await expectCode(schedules.create(OWNER, { name: "a", cron: "61 * * * *", environment: "chat", prompt: "p" }), "invalid_request", /minute 61/);
      await expectCode(schedules.create(OWNER, { name: "a", cron: "0 9 * * *", timeZone: "Mars/Olympus", environment: "chat", prompt: "p" }), "invalid_request", /Unknown time zone/);
      await expectCode(schedules.create(OWNER, { name: "a", runAt: "2026-10-27T09:00:00", environment: "chat", prompt: "p" }), "invalid_request", /UTC offset/);
      await expectCode(schedules.create(OWNER, { name: "a", runAt: "2020-01-01T00:00:00Z", environment: "chat", prompt: "p" }), "invalid_request", /in the past/);
      await expectCode(schedules.create(OWNER, { name: "a", cron: "0 9 * * *", environment: "missing", prompt: "p" }), "environment_not_found");
      await expectCode(schedules.create(OWNER, { name: "a", cron: "0 9 * * *", prompt: "p" }), "invalid_request", /environment is required/);
      await expectCode(schedules.create(OWNER, { name: "a", cron: "0 9 * * *", prompt: "p", target: { sessionId: "nope" } }), "not_found");
      sessions.views.set("s-other", { id: "s-other", ownerId: OTHER.accountId, environment: "chat", state: "idle", generation: 0 });
      await expectCode(schedules.create(OWNER, { name: "a", cron: "0 9 * * *", prompt: "p", target: { sessionId: "s-other" } }), "not_found");
      sessions.views.set("s-mine", { id: "s-mine", ownerId: OWNER.accountId, environment: "chat", state: "idle", generation: 0 });
      await expectCode(schedules.create(OWNER, { name: "a", cron: "0 9 * * *", prompt: "p", target: { sessionId: "s-mine" }, session: { agent: "x" } }), "invalid_request", /remove session/);
      credentials.active.delete(OWNER.accountId);
      await expectCode(schedules.create(OWNER, { name: "a", cron: "0 9 * * *", environment: "chat", prompt: "p" }), "authentication_required", /managed-copilot login/);
    });

    it("treats an identical create as idempotent and a different one with the same name as a conflict", async () => {
      const first = await schedules.create(OWNER, { name: "daily", cron: "0 9 * * *", environment: "chat", prompt: "p" });
      expect((await schedules.create(OWNER, { name: "daily", cron: "0 9 * * *", environment: "chat", prompt: "p" })).id).toBe(first.id);
      await expectCode(schedules.create(OWNER, { name: "daily", cron: "0 10 * * *", environment: "chat", prompt: "p" }), "conflict", /already exists/);
      expect((await schedules.create(OTHER, { name: "daily", cron: "0 10 * * *", environment: "chat", prompt: "p" })).id).not.toBe(first.id);
    });
  });

  describe("running", () => {
    it("creates one session per occurrence, sends the prompt once, and completes on the turn's outcome", async () => {
      const schedule = await schedules.create(OWNER, { name: "weekday-triage", cron: "0 9 * * 1-5", timeZone: "America/Los_Angeles", environment: "chat", prompt: "Triage the issues", session: { agent: "triage" } });
      await tick();
      expect(sessions.creates).toHaveLength(0);

      now = Date.parse("2026-10-26T16:00:00Z");
      await tick();
      expect(sessions.creates).toHaveLength(1);
      expect(sessions.creates[0]).toMatchObject({ environment: "chat", agent: "triage", scheduleId: schedule.id });
      expect(sessions.sends).toEqual([{ sessionId: sessions.creates[0]!.sessionId, prompt: "Triage the issues", source: "system" }]);
      const [run] = schedules.runs(OWNER.accountId, schedule.id);
      expect(run).toMatchObject({ status: "running", trigger: "cron", scheduledFor: "2026-10-26T16:00:00.000Z", sessionId: sessions.creates[0]!.sessionId, messageId: "msg-1" });
      expect(published.map((event) => event.type)).toEqual(["schedule.run_started"]);
      expect(published[0]!.data).toMatchObject({ scheduleId: schedule.id, scheduleName: "weekday-triage", runId: run!.id, status: "running", messageId: "msg-1" });

      // Idleness before the run's own prompt was consumed is not success.
      sessions.emit(run!.sessionId!, "session.idle");
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]!.status).toBe("running");
      sessions.finishTurn(run!.sessionId!, "msg-1");
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "completed", completedAt: expect.any(String) });
      expect(published.map((event) => event.type)).toEqual(["schedule.run_started", "schedule.run_completed"]);
      expect(schedules.get(OWNER.accountId, schedule.id).nextRunAt).toBe("2026-10-27T16:00:00.000Z");
    });

    it("records a failed turn as a failed run", async () => {
      const schedule = await schedules.create(OWNER, { name: "once", runAt: new Date(START + 60_000).toISOString(), environment: "chat", prompt: "p" });
      now += 60_000;
      await tick();
      const [run] = schedules.runs(OWNER.accountId, schedule.id);
      sessions.emit(run!.sessionId!, "session.error", { message: "model unavailable", originatingMessageId: "msg-1" });
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "failed", reason: "The run's turn failed: model unavailable" });
      expect(schedules.get(OWNER.accountId, schedule.id).nextRunAt).toBeUndefined();
    });

    it("moves a run to waiting while an action needs a responder", async () => {
      await schedules.create(OWNER, { name: "once", runAt: new Date(START + 60_000).toISOString(), environment: "chat", prompt: "p" });
      now += 60_000;
      await tick();
      const sessionId = sessions.creates[0]!.sessionId;
      openActions = [{ id: "act", sessionId, kind: "tool", state: "pending", requestId: "r", idempotencyKey: "k", createdAt: "" }];
      for (const listener of actionListeners) listener({ type: "pending", sessionId, actionId: "act" });
      expect(schedules.list(OWNER.accountId)[0]!.lastRun!.status).toBe("waiting");
      openActions = [];
      for (const listener of actionListeners) listener({ type: "resolved", sessionId, actionId: "act" });
      expect(schedules.list(OWNER.accountId)[0]!.lastRun!.status).toBe("running");
    });
  });

  describe("restarts never duplicate sessions or input", () => {
    async function dueOccurrence() {
      const schedule = await schedules.create(OWNER, { name: "once", runAt: new Date(START + 60_000).toISOString(), environment: "chat", prompt: "Summarize overnight alerts" });
      now += 60_000;
      return schedule;
    }

    it("survives a restart between persisting the occurrence and creating the session", async () => {
      const schedule = await dueOccurrence();
      // Materialize only (the dispatcher never ran), then "crash".
      sessions.createFailures.push("before");
      await tick();
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "queued" });
      await schedules.stop();

      schedules = build();
      now += 5_000;
      await tick();
      expect(new Set(sessions.creates.map((request) => request.sessionId)).size).toBe(1);
      expect(sessions.views.size).toBe(1);
      expect(sessions.sends).toHaveLength(1);
      expect(schedules.runs(OWNER.accountId, schedule.id)).toHaveLength(1);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]!.status).toBe("running");
    });

    it("finds the session it already created instead of creating a second one", async () => {
      const schedule = await dueOccurrence();
      sessions.createFailures.push("after");
      await tick();
      await schedules.stop();
      schedules = build();
      now += 5_000;
      await tick();
      expect(sessions.creates).toHaveLength(2);
      expect(sessions.creates[0]!.sessionId).toBe(sessions.creates[1]!.sessionId);
      expect(sessions.views.size).toBe(1);
      expect(sessions.sends).toHaveLength(1);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]!.status).toBe("running");
    });

    it("never adopts a session that reused the ID of the one a lost create made", async () => {
      // The create reached core (session A) but its reply was lost: the run does not know it has a session.
      const first = await dueOccurrence();
      sessions.createFailures.push("after");
      await tick();
      const sessionId = sessions.creates[0]!.sessionId;
      expect(schedules.runs(OWNER.accountId, first.id)[0]).toMatchObject({ status: "queued" });
      // A is deleted: the run's own session may be what was deleted, so the run ends.
      sessions.views.delete(sessionId);
      schedules.onSessionDeleted(sessionId, "inc-a");
      expect(schedules.runs(OWNER.accountId, first.id)[0]).toMatchObject({ status: "skipped", reason: "The session was deleted before this run started" });
      now += 5_000;
      await tick();
      expect(sessions.creates).toHaveLength(1);

      // Again, but the owner reuses the ID before the deletion is seen: the run never adopts that session.
      db.exec("DELETE FROM durable_schedule_runs; DELETE FROM durable_schedules");
      sessions.creates.length = 0;
      sessions.views.clear();
      const second = await dueOccurrence();
      sessions.createFailures.push("after");
      await tick();
      const reusedId = sessions.creates[0]!.sessionId;
      sessions.views.set(reusedId, { id: reusedId, ownerId: OWNER.accountId, environment: "chat", state: "idle", generation: 0, incarnation: "inc-b" });
      sessions.history.set(reusedId, []);
      schedules.onSessionDeleted(reusedId, "inc-a"); // announced late: the ID names B now
      now += 5_000;
      await tick();
      expect(sessions.sends).toEqual([]);
      expect(schedules.runs(OWNER.accountId, second.id)[0]).toMatchObject({ status: "failed", reason: expect.stringMatching(/did not create now uses the run's session ID/) });
    });

    it("does not resend a prompt the runtime accepted before the crash", async () => {
      const schedule = await dueOccurrence();
      sessions.sendFailures.push("lost");
      await tick();
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "queued", reason: expect.stringMatching(/^Retrying/) });
      await schedules.stop();
      schedules = build();
      now += 5_000;
      await tick();
      expect(sessions.sends).toHaveLength(1);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "running", messageId: "msg-1" });
    });

    it("sends the prompt when the history shows the runtime never received it", async () => {
      const schedule = await dueOccurrence();
      sessions.sendFailures.push("refused-transient");
      await tick();
      now += 5_000;
      await tick();
      expect(sessions.sends).toHaveLength(1);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "running" });
    });

    it("surfaces needs_reconciliation instead of resending when acceptance cannot be established", async () => {
      schedules = build({ maxDispatchAttempts: 3 });
      const schedule = await dueOccurrence();
      sessions.sendFailures.push("lost");
      await tick();
      sessions.historyUnavailable = true;
      for (let i = 0; i < 4; i++) {
        now += 60_000;
        await tick();
      }
      expect(sessions.sends).toHaveLength(1);
      const [run] = schedules.runs(OWNER.accountId, schedule.id);
      expect(run).toMatchObject({ status: "needs_reconciliation" });
      expect(run!.reason).toMatch(/not sent again/);
      expect(published.at(-1)).toMatchObject({ type: "schedule.run_completed", data: { status: "needs_reconciliation" } });
    });

    it("fails a run the runtime definitively refused", async () => {
      const schedule = await dueOccurrence();
      sessions.sendFailures.push("refused-final");
      await tick();
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "failed", reason: "Could not start the run: The prompt was refused" });
    });

    it("never sends a prompt again while the runtime may still hold it queued behind another turn", async () => {
      sessions.views.set("s-chat", { id: "s-chat", ownerId: OWNER.accountId, environment: "chat", state: "running", generation: 0, lastTurn: { turnId: "typed-1", status: "running" } });
      sessions.history.set("s-chat", []);
      const schedule = await schedules.create(OWNER, { name: "check", runAt: new Date(START + 60_000).toISOString(), target: { sessionId: "s-chat" }, prompt: "Check my calendar" });
      now += 60_000;
      // The runtime queued the prompt behind a person's turn, but the reply was lost.
      sessions.sendFailures.push("queued-lost");
      await tick();
      now += 5_000;
      await tick();
      // That turn ends; the prompt still waits in the queue, unlisted because it was sent as `system`.
      sessions.views.set("s-chat", { ...sessions.views.get("s-chat")!, state: "idle", lastTurn: { turnId: "typed-1", status: "completed" } });
      for (let i = 0; i < 3; i++) {
        now += 60_000;
        await tick();
      }
      expect(sessions.sends).toHaveLength(1);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "queued", reason: expect.stringMatching(/^Waiting: confirming/) });
      // Its turn starts: the history shows the prompt, and the run follows that message.
      sessions.drainQueue("s-chat");
      now += 60_000;
      await tick();
      expect(sessions.sends).toHaveLength(1);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "running", messageId: "msg-1" });
    });

    it("ends needs_reconciliation, without resending, when the session's queue cannot be read", async () => {
      const schedule = await dueOccurrence();
      sessions.sendFailures.push("queued-lost");
      await tick();
      sessions.queueUnavailable = true;
      now += 60_000;
      await tick();
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "queued", reason: expect.stringMatching(/^Retrying: Could not read the session's queue/) });
      for (let i = 0; i < 12; i++) {
        now += 60_000;
        await tick();
      }
      expect(sessions.sends).toHaveLength(1);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "needs_reconciliation", reason: expect.stringMatching(/not sent again/) });
    });

    it("never resends a prompt that left the queue for the history between the two reads", async () => {
      const schedule = await dueOccurrence();
      sessions.sendFailures.push("queued-lost");
      await tick();
      const sessionId = sessions.creates[0]!.sessionId;
      // The runtime starts the prompt's turn right after the first history read, just before the queue is read.
      const request = sessions.request.bind(sessions);
      let started = false;
      sessions.request = (async <T,>(id: string, method: string): Promise<T> => {
        if (method === "session.queue.hasPending" && !started) {
          started = true;
          sessions.drainQueue(id);
        }
        return request<T>(id, method);
      }) as typeof sessions.request;
      now += 5_000;
      await tick();
      expect(started).toBe(true);
      expect(sessions.sends).toHaveLength(1);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "running", messageId: "msg-1", sessionId });
    });

    it("pauses a schedule whose session needs a handler that is not connected", async () => {
      const schedule = await schedules.create(OWNER, { name: "daily", cron: "0 9 * * *", environment: "chat", prompt: "p" });
      sessions.sendFailures.push("callback-unsupported");
      await schedules.runNow(OWNER.accountId, schedule.id, "first");
      await schedules.idle();
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "failed", reason: expect.stringMatching(/hooks have no connected handler/) });
      expect(schedules.get(OWNER.accountId, schedule.id)).toMatchObject({ state: "paused", pausedReason: expect.stringMatching(/^Paused: .*hooks/) });
      await expectCode(schedules.runNow(OWNER.accountId, schedule.id, "second"), "conflict", /paused by the platform/);
    });

    it("settles a recovered run from the session ledger when its turn ended while the gateway was down", async () => {
      const schedule = await dueOccurrence();
      sessions.sendFailures.push("lost");
      await tick();
      await schedules.stop();
      // The turn finished while no gateway observed it (session.idle is ephemeral, so history cannot show it).
      const sessionId = sessions.creates[0]!.sessionId;
      sessions.views.set(sessionId, { ...sessions.views.get(sessionId)!, state: "idle", lastTurn: { turnId: "msg-1", status: "completed" } });
      schedules = build();
      now += 5_000;
      await tick();
      expect(sessions.sends).toHaveLength(1);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "completed", messageId: "msg-1" });
    });

    it("keeps following a recovered run whose turn is still going", async () => {
      const schedule = await dueOccurrence();
      sessions.sendFailures.push("lost");
      await tick();
      await schedules.stop();
      schedules = build();
      now += 5_000;
      await tick();
      const sessionId = sessions.creates[0]!.sessionId;
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]!.status).toBe("running");
      // The prompt was consumed before the restart, so the turn's end completes the run without another user.message.
      sessions.emit(sessionId, "session.idle");
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]!.status).toBe("completed");
    });

    it("does not mistake a continued session's earlier turn for this run's when recovering", async () => {
      sessions.views.set("s-chat", { id: "s-chat", ownerId: OWNER.accountId, environment: "chat", state: "idle", generation: 0, lastTurn: { turnId: "earlier", status: "completed", completedAt: new Date(START - 3_600_000).toISOString() } });
      sessions.history.set("s-chat", []);
      const schedule = await schedules.create(OWNER, { name: "check", runAt: new Date(START + 60_000).toISOString(), target: { sessionId: "s-chat" }, prompt: "Check my calendar" });
      now += 60_000;
      sessions.sendFailures.push("lost");
      await tick();
      now += 5_000;
      await tick();
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "running", messageId: "msg-1" });
      sessions.emit("s-chat", "session.idle");
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]!.status).toBe("completed");
    });

    it("never resends a prompt found in history without a message ID", async () => {
      const schedule = await dueOccurrence();
      sessions.sendFailures.push("lost");
      await tick();
      const sessionId = sessions.creates[0]!.sessionId;
      for (const event of sessions.history.get(sessionId)!) delete (event.data as { messageId?: string }).messageId;
      now += 5_000;
      await tick();
      expect(sessions.sends).toHaveLength(1);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "needs_reconciliation" });
    });

    it("never mistakes an earlier run's identical prompt for this occurrence's", async () => {
      sessions.views.set("s-chat", { id: "s-chat", ownerId: OWNER.accountId, environment: "chat", state: "idle", generation: 0 });
      sessions.history.set("s-chat", []);
      const schedule = await schedules.create(OWNER, { name: "check", cron: "*/5 * * * *", target: { sessionId: "s-chat" }, prompt: "Check my calendar" });
      now = START + 5 * 60_000;
      await tick();
      sessions.finishTurn("s-chat", "msg-1");
      // The next occurrence's send fails before the runtime accepts it, seconds after the first run's prompt.
      now = START + 10 * 60_000;
      sessions.history.get("s-chat")![0] = { ...sessions.history.get("s-chat")![0]!, timestamp: new Date(now - 2_000).toISOString() };
      sessions.sendFailures.push("refused-transient");
      await tick();
      now += 5_000;
      await tick();
      expect(sessions.sends.map((send) => send.prompt)).toEqual(["Check my calendar", "Check my calendar"]);
      expect(schedules.runs(OWNER.accountId, schedule.id).map((run) => [run.status, run.messageId])).toEqual([
        ["running", "msg-2"],
        ["completed", "msg-1"],
      ]);
    });

    it("refuses to guess when two messages could be this occurrence's prompt", async () => {
      sessions.views.set("s-chat", { id: "s-chat", ownerId: OWNER.accountId, environment: "chat", state: "idle", generation: 0 });
      sessions.history.set("s-chat", []);
      const schedule = await schedules.create(OWNER, { name: "check", runAt: new Date(START + 60_000).toISOString(), target: { sessionId: "s-chat" }, prompt: "Check my calendar" });
      now += 60_000;
      sessions.sendFailures.push("lost");
      await tick();
      // Someone else typed the same text right after.
      sessions.history.get("s-chat")!.push({ id: "typed", type: "user.message", timestamp: new Date(now + 1_000).toISOString(), parentId: null, data: { content: "Check my calendar", messageId: "typed-1" } });
      now += 5_000;
      await tick();
      expect(sessions.sends).toHaveLength(1);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "needs_reconciliation" });
    });
  });

  describe("turn outcomes", () => {
    it("ignores sub-agent events and treats an aborted turn as a failed run", async () => {
      const schedule = await schedules.create(OWNER, { name: "once", runAt: new Date(START + 60_000).toISOString(), environment: "chat", prompt: "p" });
      now += 60_000;
      await tick();
      const sessionId = sessions.creates[0]!.sessionId;
      sessions.emit(sessionId, "user.message", { messageId: "msg-1" });
      const subagentIdle: RuntimeSessionEvent = { id: "sub", type: "session.idle", timestamp: new Date(now).toISOString(), parentId: null, agentId: "task-1", data: {} };
      for (const listener of sessions.listeners) listener(sessionId, subagentIdle);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]!.status).toBe("running");
      sessions.emit(sessionId, "session.idle", { aborted: true });
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "failed", reason: "The run's turn was cancelled" });
    });
  });

  describe("policy", () => {
    it("skips missed occurrences with a recorded outcome instead of backfilling", async () => {
      const schedule = await schedules.create(OWNER, { name: "daily", cron: "0 9 * * *", timeZone: "America/Los_Angeles", environment: "chat", prompt: "p" });
      now = Date.parse("2026-10-28T20:00:00Z"); // two 09:00 occurrences passed while the platform was down
      await tick();
      const runs = schedules.runs(OWNER.accountId, schedule.id);
      expect(runs.map((run) => [run.scheduledFor, run.status])).toEqual([
        ["2026-10-28T16:00:00.000Z", "skipped"],
        ["2026-10-27T16:00:00.000Z", "skipped"],
        ["2026-10-26T16:00:00.000Z", "skipped"],
      ]);
      expect(runs[0]!.reason).toMatch(/^Missed/);
      expect(sessions.creates).toHaveLength(0);
      expect(schedules.get(OWNER.accountId, schedule.id).nextRunAt).toBe("2026-10-29T16:00:00.000Z");
    });

    it("never overlaps runs of one schedule and bounds the backlog", async () => {
      const schedule = await schedules.create(OWNER, { name: "frequent", cron: "*/5 * * * *", environment: "chat", prompt: "p" });
      now = START + 5 * 60_000;
      await tick();
      now += 5 * 60_000;
      await tick();
      now += 5 * 60_000;
      await tick();
      const statuses = schedules.runs(OWNER.accountId, schedule.id).map((run) => run.status);
      expect(statuses).toEqual(["skipped", "queued", "running"]);
      expect(sessions.creates).toHaveLength(1);

      sessions.finishTurn(sessions.creates[0]!.sessionId, "msg-1");
      await tick();
      expect(schedules.runs(OWNER.accountId, schedule.id).map((run) => run.status)).toEqual(["skipped", "running", "completed"]);
      expect(sessions.creates).toHaveLength(2);
    });

    it("caps concurrent runs per owner", async () => {
      schedules = build({ maxActiveRunsPerOwner: 1 });
      await schedules.create(OWNER, { name: "a", runAt: new Date(START + 60_000).toISOString(), environment: "chat", prompt: "a" });
      await schedules.create(OWNER, { name: "b", runAt: new Date(START + 60_000).toISOString(), environment: "chat", prompt: "b" });
      now += 60_000;
      await tick();
      expect(sessions.sends.map((send) => send.prompt)).toEqual(["a"]);
      sessions.finishTurn(sessions.creates[0]!.sessionId, "msg-1");
      await tick();
      expect(sessions.sends.map((send) => send.prompt)).toEqual(["a", "b"]);
    });

    it("counts dispatches still starting against the owner's capacity", async () => {
      await schedules.stop();
      schedules = build({ maxActiveRunsPerOwner: 1 });
      let release!: () => void;
      const gate = new Promise<void>((done) => (release = done));
      const slowCredentials = credentials.principalFor.bind(credentials);
      credentials.principalFor = async (accountId: number) => {
        await gate;
        return slowCredentials(accountId);
      };
      const a = await schedules.create(OWNER, { name: "a", cron: "0 9 * * *", environment: "chat", prompt: "a" });
      const b = await schedules.create(OWNER, { name: "b", cron: "0 9 * * *", environment: "chat", prompt: "b" });
      await schedules.runNow(OWNER.accountId, a.id, "x");
      await schedules.runNow(OWNER.accountId, b.id, "y");
      await schedules.tick();
      release();
      await schedules.idle();
      expect(sessions.sends.map((send) => send.prompt)).toEqual(["a"]);
    });

    it("stops an overdue run only when its own turn is the one running, and otherwise pauses", async () => {
      await schedules.stop();
      schedules = build({ maxRunLifetimeMs: 60_000 });
      const aborted: string[] = [];
      const request = sessions.request.bind(sessions);
      sessions.request = (async (sessionId: string, method: string, _params: Record<string, unknown>) => {
        if (method === "session.abort") {
          aborted.push(sessionId);
          return {};
        }
        return request(sessionId, method);
      }) as typeof sessions.request;
      void request;
      const schedule = await schedules.create(OWNER, { name: "frequent", cron: "*/5 * * * *", environment: "chat", prompt: "p" });
      now = START + 5 * 60_000;
      await tick();
      const first = sessions.creates[0]!.sessionId;
      // The run's prompt was consumed and its turn is the session's current turn: stopping it is safe.
      sessions.emit(first, "user.message", { messageId: "msg-1" });
      sessions.views.set(first, { ...sessions.views.get(first)!, state: "running", lastTurn: { turnId: "msg-1", status: "running" } });
      now += 2 * 60_000;
      await tick();
      expect(aborted).toEqual([first]);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "failed", reason: expect.stringMatching(/its turn was stopped/) });

      // The next run's prompt never started (queued behind other work): never abort someone else's turn; pause.
      now += 3 * 60_000;
      await tick();
      now += 2 * 60_000;
      await tick();
      expect(aborted).toHaveLength(1);
      expect(schedules.get(OWNER.accountId, schedule.id)).toMatchObject({ state: "paused", pausedReason: expect.stringMatching(/never started/) });
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "failed", reason: expect.stringMatching(/never started/) });
    });

    it("lets a safety pause take over a person's pause, so a run that could not be stopped is never overlapped", async () => {
      await schedules.stop();
      schedules = build({ maxRunLifetimeMs: 60_000 });
      const request = sessions.request.bind(sessions);
      sessions.request = (async (sessionId: string, method: string) => {
        if (method === "session.abort") throw new Error("runtime unavailable");
        return request(sessionId, method);
      }) as typeof sessions.request;
      const schedule = await schedules.create(OWNER, { name: "daily", cron: "0 9 * * *", environment: "chat", prompt: "p" });
      await schedules.runNow(OWNER.accountId, schedule.id, "first");
      await schedules.idle();
      const first = sessions.creates[0]!.sessionId;
      sessions.emit(first, "user.message", { messageId: "msg-1" });
      sessions.views.set(first, { ...sessions.views.get(first)!, state: "running", lastTurn: { turnId: "msg-1", status: "running" } });
      schedules.pause(OWNER.accountId, schedule.id);
      now += 2 * 60_000;
      await tick();
      expect(schedules.get(OWNER.accountId, schedule.id)).toMatchObject({ state: "paused", pausedReason: expect.stringMatching(/could not be stopped/) });
      // Pausing again cannot clear it, and nothing else runs until the owner checks the session and resumes.
      schedules.pause(OWNER.accountId, schedule.id);
      await expectCode(schedules.runNow(OWNER.accountId, schedule.id, "second"), "conflict", /paused by the platform/);
      expect(sessions.creates).toHaveLength(1);
    });

    it("upgrades ledgers that already attribute one message to several runs, without running anything again", () => {
      const legacy = openDatabase(":memory:");
      migrate(legacy, "durable", DURABLE_MIGRATIONS.slice(0, 4));
      const insert = legacy.prepare(
        `INSERT INTO durable_schedule_runs (id, schedule_id, owner_id, occurrence_id, trigger, scheduled_for, status, reason, session_mode, session_id, message_id, created_at, updated_at)
         VALUES (?, 'sch', 1, ?, 'cron', 0, ?, ?, 'target', 's1', ?, 0, 0)`,
      );
      insert.run("run1", "occ1", "completed", null, "m1");
      insert.run("run2", "occ2", "running", null, "m1");
      insert.run("run3", "occ3", "completed", "Done", "m1");
      insert.run("run4", "occ4", "completed", null, "m2");
      insert.run("run5", "occ5", "skipped", null, null);
      insert.run("run6", "occ6", "skipped", null, null);
      migrate(legacy, "durable", DURABLE_MIGRATIONS);
      const rows = legacy.prepare("SELECT id, status, message_id, reason, completed_at FROM durable_schedule_runs ORDER BY id").all() as Record<string, unknown>[];
      const shared = "Runtime message m1 was also attributed to an earlier run of this session";
      expect(rows).toMatchObject([
        { id: "run1", status: "completed", message_id: "m1", reason: null },
        { id: "run2", status: "needs_reconciliation", message_id: null, reason: shared },
        { id: "run3", status: "completed", message_id: null, reason: `${shared}; Done` },
        { id: "run4", status: "completed", message_id: "m2", reason: null },
        { id: "run5", status: "skipped", message_id: null },
        { id: "run6", status: "skipped", message_id: null },
      ]);
      expect(rows[1]!.completed_at).toBeGreaterThan(0);
      expect(() => legacy.prepare("UPDATE durable_schedule_runs SET message_id = 'm1' WHERE id = 'run4'").run()).toThrow(/UNIQUE/);
      legacy.close();
    });

    it("blocks every run, including queued manual ones, while the platform has a schedule paused", async () => {
      const schedule = await schedules.create(OWNER, { name: "daily", cron: "0 9 * * *", environment: "chat", prompt: "p" });
      const queued = await schedules.runNow(OWNER.accountId, schedule.id, "before-pause");
      await schedules.idle();
      // A person's pause still allows an explicit run now.
      schedules.pause(OWNER.accountId, schedule.id);
      sessions.finishTurn(sessions.creates[0]!.sessionId, "msg-1");
      const manual = await schedules.runNow(OWNER.accountId, schedule.id, "after-user-pause");
      await schedules.idle();
      expect(schedules.runs(OWNER.accountId, schedule.id).find((run) => run.id === manual.id)!.status).toBe("running");
      expect(queued.id).not.toBe(manual.id);

      // A platform pause (here: sign-in revoked) refuses new manual runs and skips any still queued.
      schedules.pauseAllForOwner(OWNER.accountId, "Paused: signed out");
      schedules.resume(OWNER.accountId, schedule.id);
      schedules.pauseAllForOwner(OWNER.accountId, "Paused: signed out");
      await expectCode(schedules.runNow(OWNER.accountId, schedule.id, "after-platform-pause"), "conflict", /paused by the platform/);
    });

    it("skips a manual run queued before a platform pause", async () => {
      const schedule = await schedules.create(OWNER, { name: "daily", cron: "0 9 * * *", environment: "chat", prompt: "p" });
      await schedules.runNow(OWNER.accountId, schedule.id, "first");
      await schedules.idle();
      const second = await schedules.runNow(OWNER.accountId, schedule.id, "second");
      expect(second.status).toBe("queued");
      schedules.pauseAllForOwner(OWNER.accountId, "Paused: a run could not be stopped");
      sessions.finishTurn(sessions.creates[0]!.sessionId, "msg-1");
      await tick();
      expect(schedules.runs(OWNER.accountId, schedule.id).find((run) => run.id === second.id)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/could not be stopped/) });
      expect(sessions.creates).toHaveLength(1);
    });

    it("pauses schedules that continue a deleted session and skips their queued runs", async () => {
      sessions.views.set("s-chat", { id: "s-chat", ownerId: OWNER.accountId, environment: "chat", state: "idle", generation: 0 });
      sessions.history.set("s-chat", []);
      const schedule = await schedules.create(OWNER, { name: "check", cron: "0 9 * * *", target: { sessionId: "s-chat" }, prompt: "Check" });
      sessions.sendFailures.push("refused-transient");
      await schedules.runNow(OWNER.accountId, schedule.id, "x");
      await schedules.idle();
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "queued", reason: expect.stringMatching(/^Retrying/) });
      // Core removes the session before it announces the deletion.
      sessions.views.delete("s-chat");
      schedules.onSessionDeleted("s-chat");
      expect(schedules.get(OWNER.accountId, schedule.id)).toMatchObject({ state: "paused", pausedReason: expect.stringMatching(/was deleted/) });
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "skipped", reason: "The session was deleted before this run started" });
    });

    it("binds a schedule to the session it continues, never to a later session that reuses the ID", async () => {
      sessions.views.set("s-chat", { id: "s-chat", ownerId: OWNER.accountId, environment: "chat", state: "idle", generation: 0, incarnation: "inc-a" });
      sessions.history.set("s-chat", []);
      const schedule = await schedules.create(OWNER, { name: "check", cron: "0 9 * * *", target: { sessionId: "s-chat" }, prompt: "Check my calendar" });
      expect(schedules.listForSession(OWNER.accountId, "s-chat").map((info) => info.id)).toEqual([schedule.id]);
      // Deleted; then the same owner creates a new session with the same ID.
      sessions.views.delete("s-chat");
      schedules.onSessionDeleted("s-chat", "inc-a");
      sessions.views.set("s-chat", { id: "s-chat", ownerId: OWNER.accountId, environment: "chat", state: "idle", generation: 0, incarnation: "inc-b" });
      expect(schedules.listForSession(OWNER.accountId, "s-chat")).toEqual([]);
      await expectCode(() => schedules.resume(OWNER.accountId, schedule.id), "conflict", /was deleted/);
      await expectCode(schedules.runNow(OWNER.accountId, schedule.id, "x"), "conflict", /was deleted/);
      expect(sessions.sends).toHaveLength(0);
      // A late announcement of the old session's deletion leaves the new session's schedules alone.
      const fresh = await schedules.create(OWNER, { name: "fresh", cron: "0 9 * * *", target: { sessionId: "s-chat" }, prompt: "p" });
      schedules.onSessionDeleted("s-chat", "inc-a");
      expect(schedules.get(OWNER.accountId, fresh.id)).toMatchObject({ state: "active" });
      expect(schedules.listForSession(OWNER.accountId, "s-chat").map((info) => info.id)).toEqual([fresh.id]);
    });

    it("fails a run in progress when its session is deleted, so a session reusing the ID never settles it", async () => {
      const schedule = await schedules.create(OWNER, { name: "once", runAt: new Date(START + 60_000).toISOString(), environment: "chat", prompt: "p" });
      now += 60_000;
      await tick();
      const sessionId = sessions.creates[0]!.sessionId;
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "running" });
      sessions.views.delete(sessionId);
      schedules.onSessionDeleted(sessionId);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "failed", reason: expect.stringMatching(/deleted while the run was in progress/) });
      sessions.views.set(sessionId, { id: sessionId, ownerId: OTHER.accountId, environment: "chat", state: "idle", generation: 0, incarnation: "someone-else" });
      sessions.finishTurn(sessionId, "msg-1");
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "failed" });
    });

    it("lets a message belong to only one run, and serializes dispatch per session", async () => {
      sessions.views.set("s-chat", { id: "s-chat", ownerId: OWNER.accountId, environment: "chat", state: "idle", generation: 0 });
      sessions.history.set("s-chat", []);
      const a = await schedules.create(OWNER, { name: "a", runAt: new Date(START + 60_000).toISOString(), target: { sessionId: "s-chat" }, prompt: "Check my calendar" });
      const b = await schedules.create(OWNER, { name: "b", runAt: new Date(START + 60_000).toISOString(), target: { sessionId: "s-chat" }, prompt: "Check my calendar" });
      now += 60_000;
      sessions.sendFailures.push("lost");
      await tick();
      now += 5_000;
      await tick();
      now += 5_000;
      await tick();
      const ids = [...schedules.runs(OWNER.accountId, a.id), ...schedules.runs(OWNER.accountId, b.id)].map((run) => run.messageId);
      expect(new Set(ids).size).toBe(2);
      expect(sessions.sends).toHaveLength(2);
      expect(() =>
        db.prepare("UPDATE durable_schedule_runs SET message_id = ? WHERE schedule_id = ?").run(ids[0]!, b.id),
      ).toThrow(/UNIQUE/);
    });

    it("pauses the owner's schedule with a visible reason when background sign-in is gone at run time", async () => {
      const schedule = await schedules.create(OWNER, { name: "once", runAt: new Date(START + 60_000).toISOString(), environment: "chat", prompt: "p" });
      credentials.active.delete(OWNER.accountId);
      credentials.revokedReason = "octocat has no active background sign-in for this deployment";
      now += 60_000;
      await tick();
      expect(sessions.creates).toHaveLength(0);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "failed", reason: "octocat has no active background sign-in for this deployment" });
      expect(schedules.get(OWNER.accountId, schedule.id)).toMatchObject({ state: "paused", pausedReason: expect.stringMatching(/^Paused: /) });
    });

    it("pauses and resumes without backfilling, and runNow is idempotent per invocation", async () => {
      const schedule = await schedules.create(OWNER, { name: "daily", cron: "0 9 * * *", timeZone: "America/Los_Angeles", environment: "chat", prompt: "p" });
      schedules.pause(OWNER.accountId, schedule.id);
      now = Date.parse("2026-10-28T20:00:00Z");
      await tick();
      expect(schedules.runs(OWNER.accountId, schedule.id)).toHaveLength(0);
      expect(schedules.resume(OWNER.accountId, schedule.id).nextRunAt).toBe("2026-10-29T16:00:00.000Z");

      const first = await schedules.runNow(OWNER.accountId, schedule.id, "inv-1");
      const again = await schedules.runNow(OWNER.accountId, schedule.id, "inv-1");
      await schedules.idle();
      expect(again.id).toBe(first.id);
      expect(first.trigger).toBe("manual");
      expect(sessions.creates).toHaveLength(1);
      expect(schedules.runs(OWNER.accountId, schedule.id)).toHaveLength(1);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]!.status).toBe("running");
    });

    it("skips queued runs of a deleted schedule", async () => {
      const schedule = await schedules.create(OWNER, { name: "frequent", cron: "*/5 * * * *", environment: "chat", prompt: "p" });
      now = START + 5 * 60_000;
      await tick();
      now += 5 * 60_000;
      await tick();
      schedules.delete(OWNER.accountId, schedule.id);
      expect(schedules.list(OWNER.accountId)).toHaveLength(0);
      const rows = db.prepare("SELECT status, reason FROM durable_schedule_runs ORDER BY scheduled_for").all() as { status: string; reason: string | null }[];
      expect(rows.map((row) => row.status)).toEqual(["running", "skipped"]);
      expect(rows[1]!.reason).toMatch(/deleted/);
    });

    it("continues an existing session, matching its prompt in history after a crash", async () => {
      sessions.views.set("s-chat", { id: "s-chat", ownerId: OWNER.accountId, environment: "chat", state: "idle", generation: 0 });
      sessions.history.set("s-chat", [
        { id: "old", type: "user.message", timestamp: new Date(START - 86_400_000).toISOString(), parentId: null, data: { content: "Check my calendar", messageId: "old-1" } },
      ]);
      const schedule = await schedules.create(OWNER, { name: "check", runAt: new Date(START + 60_000).toISOString(), target: { sessionId: "s-chat" }, prompt: "Check my calendar" });
      expect(schedule).toMatchObject({ environment: "chat", target: { sessionId: "s-chat" } });
      now += 60_000;
      sessions.sendFailures.push("refused-transient");
      await tick();
      now += 5_000;
      await tick();
      expect(sessions.creates).toHaveLength(0);
      expect(sessions.sends).toEqual([{ sessionId: "s-chat", prompt: "Check my calendar", source: "system" }]);
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]).toMatchObject({ status: "running", sessionId: "s-chat" });
    });
  });

  describe("session incarnations", () => {
    const chat = (incarnation: string, extra: Partial<DurableSessionView> = {}): DurableSessionView => ({
      id: "s-chat",
      ownerId: OWNER.accountId,
      environment: "chat",
      state: "idle",
      generation: 0,
      incarnation,
      ...extra,
    });
    const runOf = (scheduleId: string) => schedules.runs(OWNER.accountId, scheduleId)[0]!;

    /** A first send whose outcome is unknown leaves the run `submitting`: the next dispatch must recover before sending. */
    async function recovering() {
      sessions.views.set("s-chat", chat("inc-a"));
      sessions.history.set("s-chat", []);
      const schedule = await schedules.create(OWNER, { name: "check", cron: "0 9 * * *", target: { sessionId: "s-chat" }, prompt: "Check my calendar" });
      sessions.sendFailures.push("refused-transient");
      await schedules.runNow(OWNER.accountId, schedule.id, "x");
      await schedules.idle();
      expect(runOf(schedule.id)).toMatchObject({ status: "queued", reason: expect.stringMatching(/^Retrying/) });
      now += 5_000;
      return schedule;
    }

    /** Applies `change` while the recovery's last history read is in flight, right before the prompt would be sent. */
    function duringLastRead(change: () => void) {
      let reads = 0;
      sessions.afterRequest = (method) => {
        if (method === "session.getMessages" && ++reads === 2) change();
      };
    }

    it("rechecks the schedule and its sign-in right before sending a recovered prompt", async () => {
      const deleted = await recovering();
      duringLastRead(() => schedules.delete(OWNER.accountId, deleted.id));
      await tick();
      expect(sessions.sends).toEqual([]);
      expect(db.prepare("SELECT status, reason FROM durable_schedule_runs").get()).toEqual({ status: "skipped", reason: "The schedule was deleted before this run started" });
      db.exec("DELETE FROM durable_schedule_runs; DELETE FROM durable_schedules");
      const revoked = await recovering();
      duringLastRead(() => schedules.pauseAllForOwner(OWNER.accountId, "Paused: octocat signed out"));
      await tick();
      expect(sessions.sends).toEqual([]);
      expect(runOf(revoked.id)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/paused before this run started \(Paused: octocat signed out\)/) });
    });

    it("never sends a recovered prompt to a session that reused the ID meanwhile", async () => {
      const schedule = await recovering();
      duringLastRead(() => sessions.views.set("s-chat", chat("inc-b")));
      await tick();
      expect(sessions.sends).toEqual([]);
      expect(runOf(schedule.id)).toMatchObject({ status: "skipped", reason: "The session was deleted before this run started" });
      expect(schedules.get(OWNER.accountId, schedule.id)).toMatchObject({ state: "paused", pausedReason: expect.stringMatching(/was deleted/) });
      // Every read and the attempted send expected the session the schedule continues.
      expect(new Set(sessions.fences.map((call) => call.incarnation))).toEqual(new Set(["inc-a"]));
    });

    it("lets core refuse a prompt for a session replaced as it is sent", async () => {
      sessions.views.set("s-chat", chat("inc-a"));
      sessions.history.set("s-chat", []);
      const schedule = await schedules.create(OWNER, { name: "check", cron: "0 9 * * *", target: { sessionId: "s-chat" }, prompt: "Check" });
      sessions.beforeWrite = () => sessions.views.set("s-chat", chat("inc-b"));
      await schedules.runNow(OWNER.accountId, schedule.id, "x");
      await schedules.idle();
      expect(sessions.sends).toEqual([]);
      expect(sessions.fences.filter((call) => call.method === "send")).toEqual([{ method: "send", incarnation: "inc-a" }]);
      expect(runOf(schedule.id)).toMatchObject({ status: "failed", reason: expect.stringMatching(/was not found/) });
      expect(schedules.get(OWNER.accountId, schedule.id)).toMatchObject({ state: "paused", pausedReason: expect.stringMatching(/was deleted/) });
    });

    it("never lets a session that reuses the ID settle a run of the session it replaced", async () => {
      sessions.views.set("s-chat", chat("inc-a"));
      sessions.history.set("s-chat", []);
      const schedule = await schedules.create(OWNER, { name: "check", cron: "0 9 * * *", target: { sessionId: "s-chat" }, prompt: "Check" });
      await schedules.runNow(OWNER.accountId, schedule.id, "x");
      await schedules.idle();
      expect(runOf(schedule.id)).toMatchObject({ status: "running", messageId: "msg-1" });
      // Deleted and the ID reused before the deletion was announced: the new session's turns say nothing about the run.
      sessions.views.set("s-chat", chat("inc-b", { lastTurn: { turnId: "msg-1", status: "completed" } }));
      sessions.finishTurn("s-chat", "msg-1");
      expect(runOf(schedule.id)).toMatchObject({ status: "running" });
      now += 60_000;
      await tick();
      expect(runOf(schedule.id)).toMatchObject({ status: "failed", reason: "The run's session was deleted while the run was in progress" });
      expect(schedules.get(OWNER.accountId, schedule.id)).toMatchObject({ state: "paused", pausedReason: expect.stringMatching(/was deleted/) });
    });

    it("never stops a turn of a session that reuses the ID when a run of the replaced one runs too long", async () => {
      sessions.views.set("s-chat", chat("inc-a"));
      sessions.history.set("s-chat", []);
      const schedule = await schedules.create(OWNER, { name: "check", cron: "0 9 * * *", target: { sessionId: "s-chat" }, prompt: "Check" });
      await schedules.runNow(OWNER.accountId, schedule.id, "x");
      await schedules.idle();
      sessions.emit("s-chat", "user.message", { messageId: "msg-1" }); // its turn started
      await tick();
      expect(runOf(schedule.id)).toMatchObject({ status: "running" });
      sessions.views.set("s-chat", chat("inc-b", { state: "running", lastTurn: { turnId: "msg-1", status: "running" } }));
      now += 7 * 60 * 60_000; // past the run lifetime
      await tick();
      expect(runOf(schedule.id)).toMatchObject({ status: "failed", reason: "The run's session was deleted while the run was in progress" });
      expect(sessions.fences.some((call) => call.method === "session.abort")).toBe(false);
    });

    it("ends the replaced session's runs when its deletion is announced late, and leaves the new session's alone", async () => {
      sessions.views.set("s-chat", chat("inc-a"));
      sessions.history.set("s-chat", []);
      const old = await schedules.create(OWNER, { name: "old", cron: "0 9 * * *", target: { sessionId: "s-chat" }, prompt: "Check" });
      await schedules.runNow(OWNER.accountId, old.id, "x");
      await schedules.idle();
      sessions.views.set("s-chat", chat("inc-b"));
      const fresh = await schedules.create(OWNER, { name: "fresh", cron: "0 9 * * *", target: { sessionId: "s-chat" }, prompt: "Plan" });
      await schedules.runNow(OWNER.accountId, fresh.id, "y");
      await schedules.idle();
      expect(runOf(fresh.id)).toMatchObject({ status: "running" });
      schedules.onSessionDeleted("s-chat", "inc-a");
      expect(runOf(old.id)).toMatchObject({ status: "failed", reason: "The run's session was deleted while the run was in progress" });
      expect(runOf(fresh.id)).toMatchObject({ status: "running" });
      expect(schedules.get(OWNER.accountId, fresh.id)).toMatchObject({ state: "active" });
      sessions.finishTurn("s-chat", runOf(fresh.id).messageId!);
      expect(runOf(fresh.id)).toMatchObject({ status: "completed" });
    });

    it("binds a schedule from before incarnations only to a session that is provably the same one", async () => {
      sessions.views.set("s-old", { id: "s-old", ownerId: OWNER.accountId, environment: "chat", state: "idle", generation: 0, incarnation: "inc-old", createdAt: new Date(START - 120_000).toISOString() });
      sessions.views.set("s-reused", { id: "s-reused", ownerId: OWNER.accountId, environment: "chat", state: "idle", generation: 0, incarnation: "inc-r1" });
      await schedules.create(OWNER, { name: "kept", cron: "0 9 * * *", target: { sessionId: "s-old" }, prompt: "p" });
      const reused = await schedules.create(OWNER, { name: "reused", cron: "0 9 * * *", target: { sessionId: "s-reused" }, prompt: "p" });
      db.exec("UPDATE durable_schedules SET target_incarnation = NULL");
      // While the gateway was down, s-reused was deleted and its ID reused (created after the schedule).
      sessions.views.set("s-reused", { id: "s-reused", ownerId: OWNER.accountId, environment: "chat", state: "idle", generation: 0, incarnation: "inc-r2", createdAt: new Date(START + 60_000).toISOString() });
      await schedules.stop();
      schedules = build();
      expect(db.prepare("SELECT name, target_incarnation, state FROM durable_schedules ORDER BY name").all()).toEqual([
        { name: "kept", target_incarnation: "inc-old", state: "active" },
        { name: "reused", target_incarnation: "retired", state: "paused" },
      ]);
      expect(schedules.get(OWNER.accountId, reused.id)).toMatchObject({ pausedReason: expect.stringMatching(/was deleted/) });
      await expectCode(() => schedules.resume(OWNER.accountId, reused.id), "conflict", /was deleted/);
    });

    it("re-keys a provisional binding once core reports incarnations, and pauses one whose session was replaced", async () => {
      // Core reports no incarnations yet: bindings are provisional (the session's creation time).
      sessions.views.set("s-a", { id: "s-a", ownerId: OWNER.accountId, environment: "chat", state: "idle", generation: 0 });
      sessions.views.set("s-b", { id: "s-b", ownerId: OWNER.accountId, environment: "chat", state: "idle", generation: 0 });
      sessions.history.set("s-a", []);
      const a = await schedules.create(OWNER, { name: "a", cron: "0 9 * * *", target: { sessionId: "s-a" }, prompt: "p" });
      const b = await schedules.create(OWNER, { name: "b", cron: "0 9 * * *", target: { sessionId: "s-b" }, prompt: "p" });
      expect(db.prepare("SELECT target_incarnation FROM durable_schedules WHERE id = ?").get(a.id)).toEqual({ target_incarnation: `created:${EARLIER}` });
      // Upgraded: core reports incarnations now. s-b was replaced while the gateway was down.
      sessions.views.set("s-a", { ...sessions.views.get("s-a")!, incarnation: "inc-a" });
      sessions.views.set("s-b", { id: "s-b", ownerId: OWNER.accountId, environment: "chat", state: "idle", generation: 0, incarnation: "inc-b2", createdAt: new Date(START + 1).toISOString() });
      await schedules.stop();
      schedules = build();
      expect(db.prepare("SELECT name, target_incarnation, state FROM durable_schedules ORDER BY name").all()).toEqual([
        { name: "a", target_incarnation: "inc-a", state: "active" },
        { name: "b", target_incarnation: `created:${EARLIER}`, state: "paused" },
      ]);
      await schedules.runNow(OWNER.accountId, a.id, "x");
      await schedules.idle();
      expect(sessions.fences.filter((call) => call.method === "send")).toEqual([{ method: "send", incarnation: "inc-a" }]);
      expect(schedules.get(OWNER.accountId, b.id)).toMatchObject({ pausedReason: expect.stringMatching(/was deleted/) });
    });

    it("binds runs from before incarnations to their sessions, or ends them", async () => {
      sessions.views.set("s-chat", chat("inc-a"));
      sessions.history.set("s-chat", []);
      const target = await schedules.create(OWNER, { name: "t", cron: "0 9 * * *", target: { sessionId: "s-chat" }, prompt: "p" });
      await schedules.runNow(OWNER.accountId, target.id, "x");
      await schedules.idle();
      const own = await schedules.create(OWNER, { name: "own", runAt: new Date(START + 60_000).toISOString(), environment: "chat", prompt: "q" });
      now += 60_000;
      await tick();
      expect([runOf(target.id).status, runOf(own.id).status]).toEqual(["running", "running"]);
      db.exec("UPDATE durable_schedule_runs SET session_incarnation = NULL; UPDATE durable_schedules SET target_incarnation = NULL");
      // The run's own session was deleted while the gateway was down.
      sessions.views.delete(runOf(own.id).sessionId!);
      await schedules.stop();
      schedules = build();
      expect(runOf(target.id)).toMatchObject({ status: "running" });
      expect(db.prepare("SELECT session_incarnation FROM durable_schedule_runs WHERE schedule_id = ?").get(target.id)).toEqual({ session_incarnation: "inc-a" });
      expect(runOf(own.id)).toMatchObject({ status: "failed", reason: "The run's session was deleted while the run was in progress" });
      sessions.finishTurn("s-chat", runOf(target.id).messageId!);
      expect(runOf(target.id)).toMatchObject({ status: "completed" });
    });

    it("binds a new session's run from before incarnations only to the session its schedule created", async () => {
      const own = await schedules.create(OWNER, { name: "own", runAt: new Date(START + 60_000).toISOString(), environment: "chat", prompt: "q" });
      const other = await schedules.create(OWNER, { name: "other", runAt: new Date(START + 60_000).toISOString(), environment: "chat", prompt: "r" });
      now += 60_000;
      await tick();
      expect([runOf(own.id).status, runOf(other.id).status]).toEqual(["running", "running"]);
      db.exec("UPDATE durable_schedule_runs SET session_incarnation = NULL");
      // While the gateway was down, the second run's session was deleted and the owner reused its ID at once: the
      // replacement falls in the run's time window, but its schedule did not create it.
      const reusedId = runOf(other.id).sessionId!;
      const { scheduleId: _created, ...replacement } = sessions.views.get(reusedId)!;
      sessions.views.set(reusedId, { ...replacement, incarnation: "inc-owner" });
      await schedules.stop();
      schedules = build();
      expect(runOf(own.id)).toMatchObject({ status: "running" });
      expect(db.prepare("SELECT session_incarnation FROM durable_schedule_runs WHERE schedule_id = ?").get(own.id)).not.toEqual({ session_incarnation: null });
      expect(runOf(other.id)).toMatchObject({ status: "failed", reason: "The run's session was deleted while the run was in progress" });
    });
  });

  describe("AppHost-declared schedules", () => {
    const declared = (prompt = "Triage the issues opened since the last run", runAs = "OctoCat") =>
      parseConfig({
        environments: { chat: { type: "shared" } },
        webhooks: { orders: { url: "https://orders.example/hook", environments: ["chat"], events: ["session.action_required"], secret: { secretEnv: "S" } } },
        schedules: {
          "weekday-triage": {
            cron: "0 9 * * 1-5",
            timeZone: "America/Los_Angeles",
            environment: "chat",
            session: { tools: [{ name: "lookup_order", parameters: { type: "object" } }] },
            webhook: "orders",
            prompt,
            runAs,
          },
          unowned: { cron: "0 9 * * *", environment: "chat", prompt: "p" },
        },
      });

    function withDeployment(config: ManagedCopilotConfig) {
      return new DurableSchedules({
        db,
        log: createLogger("test", "error"),
        deployment: config,
        sessions: () => sessions,
        credentials: () => credentials,
        actions: () => undefined,
        publish: (event) => published.push(event),
        now: () => now,
        options: { tickIntervalMs: 0 },
      });
    }

    it("waits paused for the named account's explicit approval, then runs as that account", async () => {
      await schedules.stop();
      schedules = withDeployment(declared());
      schedules.syncAppHost(OWNER);
      schedules.syncAppHost(OTHER);
      expect(schedules.list(OTHER.accountId)).toHaveLength(0);
      const [pending] = schedules.list(OWNER.accountId);
      expect(pending).toMatchObject({ name: "weekday-triage", createdBy: "apphost", state: "paused", webhook: "orders" });
      expect(pending!.pausedReason).toMatch(/Resume it to allow it to run as you/);

      now = Date.parse("2026-10-26T16:00:00Z");
      await tick();
      expect(sessions.creates).toHaveLength(0);

      // Resuming is the account's grant for this deployment, environment, and schedule.
      now = START;
      expect(schedules.resume(OWNER.accountId, pending!.id)).toMatchObject({ state: "active", nextRunAt: "2026-10-26T16:00:00.000Z" });
      now = Date.parse("2026-10-26T16:00:00Z");
      await tick();
      expect(sessions.creates).toEqual([expect.objectContaining({ environment: "chat", webhook: "orders", tools: [{ name: "lookup_order", parameters: { type: "object" } }] })]);
      schedules.syncAppHost(OWNER);
      expect(schedules.list(OWNER.accountId)[0]!.state).toBe("active");
    });

    it("pauses again when the operator changes the declaration, and deletes it when removed", async () => {
      await schedules.stop();
      schedules = withDeployment(declared());
      schedules.syncAppHost(OWNER);
      const [first] = schedules.list(OWNER.accountId);
      schedules.resume(OWNER.accountId, first!.id);

      schedules = withDeployment(declared("A different prompt"));
      schedules.syncAppHost(OWNER);
      const [changed] = schedules.list(OWNER.accountId);
      expect(changed).toMatchObject({ id: first!.id, state: "paused", prompt: "A different prompt" });
      expect(changed!.pausedReason).toMatch(/changed this schedule/);

      schedules = withDeployment(declared("A different prompt", "someone-else"));
      schedules.syncAppHost(OWNER);
      expect(schedules.list(OWNER.accountId)).toHaveLength(0);
    });

    it("removes approved AppHost schedules at startup once the AppHost declares none", async () => {
      await schedules.stop();
      schedules = withDeployment(declared());
      schedules.syncAppHost(OWNER);
      schedules.resume(OWNER.accountId, schedules.list(OWNER.accountId)[0]!.id);
      await schedules.stop();
      schedules = withDeployment(parseConfig({ environments: { chat: { type: "shared" } } }));
      schedules.start();
      expect(schedules.list(OWNER.accountId)).toHaveLength(0);
    });
  });

  describe("agent scheduling tools", () => {
    function tools(): Record<string, PlatformToolDefinition> {
      return Object.fromEntries(scheduleToolDefinitions({ deployment, schedules, credentials: () => credentials, now: () => now }).map((tool) => [tool.name, tool]));
    }
    const context = (sessionId: string, toolCallId: string, environment = "chat") => ({ sessionId, ownerId: OWNER.accountId, environment, toolCallId, idempotencyKey: `${sessionId}:${toolCallId}` });

    beforeEach(() => {
      sessions.views.set("s-bot", { id: "s-bot", ownerId: OWNER.accountId, environment: "chat", state: "running", generation: 0 });
      sessions.views.set("s-elsewhere", { id: "s-elsewhere", ownerId: OWNER.accountId, environment: "chat", state: "running", generation: 0 });
    });

    it("is offered only where the operator enabled scheduling", () => {
      const definitions = tools();
      expect(Object.keys(definitions).sort()).toEqual(["cancel_schedule", "list_schedules", "schedule_task"]);
      expect(definitions.schedule_task!.enabledFor("chat")).toBe(true);
      expect(definitions.schedule_task!.enabledFor("plain")).toBe(false);
    });

    it("schedules a one-shot reminder for the calling session that fires later and continues it", async () => {
      const result = await tools().schedule_task!.handler({ prompt: "Remind the user to stretch", delaySeconds: 120, name: "stretch" }, context("s-bot", "call-1"));
      expect(result).toMatch(/^Scheduled "stretch" \(id sch_/);
      const [schedule] = schedules.list(OWNER.accountId);
      expect(schedule).toMatchObject({ createdBy: "agent", target: { sessionId: "s-bot" }, runAt: new Date(START + 120_000).toISOString() });

      // A retried tool call (same idempotency key) does not create a second schedule.
      await tools().schedule_task!.handler({ prompt: "Remind the user to stretch", delaySeconds: 120, name: "stretch" }, context("s-bot", "call-1"));
      expect(schedules.list(OWNER.accountId)).toHaveLength(1);

      now += 120_000;
      await tick();
      expect(sessions.sends).toEqual([{ sessionId: "s-bot", prompt: "Remind the user to stretch", source: "system" }]);
    });

    it("lists and cancels only the calling session's tasks", async () => {
      await tools().schedule_task!.handler({ prompt: "daily digest", cron: "0 8 * * *", timeZone: "America/Los_Angeles" }, context("s-bot", "call-1"));
      await tools().schedule_task!.handler({ prompt: "other", delaySeconds: 60 }, context("s-elsewhere", "call-2"));
      const listed = JSON.parse(String(await tools().list_schedules!.handler({}, context("s-bot", "call-3")))) as { id: string; cron: string }[];
      expect(listed).toHaveLength(1);
      expect(listed[0]!.cron).toBe("0 8 * * *");
      const otherId = schedules.list(OWNER.accountId).find((schedule) => schedule.target?.sessionId === "s-elsewhere")!.id;
      expect(await tools().cancel_schedule!.handler({ scheduleId: otherId }, context("s-bot", "call-4"))).toMatchObject({ resultType: "failure" });
      expect(await tools().cancel_schedule!.handler({ scheduleId: listed[0]!.id }, context("s-bot", "call-5"))).toMatch(/^Cancelled/);
      expect(schedules.list(OWNER.accountId).map((schedule) => schedule.target?.sessionId)).toEqual(["s-elsewhere"]);
    });

    it("enforces frequency limits and explains missing sign-in to the model", async () => {
      expect(await tools().schedule_task!.handler({ prompt: "spam", cron: "* * * * *" }, context("s-bot", "c1"))).toMatchObject({
        resultType: "failure",
        textResultForLlm: expect.stringMatching(/at most every 5 minutes/),
      });
      expect(await tools().schedule_task!.handler({ prompt: "x", delaySeconds: 60, cron: "0 8 * * *" }, context("s-bot", "c2"))).toMatchObject({ resultType: "failure" });
      credentials.active.delete(OWNER.accountId);
      expect(await tools().schedule_task!.handler({ prompt: "x", delaySeconds: 60 }, context("s-bot", "c3"))).toMatchObject({
        resultType: "failure",
        textResultForLlm: expect.stringMatching(/npx managed-copilot login/),
      });
    });

    it("rechecks the operator's approval at run time", async () => {
      await tools().schedule_task!.handler({ prompt: "x", delaySeconds: 60 }, context("s-bot", "c1"));
      const restricted = parseConfig({ environments: { chat: { type: "shared" } } });
      await schedules.stop();
      schedules = new DurableSchedules({
        db,
        log: createLogger("test", "error"),
        deployment: restricted,
        sessions: () => sessions,
        credentials: () => credentials,
        actions: () => undefined,
        publish: (event) => published.push(event),
        now: () => now,
        options: { tickIntervalMs: 0 },
      });
      now += 60_000;
      await tick();
      expect(sessions.sends).toHaveLength(0);
      expect(schedules.list(OWNER.accountId)[0]).toMatchObject({ state: "paused", lastRun: { status: "failed" } });
    });
  });

  describe("operator pauses and views", () => {
    it("show operators run reasons without the output a failure carried, while the owner sees it all", async () => {
      const schedule = await schedules.create(OWNER, { name: "once", runAt: new Date(START + 60_000).toISOString(), environment: "chat", prompt: "p" });
      now += 60_000;
      await tick();
      const [run] = schedules.runs(OWNER.accountId, schedule.id);
      sessions.emit(run!.sessionId!, "session.error", { message: "setup failed\nLast output:\nPRIVATE-LINE", originatingMessageId: "msg-1" });
      expect(schedules.runs(OWNER.accountId, schedule.id)[0]!.reason).toContain("PRIVATE-LINE");
      const views = JSON.stringify([schedules.operatorSchedules(), schedules.operatorRuns(schedule.id)]);
      expect(views).not.toContain("PRIVATE-LINE");
      expect(schedules.operatorRuns(schedule.id).schedule.lastRun?.reason).toMatch(/setup failed\n\(Command output is not shown to operators\.\)$/);
    });

    it("never hide the owner's pause or a platform pause behind an operator's", async () => {
      const schedule = await schedules.create(OWNER, { name: "daily", cron: "0 9 * * *", environment: "chat", prompt: "p" });
      // The owner pauses during an operator's pause: lifting the operator's leaves the owner's.
      schedules.operatorPause(schedule.id, "alice", "maintenance");
      schedules.pause(OWNER.accountId, schedule.id);
      expect(schedules.get(OWNER.accountId, schedule.id).pausedReason).toMatch(/^Paused: an operator \(@alice\) paused this schedule \(maintenance\)\. Its owner had paused it too\.$/);
      expect(schedules.operatorResume(schedule.id)).toMatchObject({ state: "paused" });
      expect(schedules.get(OWNER.accountId, schedule.id).pausedReason).toBeUndefined();
      await expectCode(() => schedules.operatorResume(schedule.id), "conflict", /paused by its owner/);

      // A platform pause takes over an operator's: only the owner lifts it, even once their sign-in works again.
      schedules.operatorPause(schedule.id, "alice");
      expect(schedules.pauseAllForOwner(OWNER.accountId, "Paused: Signed out with `managed-copilot logout`.")).toBe(1);
      expect(schedules.get(OWNER.accountId, schedule.id).pausedReason).toBe("Paused: Signed out with `managed-copilot logout`.");
      await expectCode(() => schedules.operatorResume(schedule.id), "conflict", /only its owner can resume it/);
      expect(schedules.resume(OWNER.accountId, schedule.id)).toMatchObject({ state: "active" });
    });
  });
});
