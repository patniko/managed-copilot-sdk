import { describe, expect, it } from "vitest";
import type { SoftwareIssue, Ticket, ToolItem } from "../../src/shared/types.js";
import { customerLine, inlineMarkdown, latestMessage, money, operatorOutcome, plainText, premium, STATUS, toolArgs, WORK_ORDER_STATUS, workOrderLine, workOrderName } from "../../src/web/lib/format.js";
import { reduce, type StoreState } from "../../src/web/lib/store.js";

const tool = (overrides: Partial<ToolItem>): ToolItem => ({ kind: "tool", id: "t1", name: "get_order", args: { orderId: "co-48177" }, at: "2026-11-03T10:00:00.000Z", status: "done", ...overrides });
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ customerId: "c01", status: "waiting", items: [], blocked: 0, ...overrides });

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

  it("shows a reported problem with the website to both: plainly to the customer, by area to the operator", () => {
    const report = tool({ name: "report_bug", args: { area: "promo-codes", title: "TRAIL15 rejected", orderId: "CO-48224" }, result: { ok: true, area: "promo-codes" } });
    expect(customerLine(report)).toEqual({ text: "Reported the problem to our engineering team", tone: "muted" });
    expect(customerLine({ ...report, status: "running" })).toEqual({ text: "Reporting the problem to our engineering team…", tone: "muted" });
    expect(customerLine({ ...report, status: "failed" })).toBeUndefined();
    expect(customerLine({ ...report, status: "refused" })).toEqual({ text: "CO-48224 isn't on your account", tone: "muted" });
    expect(operatorOutcome(report)).toEqual({ text: "Reported: Promo codes", tone: "done" });
    expect(operatorOutcome({ ...report, args: { area: "made-up" } })).toEqual({ text: "Reported: Other", tone: "done" });
  });

  it("names work orders and their statuses the way Software Factory does", () => {
    expect(workOrderName(12)).toBe("WO-0012");
    expect(workOrderLine({ workOrderId: "wo_12", number: 12, title: "Fix", status: "building", url: "http://factory.test/#/wo/wo_12" })).toBe("WO-0012 · Building");
    expect(Object.values(WORK_ORDER_STATUS).map((status) => status.label)).toEqual(["Queued", "Planning", "Building", "Releasing", "Completed", "Failed", "Cancelled"]);
  });

  it("applies the Markdown marks agents use, and drops them from previews", () => {
    expect(inlineMarkdown("Yes! **CO-48234** ships *tomorrow*, see `track_shipment`.")).toEqual([
      { kind: "text", text: "Yes! " },
      { kind: "strong", text: "CO-48234" },
      { kind: "text", text: " ships " },
      { kind: "em", text: "tomorrow" },
      { kind: "text", text: ", see " },
      { kind: "code", text: "track_shipment" },
      { kind: "text", text: "." },
    ]);
    expect(inlineMarkdown("$39 back, 3 * 4 = 12")).toEqual([{ kind: "text", text: "$39 back, 3 * 4 = 12" }]);
    expect(plainText("Yes! **CO-48234** (Merino)\n- ships __tomorrow__")).toBe("Yes! CO-48234 (Merino) ships tomorrow");
  });
});

describe("store", () => {
  const base: StoreState = {
    phase: "ready",
    connection: "open",
    customers: [],
    tickets: {},
    issues: [],
    counters: { sessions: 0, runtimes: 0, sandboxes: 0, messages: 0, premiumRequests: 0 },
    knowledge: [],
    proposals: [],
    forgetting: {},
    size: 25,
    answering: {},
    routing: {},
    toasts: [],
  };
  const issue: SoftwareIssue = { area: "cart", title: "Wrong quantities in the cart", reports: [{ customerId: "c08", name: "Lucas Silva", whatHappened: "Charged for 3.", at: "" }] };

  it("replaces the tickets and issues when a simulation starts or ends", () => {
    const started = reduce(base, { type: "run", run: { id: "r1", size: 5, startedAt: "" }, tickets: [ticket()], issues: [issue] });
    expect(started.run?.id).toBe("r1");
    expect(Object.keys(started.tickets)).toEqual(["c01"]);
    expect(started.issues).toEqual([issue]);
    const ended = reduce(started, { type: "run", tickets: [], issues: [] });
    expect(ended.run).toBeUndefined();
    expect(ended.tickets).toEqual({});
    expect(ended.issues).toEqual([]);
  });

  it("updates a ticket of the current simulation and drops late updates of an ended one", () => {
    const started = reduce(base, { type: "run", run: { id: "r1", size: 5, startedAt: "" }, tickets: [ticket()], issues: [] });
    expect(reduce(started, { type: "ticket", ticket: ticket({ status: "resolved" }) }).tickets["c01"]?.status).toBe("resolved");
    expect(reduce(started, { type: "ticket", ticket: ticket({ customerId: "c09" }) })).toBe(started);
    expect(reduce(base, { type: "ticket", ticket: ticket() })).toBe(base);
  });

  it("follows the current simulation's issues, and drops late ones of an ended simulation", () => {
    const started = reduce(base, { type: "run", run: { id: "r1", size: 5, startedAt: "" }, tickets: [ticket()], issues: [] });
    const routed = { ...issue, routed: { workOrderId: "wo_1", number: 1, title: "Fix: wrong quantities in the cart", status: "queued" as const, url: "http://factory.test/#/wo/wo_1" } };
    expect(reduce(started, { type: "issues", issues: [routed] }).issues).toEqual([routed]);
    expect(reduce(base, { type: "issues", issues: [routed] })).toBe(base);
  });
});
