// The agent's hands: the Downhill Shop's support tools, created per session and bound to that session's player,
// including `report_bug` for problems the player ran into in the shop. None of them takes a customer ID, so a session
// can't even ask for another player's data; an order number of someone else's order is answered exactly like one that
// doesn't exist.
import { defineTool, type Tool } from "@github/copilot-sdk";
import { z } from "zod";
import { BUG_AREAS, type ToolInfo, type ToolName } from "../shared/types.js";
import { teamNoteRules } from "./notes.js";
import type { Shop, ToolResult } from "./shop.js";
import { PROMOTIONS, REFUND_ARRIVES_IN, REFUND_WINDOW_DAYS, type CustomerSeed } from "./seed.js";

/** The tools that change orders: each call waits for the operator's approval. */
export const APPROVAL_TOOLS: ReadonlySet<string> = new Set<ToolName>(["request_refund", "cancel_order"]);

export const TOOLS: readonly ToolInfo[] = [
  { name: "list_my_orders", approval: false },
  { name: "get_order", approval: false },
  { name: "check_unlock", approval: false },
  { name: "request_refund", approval: true },
  { name: "cancel_order", approval: true },
  { name: "report_bug", approval: false },
  { name: "report_known_issue", approval: false },
  { name: "resolve_conversation", approval: false },
];

const orderId = z.string().min(1).max(40).describe("The order number, for example DH-20652");
const OrderInput = z.object({ orderId });
export const RefundInput = z.object({
  orderId,
  amount: z.number().positive().optional().describe("Dollars to refund, for a partial refund. Omit it to refund everything not refunded yet."),
  reason: z.string().max(300).describe("Why, in a few words"),
});
const CancelInput = z.object({ orderId, reason: z.string().max(300).describe("Why, in a few words") });
export const BugInput = z.object({
  area: z.enum(BUG_AREAS).describe("What it's about: promo-codes (a code at checkout), cart (looks, quantities, or totals in the cart), purchase-status (the status the My purchases page shows), or other"),
  title: z.string().trim().min(3).max(120).describe("One line: what's wrong in the shop"),
  whatHappened: z.string().trim().min(3).max(800).describe("What they did in the shop and what they saw, with the details they gave: codes, looks, amounts, labels"),
  expected: z.string().trim().min(3).max(400).describe("What the shop should have done"),
  orderId: orderId.optional().describe("The order it affected, if any, for example DH-20652"),
});
export const ResolveInput = z.object({ summary: z.string().max(300).describe("One line: what was done for the customer") });
export const KnownIssueInput = z.object({
  title: z.string().trim().min(3).max(120).describe("A few words: the problem, for example 'Launch code trail15 rejected at checkout'"),
  symptoms: z.string().trim().min(3).max(500).describe("How customers describe it: what they did and what they saw, without names, emails, order numbers, or amounts"),
  update: z.string().trim().min(3).max(500).describe("What customers should be told: what the team is doing about it, and what to do meanwhile"),
});
export type KnownIssueReport = z.infer<typeof KnownIssueInput>;

/** Records a known issue an agent proposed, for a team member to decide; says what happened to it. */
export type ReportKnownIssue = (report: KnownIssueReport) => ToolResult;

const NO_KNOWN_ISSUES: ReportKnownIssue = () => ({ ok: false, error: "Known issues can't be proposed from this conversation." });

/** Runs `run` with the arguments `schema` accepts, or tells the agent what was wrong with them. */
export function withInput<T>(schema: z.ZodType<T>, args: unknown, run: (input: T) => ToolResult): ToolResult {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: `Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`).join("; ")}` };
  return run(parsed.data);
}

/** The support tools for one player's session. `reportKnownIssue` keeps the known issues its agent proposes. */
export function customerTools(shop: Shop, customerId: string, reportKnownIssue: ReportKnownIssue = NO_KNOWN_ISSUES): Tool<any>[] {
  return [
    defineTool("list_my_orders", {
      description: "List the signed-in player's Downhill Shop orders, newest first, with their status.",
      parameters: z.object({}),
      skipPermission: true,
      handler: () => shop.listOrders(customerId),
    }),
    defineTool("get_order", {
      description: "Get one of the player's orders: the looks (and who each fits), the total, the payment, and the status.",
      parameters: OrderInput,
      skipPermission: true,
      handler: (args) => withInput(OrderInput, args, (input) => shop.getOrder(customerId, input.orderId)),
    }),
    defineTool("check_unlock", {
      description: "Check the payment and unlock history of one of the player's orders: the payment method, the payment provider's events, and when its looks unlock.",
      parameters: OrderInput,
      skipPermission: true,
      handler: (args) => withInput(OrderInput, args, (input) => shop.checkUnlock(customerId, input.orderId)),
    }),
    defineTool("request_refund", {
      description: "Refund one of the player's paid orders, in full or in part, to their original payment method. A support team member approves each refund first.",
      parameters: RefundInput,
      handler: (args, invocation) => withInput(RefundInput, args, (input) => shop.refund(customerId, input.orderId, input.amount, invocation.toolCallId)),
    }),
    defineTool("cancel_order", {
      description: "Cancel one of the player's orders whose payment hasn't cleared yet, so nothing is charged. A support team member approves each cancellation first.",
      parameters: CancelInput,
      handler: (args, invocation) => withInput(CancelInput, args, (input) => shop.cancel(customerId, input.orderId, invocation.toolCallId)),
    }),
    defineTool("report_bug", {
      description:
        "Report a software problem the player ran into in the Downhill Shop or on My purchases (an error, a rejected promo code, a look charged twice, a wrong total, a wrong purchase status) to the engineering team, who fix the shop's checkout code. Not for looks they don't like, bought by mistake, or that someone else bought: those aren't software problems.",
      parameters: BugInput,
      skipPermission: true,
      handler: (args) => withInput(BugInput, args, (input) => shop.reportBug(customerId, input)),
    }),
    defineTool("report_known_issue", {
      description:
        "Propose an ongoing problem a support team member told you about in a team note as a known issue for the whole support desk. A team member records it, and every agent then tells affected customers the update. Internal: never mention it to the customer.",
      parameters: KnownIssueInput,
      skipPermission: true,
      handler: (args) => withInput(KnownIssueInput, args, reportKnownIssue),
    }),
    defineTool("resolve_conversation", {
      description: "Mark this conversation resolved once the player's request is fully handled and you aren't waiting on them.",
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

/** The Downhill Shop's promotion codes and their terms, as the agents are told them. */
export function promotionList(): string {
  return Object.entries(PROMOTIONS)
    .map(([code, promotion]) => `${code} (${promotion.terms})`)
    .join(", ");
}

/** Added to the platform's instructions for every simulated player's session. */
export function systemMessage(customer: CustomerSeed, shop: Shop): string {
  const first = customer.name.split(" ")[0] ?? customer.name;
  const promotions = promotionList();
  return [
    `You are the support assistant of Contoso Outdoors for Downhill, its mountain-biking browser game, and the Downhill Shop, the game's in-game shop, which sells looks: rider outfits and bike paint. You're chatting with ${first}, a signed-in player, in Contoso Outdoors' support widget. Today is ${WEEKDAY.format(shop.startedAt)}, ${shop.date(0)}: Downhill's launch day. It's ${shop.time(0)} now.`,
    "- Your tools only read and change this player's own account. Use them instead of guessing; never make up orders, times, amounts, or payment details.",
    "- Help the team learn. Whenever the player tells you something that would help other players and the team knowledge base below doesn't say it yet (how a look or the game works, a setting or workaround that fixes a problem with the game or the shop), your first tool calls must include store_memory, with a short, general fact that names the look, setting, or page. It's internal: a team member reviews it later, and the player must never hear about it, so never say you're storing, noting, saving, or passing anything on for the team, not even in the text you write before your tool calls.",
    "- When the player names an order number, call get_order or check_unlock with it before you answer: those tools decide which orders this player may see. If a tool says an order isn't on this account, say you can only help with orders on their own account, without saying whether that order exists.",
    "- Never ask the player for an order number: when they don't name one, call list_my_orders and find the order yourself.",
    "- When the player clearly asks for a refund or a cancellation, call request_refund or cancel_order right away, without asking them to confirm: a team member approves it. Then tell them the outcome.",
    `- Shop policy: an order whose payment hasn't cleared yet can be cancelled, and nothing is charged; paid looks can be refunded within ${REFUND_WINDOW_DAYS} days of purchase, and refunds reach the original payment method in ${REFUND_ARRIVES_IN}. You can't move purchases to another account or add looks to an order.`,
    `- The Downhill Shop's promotion codes: ${promotions}.`,
    "- Downhill basics: each rider outfit fits one rider (Mona, Copilot, or the Rider), and a paint job goes on whichever bike they ride. Looks are saved in the browser they were bought in. Downhill plays with a keyboard, touch, or a gamepad: the browser connects a gamepad once the player presses one of its buttons on the title screen. For anything else about playing Downhill, use the team knowledge base; don't make up settings or features.",
    "- The player sees the Downhill Shop and their My purchases page; your tools see the orders behind them. An order's shownOnMyPurchasesPage is the label the player's My purchases page shows: when it doesn't match the order's real status, the page is wrong. When the player says the shop or My purchases showed or did something wrong (it rejected a promo code, charged for a look twice, showed a wrong total, or showed a look as unlocked when it isn't), that's a software problem even if the order looks right in your tools: check their order with your tools, call report_bug once with the area it's about, and tell them you reported it to the engineering team. A look they don't like, bought by mistake, or that someone else bought is not a software problem: never report it with report_bug. Still help with their order as usual: if the shop's problem made them pay more than they should have, request a partial refund of the difference right away (a team member approves it).",
    "- Reply in two or three short, friendly sentences of plain text: no headings, lists, or tables.",
    teamNoteRules("player", true),
    "- End every turn the same way: when nothing is left for the player to wait on (their question is answered, or a refund or cancellation was decided), call resolve_conversation with a one-line summary, then send your reply. Only skip it when you asked them a question.",
  ].join("\n");
}
