import type { PermissionRequestResult } from "@github/copilot-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { HelpDesk, runIdAt, runStartedAt } from "../src/server/desk.js";
import { parseSessionId, sessionIdFor } from "../src/server/ticket.js";
import type { ServerEvent } from "../src/shared/types.js";
import { event, FakePlatform, settle, testConfig } from "./fakes.js";

const desks: HelpDesk[] = [];
afterEach(() => {
  for (const desk of desks.splice(0)) desk.close();
});

function setup(platform = new FakePlatform()) {
  const events: ServerEvent[] = [];
  const desk = new HelpDesk(platform, testConfig(), (published) => events.push(published));
  desk.start();
  desks.push(desk);
  return { desk, platform, events };
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
    expect(liam.tools?.map((tool) => tool.name)).toHaveLength(6);
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
    expect(events.filter((published) => published.type === "run").at(-1)).toEqual({ type: "run", tickets: [] });
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
