import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, WEBHOOK_HEADERS, type ActionCapability, type PlatformEvent } from "@managed-copilot/protocol";
import { migrate, openDatabase, type Database } from "../../src/db.js";
import type { Logger } from "../../src/log.js";
import type { ActionsService } from "../../src/modules/durable/contract.js";
import { DURABLE_MIGRATIONS } from "../../src/modules/durable/migrations.js";
import { DurableWebhooks } from "../../src/modules/durable/webhooks/service.js";

interface Received {
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

const SECRET = "whsec_test_secret";
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

describe("durable webhooks", () => {
  let server: Server;
  let base: string;
  let received: Received[];
  let statuses: number[];
  let db: Database;
  let now: number;
  let webhooks: DurableWebhooks;
  let minted: { sessionId: string; actionIds: readonly string[]; webhook: string }[];
  let pendingIds: Set<string>;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "http://example.invalid/" });
          res.end();
          return;
        }
        const status = statuses.shift() ?? 200;
        res.writeHead(status);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function build(paths: { orders?: string; audit?: string } = {}, env: Record<string, string> = { ORDERS_SECRET: SECRET, AUDIT_SECRET: "other" }) {
    const deployment = parseConfig({
      environments: { chat: { type: "shared" }, coder: { type: "isolated" } },
      webhooks: {
        orders: { url: `${base}${paths.orders ?? "/orders"}`, environments: ["chat"], events: ["session.action_required", "session.idle"], secret: { secretEnv: "ORDERS_SECRET" } },
        audit: { url: `${base}${paths.audit ?? "/audit"}`, environments: ["chat", "coder"], events: ["*"], secret: { secretEnv: "AUDIT_SECRET" } },
      },
    });
    const actions = {
      mintCapability: (sessionId: string, actionIds: readonly string[], webhook: string): ActionCapability | undefined => {
        minted.push({ sessionId, actionIds, webhook });
        const pending = actionIds.filter((id) => pendingIds.has(id));
        if (pending.length === 0) return undefined;
        return { token: `mcc_${webhook}_${minted.length}`, expiresAt: new Date(now + 60_000).toISOString(), sessionId, actionIds: pending, audience: "http://gateway" };
      },
    } as unknown as ActionsService;
    return new DurableWebhooks({
      db,
      log: silent,
      deployment,
      mode: "local",
      env,
      actions: () => actions,
      now: () => now,
      options: { pollIntervalMs: 0, baseDelayMs: 1_000, maxAttempts: 3, requestTimeoutMs: 2_000 },
    });
  }

  function event(type: PlatformEvent["type"], environment = "chat", data: Record<string, unknown> = {}): PlatformEvent {
    return { id: `evt_${Math.random().toString(36).slice(2)}`, type, createdAt: new Date(now).toISOString(), sessionId: "s1", environment, data };
  }

  function verify(item: Received, secret = SECRET): boolean {
    const header = String(item.headers[WEBHOOK_HEADERS.signature]);
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
    if (!match) return false;
    const expected = createHmac("sha256", secret).update(`${match[1]}.${item.body}`).digest("hex");
    return expected === match[2];
  }

  beforeEach(() => {
    received = [];
    statuses = [];
    minted = [];
    pendingIds = new Set();
    db = openDatabase(":memory:");
    migrate(db, "durable", DURABLE_MIGRATIONS);
    now = Date.parse("2026-10-23T12:00:00Z");
    webhooks = build();
    webhooks.start();
  });

  afterEach(async () => {
    await webhooks.stop();
    db.close();
  });

  it("routes events only to subscriptions that cover the environment and event type", () => {
    expect(webhooks.subscribers("chat", "session.idle").sort()).toEqual(["audit", "orders"]);
    expect(webhooks.subscribers("chat", "artifact.published")).toEqual(["audit"]);
    expect(webhooks.subscribers("coder", "session.action_required")).toEqual(["audit"]);
    expect(webhooks.subscribers("other", "session.idle")).toEqual([]);
    expect(webhooks.enqueue(event("session.idle"), { ownerId: 1 })).toBe(2);
    expect(webhooks.enqueue(event("schedule.run_started", "coder"), { ownerId: 1 })).toBe(1);
  });

  it("signs the raw body with the subscription secret and identifies the event", async () => {
    const sent = event("session.idle");
    webhooks.enqueue(sent, { ownerId: 1 });
    await webhooks.pump();
    expect(received).toHaveLength(2);
    const orders = received.find((item) => item.headers["user-agent"]?.includes("ManagedCopilot") && verify(item))!;
    expect(orders).toBeDefined();
    expect(orders.headers[WEBHOOK_HEADERS.eventId]).toBe(sent.id);
    expect(orders.headers[WEBHOOK_HEADERS.deliveryAttempt]).toBe("1");
    const envelope = JSON.parse(orders.body);
    expect(envelope).toMatchObject({ id: sent.id, type: "session.idle", deployment: "copilot", sessionId: "s1" });
    expect(envelope.capability).toBeUndefined();
    const audit = received.find((item) => item !== orders)!;
    expect(verify(audit)).toBe(false);
    expect(verify(audit, "other")).toBe(true);
    expect(webhooks.deliveries({ state: "delivered" })).toHaveLength(2);
  });

  it("deduplicates the same event and retries with backoff using the same event ID", async () => {
    await webhooks.stop();
    webhooks = build({ audit: "/audit-unused" }, { ORDERS_SECRET: SECRET });
    webhooks.start();
    const sent = event("session.action_required");
    expect(webhooks.enqueue(sent, { ownerId: 1 })).toBe(2);
    expect(webhooks.enqueue(sent, { ownerId: 1 })).toBe(0);
    statuses.push(500);
    await webhooks.pump();
    const orders = () => received.filter((item) => verify(item));
    expect(orders()).toHaveLength(1);
    const [retrying] = webhooks.deliveries({ state: "pending" }).filter((delivery) => delivery.webhook === "orders");
    expect(retrying).toMatchObject({ attempts: 1, lastStatus: 500, lastError: "The webhook answered HTTP 500" });

    await webhooks.pump();
    expect(orders()).toHaveLength(1);
    now += 1_300;
    await webhooks.pump();
    expect(orders()).toHaveLength(2);
    expect(orders().map((item) => item.headers[WEBHOOK_HEADERS.eventId])).toEqual([sent.id, sent.id]);
    expect(orders()[1]!.headers[WEBHOOK_HEADERS.deliveryAttempt]).toBe("2");
    expect(webhooks.deliveries({ state: "delivered" }).map((delivery) => delivery.webhook)).toContain("orders");
  });

  it("marks a delivery failed after the bounded attempts and keeps it visible", async () => {
    statuses.push(503, 503, 503, 503, 503, 503);
    webhooks.enqueue(event("schedule.run_completed", "coder"), { ownerId: 1 });
    for (let i = 0; i < 5; i++) {
      await webhooks.pump();
      now += 10_000;
    }
    const [failed] = webhooks.deliveries({ state: "failed" });
    expect(failed).toMatchObject({ webhook: "audit", eventType: "schedule.run_completed", attempts: 3, lastStatus: 503 });
    expect(received).toHaveLength(3);
  });

  it("fails visibly instead of sending unsigned deliveries when the secret is missing", async () => {
    await webhooks.stop();
    webhooks = build({}, { AUDIT_SECRET: "other" });
    webhooks.start();
    webhooks.enqueue(event("session.idle"), { ownerId: 1 });
    await webhooks.pump();
    expect(received).toHaveLength(1);
    expect(webhooks.deliveries({ state: "failed" })).toMatchObject([{ webhook: "orders", lastError: "The webhook's signing secret is not configured" }]);
  });

  it("does not follow redirects", async () => {
    await webhooks.stop();
    webhooks = build({ orders: "/redirect", audit: "/redirect" });
    webhooks.start();
    webhooks.enqueue(event("session.idle"), { ownerId: 1 });
    await webhooks.pump();
    expect(webhooks.deliveries({ state: "pending" }).map((delivery) => delivery.lastStatus)).toEqual([302, 302]);
  });

  it("attaches a fresh capability per attempt, only for actions still pending", async () => {
    await webhooks.stop();
    webhooks = build({}, { ORDERS_SECRET: SECRET });
    webhooks.start();
    pendingIds = new Set(["act_1", "act_2"]);
    const sent = event("session.action_required", "chat", { actions: [{ id: "act_1" }, { id: "act_2" }] });
    webhooks.enqueue(sent, { ownerId: 1 });
    statuses.push(500);
    await webhooks.pump();
    const first = JSON.parse(received.find((item) => verify(item))!.body);
    expect(first.capability).toMatchObject({ sessionId: "s1", actionIds: ["act_1", "act_2"] });

    pendingIds.delete("act_1");
    now += 1_300;
    await webhooks.pump();
    const second = JSON.parse(received.filter((item) => verify(item))[1]!.body);
    expect(second.capability).toMatchObject({ actionIds: ["act_2"] });
    expect(second.capability.token).not.toBe(first.capability.token);
    expect(minted.every((entry) => entry.webhook === "orders" && entry.sessionId === "s1")).toBe(true);

    pendingIds.clear();
    webhooks.enqueue(event("session.action_required", "chat", { actions: [{ id: "act_2" }] }), { ownerId: 1 });
    await webhooks.pump();
    expect(JSON.parse(received.filter((item) => verify(item))[2]!.body).capability).toBeUndefined();
  });

  it("redelivers deliveries interrupted by a restart", async () => {
    webhooks.enqueue(event("session.idle"), { ownerId: 1 });
    db.prepare("UPDATE durable_webhook_deliveries SET state = 'delivering'").run();
    await webhooks.stop();
    webhooks = build();
    webhooks.start();
    await webhooks.pump();
    expect(received).toHaveLength(2);
    expect(webhooks.deliveries({ state: "delivered" })).toHaveLength(2);
  });

  it("stops queued deliveries a narrowed subscription is no longer authorized for", async () => {
    await webhooks.stop();
    webhooks = build({}, { ORDERS_SECRET: SECRET, AUDIT_SECRET: "other" });
    webhooks.enqueue(event("session.idle", "coder"), { ownerId: 1 });
    // The operator narrows "audit" to chat only and restarts before the queued coder event went out.
    const narrowed = parseConfig({
      environments: { chat: { type: "shared" }, coder: { type: "isolated" } },
      webhooks: { audit: { url: `${base}/audit`, environments: ["chat"], events: ["*"], secret: { secretEnv: "AUDIT_SECRET" } } },
    });
    webhooks = new DurableWebhooks({ db, log: silent, deployment: narrowed, mode: "local", env: { AUDIT_SECRET: "other" }, actions: () => undefined, now: () => now, options: { pollIntervalMs: 0 } });
    webhooks.start();
    await webhooks.pump();
    expect(received).toHaveLength(0);
    expect(webhooks.deliveries({ state: "failed" })).toMatchObject([{ webhook: "audit", lastError: "The webhook is no longer authorized for this event's environment or type" }]);
  });

  it("shows each owner only their own sessions' deliveries", () => {
    webhooks.enqueue(event("session.idle"), { ownerId: 1 });
    webhooks.enqueue(event("session.idle"), { ownerId: 2 });
    expect(webhooks.deliveries({ ownerId: 1 })).toHaveLength(2);
    expect(webhooks.deliveries({ ownerId: 2 })).toHaveLength(2);
    expect(webhooks.deliveries({ ownerId: 3 })).toHaveLength(0);
    expect(webhooks.deliveries()).toHaveLength(4);
  });
});
