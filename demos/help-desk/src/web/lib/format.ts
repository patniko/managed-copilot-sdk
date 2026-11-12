// Words for what the wall and the support widget show. Pure, so tests cover them.
import { BUG_AREA_INFO, BUG_AREAS, type BugArea, type MessageItem, type RoutedWorkOrder, type Ticket, type TicketStatus, type ToolItem, type WorkOrderStatus } from "../../shared/types.js";

export type Tone = "accent" | "attention" | "success" | "danger" | "done" | "muted";

export function money(amount: number): string {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** A premium request count as the counters show it: whole numbers plainly, fractions with up to two decimals. */
export function premium(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, "");
}

export const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`;

export const STATUS: Readonly<Record<TicketStatus, { readonly label: string; readonly tone: Tone }>> = {
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

/** The latest message of a conversation, by either side. */
export function latestMessage(ticket: Ticket | undefined): MessageItem | undefined {
  if (!ticket) return undefined;
  for (let index = ticket.items.length - 1; index >= 0; index--) {
    const item = ticket.items[index]!;
    if (item.kind === "message" && item.text.trim()) return item;
  }
  return undefined;
}

export function toolCallCount(ticket: Ticket | undefined): number {
  return ticket ? ticket.items.filter((item) => item.kind === "tool").length : 0;
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
      // The call only proposes the fact: the operator adds it or not later, in the team knowledge base.
      return { text: "Proposed to the team", tone: "muted" };
    default:
      return { text: "Done", tone: "success" };
  }
}

/** The arguments worth showing next to a tool's name. */
export function toolArgs(item: ToolItem): string {
  const parts: string[] = [];
  if (item.name === "store_memory" && typeof item.args["subject"] === "string") parts.push(item.args["subject"]);
  if (typeof item.args["orderId"] === "string") parts.push(item.args["orderId"].toUpperCase());
  if (typeof item.args["amount"] === "number") parts.push(money(item.args["amount"]));
  return parts.join(" · ");
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
