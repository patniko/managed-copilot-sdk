import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { KnownIssueTicketState, PlayerTicket, SoftwareIssue, Ticket, ToolItem } from "../../src/shared/types.js";
import { PlayerConversation } from "../../src/web/components/PlayerChat.js";
import { reduceChat, type ChatState } from "../../src/web/lib/chat.js";
import {
  answerLine,
  approvalTitle,
  checkoutLine,
  customerLine,
  inlineMarkdown,
  latestMessage,
  money,
  operatorOutcome,
  plainText,
  PLAYER_GREETING,
  playerLabel,
  premium,
  STATUS,
  toolArgs,
  WORK_ORDER_STATUS,
  workOrderLine,
  workOrderName,
} from "../../src/web/lib/format.js";
import { chatTicketId, parseHash } from "../../src/web/lib/router.js";
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
    // A team member's note to the agent isn't part of the conversation the tile previews.
    expect(latestMessage(ticket({ items: [...items, { kind: "message", id: "n", from: "team", text: "Known issue: …", at: "", author: "octocat" }] }))?.text).toBe("Hello!");
  });

  it("counts a known issue's answer as it goes: classifying, then matched, updates sent, and failures", () => {
    const entry = (name: string, state: KnownIssueTicketState, matched = false) => ({ sessionId: name, name, state, ...(matched ? { matched } : {}) });
    const running = { startedAt: "", startedBy: "octocat", tickets: [entry("a", "classifying"), entry("b", "replying", true), entry("c", "no-match")] };
    expect(answerLine(running)).toBe("Classifying 3 open tickets… 2 done");
    const finished = { ...running, finishedAt: "now", tickets: [entry("a", "replied", true), entry("b", "replied", true), entry("c", "no-match"), entry("d", "failed", true)] };
    expect(answerLine(finished)).toBe("4 tickets classified · 3 match · 2 updates sent · 1 failed");
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
    expect(operatorOutcome(tool({ name: "store_memory", args: { subject: "Boots" } }))).toEqual({ text: "Proposed to the team", tone: "muted" });
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

  it("shows a player's checkout and refund in plain words", () => {
    expect(playerLabel("Mona")).toBe("Mona · Downhill");
    expect(checkoutLine({ code: "trail15 ", error: "Invalid code.", items: [], subtotalCents: 499 })).toBe('Code "trail15 ": Invalid code.');
    expect(checkoutLine({ items: [], subtotalCents: 499, order: { id: "DH-1042", totalCents: 499, paidAt: "" } })).toBe("Paid full price · DH-1042");
    expect(checkoutLine({ items: [], subtotalCents: 499 })).toBe("No code applied");
    const refund = { id: "r1", action: "refund" as const, orderId: "DH-1042", amount: 0.75 };
    expect(approvalTitle(refund, "Mona")).toBe("Refund $0.75 of DH-1042 to Mona");
    expect(approvalTitle({ ...refund, orderId: "CO-48177", amount: 39 })).toBe("Refund $39.00 · CO-48177");
    expect(customerLine(tool({ name: "get_checkout", args: {}, status: "running" }))).toEqual({ text: "Looking at your checkout…", tone: "muted" });
    expect(customerLine(tool({ name: "get_checkout", args: {} }))).toEqual({ text: "Looked at your checkout", tone: "muted" });
    expect(operatorOutcome(tool({ name: "get_checkout", args: {}, result: { ok: true, code: "trail15", bought: true } }))).toEqual({ text: 'Code "trail15" · bought anyway', tone: "success" });
    expect(customerLine(tool({ name: "request_refund", args: { orderId: "DH-1042" }, result: { ok: true, refunded: 0.75 } }))).toEqual({ text: "Refund approved: $0.75 back", tone: "success" });
  });

  it("routes the wall's pages by hash, and a player's chat by path", () => {
    expect(parseHash("#/p/mhv3k2a1q9z4f2")).toEqual({ kind: "player", id: "mhv3k2a1q9z4f2" });
    expect(parseHash("#/c/c05")).toEqual({ kind: "customer", id: "c05" });
    expect(chatTicketId("/chat/mhv3k2a1q9z4f2")).toBe("mhv3k2a1q9z4f2");
    expect(chatTicketId("/chat/mhv3k2a1q9z4f2/")).toBe("mhv3k2a1q9z4f2");
    expect(chatTicketId("/chat")).toBe("");
    expect(chatTicketId("/")).toBeUndefined();
    expect(chatTicketId("/chatter")).toBeUndefined();
  });
});

describe("store", () => {
  const base: StoreState = {
    phase: "ready",
    connection: "open",
    customers: [],
    tickets: {},
    players: [],
    classifications: {},
    issues: [],
    counters: { sessions: 0, runtimes: 0, sandboxes: 0, messages: 0, premiumRequests: 0 },
    knowledge: [],
    proposals: [],
    forgetting: {},
    knownIssues: [],
    issueWork: {},
    size: 25,
    answering: {},
    routing: {},
    ending: {},
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

  it("follows Classify's results, each method's latest for comparison, until a simulation clears them", () => {
    const usage = { inputTokens: 70, outputTokens: 2, measured: 1 };
    const decision = { id: "k1", method: "decision" as const, size: 5, startedAt: "", results: { c01: { state: "done" as const, category: "refund" as const, urgent: true } }, elapsedMs: 840, usage };
    const llm = { ...decision, id: "k2", method: "llm" as const, elapsedMs: 4200, usage: { ...usage, inputTokens: 900 } };
    const classified = reduce(base, { type: "classification", classification: decision, classifications: { decision } });
    expect(classified.classification).toEqual(decision);
    const compared = reduce(classified, { type: "classification", classification: llm, classifications: { decision, llm } });
    expect(compared.classification).toEqual(llm);
    expect(compared.classifications).toEqual({ decision, llm });
    const cleared = reduce(compared, { type: "classification", classifications: {} });
    expect(cleared.classification).toBeUndefined();
    expect(cleared.classifications).toEqual({});
  });

  it("updates a ticket of the current simulation and drops late updates of an ended one", () => {
    const started = reduce(base, { type: "run", run: { id: "r1", size: 5, startedAt: "" }, tickets: [ticket()], issues: [] });
    expect(reduce(started, { type: "ticket", ticket: ticket({ status: "resolved" }) }).tickets["c01"]?.status).toBe("resolved");
    expect(reduce(started, { type: "ticket", ticket: ticket({ customerId: "c09" }) })).toBe(started);
    expect(reduce(base, { type: "ticket", ticket: ticket() })).toBe(base);
  });

  it("follows the software issues, with or without a simulation: players' reports make issues too", () => {
    const started = reduce(base, { type: "run", run: { id: "r1", size: 5, startedAt: "" }, tickets: [ticket()], issues: [] });
    const routed = { ...issue, routed: { workOrderId: "wo_1", number: 1, title: "Fix: wrong quantities in the cart", status: "queued" as const, url: "http://factory.test/#/wo/wo_1" } };
    expect(reduce(started, { type: "issues", issues: [routed] }).issues).toEqual([routed]);
    expect(reduce(base, { type: "issues", issues: [routed] }).issues).toEqual([routed]);
  });

  it("keeps live players' tickets apart from the simulation, and drops late updates of an ended one", () => {
    const mona = player();
    const opened = reduce(base, { type: "players", players: [mona] });
    expect(opened.players).toEqual([mona]);
    const answering = player({ status: "answering" });
    expect(reduce(opened, { type: "player", ticket: answering }).players).toEqual([answering]);
    // A simulation starting or ending doesn't touch them.
    expect(reduce(opened, { type: "run", run: { id: "r1", size: 5, startedAt: "" }, tickets: [ticket()], issues: [] }).players).toEqual([mona]);
    expect(reduce(base, { type: "player", ticket: answering })).toBe(base);
    expect(reduce(opened, { type: "players", players: [] }).players).toEqual([]);
  });
});

const player = (overrides: Partial<PlayerTicket> = {}): PlayerTicket => ({
  ticketId: "mhv3k2a1q9z4f2",
  product: "downhill",
  player: { name: "Mona", rider: "mona", initials: "M", color: "blue" },
  createdAt: "2026-11-12T17:30:05.000Z",
  status: "waiting",
  items: [],
  ...overrides,
});

describe("a player's chat page", () => {
  const loading: ChatState = { phase: "loading", ended: false, connection: "connecting" };
  const id = "mhv3k2a1q9z4f2";

  it("shows the ticket and the platform's status as they change, and only that ticket", () => {
    const ready = reduceChat(loading, { type: "players", players: [player()] }, id);
    expect(ready).toMatchObject({ phase: "ready", ticket: player(), ended: false });
    expect(reduceChat(ready, { type: "player", ticket: player({ status: "approval" }) }, id).ticket?.status).toBe("approval");
    expect(reduceChat(ready, { type: "player", ticket: player({ ticketId: "someoneelse123" }) }, id)).toBe(ready);
    const offline = reduceChat(ready, { type: "platform", platform: { state: "reconnecting" }, desk: { environment: "help-desk", tools: [], playerTools: [], factory: { configured: false }, triage: { state: "off" }, llmTriage: { state: "off" } } }, id);
    expect(offline.platform?.state).toBe("reconnecting");
  });

  it("says the chat ended once the ticket is no longer listed, and stays ended", () => {
    const ready = reduceChat(loading, { type: "players", players: [player()] }, id);
    const ended = reduceChat(ready, { type: "players", players: [] }, id);
    expect(ended.ended).toBe(true);
    expect(reduceChat(ended, { type: "player", ticket: player() }, id)).toBe(ended);
    // Not loaded yet: an empty list says nothing.
    expect(reduceChat(loading, { type: "players", players: [] }, id)).toBe(loading);
  });

  it("greets the player before anyone writes and lets them write first; the agent types only once they did", () => {
    const online: ChatState = { phase: "ready", ended: false, connection: "open", platform: { state: "connected" } };
    const page = (ticket: PlayerTicket, chat = online) => renderToStaticMarkup(createElement(PlayerConversation, { chat: { ...chat, ticket }, ticket, framed: true }));
    const box = (html: string) => html.match(/<input[^>]*>/)?.[0] ?? "";

    const opened = page(player({ status: "opened" }));
    expect(textOf(opened)).toContain(PLAYER_GREETING);
    expect(box(opened)).toContain('placeholder="Tell us what happened…"');
    expect(box(opened)).not.toContain("disabled");
    expect(opened).not.toContain('aria-label="Typing"');

    const first = { kind: "message" as const, id: "u1", from: "customer" as const, text: "The discount code isn't working!", attachment: "Checkout details", at: "" };
    const starting = page(player({ status: "starting", items: [first] }));
    const words = textOf(starting);
    expect(words.indexOf(PLAYER_GREETING)).toBeGreaterThanOrEqual(0);
    expect(words.indexOf(PLAYER_GREETING)).toBeLessThan(words.indexOf(first.text));
    expect(starting).toContain('aria-label="Typing"');
    expect(box(starting)).toContain('placeholder="Write a message…"');
    // The team's notes to the agent never show in the chat.
    const note = { kind: "message" as const, id: "n1", from: "team" as const, text: "Known issue: tell her to type TRAIL15", author: "Help Desk", at: "" };
    expect(textOf(page(player({ status: "answering", items: [first, note] })))).not.toContain(note.text);

    expect(box(page(player({ status: "opened" }), { ...online, platform: { state: "reconnecting" } }))).toContain("disabled");
  });
});

/** A page's words, without its markup. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
