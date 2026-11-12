// The agent's hands: the store's tools, created per session and bound to that session's customer, including
// `report_bug` for problems the customer ran into on the store's website. None of them takes a customer ID, so a
// session can't even ask for another customer's data; an order number of someone else's order is answered exactly like
// one that doesn't exist.
import { defineTool, type Tool } from "@github/copilot-sdk";
import { z } from "zod";
import { BUG_AREAS, type ToolInfo, type ToolName } from "../shared/types.js";
import type { Shop, ToolResult } from "./shop.js";
import { PROMOTIONS, REFUND_WINDOW_DAYS, type CustomerSeed } from "./seed.js";

/** The tools that change orders: each call waits for the operator's approval. */
export const APPROVAL_TOOLS: ReadonlySet<string> = new Set<ToolName>(["request_refund", "cancel_order"]);

export const TOOLS: readonly ToolInfo[] = [
  { name: "list_my_orders", approval: false },
  { name: "get_order", approval: false },
  { name: "track_shipment", approval: false },
  { name: "request_refund", approval: true },
  { name: "cancel_order", approval: true },
  { name: "report_bug", approval: false },
  { name: "resolve_conversation", approval: false },
];

const orderId = z.string().min(1).max(40).describe("The order number, for example CO-48213");
const OrderInput = z.object({ orderId });
export const RefundInput = z.object({
  orderId,
  amount: z.number().positive().optional().describe("Dollars to refund, for a partial refund. Omit it to refund everything not refunded yet."),
  reason: z.string().max(300).describe("Why, in a few words"),
});
const CancelInput = z.object({ orderId, reason: z.string().max(300).describe("Why, in a few words") });
export const BugInput = z.object({
  area: z.enum(BUG_AREAS).describe("What it's about: promo-codes (a code at checkout), cart (items, quantities, or totals in the cart), order-status (the status the My orders page shows), or other"),
  title: z.string().trim().min(3).max(120).describe("One line: what's wrong on the website"),
  whatHappened: z.string().trim().min(3).max(800).describe("What they did on the website and what they saw, with the details they gave: codes, quantities, labels"),
  expected: z.string().trim().min(3).max(400).describe("What the website should have done"),
  orderId: orderId.optional().describe("The order it affected, if any, for example CO-48213"),
});
export const ResolveInput = z.object({ summary: z.string().max(300).describe("One line: what was done for the customer") });

/** Runs `run` with the arguments `schema` accepts, or tells the agent what was wrong with them. */
export function withInput<T>(schema: z.ZodType<T>, args: unknown, run: (input: T) => ToolResult): ToolResult {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: `Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`).join("; ")}` };
  return run(parsed.data);
}

/** The store's tools for one customer's session. */
export function customerTools(shop: Shop, customerId: string): Tool<any>[] {
  return [
    defineTool("list_my_orders", {
      description: "List the signed-in customer's orders, newest first, with their status.",
      parameters: z.object({}),
      skipPermission: true,
      handler: () => shop.listOrders(customerId),
    }),
    defineTool("get_order", {
      description: "Get one of the customer's orders: items, total, status, and shipping.",
      parameters: OrderInput,
      skipPermission: true,
      handler: (args) => withInput(OrderInput, args, (input) => shop.getOrder(customerId, input.orderId)),
    }),
    defineTool("track_shipment", {
      description: "Track the shipment of one of the customer's orders: carrier, tracking number, delivery date, and scan history.",
      parameters: OrderInput,
      skipPermission: true,
      handler: (args) => withInput(OrderInput, args, (input) => shop.trackShipment(customerId, input.orderId)),
    }),
    defineTool("request_refund", {
      description: "Refund one of the customer's delivered orders, in full or in part, to their original payment method. A support team member approves each refund first.",
      parameters: RefundInput,
      handler: (args, invocation) => withInput(RefundInput, args, (input) => shop.refund(customerId, input.orderId, input.amount, invocation.toolCallId)),
    }),
    defineTool("cancel_order", {
      description: "Cancel one of the customer's orders that hasn't shipped yet, and refund it. A support team member approves each cancellation first.",
      parameters: CancelInput,
      handler: (args, invocation) => withInput(CancelInput, args, (input) => shop.cancel(customerId, input.orderId, invocation.toolCallId)),
    }),
    defineTool("report_bug", {
      description:
        "Report a software problem the customer ran into on the store's website or app (an error, a rejected promo code, a wrong total or quantity, a wrong order status) to the store's engineering team, who fix the website. Not for products that arrived broken, leak, or don't fit: those aren't software problems.",
      parameters: BugInput,
      skipPermission: true,
      handler: (args) => withInput(BugInput, args, (input) => shop.reportBug(customerId, input)),
    }),
    defineTool("resolve_conversation", {
      description: "Mark this conversation resolved once the customer's request is fully handled and you aren't waiting on them.",
      parameters: ResolveInput,
      skipPermission: true,
      handler: (args) => withInput(ResolveInput, args, () => ({ ok: true })),
    }),
  ];
}

/** What a refund or cancellation the agent asked for would do, for the operator's approval. */
export function checkRequest(shop: Shop, customerId: string, tool: string, args: Readonly<Record<string, unknown>>) {
  return tool === "request_refund" ? shop.checkRefund(customerId, args["orderId"], args["amount"]) : shop.checkCancel(customerId, args["orderId"]);
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });

/** This month's promotion codes and their terms, as the agents are told them. */
export function promotionList(): string {
  return Object.entries(PROMOTIONS)
    .map(([code, promotion]) => `${code} (${promotion.terms})`)
    .join(", ");
}

/** Added to the platform's instructions for every customer's session. */
export function systemMessage(customer: CustomerSeed, shop: Shop): string {
  const first = customer.name.split(" ")[0] ?? customer.name;
  const promotions = promotionList();
  return [
    `You are the support assistant of Contoso Outdoors, an online outdoor gear store. You're chatting with ${first}, a signed-in customer, in the store's support widget. Today is ${WEEKDAY.format(shop.startedAt)}, ${shop.date(0)}.`,
    "- Your tools only read and change this customer's own account. Use them instead of guessing; never make up orders, dates, amounts, or tracking details.",
    "- Help the team learn. Whenever the customer tells you something that would help other customers and the team knowledge base below doesn't say it yet (how a product fits, for example that it runs small or large; how a product works; a workaround for a problem with the website), your first tool calls must include store_memory, with a short, general fact that names the product or page. It's internal: a team member reviews it later, and the customer must never hear about it, so never say you're storing, noting, saving, or passing anything on for the team, not even in the text you write before your tool calls.",
    "- When the customer names an order number, call get_order or track_shipment with it before you answer: those tools decide which orders this customer may see. If a tool says an order isn't on this account, say you can only help with orders on their own account, without saying whether that order exists.",
    "- Never ask the customer for an order number: when they don't name one, call list_my_orders and find the order yourself.",
    "- When the customer clearly asks for a refund or a cancellation, call request_refund or cancel_order right away, without asking them to confirm: a team member approves it. Then tell them the outcome.",
    `- Store policy: orders can be cancelled until they ship; delivered orders can be refunded within ${REFUND_WINDOW_DAYS} days of delivery. You can't change addresses or add items to an order.`,
    `- This month's promotion codes: ${promotions}.`,
    "- The customer sees the store's website and app; your tools see the orders behind them. An order's shownOnMyOrdersPage is the label the customer's My orders page shows: when it doesn't match the order's real status, the website is wrong. When the customer says the website or app showed or did something wrong (it rejected a promo code, changed a quantity, showed a wrong total, or showed an order as delivered when the carrier says it isn't), that's a software problem even if the order's status looks right in your tools: check their order with your tools, call report_bug once with the area it's about, and tell them you reported it to the store's engineering team. A product that arrived broken, leaks, or doesn't fit is not a software problem: never report it with report_bug. Still help with their order as usual: if the website's problem made them pay more than they should have, request a partial refund of the difference right away (a team member approves it).",
    "- Reply in two or three short, friendly sentences of plain text: no headings, lists, or tables.",
    "- End every turn the same way: when nothing is left for the customer to wait on (their question is answered, or a refund or cancellation was decided), call resolve_conversation with a one-line summary, then send your reply. Only skip it when you asked them a question.",
  ].join("\n");
}
