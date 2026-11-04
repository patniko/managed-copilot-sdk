// Words for what the wall and the support widget show. Pure, so tests cover them.
import type { MessageItem, Ticket, TicketStatus, ToolItem } from "../../shared/types.js";

export type Tone = "accent" | "attention" | "success" | "danger" | "muted";

export function money(amount: number): string {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** A premium request count as the counters show it: whole numbers plainly, fractions with up to two decimals. */
export function premium(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, "");
}

export const STATUS: Readonly<Record<TicketStatus, { readonly label: string; readonly tone: Tone }>> = {
  starting: { label: "Starting", tone: "muted" },
  answering: { label: "Answering", tone: "accent" },
  approval: { label: "Needs you", tone: "attention" },
  waiting: { label: "Waiting", tone: "muted" },
  resolved: { label: "Resolved", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

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
      return { text: "Declined", tone: "danger" };
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
    case "resolve_conversation":
      return { text: typeof item.args["summary"] === "string" ? item.args["summary"] : "Resolved", tone: "success" };
    default:
      return { text: "Done", tone: "success" };
  }
}

/** The arguments worth showing next to a tool's name. */
export function toolArgs(item: ToolItem): string {
  const parts: string[] = [];
  if (typeof item.args["orderId"] === "string") parts.push(item.args["orderId"].toUpperCase());
  if (typeof item.args["amount"] === "number") parts.push(money(item.args["amount"]));
  return parts.join(" · ");
}
