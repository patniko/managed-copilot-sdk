import type { PermissionRequestResult } from "@github/copilot-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpDesk, MAX_PLAYER_TICKETS, runIdAt, runStartedAt } from "../src/server/desk.js";
import { HelpDeskError } from "../src/server/errors.js";
import { contextOf, newTicketId, parsePlayerTicket, playerSessionId, promptFor, readPrompt } from "../src/server/player.js";
import { parseSessionId, sessionIdFor } from "../src/server/ticket.js";
import { PLAYER_TOOL_NAMES, type ServerEvent } from "../src/shared/types.js";
import { event, FakeFactory, FakePlatform, MONA, MONA_REPORT, monaWith, reportBug, settle, testConfig } from "./fakes.js";

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

/** What Mona writes when she opens support in Downhill. */
const MONA_WORDS = "The launch code trail15 says “Invalid code.” at checkout, so I paid full price for Neon Mona.";

/**
 * Mona (or another player) opens support in the game and writes her complaint: her first message starts the session,
 * and the runtime then delivers it.
 */
async function openPlayer(desk: HelpDesk, platform: FakePlatform, body: unknown = MONA, words = MONA_WORDS) {
  const { ticket } = desk.openPlayerTicket(body);
  await desk.sendAsPlayer(ticket.ticketId, words);
  const session = platform.sessions.get(playerSessionId(ticket.ticketId))!;
  session.emit(event("user.message", { content: session.sent[0]!.prompt }));
  return { ...ticket, session };
}

/** A player's report without an order: one more player who hit the launch code. */
const PLAYER_REPORT = { area: "promo-codes", title: MONA_REPORT.title, whatHappened: MONA_REPORT.whatHappened, expected: MONA_REPORT.expected };

/** What `act` threw. */
function caught(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error("Expected it to throw.");
}

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
    expect(liam).toMatchObject({ model: "claude-haiku-4.5", streaming: true, availableTools: ["custom:*", "builtin:store_memory"], memory: { enabled: true } });
    expect(liam.memory?.storeMemory).toBeTypeOf("function");
    expect(liam.systemMessage?.content).toContain("Team knowledge base:");
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

  it("keeps a proposed memory for the operator without holding the turn, and adds an approved one to the team knowledge every later session gets", async () => {
    const { desk, platform, events } = setup();
    const run = await simulate(desk, platform);
    const maya = platform.sessions.get(sessionIdFor(run.id, "c01"))!;
    const proposal = { subject: "Weather holds", fact: "UPS weather holds in Denver usually clear within 48 hours.", citations: "Tracking for a delayed tent" };
    // The runtime's permission is granted at once: the agent's turn never waits for the team's decision.
    expect(await maya.ask({ kind: "memory", action: "store", toolCallId: "mem-1", ...proposal })).toEqual({ kind: "approve-once" });
    await maya.config.memory!.storeMemory!({ sessionId: maya.sessionId, ...proposal, reason: "Saves a lookup" }, { signal: new AbortController().signal });
    await settle();
    const memory = desk.ticket("c01").memory!;
    expect(memory).toMatchObject({ ...proposal, reason: "Saves a lookup", source: { customerId: "c01", name: "Maya Chen", sessionId: maya.sessionId } });
    expect(desk.ticket("c01").status).not.toBe("approval");
    expect(desk.knowledge.list()).toEqual([]);
    expect(events.filter((published) => published.type === "knowledge").at(-1)).toMatchObject({ knowledge: [], proposals: [{ id: memory.id }] });

    desk.answer("c01", memory.id, true);
    expect(desk.ticket("c01").memory).toBeUndefined();
    expect(desk.knowledge.list()).toMatchObject([{ subject: "Weather holds", fact: proposal.fact, reason: "Saves a lookup", source: { customerId: "c01" } }]);
    expect(events.filter((published) => published.type === "knowledge").at(-1)).toMatchObject({ knowledge: [{ subject: "Weather holds" }], proposals: [] });
    expect(() => desk.answer("c01", memory.id, true)).toThrow(HelpDeskError);

    const next = await simulate(desk, platform, 5);
    const later = () => platform.created.find((config) => config.sessionId === sessionIdFor(next.id, "c05"));
    for (let tries = 0; tries < 50 && !later(); tries++) await settle(5);
    expect(later()?.systemMessage?.content).toContain("Weather holds: UPS weather holds in Denver usually clear within 48 hours.");

    const id = desk.knowledge.list()[0]!.id;
    desk.forget(id);
    expect(desk.knowledge.list()).toEqual([]);
    expect(() => desk.forget(id)).toThrow(HelpDeskError);
  });

  it("declines a proposed memory without the agent's session hearing anything", async () => {
    const { desk, platform } = setup();
    const run = await simulate(desk, platform);
    const noah = platform.sessions.get(sessionIdFor(run.id, "c04"))!;
    // The cancellation and the memory come in the same step; the cancellation waits for the operator.
    const cancel = noah.ask({ kind: "custom-tool", toolName: "cancel_order", toolCallId: "call-1", args: { orderId: "CO-48231" } }) as Promise<PermissionRequestResult>;
    expect(await noah.ask({ kind: "memory", action: "store", toolCallId: "mem-1", subject: "Boots", fact: "Ridgeline boots run small." })).toEqual({ kind: "approve-once" });
    await noah.config.memory!.storeMemory!({ sessionId: noah.sessionId, subject: "Boots", fact: "Ridgeline boots run small.", citations: "", reason: "" }, { signal: new AbortController().signal });
    await settle();
    const ticket = desk.ticket("c04");
    expect(ticket).toMatchObject({ status: "approval", approval: { id: "call-1", action: "cancel" }, memory: { subject: "Boots" } });

    desk.answer("c04", ticket.memory!.id, false);
    expect(desk.ticket("c04")).toMatchObject({ status: "approval", approval: { id: "call-1" } });
    expect(desk.ticket("c04").memory).toBeUndefined();
    expect(desk.knowledge.list()).toEqual([]);
    let settled = false;
    void cancel.then(() => (settled = true));
    await settle();
    expect(settled).toBe(false);
    desk.answer("c04", "call-1", true);
    expect(await cancel).toEqual({ kind: "approve-once", approvedInteractively: true });
    await expect(noah.config.memory!.storeMemory!({ sessionId: noah.sessionId, subject: " ", fact: "x", citations: "", reason: "" }, { signal: new AbortController().signal })).rejects.toThrow();
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

describe("player tickets", () => {
  it("open without a session or a message: the player's first message starts it, with their context hidden in it", async () => {
    const { desk, platform, events } = setup();
    const { ticket, reopened } = desk.openPlayerTicket(monaWith({ opener: "promo-error" }));
    const { ticketId, chatPath } = ticket;
    expect(reopened).toBe(false);
    expect(chatPath).toBe(`/chat/${ticketId}`);
    // On the wall right away, waiting for the player; no session, so nothing is counted yet.
    expect(desk.playerTicket(ticketId)).toMatchObject({ ticketId, product: "downhill", player: { name: "Mona", rider: "mona", initials: "M" }, opener: "promo-error", status: "opened", items: [] });
    expect(desk.playerTicket(ticketId).sessionId).toBeUndefined();
    expect(events.some((published) => published.type === "players" && published.players[0]?.ticketId === ticketId)).toBe(true);
    expect(platform.created).toEqual([]);
    expect(desk.computeCounters().sessions).toBe(0);

    await desk.sendAsPlayer(ticketId, MONA_WORDS);
    const config = platform.created.at(-1)!;
    expect(config).toMatchObject({ sessionId: playerSessionId(ticketId), model: "claude-haiku-4.5", streaming: true, availableTools: ["custom:*"] });
    expect(config.tools?.map((tool) => tool.name)).toEqual([...PLAYER_TOOL_NAMES]);
    expect(config.systemMessage?.content).toContain("Downhill Shop");
    // The store customers' team knowledge isn't the player's agent's: it neither stores memories nor is told them.
    expect(config.memory).toBeUndefined();
    expect(config.systemMessage?.content).not.toContain("Team knowledge base:");
    const session = platform.sessions.get(playerSessionId(ticketId))!;
    // The player's words first; the context the game sent rides along, hidden.
    expect(readPrompt(session.sent[0]!.prompt)).toEqual({ text: MONA_WORDS, context: contextOf(parsePlayerTicket(monaWith({ opener: "promo-error" }))) });
    session.emit(event("user.message", { content: session.sent[0]!.prompt }));
    const view = desk.playerTicket(ticketId);
    expect(view).toMatchObject({ sessionId: playerSessionId(ticketId), status: "answering", checkout: { code: "trail15", order: { id: "DH-1042", totalCents: 499 } } });
    expect(view.items).toEqual([{ kind: "message", id: expect.any(String), from: "customer", text: MONA_WORDS, at: expect.any(String), attachment: "Checkout details" }]);
    expect(JSON.stringify(view)).not.toContain("downhill_checkout");

    // Its tools reach only Mona's checkout and order.
    expect(await session.call("get_checkout", {})).toMatchObject({ ok: true, player: "Mona", code: "trail15", bought: true });
    expect(await session.call("request_refund", { orderId: "CO-48224", reason: "code" })).toEqual({ ok: false, error: "No order CO-48224 on this account." });
    expect(await reportBug(session, undefined, MONA_REPORT)).toEqual({ ok: true, area: "promo-codes", orderId: "DH-1042", sentTo: "the store's engineering team" });
    expect(desk.playerTicket(ticketId).bug).toMatchObject({ area: "promo-codes", orderId: "DH-1042" });

    // The same opening sent again (the game retried it) gets the same ticket.
    expect(desk.openPlayerTicket(monaWith({ opener: "promo-error" }))).toEqual({ ticket, reopened: true });
    expect(platform.created).toHaveLength(1);
  });

  it("reopen by ticket ID with the latest checkout, which the next message carries only when it changed", async () => {
    const { desk, platform } = setup();
    const { ticketId } = desk.openPlayerTicket(monaWith({ checkout: undefined, opener: "support-button" })).ticket;
    await desk.sendAsPlayer(ticketId, "Hi! The discount code isn't working.");
    const session = platform.sessions.get(playerSessionId(ticketId))!;
    const first = readPrompt(session.sent[0]!.prompt);
    expect(first.text).toBe("Hi! The discount code isn't working.");
    expect(first.context).toMatchObject({ player: { name: "Mona", rider: "mona" }, opener: "support-button" });
    expect(first.context?.checkout).toBeUndefined();
    expect(await session.call("get_checkout", {})).toMatchObject({ ok: true, tried: false });

    // Reopened under the rejected code, with the checkout: get_checkout has it at once.
    const again = desk.openPlayerTicket({ ...MONA, opener: "promo-error", ticketId, at: "2026-11-12T17:31:00.000Z" });
    expect(again).toEqual({ ticket: { ticketId, chatPath: `/chat/${ticketId}` }, reopened: true });
    expect(desk.playerTicket(ticketId)).toMatchObject({ opener: "promo-error", checkout: { code: "trail15" } });
    expect(await session.call("get_checkout", {})).toMatchObject({ tried: true, code: "trail15", bought: true });
    await desk.sendAsPlayer(ticketId, "It says Invalid code.");
    expect(readPrompt(session.sent[1]!.prompt)).toMatchObject({ text: "It says Invalid code.", context: { opener: "promo-error", checkout: { code: "trail15" } } });
    await desk.sendAsPlayer(ticketId, "Can you help?");
    expect(session.sent[2]!.prompt).toBe("Can you help?");
    for (const sent of session.sent) session.emit(event("user.message", { content: sent.prompt }));
    expect(desk.playerTicket(ticketId).items.map((item) => (item.kind === "message" ? [item.text, item.attachment] : []))).toEqual([
      ["Hi! The discount code isn't working.", undefined],
      ["It says Invalid code.", "Checkout details"],
      ["Can you help?", undefined],
    ]);

    // Another rider's opening, or one of an ended ticket, opens a new ticket.
    const copilot = desk.openPlayerTicket({ ...MONA, player: { name: "Copilot", rider: "copilot" }, ticketId, at: "2026-11-12T17:32:00.000Z" });
    expect(copilot.reopened).toBe(false);
    expect(copilot.ticket.ticketId).not.toBe(ticketId);
    await desk.endPlayer(ticketId);
    const after = desk.openPlayerTicket({ ...MONA, ticketId, at: "2026-11-12T17:33:00.000Z" });
    expect(after.reopened).toBe(false);
    expect(after.ticket.ticketId).not.toBe(ticketId);
  });

  it("drop a ticket that never got a message once it's idle, and end one without a session like any other", async () => {
    const { desk, platform, events } = setup(new FakePlatform(), new FakeFactory(), testConfig({ playerIdleMs: 60_000 }));
    const start = Date.parse("2026-11-12T17:30:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(start);
      const stray = desk.openPlayerTicket(monaWith({ checkout: undefined, opener: "support-button" })).ticket.ticketId;
      const reopenedLater = desk.openPlayerTicket(monaWith({ checkout: undefined, player: { name: "Ben", rider: "ben" }, at: "2026-11-12T17:30:01.000Z" })).ticket.ticketId;
      const talking = (await openPlayer(desk, platform, monaWith({ player: { name: "Copilot", rider: "copilot" }, at: "2026-11-12T17:30:02.000Z" }))).ticketId;
      // Opening it again counts as activity.
      vi.setSystemTime(start + 50_000);
      desk.openPlayerTicket(monaWith({ checkout: undefined, player: { name: "Ben", rider: "ben" }, ticketId: reopenedLater, at: "2026-11-12T17:30:50.000Z" }));
      desk.dropIdlePlayers(start + 59_000);
      expect(desk.state().players).toHaveLength(3);
      desk.dropIdlePlayers(start + 61_000);
      expect(desk.state().players.map((ticket) => ticket.ticketId).sort()).toEqual([reopenedLater, talking].sort());
      desk.dropIdlePlayers(start + 111_000);
      expect(desk.state().players.map((ticket) => ticket.ticketId)).toEqual([talking]);
      expect(desk.state().players.map((ticket) => ticket.ticketId)).not.toContain(stray);
      expect(events.filter((published) => published.type === "players").at(-1)).toMatchObject({ players: [{ ticketId: talking }] });
      // A conversation stays however long it's quiet; nothing was on the platform to delete.
      desk.dropIdlePlayers(start + 10 * 60 * 60_000);
      expect(desk.state().players.map((ticket) => ticket.ticketId)).toEqual([talking]);
      expect(platform.deleted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }

    const waiting = desk.openPlayerTicket(monaWith({ checkout: undefined, at: "2026-11-12T17:50:00.000Z" })).ticket.ticketId;
    await desk.endPlayer(waiting);
    expect(desk.state().players).toHaveLength(1);
    expect(platform.deleted).toEqual([]);
  });

  it("hold a refund of the player's order for the operator, then answer the runtime with the decision", async () => {
    const { desk, platform } = setup();
    const { ticketId, session } = await openPlayer(desk, platform);
    const asking = (toolCallId: string, amount: number) => ({
      kind: "custom-tool",
      toolName: "request_refund",
      toolCallId,
      args: { orderId: "DH-1042", amount, reason: "the 15% TRAIL15 should have taken off" },
    });
    const pending = session.ask(asking("r1", 0.75)) as Promise<PermissionRequestResult>;
    await settle();
    expect(desk.playerTicket(ticketId)).toMatchObject({
      status: "approval",
      approval: { id: "r1", action: "refund", orderId: "DH-1042", amount: 0.75, reason: "the 15% TRAIL15 should have taken off" },
    });
    desk.answerPlayer(ticketId, "r1", true);
    expect(await pending).toEqual({ kind: "approve-once", approvedInteractively: true });
    expect(await session.call("request_refund", asking("r1", 0.75).args, "r1")).toMatchObject({ ok: true, orderId: "DH-1042", refunded: 0.75 });
    expect(desk.playerTicket(ticketId).refunded).toBe(0.75);

    const declined = session.ask(asking("r2", 1)) as Promise<PermissionRequestResult>;
    await settle();
    desk.answerPlayer(ticketId, "r2", false);
    expect(await declined).toMatchObject({ kind: "reject", feedback: expect.stringContaining("a team member will follow up") });
    expect(() => desk.answerPlayer(ticketId, "r2", true)).toThrow(/answered already/);
    // More than is left on the order needs no one: the tool says why.
    expect(await session.ask(asking("r3", 4.5))).toEqual({ kind: "approve-once" });
    expect(desk.playerTicket(ticketId).approval).toBeUndefined();
  });

  it("stay through simulations: starting, replacing, and ending one leave them; ending one deletes its session", async () => {
    const { desk, platform, events } = setup();
    const { ticketId, session } = await openPlayer(desk, platform);
    const first = await desk.simulate(5);
    await until(() => platform.created.length === 6 && [...platform.sessions.values()].every((each) => each.sent.length > 0));
    // Counted with the customers: one runtime for all.
    session.premium = 0.33;
    session.emit(event("session.idle", {}, { ephemeral: true }));
    await until(() => desk.computeCounters().premiumRequests === 0.33);
    expect(desk.computeCounters()).toMatchObject({ sessions: 6, runtimes: 1, sandboxes: 0, messages: 1 });

    await desk.simulate(10);
    await desk.end();
    expect(platform.deleted).toContain(sessionIdFor(first.id, "c01"));
    expect(platform.deleted).not.toContain(playerSessionId(ticketId));
    expect(desk.state().players.map((ticket) => ticket.ticketId)).toEqual([ticketId]);
    expect(desk.computeCounters()).toMatchObject({ sessions: 1, premiumRequests: 0.33 });

    await desk.endPlayer(ticketId);
    expect(platform.deleted).toContain(playerSessionId(ticketId));
    expect(desk.state().players).toEqual([]);
    expect(events.filter((published) => published.type === "players").at(-1)).toEqual({ type: "players", players: [] });
    expect(() => desk.playerTicket(ticketId)).toThrow(/no such support chat/);
    expect(desk.computeCounters().sessions).toBe(0);
  });

  it("are picked up after a restart: the conversation, the checkout read back from it, refunds, and a refund asked again", async () => {
    const platform = new FakePlatform();
    const ticketId = newTicketId(new Date("2026-11-12T17:30:05.000Z"));
    const sessionId = playerSessionId(ticketId);
    const refundArgs = { orderId: "DH-1042", amount: 0.75, reason: "the 15% TRAIL15 should have taken off" };
    // Mona wrote first from the Support button, with no checkout yet; she reopened support from her receipt later.
    const browsing = contextOf(parsePlayerTicket(monaWith({ checkout: undefined, opener: "support-button" })));
    const bought = contextOf(parsePlayerTicket(monaWith({ opener: "receipt", at: "2026-11-12T17:35:00.000Z" })));
    const seeded = platform.seed(sessionId, [
      event("user.message", { content: promptFor("The discount code isn't working!", browsing) }),
      event("assistant.message", { messageId: "m0", content: "Sorry about that! Which code did you try, and what were you buying?" }),
      event("user.message", { content: promptFor(MONA_WORDS, bought) }),
      event("tool.execution_start", { toolCallId: "b1", toolName: "report_bug", arguments: MONA_REPORT }),
      event("tool.execution_complete", { toolCallId: "b1", success: true, result: { content: JSON.stringify({ ok: true, area: "promo-codes", orderId: "DH-1042" }) } }),
      event("tool.execution_start", { toolCallId: "r1", toolName: "request_refund", arguments: refundArgs }),
      event("permission.requested", { permissionRequest: { kind: "custom-tool", toolCallId: "r1", toolName: "request_refund" } }),
      event("permission.completed", { toolCallId: "r1", result: { kind: "approved" } }),
      event("tool.execution_complete", { toolCallId: "r1", success: true, result: { content: JSON.stringify({ ok: true, orderId: "DH-1042", refunded: 0.75 }) } }),
      event("assistant.message", { messageId: "m1", content: "Sorry, Mona! I've refunded $0.75 to you." }),
    ]);
    const { desk } = setup(platform);
    platform.connect();
    await until(() => platform.resumed.includes(sessionId));
    await settle(5);

    expect(desk.state().run).toBeUndefined();
    const view = desk.playerTicket(ticketId);
    // The latest context the conversation carried: her receipt.
    expect(view).toMatchObject({
      player: { name: "Mona" },
      opener: "receipt",
      checkout: { code: "trail15", order: { id: "DH-1042" } },
      refunded: 0.75,
      bug: { area: "promo-codes", orderId: "DH-1042" },
      status: "waiting",
      createdAt: "2026-11-12T17:30:05.000Z",
    });
    expect(view.items.flatMap((item) => (item.kind === "message" && item.from === "customer" ? [[item.text, item.attachment]] : []))).toEqual([
      ["The discount code isn't working!", undefined],
      [MONA_WORDS, "Checkout details"],
    ]);
    expect(JSON.stringify(view)).not.toContain("downhill_checkout");
    expect(desk.issues()).toEqual([
      {
        area: "promo-codes",
        title: "Promo codes rejected at checkout",
        reports: [{ ticketId, product: "downhill", name: "Mona", whatHappened: MONA_REPORT.whatHappened, orderId: "DH-1042", at: expect.any(String) }],
      },
    ]);
    expect(await seeded.call("get_checkout", {})).toMatchObject({ openedSupportFrom: "a receipt", order: { orderId: "DH-1042", refunded: 0.75 } });
    expect(await seeded.call("request_refund", { ...refundArgs, amount: 4.5 })).toEqual({ ok: false, error: "At most $4.24 of this order can be refunded." });

    // The platform asks again for a refund still waiting when the session is resumed.
    const pending = seeded.ask({ kind: "custom-tool", toolName: "request_refund", toolCallId: "r2", args: { ...refundArgs, amount: 1 } }) as Promise<PermissionRequestResult>;
    await settle();
    expect(desk.playerTicket(ticketId).approval).toMatchObject({ id: "r2", amount: 1 });
    desk.answerPlayer(ticketId, "r2", false);
    expect(await pending).toMatchObject({ kind: "reject" });
    expect(platform.deleted).toEqual([]);
    expect(desk.computeCounters()).toMatchObject({ sessions: 1, runtimes: 1, messages: 4 });

    // Her context reached the session already: her next message carries no block, until the game sends a newer one.
    await desk.sendAsPlayer(ticketId, "Thanks!");
    expect(seeded.sent.at(-1)).toEqual({ prompt: "Thanks!" });
  });

  it("stay open on their chat pages while a restarted Help Desk picks them up, even when another player opens support meanwhile", async () => {
    const platform = new FakePlatform();
    const ticketId = newTicketId(new Date("2026-11-12T17:30:05.000Z"));
    platform.seed(playerSessionId(ticketId), [event("user.message", { content: promptFor(MONA_WORDS, contextOf(parsePlayerTicket(MONA))) })]);
    platform.status = { state: "connecting" };
    const { desk, events } = setup(platform);

    // Not connected yet: Mona's chat page hears nothing about her ticket, and asking for it says to try again.
    expect(desk.playerEvents(ticketId).map((published) => published.type)).toEqual(["platform"]);
    expect(caught(() => desk.playerTicket(ticketId))).toMatchObject({ code: "platform_unavailable", status: 503, message: "Support is reconnecting. Try again in a moment." });

    // Connected, with the platform's sessions still being listed.
    const list = platform.listSessions.bind(platform);
    let release!: () => void;
    platform.listSessions = () => new Promise((resolve) => (release = () => resolve(list())));
    platform.setStatus({ state: "connected" });
    platform.connect();
    // The game reopening her ticket waits for it rather than open a second one; Ben's new ticket publishes no list
    // without hers.
    expect(caught(() => desk.openPlayerTicket(monaWith({ ticketId })))).toMatchObject({ status: 503 });
    const ben = desk.openPlayerTicket(monaWith({ player: { name: "Ben", rider: "ben" }, at: "2026-11-12T17:40:00.000Z" })).ticket;
    release();
    await until(() => platform.resumed.includes(playerSessionId(ticketId)));
    await settle(5);

    expect(desk.playerEvents(ticketId).at(-1)).toMatchObject({ type: "players", players: [{ ticketId }] });
    const lists = events.flatMap((published) => (published.type === "players" ? [published.players.map((ticket) => ticket.ticketId)] : []));
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.every((ids) => ids.includes(ticketId))).toBe(true);
    expect(lists.at(-1)).toEqual(expect.arrayContaining([ticketId, ben.ticketId]));
    // Picked up: a ticket Help Desk doesn't know now is an ended one.
    expect(desk.playerEvents("zzzzzzzzzzzzzz").at(-1)).toEqual({ type: "players", players: [] });
    expect(() => desk.playerTicket("zzzzzzzzzzzzzz")).toThrow(/no such support chat/);
  });

  it("go away when their session was deleted elsewhere", async () => {
    const { desk, platform } = setup();
    const { ticketId } = await openPlayer(desk, platform);
    platform.listed.delete(playerSessionId(ticketId));
    await desk.sync();
    expect(desk.state().players).toEqual([]);
  });

  it("are refused in plain words: an invalid request, no platform, or too many open", async () => {
    const { desk, platform } = setup();
    expect(() => desk.openPlayerTicket({ ...MONA, product: "skyline" })).toThrow(/product must be "downhill"/);
    platform.setStatus({ state: "unavailable", message: "Managed Copilot isn't reachable yet." });
    expect(() => desk.openPlayerTicket(MONA)).toThrow("Managed Copilot isn't reachable yet.");
    platform.setStatus({ state: "connected" });
    for (let index = 0; index < MAX_PLAYER_TICKETS; index++) desk.openPlayerTicket(monaWith({ at: new Date(Date.parse(MONA.at) + index * 1000).toISOString() }));
    expect(() => desk.openPlayerTicket(monaWith({ at: "2026-11-12T18:00:00.000Z" }))).toThrow(/25 open player tickets already/);
    await expect(desk.endPlayer("nosuchticket")).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(desk.sendAsPlayer("nosuchticket", "Hello?")).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});

describe("software issues with players", () => {
  it("count a player's report from the Downhill Shop in the same issue as the customers', and keep it without a simulation", async () => {
    const { desk, platform } = setup();
    const run = await simulate(desk, platform, 25);
    const session = (customerId: string) => platform.sessions.get(sessionIdFor(run.id, customerId))!;
    await reportBug(session("c05"), AISHA, AISHA_REPORT);
    await reportBug(session("c18"), BEN, BEN_REPORT);
    const mona = await openPlayer(desk, platform);
    await reportBug(mona.session, undefined, MONA_REPORT);
    const [issue] = desk.issues();
    expect(issue).toMatchObject({ area: "promo-codes", title: "Promo codes rejected at checkout" });
    expect(issue!.reports.map((report) => [report.customerId ?? report.ticketId, report.name, report.product])).toEqual([
      ["c05", "Aisha Khan", undefined],
      ["c18", "Ben Carter", undefined],
      [mona.ticketId, "Mona", "downhill"],
    ]);
    await desk.end();
    expect(desk.issues()).toEqual([
      { area: "promo-codes", title: "Promo codes rejected at checkout", reports: [expect.objectContaining({ ticketId: mona.ticketId, product: "downhill" })] },
    ]);
  });

  it("go to Software Factory without a simulation: the storefront, a brief that names the Downhill Shop, once per first player ticket", async () => {
    const { desk, platform, factory } = setup();
    const mona = await openPlayer(desk, platform);
    await reportBug(mona.session, undefined, MONA_REPORT);
    expect((await desk.routeIssue("promo-codes", APP)).routed).toMatchObject({ workOrderId: "wo_1", status: "queued" });
    const sent = factory.created[0]!;
    expect(sent.origin).toEqual({ app: "help-desk", name: "Help Desk", label: "Promo codes · 1 ticket", url: `${APP}/#/p/${mona.ticketId}`, key: `player-${mona.ticketId}:promo-codes` });
    expect(sent.project?.name).toBe("contoso-storefront");
    expect(sent.project?.files.map((file) => file.path)).toContain("src/promotions.js");
    expect(sent.brief).toContain("from 1 player in the Downhill Shop.");
    expect(sent.brief).toContain("same `applyPromoCode` (`src/promotions.js`) as the store's website");
    expect(sent.brief).toContain("The shop's offer banner (“Launch week: 15% off everything with code trail15”) applies the code \"trail15\", and checkout said “Invalid code.”");
    expect(sent.brief).toContain("**Mona** (Downhill Shop), order DH-1042, wrote:");
    expect(sent.brief).toContain(`> ${MONA_WORDS}`);
    expect(sent.brief).not.toContain("downhill_checkout");
    expect(sent.brief).toContain("reproduce what the players reported, with each code exactly as the Downhill Shop sent it");
    const [bugReport, transcripts] = sent.context!;
    expect(bugReport!.content).toContain("- Player: Mona, in the Downhill Shop (Downhill 1.0.0)");
    expect(bugReport!.content).toContain("- Code: \"trail15\", from the shop's offer banner (“Launch week: 15% off everything with code trail15”)");
    expect(bugReport!.content).toContain("- Checkout said: Invalid code.\n- Cart: Neon Mona (`mona-neon`, $4.99); subtotal $4.99\n- Order: DH-1042, $4.99 paid at full price");
    expect(transcripts!.content).toContain(`## Mona (Downhill Shop)\n\nPlayer: ${MONA_WORDS}`);
    expect(bugReport!.content + transcripts!.content).not.toContain("downhill_checkout");

    // A later player's report joins the issue, which stays sent while the first player's ticket is open.
    const ben = await openPlayer(desk, platform, monaWith({ player: { name: "Ben", rider: "ben" }, at: "2026-11-12T17:40:00.000Z" }));
    await reportBug(ben.session, undefined, PLAYER_REPORT);
    expect(desk.issues()[0]).toMatchObject({ reports: [expect.objectContaining({ name: "Mona" }), expect.objectContaining({ name: "Ben" })], routed: { workOrderId: "wo_1" } });
    await expect(desk.routeIssue("promo-codes", APP)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("WO-0001") });

    // Ending it ends that scope: the next player's report can go to Software Factory as a new work order.
    await desk.endPlayer(mona.ticketId);
    expect(desk.issues()[0]?.routed).toBeUndefined();
    expect((await desk.routeIssue("promo-codes", APP)).routed).toMatchObject({ workOrderId: "wo_2" });
    expect(factory.created[1]?.origin?.key).toBe(`player-${ben.ticketId}:promo-codes`);
  });

  it("go with the simulation's issue while one runs, keyed by the simulation", async () => {
    const { desk, platform, factory } = setup();
    const run = await simulate(desk, platform, 5);
    await reportBug(platform.sessions.get(sessionIdFor(run.id, "c05"))!, AISHA, AISHA_REPORT);
    const mona = await openPlayer(desk, platform);
    await reportBug(mona.session, undefined, MONA_REPORT);
    await desk.routeIssue("promo-codes", APP);
    const sent = factory.created[0]!;
    expect(sent.origin).toMatchObject({ label: "Promo codes · 2 tickets", url: `${APP}/#/c/c05`, key: `${run.id}:promo-codes` });
    expect(sent.brief).toContain("received 2 reports of the same problem, promo codes rejected at checkout, from 1 customer of the store's website and 1 player in the Downhill Shop.");
    expect(sent.brief).toContain("the code behind the store's website and the Downhill Shop's checkout");
    expect(sent.brief).toContain("reproduce what the customers and players reported");
    expect(sent.context?.[0]?.content).toContain("- Customer: Aisha Khan\n- Order: CO-48224");

    // Ending the simulation ends its scope: the player's report makes an issue of its own again.
    await desk.end();
    expect(desk.issues()).toEqual([{ area: "promo-codes", title: "Promo codes rejected at checkout", reports: [expect.objectContaining({ ticketId: mona.ticketId })] }]);
  });

  it("are found again in Software Factory after a restart, by the first player ticket's key", async () => {
    const platform = new FakePlatform();
    const factory = new FakeFactory();
    const ticketId = newTicketId(new Date("2026-11-12T17:30:05.000Z"));
    platform.seed(playerSessionId(ticketId), [
      event("user.message", { content: promptFor(MONA_WORDS, contextOf(parsePlayerTicket(MONA))) }),
      event("tool.execution_start", { toolCallId: "b1", toolName: "report_bug", arguments: MONA_REPORT }),
      event("tool.execution_complete", { toolCallId: "b1", success: true, result: { content: JSON.stringify({ ok: true, area: "promo-codes", orderId: "DH-1042" }) } }),
    ]);
    factory.workOrders = [
      { id: "wo_4", number: 4, title: "Fix: promo codes rejected at checkout", status: "building", origin: { app: "help-desk", name: "Help Desk", key: `player-${ticketId}:promo-codes` } },
      { id: "wo_3", number: 3, title: "Fix: promo codes rejected at checkout", status: "completed", origin: { app: "help-desk", name: "Help Desk", key: "player-zzzzzzzzzzzzzz:promo-codes" } },
    ];
    const { desk } = setup(platform, factory);
    platform.connect();
    await until(() => platform.resumed.length === 1);
    await settle(5);
    await desk.pollFactory();
    expect(desk.issues()).toEqual([expect.objectContaining({ area: "promo-codes", routed: expect.objectContaining({ workOrderId: "wo_4", status: "building" }) })]);
    await expect(desk.routeIssue("promo-codes", APP)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("WO-0004") });
    expect(factory.created).toEqual([]);
  });
});
