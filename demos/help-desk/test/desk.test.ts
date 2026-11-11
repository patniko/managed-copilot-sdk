import type { PermissionRequestResult } from "@github/copilot-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { HelpDesk, runIdAt, runStartedAt } from "../src/server/desk.js";
import { HelpDeskError } from "../src/server/errors.js";
import { parseSessionId, sessionIdFor } from "../src/server/ticket.js";
import type { ServerEvent } from "../src/shared/types.js";
import { event, FakeFactory, FakePlatform, reportBug, settle, testConfig } from "./fakes.js";

const desks: HelpDesk[] = [];
afterEach(() => {
  for (const desk of desks.splice(0)) desk.close();
});

function setup(platform = new FakePlatform(), factory = new FakeFactory(), config = testConfig()) {
  const events: ServerEvent[] = [];
  const desk = new HelpDesk(platform, config, (published) => events.push(published), factory);
  desk.start();
  desks.push(desk);
  return { desk, platform, events, factory };
}

/** Simulates `size` customers and waits until every session exists and got its first message. */
async function simulate(desk: HelpDesk, platform: FakePlatform, size = 5) {
  const run = await desk.simulate(size);
  for (let tries = 0; tries < 50 && [...platform.sessions.values()].filter((session) => session.sent.length > 0).length < size; tries++) await settle(5);
  return run;
}

const refund = (toolCallId: string, orderId: string) => ({ kind: "custom-tool", toolName: "request_refund", toolCallId, args: { orderId, reason: "broken" }, toolDescription: "Refund" });

describe("session IDs", () => {
  it("carry the simulation and the customer, so a restarted Help Desk finds its tickets", () => {
    const runId = runIdAt(new Date("2026-11-03T10:00:00.000Z"), () => 0.5);
    expect(runStartedAt(runId)?.toISOString()).toBe("2026-11-03T10:00:00.000Z");
    expect(sessionIdFor(runId, "c07")).toBe(`hd-${runId}-c07`);
    expect(parseSessionId(`hd-${runId}-c07`)).toEqual({ runId, customerId: "c07" });
    expect(parseSessionId("3f0c2b1e-0000-4000-8000-000000000000")).toBeUndefined();
  });
});

describe("a simulation", () => {
  it("starts one session per customer on the shared environment, bound to that customer", async () => {
    const { desk, platform, events } = setup();
    const run = await simulate(desk, platform);
    expect(run.size).toBe(5);
    expect(platform.created.map((config) => config.sessionId)).toEqual(["c01", "c02", "c03", "c04", "c05"].map((id) => sessionIdFor(run.id, id)));
    const liam = platform.created[1]!;
    expect(liam).toMatchObject({ model: "claude-haiku-4.5", streaming: true, availableTools: ["custom:*"] });
    expect(liam.tools?.map((tool) => tool.name)).toHaveLength(7);
    expect(liam.systemMessage?.content).toContain("chatting with Liam");
    expect(platform.sessions.get(sessionIdFor(run.id, "c02"))?.sent).toEqual([{ prompt: "Can you check the status of order CO-48177?" }]);
    expect(events.some((published) => published.type === "run" && published.run?.id === run.id)).toBe(true);
    // Liam's tools refuse Sofia's order, whatever the model asks for.
    expect(await platform.sessions.get(sessionIdFor(run.id, "c02"))!.call("get_order", { orderId: "CO-48177" })).toEqual({ ok: false, error: "No order CO-48177 on this account." });
  });

  it("accepts 5, 10, or 25 customers, and only while connected", async () => {
    const { desk, platform } = setup();
    expect(() => desk.simulate(7)).toThrow(/5, 10, 25/);
    platform.setStatus({ state: "unavailable", message: "Managed Copilot isn't reachable yet." });
    expect(() => desk.simulate(5)).toThrow("Managed Copilot isn't reachable yet.");
  });

  it("refuses a second change while one is in progress", async () => {
    const { desk } = setup();
    const first = desk.simulate(5);
    expect(() => desk.simulate(5)).toThrow(/still starting or ending/);
    await first;
  });

  it("shows a session that couldn't start as failed, and counts the others", async () => {
    const platform = new FakePlatform();
    platform.failCreate.add("c01");
    const { desk } = setup(platform);
    await simulate(desk, platform, 5);
    await settle(5);
    expect(desk.ticket("c01")).toMatchObject({ status: "failed", problem: "Couldn't start the session: The runtime is busy" });
    expect(desk.ticket("c01").sessionId).toBeUndefined();
    expect(desk.computeCounters().sessions).toBe(4);
  });

  it("holds a refund for the operator, then answers the runtime with the decision", async () => {
    const { desk, platform } = setup();
    const run = await simulate(desk, platform);
    const sofia = platform.sessions.get(sessionIdFor(run.id, "c03"))!;
    const pending = sofia.ask(refund("call-1", "CO-48177")) as Promise<PermissionRequestResult>;
    await settle();
    expect(desk.ticket("c03")).toMatchObject({ status: "approval", approval: { id: "call-1", action: "refund", orderId: "CO-48177", amount: 39, reason: "broken" } });
    desk.answer("c03", "call-1", true);
    expect(await pending).toEqual({ kind: "approve-once", approvedInteractively: true });
    expect(desk.ticket("c03").approval).toBeUndefined();
    expect(() => desk.answer("c03", "call-1", true)).toThrow(/answered already/);

    const noah = platform.sessions.get(sessionIdFor(run.id, "c04"))!;
    const cancel = noah.ask({ kind: "custom-tool", toolName: "cancel_order", toolCallId: "call-2", args: { orderId: "CO-48231" } }) as Promise<PermissionRequestResult>;
    await settle();
    desk.answer("c04", "call-2", false);
    expect(await cancel).toMatchObject({ kind: "reject", feedback: expect.stringContaining("declined") });
  });

  it("lets the store refuse a request no one needs to see", async () => {
    const { desk, platform } = setup();
    const run = await simulate(desk, platform);
    const liam = platform.sessions.get(sessionIdFor(run.id, "c02"))!;
    expect(await liam.ask(refund("call-1", "CO-48177"))).toEqual({ kind: "approve-once" });
    expect(desk.ticket("c02").approval).toBeUndefined();
    expect(await liam.ask({ kind: "custom-tool", toolName: "get_order", toolCallId: "call-2", args: {} })).toEqual({ kind: "approve-once" });
  });

  it("follows each conversation from the session's events", async () => {
    const { desk, platform } = setup();
    const run = await simulate(desk, platform);
    const maya = platform.sessions.get(sessionIdFor(run.id, "c01"))!;
    maya.emit(event("user.message", { content: "Where's my tent?" }));
    expect(desk.ticket("c01").status).toBe("answering");
    maya.emit(event("tool.execution_start", { toolCallId: "t1", toolName: "track_shipment", arguments: { orderId: "CO-48213" } }));
    maya.emit(event("tool.execution_complete", { toolCallId: "t1", success: true, result: { content: JSON.stringify({ orderId: "CO-48213", carrier: "UPS" }) } }));
    maya.emit(event("assistant.message", { messageId: "m1", content: "It's held in Denver by weather." }));
    maya.premium = 0.33;
    maya.emit(event("session.idle", {}, { ephemeral: true }));
    await settle(5);
    expect(desk.ticket("c01")).toMatchObject({ status: "waiting", premiumRequests: 0.33 });
    expect(desk.ticket("c01").items.map((item) => item.kind)).toEqual(["message", "tool", "message"]);
  });

  it("counts sessions, the one runtime they share, sandboxes, messages, and premium requests", async () => {
    const { desk, platform } = setup();
    const run = await simulate(desk, platform, 10);
    const sessions = [...platform.sessions.values()];
    for (const session of sessions) {
      session.emit(event("user.message", { content: "Hi" }));
      session.emit(event("assistant.message", { messageId: `m-${session.sessionId}`, content: "Hello!" }));
      session.premium = 0.33;
      session.emit(event("session.idle", {}, { ephemeral: true }));
    }
    await desk.sync();
    await settle(5);
    expect(desk.computeCounters()).toEqual({ sessions: 10, runtimes: 1, sandboxes: 0, messages: 20, premiumRequests: 3.3 });

    // A session the platform placed in a sandbox would bring its own runtime and sandbox.
    platform.listed.set(sessionIdFor(run.id, "c01"), { ...platform.listed.get(sessionIdFor(run.id, "c01"))!, placement: "sandbox", sandbox: { id: "sb", size: "small", state: "running", network: { access: "disabled", allowedDomains: [] } } });
    await desk.sync();
    expect(desk.computeCounters()).toMatchObject({ runtimes: 2, sandboxes: 1 });
  });

  it("ends by deleting every session", async () => {
    const { desk, platform, events } = setup();
    const run = await simulate(desk, platform);
    await desk.end();
    expect(platform.deleted.sort()).toEqual(["c01", "c02", "c03", "c04", "c05"].map((id) => sessionIdFor(run.id, id)));
    expect(desk.state().run).toBeUndefined();
    expect(desk.state().tickets).toEqual([]);
    expect(desk.computeCounters().sessions).toBe(0);
    expect(events.filter((published) => published.type === "run").at(-1)).toEqual({ type: "run", tickets: [], issues: [] });
    expect(() => desk.ticket("c01")).toThrow(/isn't in the current simulation/);
  });

  it("replaces the previous simulation when a new one starts", async () => {
    const { desk, platform } = setup();
    const first = await simulate(desk, platform);
    await settle(2);
    const second = await desk.simulate(5);
    expect(second.id).not.toBe(first.id);
    expect(platform.deleted).toContain(sessionIdFor(first.id, "c05"));
  });
});

describe("after a restart", () => {
  it("picks up the latest simulation, rebuilds its conversations, replays refunds, and deletes older leftovers", async () => {
    const platform = new FakePlatform();
    const older = runIdAt(new Date("2026-11-03T09:00:00.000Z"));
    const latest = runIdAt(new Date("2026-11-03T10:00:00.000Z"));
    platform.seed(sessionIdFor(older, "c01"));
    platform.seed(sessionIdFor(latest, "c01"), [event("user.message", { content: "Where's my tent?" }), event("assistant.message", { messageId: "m1", content: "In Denver." })]);
    platform.seed(sessionIdFor(latest, "c03"), [
      event("user.message", { content: "Refund please" }),
      event("tool.execution_start", { toolCallId: "t1", toolName: "request_refund", arguments: { orderId: "CO-48177", reason: "broken" } }),
      event("permission.requested", { permissionRequest: { kind: "custom-tool", toolCallId: "t1", toolName: "request_refund" } }),
      event("permission.completed", { toolCallId: "t1", result: { kind: "approved" } }),
      event("tool.execution_complete", { toolCallId: "t1", success: true, result: { content: JSON.stringify({ ok: true, orderId: "CO-48177", refunded: 39 }) } }),
    ]);
    platform.seed("someone-elses-session");
    const { desk } = setup(platform);
    platform.connect();
    for (let tries = 0; tries < 50 && platform.resumed.length < 2; tries++) await settle(5);
    await settle(5);

    expect(desk.state().run).toMatchObject({ id: latest, size: 2, startedAt: "2026-11-03T10:00:00.000Z" });
    expect(desk.ticket("c01")).toMatchObject({ status: "waiting", items: [{ text: "Where's my tent?" }, { text: "In Denver." }] });
    expect(desk.ticket("c03").items[1]).toMatchObject({ kind: "tool", status: "done" });
    expect(desk.shop.getOrder("c03", "CO-48177")).toMatchObject({ refunded: 39 });
    expect(platform.resumed.sort()).toEqual([sessionIdFor(latest, "c01"), sessionIdFor(latest, "c03")]);
    expect(platform.deleted).toEqual([sessionIdFor(older, "c01")]);
    expect(platform.listed.has("someone-elses-session")).toBe(true);
    expect(desk.computeCounters()).toMatchObject({ sessions: 2, runtimes: 1, sandboxes: 0, messages: 3 });
  });

  it("drops a ticket whose session was deleted elsewhere", async () => {
    const { desk, platform } = setup();
    const run = await simulate(desk, platform);
    platform.listed.delete(sessionIdFor(run.id, "c02"));
    await desk.sync();
    expect(desk.state().tickets.map((ticket) => ticket.customerId)).toEqual(["c01", "c03", "c04", "c05"]);
  });
});

// What three customers write, and what their agents report with report_bug.
const AISHA = "The code TRAIL15 from your newsletter says 'invalid code' when I paste it at checkout, so I paid full price for my jacket.";
const AISHA_REPORT = {
  area: "promo-codes",
  title: "TRAIL15 rejected when pasted from the newsletter",
  whatHappened: "She pasted TRAIL15 from the newsletter at checkout and got 'invalid code', so she paid full price ($189.00) for her jacket.",
  expected: "TRAIL15 takes 15% off, however it's pasted.",
  orderId: "CO-48224",
};
const BEN = "Your promo code TRAIL15 doesn't work if I type it in lowercase.";
const BEN_REPORT = { area: "promo-codes", title: "Lowercase trail15 rejected", whatHappened: "Typing trail15 in lowercase says the code is invalid.", expected: "Codes work in any case." };
const LUCAS = "I changed the water bottles from 1 to 2 in my cart, but my order charged me for 3.";
const LUCAS_REPORT = { area: "cart", title: "Changing a quantity adds to it", whatHappened: "He changed the bottles from 1 to 2 and was charged for 3.", expected: "Charged for the 2 he chose.", orderId: "CO-48198" };
const APP = "http://localhost:7440";

/** Waits until `done` holds (polls and publishing run on timers). */
async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !done(); tries++) await settle(5);
  expect(done()).toBe(true);
}

describe("software issues", () => {
  async function reported(size = 25, desk = setup()) {
    const run = await simulate(desk.desk, desk.platform, size);
    const session = (customerId: string) => desk.platform.sessions.get(sessionIdFor(run.id, customerId))!;
    return { ...desk, run, session };
  }

  it("group the agents' reports of problems with the website by area, oldest first, and follow the tickets", async () => {
    const { desk, events, session } = await reported();
    await reportBug(session("c05"), AISHA, AISHA_REPORT);
    await reportBug(session("c08"), LUCAS, LUCAS_REPORT);
    await reportBug(session("c18"), BEN, BEN_REPORT);
    expect(desk.ticket("c05").bug).toEqual({ ...AISHA_REPORT, at: expect.any(String) });
    expect(desk.issues()).toEqual([
      {
        area: "promo-codes",
        title: "Promo codes rejected at checkout",
        reports: [
          { customerId: "c05", name: "Aisha Khan", whatHappened: AISHA_REPORT.whatHappened, orderId: "CO-48224", at: expect.any(String) },
          { customerId: "c18", name: "Ben Carter", whatHappened: BEN_REPORT.whatHappened, at: expect.any(String) },
        ],
      },
      { area: "cart", title: "Wrong quantities in the cart", reports: [{ customerId: "c08", name: "Lucas Silva", whatHappened: LUCAS_REPORT.whatHappened, orderId: "CO-48198", at: expect.any(String) }] },
    ]);
    expect(desk.state().issues).toEqual(desk.issues());
    await until(() => events.some((published) => published.type === "issues" && published.issues.length === 2));
    expect(events.filter((published) => published.type === "issues").at(-1)).toEqual({ type: "issues", issues: desk.issues() });
  });

  it("go to Software Factory once each: the storefront to fix, the reports and conversations, and a link back", async () => {
    const { desk, factory, run, session } = await reported();
    await reportBug(session("c05"), AISHA, AISHA_REPORT);
    await reportBug(session("c18"), BEN, BEN_REPORT);
    expect(desk.desk().factory).toEqual({ configured: true, url: "http://factory.test" });

    const issue = await desk.routeIssue("promo-codes", APP);
    expect(issue.routed).toEqual({ workOrderId: "wo_1", number: 1, title: "Fix: promo codes rejected at checkout", status: "queued", url: "http://factory.test/#/wo/wo_1" });
    expect(desk.issues()[0]?.routed).toEqual(issue.routed);

    const sent = factory.created[0]!;
    expect(sent).toMatchObject({
      title: "Fix: promo codes rejected at checkout",
      maxReviewRounds: 2,
      origin: { app: "help-desk", name: "Help Desk", label: "Promo codes · 2 tickets", url: `${APP}/#/c/c05`, key: `${run.id}:promo-codes` },
    });
    expect(sent.mode).toBeUndefined();
    expect(sent.brief.length).toBeLessThanOrEqual(8_000);
    expect(sent.brief).toContain("received 2 reports");
    expect(sent.brief).toContain(`**Aisha Khan**, order CO-48224, wrote:\n\n   > ${AISHA}`);
    expect(sent.brief).toContain(`   > ${BEN}`);
    expect(sent.brief).toContain("Their support agent found: TRAIL15 rejected when pasted from the newsletter.");
    expect(sent.brief).toContain("- TRAIL15 takes 15% off, however it's pasted.");
    expect(sent.brief).toContain("Add regression tests that reproduce what the customers reported");
    expect(sent.brief).toContain("Keep the existing tests passing");

    expect(sent.project?.name).toBe("contoso-storefront");
    const files = new Map(sent.project!.files.map((file) => [file.path, file.content]));
    expect([...files.keys()]).toEqual(expect.arrayContaining(["package.json", "README.md", "src/promotions.js", "src/cart.js", "src/order-status.js", "test/promotions.test.js", "test/cart.test.js"]));
    expect(JSON.parse(files.get("package.json")!)).toMatchObject({ name: "contoso-storefront", scripts: { test: "node --test" } });
    expect(files.get("src/promotions.js")).toContain("export function applyPromoCode(code, subtotalCents)");
    expect([...files.values()].some((content) => content.includes("\r"))).toBe(false);

    expect(sent.context?.map((file) => file.path)).toEqual(["BUG_REPORT.md", "transcripts.md"]);
    const [bugReport, transcripts] = sent.context!;
    expect(bugReport!.content).toContain("# Promo codes rejected at checkout");
    expect(bugReport!.content).toContain("- Customer: Aisha Khan\n- Order: CO-48224");
    expect(bugReport!.content).toContain("Expected: Codes work in any case.");
    expect(transcripts!.content).toContain(`## Ben Carter\n\nCustomer: ${BEN}`);
    expect(transcripts!.content).toContain('Tool: report_bug {"area":"promo-codes"');

    await expect(desk.routeIssue("promo-codes", APP)).rejects.toMatchObject({ code: "conflict", status: 409, message: expect.stringContaining("WO-0001") });
    expect(factory.created).toHaveLength(1);
  });

  it("can be sent again after a send that failed", async () => {
    const { desk, factory, session } = await reported(10);
    await reportBug(session("c08"), LUCAS, LUCAS_REPORT);
    factory.failWith = new HelpDeskError("factory_unreachable", "Software Factory didn't answer at http://factory.test.", 502);
    await expect(desk.routeIssue("cart", APP)).rejects.toMatchObject({ code: "factory_unreachable", status: 502 });
    expect(desk.issues()[0]?.routed).toBeUndefined();
    factory.failWith = undefined;
    expect((await desk.routeIssue("cart", APP)).routed).toMatchObject({ number: 1, status: "queued" });
  });

  it("show their work order's status while Software Factory works on it, then stop asking", async () => {
    const { desk, factory, events, session } = await reported(10, setup(new FakePlatform(), new FakeFactory(), testConfig({ factoryPollMs: 10 })));
    await reportBug(session("c08"), LUCAS, LUCAS_REPORT);
    await desk.routeIssue("cart", APP);
    factory.update("wo_1", { status: "building" });
    await until(() => desk.issues()[0]?.routed?.status === "building");
    expect(events.some((published) => published.type === "issues" && published.issues[0]?.routed?.status === "building")).toBe(true);
    factory.update("wo_1", { status: "failed", error: { code: "tests_failed", message: "2 tests failed." } });
    await until(() => desk.issues()[0]?.routed?.status === "failed");
    expect(desk.issues()[0]?.routed).toMatchObject({ status: "failed", error: "2 tests failed." });
    const asked = factory.lists;
    await settle(60);
    expect(factory.lists).toBe(asked);
  });

  it("are found again in Software Factory after a restart, by their origin", async () => {
    const platform = new FakePlatform();
    const factory = new FakeFactory();
    const older = runIdAt(new Date("2026-11-03T09:00:00.000Z"));
    const latest = runIdAt(new Date("2026-11-03T10:00:00.000Z"));
    platform.seed(sessionIdFor(latest, "c05"), [
      event("user.message", { content: AISHA }),
      event("tool.execution_start", { toolCallId: "t1", toolName: "report_bug", arguments: AISHA_REPORT }),
      event("tool.execution_complete", { toolCallId: "t1", success: true, result: { content: JSON.stringify({ ok: true, area: "promo-codes", orderId: "CO-48224" }) } }),
    ]);
    factory.workOrders = [
      { id: "wo_9", number: 9, title: "Fix: checkout", status: "building", origin: { app: "incident-commander", name: "Incident Commander", key: `${latest}:promo-codes` } },
      { id: "wo_8", number: 8, title: "Fix: promo codes rejected at checkout", status: "building", origin: { app: "help-desk", name: "Help Desk", key: `${latest}:promo-codes` } },
      { id: "wo_7", number: 7, title: "Fix: wrong quantities in the cart", status: "completed", origin: { app: "help-desk", name: "Help Desk", key: `${older}:cart` } },
    ];
    const { desk } = setup(platform, factory);
    platform.connect();
    await until(() => platform.resumed.length === 1);
    await settle(5);
    await desk.pollFactory();

    expect(desk.ticket("c05").bug).toMatchObject({ area: "promo-codes", orderId: "CO-48224" });
    expect(desk.issues()).toEqual([
      {
        area: "promo-codes",
        title: "Promo codes rejected at checkout",
        reports: [expect.objectContaining({ customerId: "c05", name: "Aisha Khan" })],
        routed: { workOrderId: "wo_8", number: 8, title: "Fix: promo codes rejected at checkout", status: "building", url: "http://factory.test/#/wo/wo_8" },
      },
    ]);
    await expect(desk.routeIssue("promo-codes", APP)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("WO-0008") });
    expect(factory.created).toEqual([]);
  });

  it("aren't sent twice when Software Factory couldn't be asked after a restart", async () => {
    const platform = new FakePlatform();
    const factory = new FakeFactory();
    const latest = runIdAt(new Date("2026-11-03T10:00:00.000Z"));
    platform.seed(sessionIdFor(latest, "c08"), [
      event("user.message", { content: LUCAS }),
      event("tool.execution_start", { toolCallId: "t1", toolName: "report_bug", arguments: LUCAS_REPORT }),
      event("tool.execution_complete", { toolCallId: "t1", success: true, result: { content: JSON.stringify({ ok: true, area: "cart", orderId: "CO-48198" }) } }),
    ]);
    factory.workOrders = [{ id: "wo_3", number: 3, title: "Fix: wrong quantities in the cart", status: "planning", origin: { app: "help-desk", name: "Help Desk", key: `${latest}:cart` } }];
    factory.failWith = new HelpDeskError("factory_unreachable", "Software Factory didn't answer.", 502);
    const { desk } = setup(platform, factory);
    platform.connect();
    await until(() => platform.resumed.length === 1);
    await settle(5);
    await desk.pollFactory();
    expect(desk.issues()[0]?.routed).toBeUndefined();

    factory.failWith = undefined;
    await expect(desk.routeIssue("cart", APP)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("WO-0003") });
    expect(desk.issues()[0]?.routed).toMatchObject({ workOrderId: "wo_3", status: "planning" });
    expect(factory.created).toEqual([]);
  });

  it("start over with each simulation, while Software Factory keeps the work orders", async () => {
    const { desk, platform, factory, session } = await reported(5);
    await reportBug(session("c05"), AISHA, AISHA_REPORT);
    await desk.routeIssue("promo-codes", APP);
    await desk.end();
    expect(desk.issues()).toEqual([]);
    expect(factory.workOrders).toHaveLength(1);

    const next = await desk.simulate(5);
    await until(() => platform.sessions.get(sessionIdFor(next.id, "c05"))?.sent.length === 1);
    await reportBug(platform.sessions.get(sessionIdFor(next.id, "c05"))!, AISHA, AISHA_REPORT);
    expect(desk.issues()[0]?.routed).toBeUndefined();
    expect((await desk.routeIssue("promo-codes", APP)).routed).toMatchObject({ number: 2 });
    expect(factory.created[1]?.origin?.key).toBe(`${next.id}:promo-codes`);
  });

  it("can be sent again once Software Factory no longer has the work order", async () => {
    const { desk, factory, session } = await reported(10);
    await reportBug(session("c08"), LUCAS, LUCAS_REPORT);
    await desk.routeIssue("cart", APP);
    factory.workOrders = [];
    await desk.pollFactory();
    expect(desk.issues()[0]?.routed).toBeUndefined();
    expect((await desk.routeIssue("cart", APP)).routed).toMatchObject({ workOrderId: "wo_1" });
    expect(factory.created).toHaveLength(2);
  });

  it("say plainly why they can't be sent", async () => {
    const factory = new FakeFactory();
    factory.configured = false;
    factory.publicUrl = undefined;
    const { desk, session } = await reported(5, setup(new FakePlatform(), factory));
    expect(desk.desk().factory).toEqual({ configured: false });
    await reportBug(session("c05"), AISHA, AISHA_REPORT);
    await expect(desk.routeIssue("promo-codes", APP)).rejects.toMatchObject({
      code: "factory_unavailable",
      status: 503,
      message: "Software Factory isn't connected. Start it with `aspire run`, or set SOFTWARE_FACTORY_URL.",
    });
    expect(desk.issues()).toHaveLength(1);

    factory.configured = true;
    await expect(desk.routeIssue("checkout", APP)).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(desk.routeIssue("cart", APP)).rejects.toMatchObject({ code: "not_found", status: 404, message: "No customer of this simulation has reported this problem." });
  });
});
