import { describe, expect, it } from "vitest";
import type { Ticket, ToolItem } from "../../src/shared/types.js";
import { customerLine, latestMessage, money, operatorOutcome, premium, STATUS, toolArgs } from "../../src/web/lib/format.js";
import { reduce, type StoreState } from "../../src/web/lib/store.js";

const tool = (overrides: Partial<ToolItem>): ToolItem => ({ kind: "tool", id: "t1", name: "get_order", args: { orderId: "co-48177" }, at: "2026-11-03T10:00:00.000Z", status: "done", ...overrides });
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ customerId: "c01", status: "waiting", items: [], blocked: 0, updatedAt: "2026-11-03T10:00:00.000Z", ...overrides });

describe("words on the wall", () => {
  it("formats money and premium requests", () => {
    expect(money(39)).toBe("$39.00");
    expect(premium(5)).toBe("5");
    expect(premium(8.25)).toBe("8.25");
    expect(premium(1.5)).toBe("1.5");
  });

  it("says each status in one or two words", () => {
    for (const status of Object.values(STATUS)) expect(status.label.split(" ").length).toBeLessThanOrEqual(2);
  });

  it("shows the latest message from either side", () => {
    expect(latestMessage(undefined)).toBeUndefined();
    const items: Ticket["items"] = [
      { kind: "message", id: "u", from: "customer", text: "Hi", at: "" },
      { kind: "message", id: "a", from: "agent", text: "Hello!", at: "" },
      tool({}),
    ];
    expect(latestMessage(ticket({ items }))?.text).toBe("Hello!");
  });

  it("tells the customer what the agent did, without the operator's details", () => {
    expect(customerLine(tool({ name: "list_my_orders", status: "running" }))).toEqual({ text: "Looking up your orders…", tone: "muted" });
    expect(customerLine(tool({ status: "refused", blocked: true }))).toEqual({ text: "CO-48177 isn't on your account", tone: "muted" });
    expect(customerLine(tool({ name: "request_refund", status: "asking" }))).toEqual({ text: "Refund sent to the team for approval", tone: "attention" });
    expect(customerLine(tool({ name: "request_refund", status: "done", result: { ok: true, refunded: 39 } }))).toEqual({ text: "Refund approved: $39.00 back", tone: "success" });
    expect(customerLine(tool({ name: "cancel_order", status: "declined" }))).toEqual({ text: "Cancellation needs a closer look", tone: "muted" });
    expect(customerLine(tool({ name: "resolve_conversation" }))).toBeUndefined();
  });

  it("tells the operator what each tool call did", () => {
    expect(operatorOutcome(tool({ status: "refused", blocked: true }))).toEqual({ text: "Blocked: another customer's order", tone: "danger" });
    expect(operatorOutcome(tool({ status: "refused", result: { ok: false, error: "Delivered 50 days ago." } }))).toEqual({ text: "Delivered 50 days ago.", tone: "muted" });
    expect(operatorOutcome(tool({ name: "list_my_orders", result: { orders: [{}, {}] } }))).toEqual({ text: "2 orders", tone: "success" });
    expect(operatorOutcome(tool({ name: "track_shipment", result: { carrier: "UPS", status: "in transit" } }))).toEqual({ text: "UPS · in transit", tone: "success" });
    expect(operatorOutcome(tool({ name: "request_refund", result: { refunded: 24 } }))).toEqual({ text: "$24.00 refunded", tone: "success" });
    expect(operatorOutcome(tool({ status: "asking" }))).toEqual({ text: "Needs approval", tone: "attention" });
    expect(toolArgs(tool({ args: { orderId: "co-1", amount: 5 } }))).toBe("CO-1 · $5.00");
  });
});

describe("store", () => {
  const base: StoreState = { phase: "ready", connection: "open", customers: [], tickets: {}, counters: { sessions: 0, runtimes: 0, sandboxes: 0, messages: 0, premiumRequests: 0 }, size: 25, answering: {}, toasts: [] };

  it("replaces the tickets when a simulation starts or ends", () => {
    const started = reduce(base, { type: "run", run: { id: "r1", size: 5, startedAt: "" }, tickets: [ticket()] });
    expect(started.run?.id).toBe("r1");
    expect(Object.keys(started.tickets)).toEqual(["c01"]);
    const ended = reduce(started, { type: "run", tickets: [] });
    expect(ended.run).toBeUndefined();
    expect(ended.tickets).toEqual({});
  });

  it("updates a ticket of the current simulation and drops late updates of an ended one", () => {
    const started = reduce(base, { type: "run", run: { id: "r1", size: 5, startedAt: "" }, tickets: [ticket()] });
    expect(reduce(started, { type: "ticket", ticket: ticket({ status: "resolved" }) }).tickets["c01"]?.status).toBe("resolved");
    expect(reduce(started, { type: "ticket", ticket: ticket({ customerId: "c09" }) })).toBe(started);
    expect(reduce(base, { type: "ticket", ticket: ticket() })).toBe(base);
  });
});
