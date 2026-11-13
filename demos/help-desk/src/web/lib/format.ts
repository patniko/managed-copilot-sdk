// Words for what the wall and the support widget show. Pure, so tests cover them.
import {
  BUG_AREA_INFO,
  BUG_AREAS,
  PRODUCT_NAME,
  type ApprovalRequest,
  type BugArea,
  type KnownIssueAnswer,
  type KnownIssueTicketState,
  type MessageItem,
  type Opener,
  type RoutedWorkOrder,
  type ShopCheckout,
  type TicketStatus,
  type ToolItem,
  type TranscriptItem,
  type WorkOrderStatus,
} from "../../shared/types.js";

export type Tone = "accent" | "attention" | "success" | "danger" | "done" | "muted";

export function money(amount: number): string {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** A price in cents, as dollars. */
export function cents(amount: number): string {
  return money(amount / 100);
}

/** A player as the wall names them: "Mona · Downhill". */
export function playerLabel(name: string): string {
  return `${name} · ${PRODUCT_NAME}`;
}

/**
 * What a player's chat says first, before they write: a fixed line of the chat page, not a model's answer. It tells them
 * up front that support is an AI agent.
 */
export const PLAYER_GREETING = "Hi, I'm Contoso Outdoors support, an AI agent. What's going on?";

/** Where in the game a player opened support, for the operator. */
export function openerText(opener: Opener | undefined): string {
  switch (opener) {
    case "support-button":
      return "Opened from the Support button";
    case "promo-error":
      return "Opened under a rejected code";
    case "receipt":
      return "Opened from a receipt";
    default:
      return "Opened from the game";
  }
}

/** What a player tried at checkout, in one line: `Code "trail15": Invalid code.`, or what they paid without a code. */
export function checkoutLine(checkout: ShopCheckout): string {
  if (checkout.code) return `Code ${JSON.stringify(checkout.code)}${checkout.error ? `: ${checkout.error}` : ""}`;
  return checkout.order ? `Paid full price · ${checkout.order.id}` : "No code applied";
}

/** What an approval would do: "Refund $39.00 · CO-48177", or for a player "Refund $0.75 of DH-1042 to Mona". */
export function approvalTitle(approval: ApprovalRequest, to?: string): string {
  const what = approval.action === "refund" ? "Refund" : "Cancel";
  return to ? `${what} ${money(approval.amount)} of ${approval.orderId} to ${to}` : `${what} ${money(approval.amount)} · ${approval.orderId}`;
}

/** What the agent waits on, in a sentence: "refund", "cancellation". */
export function approvalNoun(approval: ApprovalRequest): string {
  return approval.action === "refund" ? "refund" : "cancellation";
}

/** A premium request count as the counters show it: whole numbers plainly, fractions with up to two decimals. */
export function premium(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, "");
}

export const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`;

export const STATUS: Readonly<Record<TicketStatus, { readonly label: string; readonly tone: Tone }>> = {
  opened: { label: "New", tone: "accent" },
  starting: { label: "Starting", tone: "muted" },
  answering: { label: "Answering", tone: "accent" },
  approval: { label: "Needs you", tone: "attention" },
  waiting: { label: "Waiting", tone: "muted" },
  resolved: { label: "Resolved", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

/** Software Factory's words for its work orders' statuses. */
export const WORK_ORDER_STATUS: Readonly<Record<WorkOrderStatus, { readonly label: string; readonly tone: Tone }>> = {
  queued: { label: "Queued", tone: "muted" },
  planning: { label: "Planning", tone: "accent" },
  building: { label: "Building", tone: "accent" },
  releasing: { label: "Releasing", tone: "accent" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

/** Software Factory is still working on it. */
export const workOrderActive = (status: WorkOrderStatus): boolean => status === "queued" || status === "planning" || status === "building" || status === "releasing";

/** How Software Factory names a work order: `WO-0012`. */
export function workOrderName(number: number): string {
  return `WO-${String(number).padStart(4, "0")}`;
}

/** `WO-0012 · Building` */
export function workOrderLine(routed: RoutedWorkOrder): string {
  return `${workOrderName(routed.number)} · ${WORK_ORDER_STATUS[routed.status].label}`;
}

/** The short label of the area a reported problem is about. */
export function areaLabel(area: unknown): string {
  return BUG_AREA_INFO[(BUG_AREAS as readonly unknown[]).includes(area) ? (area as BugArea) : "other"].label;
}

/** The latest message of a conversation, by either side (the team's notes to the agent aren't part of it). */
export function latestMessage(ticket: { readonly items: readonly TranscriptItem[] } | undefined): MessageItem | undefined {
  if (!ticket) return undefined;
  for (let index = ticket.items.length - 1; index >= 0; index--) {
    const item = ticket.items[index]!;
    if (item.kind === "message" && item.from !== "team" && item.text.trim()) return item;
  }
  return undefined;
}

export function toolCallCount(ticket: { readonly items: readonly TranscriptItem[] } | undefined): number {
  return ticket ? ticket.items.filter((item) => item.kind === "tool").length : 0;
}

/** The latest refund that went through, for the player's chat. */
export function latestRefund(items: readonly TranscriptItem[]): ToolItem | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === "tool" && item.name === "request_refund" && item.status === "done") return item;
  }
  return undefined;
}

const orderOf = (item: ToolItem): string => (typeof item.args["orderId"] === "string" ? item.args["orderId"].toUpperCase() : "your order");
const amountOf = (item: ToolItem): number | undefined => (typeof item.result?.["refunded"] === "number" ? item.result["refunded"] : undefined);

/** A tool call as the customer sees it in the support widget, or nothing for calls they don't need to see. */
export function customerLine(item: ToolItem): { readonly text: string; readonly tone: Tone } | undefined {
  const order = orderOf(item);
  if (item.status === "refused" && item.name !== "request_refund" && item.name !== "cancel_order") {
    return { text: typeof item.args["orderId"] === "string" ? `${order} isn't on your account` : "Couldn't find that order", tone: "muted" };
  }
  switch (item.name) {
    case "get_checkout":
      return { text: item.status === "running" ? "Looking at your checkout…" : "Looked at your checkout", tone: "muted" };
    case "list_my_orders":
      return { text: item.status === "running" ? "Looking up your orders…" : "Looked up your orders", tone: "muted" };
    case "get_order":
      return { text: item.status === "running" ? `Opening ${order}…` : `Opened ${order}`, tone: "muted" };
    case "track_shipment":
      return { text: item.status === "running" ? `Tracking ${order}…` : `Tracked ${order}`, tone: "muted" };
    case "request_refund":
    case "cancel_order": {
      const what = item.name === "request_refund" ? "Refund" : "Cancellation";
      switch (item.status) {
        case "asking":
        case "running":
          return { text: `${what} sent to the team for approval`, tone: "attention" };
        case "done": {
          const amount = amountOf(item);
          return { text: `${what} approved${amount !== undefined ? `: ${money(amount)} back` : ""}`, tone: "success" };
        }
        case "declined":
          return { text: `${what} needs a closer look`, tone: "muted" };
        default:
          return { text: `${what} not possible`, tone: "muted" };
      }
    }
    case "report_bug":
      if (item.status === "running") return { text: "Reporting the problem to our engineering team…", tone: "muted" };
      return item.status === "done" ? { text: "Reported the problem to our engineering team", tone: "muted" } : undefined;
    default:
      return undefined;
  }
}

/** What a tool call did, for the operator: one or two words, or the store's own short answer. */
export function operatorOutcome(item: ToolItem): { readonly text: string; readonly tone: Tone } {
  const result = item.result ?? {};
  switch (item.status) {
    case "running":
      return { text: "Running", tone: "accent" };
    case "asking":
      return { text: "Needs approval", tone: "attention" };
    case "declined":
      return item.name === "store_memory" ? { text: "Not added", tone: "muted" } : { text: "Declined", tone: "danger" };
    case "failed":
      return { text: "Failed", tone: "danger" };
    case "refused":
      return item.blocked ? { text: "Blocked: another customer's order", tone: "danger" } : { text: typeof result["error"] === "string" ? result["error"] : "Refused", tone: "muted" };
    case "done":
      break;
  }
  switch (item.name) {
    case "get_checkout": {
      const code = typeof result["code"] === "string" ? JSON.stringify(result["code"]) : undefined;
      return { text: code ? `Code ${code} · ${result["bought"] === true ? "bought anyway" : "not bought"}` : "Done", tone: "success" };
    }
    case "list_my_orders": {
      const count = Array.isArray(result["orders"]) ? result["orders"].length : 0;
      return { text: `${count} order${count === 1 ? "" : "s"}`, tone: "success" };
    }
    case "get_order":
    case "track_shipment":
      return { text: [result["carrier"], result["status"]].filter((part) => typeof part === "string").join(" · ") || "Done", tone: "success" };
    case "request_refund": {
      const amount = amountOf(item);
      return { text: amount !== undefined ? `${money(amount)} refunded` : "Refunded", tone: "success" };
    }
    case "cancel_order":
      return { text: "Cancelled", tone: "success" };
    case "report_bug":
      return { text: `Reported: ${areaLabel(item.args["area"])}`, tone: "done" };
    case "resolve_conversation":
      return { text: typeof item.args["summary"] === "string" ? item.args["summary"] : "Resolved", tone: "success" };
    case "store_memory":
    case "report_known_issue":
      // The call only proposes the fact or known issue: the operator adds it or not later, in the team knowledge panel.
      return { text: "Proposed to the team", tone: "muted" };
    default:
      return { text: "Done", tone: "success" };
  }
}

/** The arguments worth showing next to a tool's name. */
export function toolArgs(item: ToolItem): string {
  const parts: string[] = [];
  if (item.name === "store_memory" && typeof item.args["subject"] === "string") parts.push(item.args["subject"]);
  if (item.name === "report_known_issue" && typeof item.args["title"] === "string") parts.push(item.args["title"]);
  if (typeof item.args["orderId"] === "string") parts.push(item.args["orderId"].toUpperCase());
  if (typeof item.args["amount"] === "number") parts.push(money(item.args["amount"]));
  return parts.join(" · ");
}

/** What a known issue's answer did with one ticket, for its tile and the known issues strip. */
export const KNOWN_ISSUE_STATE: Readonly<Record<KnownIssueTicketState, { readonly label: string; readonly tone: Tone }>> = {
  classifying: { label: "Checking", tone: "accent" },
  "no-match": { label: "Not about it", tone: "muted" },
  replying: { label: "Sending the update", tone: "accent" },
  replied: { label: "Update sent", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

/** A known issue's answer in numbers: tickets checked, matched, sent the update, and failed. */
export function answerProgress(answer: KnownIssueAnswer): {
  readonly total: number;
  readonly classified: number;
  readonly matched: number;
  readonly replied: number;
  readonly failed: number;
  readonly finished: boolean;
} {
  const count = (...states: KnownIssueTicketState[]) => answer.tickets.filter((ticket) => states.includes(ticket.state)).length;
  const failed = count("failed");
  return {
    total: answer.tickets.length,
    classified: answer.tickets.length - count("classifying"),
    matched: answer.tickets.filter((ticket) => ticket.matched).length,
    replied: count("replied"),
    failed,
    finished: answer.finishedAt !== undefined,
  };
}

/** `Classifying 12 open tickets… 5 done`, then `12 tickets classified · 3 match · 3 updates sent`. */
export function answerLine(answer: KnownIssueAnswer): string {
  const progress = answerProgress(answer);
  const failed = progress.failed > 0 ? ` · ${progress.failed} failed` : "";
  if (progress.classified < progress.total) return `Classifying ${plural(progress.total, "open ticket")}… ${progress.classified} done`;
  const replies = `${plural(progress.replied, "update")} sent`;
  return `${plural(progress.total, "ticket")} classified · ${progress.matched} ${progress.matched === 1 ? "matches" : "match"} · ${progress.finished ? replies : `sending, ${replies}`}${failed}`;
}

export interface Span {
  readonly kind: "text" | "strong" | "em" | "code";
  readonly text: string;
}

const EMPHASIS = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\s][^*\n]*\*)/g;

/** The few Markdown marks agents use in short replies (bold, italics, code), as spans; everything else is text. */
export function inlineMarkdown(text: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const match of text.matchAll(EMPHASIS)) {
    const token = match[0];
    if (match.index > last) spans.push({ kind: "text", text: text.slice(last, match.index) });
    if (token.startsWith("**") || token.startsWith("__")) spans.push({ kind: "strong", text: token.slice(2, -2) });
    else if (token.startsWith("`")) spans.push({ kind: "code", text: token.slice(1, -1) });
    else spans.push({ kind: "em", text: token.slice(1, -1) });
    last = match.index + token.length;
  }
  if (last < text.length) spans.push({ kind: "text", text: text.slice(last) });
  return spans;
}

/** A reply without its Markdown marks, for one- and two-line previews. */
export function plainText(text: string): string {
  return inlineMarkdown(text)
    .map((span) => span.text)
    .join("")
    .replace(/^\s*(?:[-*+] |#{1,6} )/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
