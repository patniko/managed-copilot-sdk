// Live players: Downhill, Contoso Outdoors' free mountain-biking browser game, sells rider outfits and bike paint in its
// in-game shop, the Downhill Shop, whose checkout runs on the store's own checkout code. The game's Support button (and
// its links under a rejected code and on receipts) opens a support ticket (`POST /api/player-tickets`), and the player
// writes their complaint in Help Desk's chat. This module validates the request, names the ticket and its session,
// carries the player's context (who they are, what they tried at checkout) hidden in their messages, so a restarted Help
// Desk reads it back from the session's history, and gives the session its tools, bound to that one player.
import { randomInt } from "node:crypto";
import { defineTool, type Tool } from "@github/copilot-sdk";
import { z } from "zod";
import {
  AVATAR_COLORS,
  OPENERS,
  PRODUCT_NAME,
  SHOP_NAME,
  type Opener,
  type PlayerCard,
  type PlayerContext,
  type PlayerTicketRequest,
  type PlayerToolName,
  type ShopCheckout,
  type ShopItem,
  type ShopOrder,
  type ToolInfo,
} from "../shared/types.js";
import { HelpDeskError } from "./errors.js";
import { defuseTeamNotes, teamNoteRules } from "./notes.js";
import type { Check, ToolResult } from "./shop.js";
import { BugInput, promotionList, RefundInput, ResolveInput, withInput } from "./tools.js";

// ─── Tickets and their sessions ──────────────────────────────────────────────────────────────────────────────

const RANDOM_CHARS = 6;
const TICKET_ID = /^[a-z0-9]{8,32}$/;
const PLAYER_SESSION = /^hd-player-([a-z0-9]{8,32})$/;

/** A player ticket's ID: when it was opened, in base 36, then randomness. It ends the player's chat page path. */
export function newTicketId(openedAt = new Date(), random: (max: number) => number = (max) => randomInt(max)): string {
  let suffix = "";
  for (let index = 0; index < RANDOM_CHARS; index++) suffix += random(36).toString(36);
  return `${openedAt.getTime().toString(36)}${suffix}`;
}

export function isTicketId(value: string): boolean {
  return TICKET_ID.test(value);
}

/** When a player ticket was opened, from its ID. */
export function ticketOpenedAt(ticketId: string): Date | undefined {
  const time = Number.parseInt(ticketId.slice(0, -RANDOM_CHARS), 36);
  return Number.isFinite(time) && time > 0 ? new Date(time) : undefined;
}

/**
 * A player ticket's session ID. Simulations' sessions are `hd-<simulation>-<customer>`; these never match that pattern,
 * so ending or replacing a simulation (and its leftover cleanup) never touches a player's session.
 */
export function playerSessionId(ticketId: string): string {
  return `hd-player-${ticketId}`;
}

/** The ticket ID of a player ticket's session, if `sessionId` is one. */
export function parsePlayerSessionId(sessionId: string): string | undefined {
  return PLAYER_SESSION.exec(sessionId)?.[1];
}

/** Help Desk's page for the player's support chat, which the game shows in a frame. */
export function chatPath(ticketId: string): string {
  return `/chat/${ticketId}`;
}

// ─── The request ─────────────────────────────────────────────────────────────────────────────────────────────

/** The most any price or total may be: $20,000. */
const MAX_CENTS = 2_000_000;
const MAX_ITEMS = 20;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// Line breaks, tabs, and other control characters.
const CONTROL = /[\u0000-\u001f\u007f]/;

const invalid = (message: string): HelpDeskError => new HelpDeskError("invalid_request", message);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function object(value: unknown, path: string, holds: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(`${path} must be an object with ${holds}.`);
  return value;
}

interface TextRules {
  /** Keep spaces around it: a promotion code is reported exactly as checkout got it. */
  readonly raw?: boolean;
  /** An identifier: letters, digits, hyphens, and underscores. */
  readonly id?: boolean;
}

function optionalText(value: unknown, path: string, max: number, rules: TextRules = {}): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalid(`${path} must be text.`);
  const text = rules.raw ? value : value.trim();
  if (!text.trim()) return undefined;
  if (text.length > max) throw invalid(`${path} can be at most ${max} characters.`);
  if (CONTROL.test(text)) throw invalid(`${path} can't contain line breaks or other control characters.`);
  if (rules.id && !ID.test(text)) throw invalid(`${path} must be letters, digits, hyphens, and underscores, like "mona".`);
  return text;
}

function requiredText(value: unknown, path: string, max: number, rules: TextRules = {}): string {
  const text = optionalText(value, path, max, rules);
  if (text === undefined) throw invalid(`${path} is required.`);
  return text;
}

function cents(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS) {
    throw invalid(`${path} must be a whole number of cents from 0 to ${MAX_CENTS.toLocaleString("en-US")}.`);
  }
  return value;
}

function date(value: unknown, path: string): string {
  const text = typeof value === "string" && value.length <= 40 ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(text)) throw invalid(`${path} must be a date and time, like "2026-11-12T17:30:00.000Z".`);
  return new Date(text).toISOString();
}

function parseItems(value: unknown): ShopItem[] {
  // Empty when the player tried a code, then emptied their cart without buying.
  if (!Array.isArray(value)) throw invalid("checkout.items must list what the player was buying, as { sku, name, priceCents }.");
  if (value.length > MAX_ITEMS) throw invalid(`checkout.items can list at most ${MAX_ITEMS} items.`);
  return value.map((item, index) => {
    const path = `checkout.items[${index}]`;
    const input = object(item, path, "sku, name, and priceCents");
    return {
      sku: requiredText(input["sku"], `${path}.sku`, 64, { id: true }),
      name: requiredText(input["name"], `${path}.name`, 80),
      priceCents: cents(input["priceCents"], `${path}.priceCents`),
    };
  });
}

function parseOrder(value: unknown): ShopOrder | undefined {
  if (value === undefined || value === null) return undefined;
  const input = object(value, "checkout.order", "id, totalCents, and paidAt (only when the player bought anyway)");
  return {
    id: requiredText(input["id"], "checkout.order.id", 40, { id: true }),
    totalCents: cents(input["totalCents"], "checkout.order.totalCents"),
    paidAt: date(input["paidAt"], "checkout.order.paidAt"),
  };
}

/** What the player tried at checkout. `code` and `error` are absent when no code reached checkout. */
function parseCheckout(value: unknown): ShopCheckout | undefined {
  if (value === undefined || value === null) return undefined;
  const input = object(value, "checkout", "the items and subtotalCents, and the code and error if a code was tried");
  const code = optionalText(input["code"], "checkout.code", 64, { raw: true });
  const error = optionalText(input["error"], "checkout.error", 300);
  const offer = optionalText(input["offer"], "checkout.offer", 200);
  const order = parseOrder(input["order"]);
  return {
    ...(code ? { code } : {}),
    ...(error ? { error } : {}),
    ...(offer ? { offer } : {}),
    items: parseItems(input["items"]),
    subtotalCents: cents(input["subtotalCents"], "checkout.subtotalCents"),
    ...(order ? { order } : {}),
  };
}

function parseOpener(value: unknown): Opener | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !(OPENERS as readonly string[]).includes(value)) throw invalid(`opener must be ${OPENERS.map((opener) => `"${opener}"`).join(", ")}.`);
  return value as Opener;
}

/** Validates the body of `POST /api/player-tickets`. Problems are `invalid_request` errors in plain words. */
export function parsePlayerTicket(body: unknown): PlayerTicketRequest {
  const root = object(body, "The request", "product, player, gameVersion, and at");
  if (root["product"] !== "downhill") throw invalid('product must be "downhill": Help Desk takes player tickets from Downhill only.');
  const player = object(root["player"], "player", "the player's name and rider");
  const checkout = parseCheckout(root["checkout"]);
  const opener = parseOpener(root["opener"]);
  const ticketId = optionalText(root["ticketId"], "ticketId", 64);
  const userAgent = optionalText(root["userAgent"], "userAgent", 512);
  return {
    product: "downhill",
    player: { name: requiredText(player["name"], "player.name", 40), rider: requiredText(player["rider"], "player.rider", 40, { id: true }) },
    ...(checkout ? { checkout } : {}),
    ...(opener ? { opener } : {}),
    ...(ticketId ? { ticketId } : {}),
    gameVersion: requiredText(root["gameVersion"], "gameVersion", 40),
    ...(userAgent ? { userAgent } : {}),
    at: date(root["at"], "at"),
  };
}

/** What a ticket keeps of a request: everything but the ticket to reopen. */
export function contextOf(request: PlayerTicketRequest): PlayerContext {
  const { ticketId: _reopen, ...context } = request;
  return context;
}

/** The same opening sent again (the game retried it): it gets the same ticket. */
export function sameOpening(a: PlayerContext, b: PlayerContext): boolean {
  return a.player.rider === b.player.rider && a.at === b.at && a.opener === b.opener;
}

/** A reopening's context: the new one, keeping the checkout the player tried before when the game sent none. */
export function reopened(previous: PlayerContext | undefined, next: PlayerContext): PlayerContext {
  return next.checkout || !previous?.checkout ? next : { ...next, checkout: previous.checkout };
}

// ─── The player's messages, with their context ───────────────────────────────────────────────────────────────

const BLOCK = "downhill_checkout";
const OPEN = `<${BLOCK}>`;
const CLOSE = `</${BLOCK}>`;
/** The block's tags as a player might type them: they're defused, so only Help Desk's own block is ever read. */
const TAGS = new RegExp(`<(/?)(${BLOCK})`, "gi");

/**
 * A player's message as the session gets it: their words, then, when it changed since their last message, their context
 * (who they are and what they tried at checkout) as JSON in a `<downhill_checkout>` block. The session keeps it in its
 * history, so a restarted Help Desk reads the context back. People never see the block.
 */
export function promptFor(text: string, context?: PlayerContext): string {
  const words = defuseTeamNotes(text.replace(TAGS, "‹$1$2"));
  if (!context) return words;
  // Escaped so nothing in the JSON can close the block.
  const json = JSON.stringify(context).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `${words}\n\n${OPEN}\n${json}\n${CLOSE}`;
}

/** A player's words in a message, and the context it carried (validated again), if any. */
export function readPrompt(content: string): { readonly text: string; readonly context?: PlayerContext } {
  const open = content.lastIndexOf(OPEN);
  const close = content.lastIndexOf(CLOSE);
  if (open < 0 || close < open) return { text: content };
  const text = content.slice(0, open).trim();
  try {
    return { text, context: contextOf(parsePlayerTicket(JSON.parse(content.slice(open + OPEN.length, close)))) };
  } catch {
    return { text };
  }
}

/** How the wall shows a player: their name, initials, and an identity color picked by their rider. */
export function playerCard(player: { readonly name: string; readonly rider: string }): PlayerCard {
  const parts = player.name.split(/\s+/).filter(Boolean);
  const initials = `${parts[0]?.[0] ?? ""}${parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : ""}`.toUpperCase() || "?";
  let hash = 0;
  for (const char of player.rider || player.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { name: player.name, rider: player.rider, initials, color: AVATAR_COLORS[hash % AVATAR_COLORS.length]! };
}

/** A ticket picked up after a restart, before its conversation is read. */
export const UNKNOWN_PLAYER: PlayerCard = { name: "Player", rider: "", initials: "?", color: "blue" };

// ─── The player's account: their checkout and their order ────────────────────────────────────────────────────

const normalizeOrderId = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value).trim().toUpperCase().replace(/^#/, "") : "");
const NOT_LOADED = "The player's details aren't loaded yet. Try again in a moment.";
const OPENED_FROM: Readonly<Record<Opener, string>> = { "support-button": "the Support button", "promo-error": "a rejected promotion code", receipt: "a receipt" };

/**
 * One player's context and Downhill Shop order, as their session's tools see them. Nothing else is reachable: an order
 * number that isn't their latest order is answered like one that doesn't exist.
 */
export class PlayerAccount {
  #context: PlayerContext | undefined;
  /** Refunded so far, in cents, by order ID. */
  readonly #refunded = new Map<string, number>();
  /** Results of refunds already made, by tool call: a repeated call changes nothing again. */
  readonly #applied = new Map<string, ToolResult>();

  constructor(context?: PlayerContext) {
    this.#context = context;
  }

  /** Who the player is, and what they last tried at checkout. */
  get context(): PlayerContext | undefined {
    return this.#context;
  }

  /** A ticket picked up after a restart learns its context from its conversation. */
  know(context: PlayerContext): void {
    this.#context ??= context;
  }

  /** The player opened support again: the game's latest context (keeping the checkout they tried before if none came). */
  update(context: PlayerContext): void {
    this.#context = reopened(this.#context, context);
  }

  get order(): ShopOrder | undefined {
    return this.#context?.checkout?.order;
  }

  /** USD refunded on the latest order so far. */
  get refunded(): number {
    const order = this.order;
    return order ? (this.#refunded.get(order.id) ?? 0) / 100 : 0;
  }

  #missing(orderId: unknown): ToolResult {
    const id = normalizeOrderId(orderId);
    return { ok: false, error: id ? `No order ${id} on this account.` : "Name the order, such as DH-1042." };
  }

  #owns(orderId: unknown): boolean {
    const order = this.order;
    return order !== undefined && normalizeOrderId(orderId) === order.id.toUpperCase();
  }

  /** What the player last tried at checkout (`get_checkout`). Prices in dollars, like the store's tools. */
  checkout(): ToolResult {
    const context = this.#context;
    if (!context) return { ok: false, error: NOT_LOADED };
    const base = {
      ok: true,
      shop: SHOP_NAME,
      player: context.player.name,
      ...(context.opener ? { openedSupportFrom: OPENED_FROM[context.opener] } : {}),
      gameVersion: context.gameVersion,
    };
    const checkout = context.checkout;
    if (!checkout) return { ...base, tried: false, note: "The game sent no checkout: the player hasn't tried one in the Downhill Shop. Ask them what they tried." };
    const order = checkout.order;
    return {
      ...base,
      tried: true,
      // No code: none reached checkout (the player bought without one).
      code: checkout.code ?? null,
      ...(checkout.error ? { checkoutSaid: checkout.error } : {}),
      ...(checkout.offer ? { offer: checkout.offer } : {}),
      items: checkout.items.map((item) => ({ name: item.name, sku: item.sku, price: item.priceCents / 100 })),
      subtotal: checkout.subtotalCents / 100,
      bought: order !== undefined,
      ...(order ? { order: { orderId: order.id, total: order.totalCents / 100, paidAt: order.paidAt, ...(this.refunded > 0 ? { refunded: this.refunded } : {}) } } : {}),
    };
  }

  /** Whether a refund of the player's order would go through, and for how much (USD). */
  checkRefund(orderId: unknown, amount?: unknown): Check {
    if (!this.#context) return { ok: false, error: NOT_LOADED };
    const order = this.order;
    if (!order) return { ok: false, error: "The game sent no Downhill Shop order for this player: there's nothing to refund." };
    if (!this.#owns(orderId)) return { ok: false, error: (this.#missing(orderId) as { error: string }).error };
    const remaining = order.totalCents - (this.#refunded.get(order.id) ?? 0);
    if (remaining <= 0) return { ok: false, error: "This order was refunded in full already." };
    if (amount === undefined || amount === null) return { ok: true, amount: remaining / 100 };
    const requested = typeof amount === "number" ? Math.round(amount * 100) : Number.NaN;
    if (!Number.isFinite(requested) || requested <= 0) return { ok: false, error: "The refund amount must be a positive number of dollars." };
    if (requested > remaining) return { ok: false, error: `At most ${usd(remaining)} of this order can be refunded.` };
    return { ok: true, amount: requested / 100 };
  }

  /** Refunds the player's order (in part when `amount` is given). `effectId` makes a repeated call change nothing again. */
  refund(orderId: unknown, amount: unknown, effectId: string): ToolResult {
    const done = this.#applied.get(effectId);
    if (done) return done;
    const check = this.checkRefund(orderId, amount);
    if (!check.ok) return { ok: false, error: check.error };
    const order = this.order!;
    this.#refunded.set(order.id, (this.#refunded.get(order.id) ?? 0) + Math.round(check.amount * 100));
    const result = { ok: true, orderId: order.id, refunded: check.amount, to: "the original payment method", arrivesIn: "3 to 5 business days" };
    this.#applied.set(effectId, result);
    return result;
  }

  /** A software problem the player ran into, for the store's engineering team. The order it names must be theirs. */
  reportBug(report: { readonly area: string; readonly orderId?: string | undefined }): ToolResult {
    if (report.orderId !== undefined && !this.#owns(report.orderId)) return this.#missing(report.orderId);
    return { ok: true, area: report.area, ...(report.orderId !== undefined ? { orderId: this.order!.id } : {}), sentTo: "the store's engineering team" };
  }
}

const usd = (amountCents: number): string => (amountCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

// ─── The player's tools and instructions ─────────────────────────────────────────────────────────────────────

/** The player tools that wait for the operator's approval. */
export const PLAYER_APPROVAL_TOOLS: ReadonlySet<string> = new Set<PlayerToolName>(["request_refund"]);

export const PLAYER_TOOLS: readonly ToolInfo[] = [
  { name: "get_checkout", approval: false },
  { name: "request_refund", approval: true },
  { name: "report_bug", approval: false },
  { name: "resolve_conversation", approval: false },
];

const shopOrderId = z.string().min(1).max(40);
const PlayerRefundInput = RefundInput.extend({ orderId: shopOrderId.describe("The player's Downhill Shop order, for example DH-1042") });
const PlayerBugInput = BugInput.extend({ orderId: shopOrderId.optional().describe("The Downhill Shop order it affected, if any, for example DH-1042") });

/** A player ticket's tools, bound to that player's checkout and order. Same names and schemas as the store's. */
export function playerTools(account: PlayerAccount): Tool<any>[] {
  return [
    defineTool("get_checkout", {
      description:
        "Get what the player last tried at the Downhill Shop's checkout, as the game sent it: the promotion code exactly as checkout got it, what checkout said, the shop's offer, the items and subtotal, and their order if they bought anyway. Says so when the game sent no checkout.",
      parameters: z.object({}),
      skipPermission: true,
      handler: () => account.checkout(),
    }),
    defineTool("request_refund", {
      description: "Refund the player's Downhill Shop order, in full or in part, to their original payment method. Only for an order they paid for. A support team member approves each refund first.",
      parameters: PlayerRefundInput,
      handler: (args, invocation) => withInput(PlayerRefundInput, args, (input) => account.refund(input.orderId, input.amount, invocation.toolCallId)),
    }),
    defineTool("report_bug", {
      description:
        "Report a software problem the player ran into at the Downhill Shop's checkout (a rejected promotion code, a wrong total) to the store's engineering team, who fix the checkout code the store's website and the Downhill Shop share.",
      parameters: PlayerBugInput,
      skipPermission: true,
      handler: (args) => withInput(PlayerBugInput, args, (input) => account.reportBug(input)),
    }),
    defineTool("resolve_conversation", {
      description: "Mark this conversation resolved once the player's request is fully handled and you aren't waiting on them.",
      parameters: ResolveInput,
      skipPermission: true,
      handler: (args) => withInput(ResolveInput, args, () => ({ ok: true })),
    }),
  ];
}

/** Added to the platform's instructions for every player's session. The player's name comes from get_checkout. */
export function playerSystemMessage(): string {
  return [
    `You are the support assistant of Contoso Outdoors, an online outdoor gear store. You're chatting with a player of ${PRODUCT_NAME}, the store's free mountain-biking browser game, who opened support from the game. The game's in-game shop, the ${SHOP_NAME}, sells rider outfits and bike paint, and its checkout runs on the store's own checkout code, so promotion codes work there exactly as on the store's website. The chat already greeted the player as Contoso Outdoors support, an AI agent; they write their complaint in their own words.`,
    "- The game attaches the player's latest checkout to their messages in a <downhill_checkout> block when it changes. It's for your tools: the player didn't write it and doesn't see it, so never mention or quote it. Read it with get_checkout, and never make up codes, items, prices, orders, or amounts.",
    "- When the player mentions a code, a discount, a price, or an order, call get_checkout before you answer. If it says the game sent no checkout, ask them what they tried: the code, and what they were buying. Call the player by the name it gives.",
    `- This month's promotion codes: ${promotionList()}.`,
    "- A valid code (one of this month's codes, in any letter case or with stray spaces) that checkout rejected is a software problem: call report_bug once with area promo-codes, naming their order if they have one, and tell them the store's engineering team is on it. A code that isn't one of this month's codes isn't a software problem: tell them it isn't a current code.",
    "- If they already bought at full price (get_checkout shows an order), call request_refund right away for what the offer's code should have taken off their order, without asking them to confirm: a team member approves it. Then tell them the outcome.",
    "- If they haven't bought yet, tell them that typing the code exactly, in capitals (for example TRAIL15 for trail15), may work in the meantime. Say it plainly, without promising it will.",
    "- Your tools only see this player's checkout and their Downhill Shop order. You can't change the shop, give items, or look up orders from the store's website.",
    "- Reply in two or three short, friendly sentences of plain text: no headings, lists, tables, error codes, or stack traces.",
    teamNoteRules("player", false),
    "- End every turn the same way: when nothing is left for the player to wait on (their question is answered, or a refund was decided), call resolve_conversation with a one-line summary, then send your reply. Only skip it when you asked them a question.",
  ].join("\n");
}
