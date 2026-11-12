// Support: the game's request is checked and capped here, then sent to Help Desk as a player ticket, server to server
// with a timeout. Every failure becomes a DownhillError in plain words.
import { RIDER_NAMES, SUPPORT_OPENERS, type PlayerTicket, type RiderId, type SupportCheckout, type SupportItem, type SupportOpener, type SupportOrder, type SupportRequest } from "../shared/support.js";
import { baseUrl } from "./config.js";
import { DownhillError } from "./errors.js";

const TIMEOUT_MS = 10_000;

export const SUPPORT_NOT_CONNECTED = "Support isn't connected. Start Help Desk with `aspire run`, or set HELP_DESK_URL.";

/** The most of each part of a request the server passes on. Longer text is cut short; larger numbers are refused. */
export const LIMITS = {
  /** Request body, bytes. */
  body: 16 * 1024,
  code: 64,
  error: 300,
  offer: 200,
  items: 20,
  name: 80,
  userAgent: 512,
  priceCents: 100_000,
  totalCents: 2_000_000,
} as const;

const SKU = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const ORDER_ID = /^DH-\d{1,9}$/;
const TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

function invalid(message: string): DownhillError {
  return new DownhillError("invalid_request", message, 400);
}

/** One line of plain text: control characters become spaces, and it's cut to `max` characters. */
export function clip(value: string, max: number): string {
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function text(value: unknown, max: number, what: string, required: true): string;
function text(value: unknown, max: number, what: string, required?: false): string | undefined;
function text(value: unknown, max: number, what: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) throw invalid(`Send ${what} as text.`);
  return clip(value, max);
}

function cents(value: unknown, max: number, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) throw invalid(`Send ${what} as a whole number of cents from 0 to ${max}.`);
  return value;
}

function item(value: unknown): SupportItem {
  const line = record(value);
  if (!line || typeof line["sku"] !== "string" || !SKU.test(line["sku"])) throw invalid("Each item needs a sku: letters, digits, and dashes.");
  return { sku: line["sku"], name: text(line["name"], LIMITS.name, "each item's name", true), priceCents: cents(line["priceCents"], LIMITS.priceCents, "each item's priceCents") };
}

function order(value: unknown): SupportOrder | undefined {
  if (value === undefined) return undefined;
  const o = record(value);
  if (!o || typeof o["id"] !== "string" || !ORDER_ID.test(o["id"])) throw invalid("Send the order's id, such as DH-1042.");
  const paidAt = typeof o["paidAt"] === "string" && o["paidAt"].length <= 40 ? Date.parse(o["paidAt"]) : Number.NaN;
  if (Number.isNaN(paidAt)) throw invalid("Send the order's paidAt as a date and time.");
  return { id: o["id"], totalCents: cents(o["totalCents"], LIMITS.totalCents, "the order's totalCents"), paidAt: new Date(paidAt).toISOString() };
}

function checkoutOf(value: unknown): SupportCheckout | undefined {
  if (value === undefined) return undefined;
  const checkout = record(value);
  if (!checkout) throw invalid("Send checkout as what happened at checkout, or leave it out.");
  const items = checkout["items"];
  if (!Array.isArray(items) || items.length > LIMITS.items) throw invalid(`Send checkout.items as a list of at most ${LIMITS.items} items.`);
  const code = text(checkout["code"], LIMITS.code, "checkout.code");
  const error = text(checkout["error"], LIMITS.error, "checkout.error");
  const placed = order(checkout["order"]);
  return {
    ...(code ? { code } : {}),
    ...(error ? { error } : {}),
    offer: text(checkout["offer"], LIMITS.offer, "checkout.offer", true),
    items: items.map(item),
    subtotalCents: cents(checkout["subtotalCents"], LIMITS.totalCents, "checkout.subtotalCents"),
    ...(placed ? { order: placed } : {}),
  };
}

/** The game's request, checked: anything malformed is refused in plain words, and long text is cut short. */
export function parseSupportRequest(body: unknown): SupportRequest {
  const request = record(body);
  const player = record(request?.["player"]);
  const rider = player?.["rider"];
  if (typeof rider !== "string" || !Object.hasOwn(RIDER_NAMES, rider)) throw invalid(`Send player.rider: one of ${Object.keys(RIDER_NAMES).join(", ")}.`);
  const opener = request?.["opener"];
  if (typeof opener !== "string" || !(SUPPORT_OPENERS as readonly string[]).includes(opener)) throw invalid(`Send opener: one of ${SUPPORT_OPENERS.join(", ")}.`);
  const ticketId = request?.["ticketId"];
  if (ticketId !== undefined && (typeof ticketId !== "string" || !TICKET_ID.test(ticketId))) throw invalid("Send ticketId as the ticket's id, letters, digits, dashes, and underscores, or leave it out.");
  const checkout = checkoutOf(request?.["checkout"]);
  return { player: { rider: rider as RiderId }, opener: opener as SupportOpener, ...(ticketId ? { ticketId } : {}), ...(checkout ? { checkout } : {}) };
}

/** The ticket Help Desk gets: the request, the rider's name, the game's version, the browser, and when. */
export function playerTicket(request: SupportRequest, context: { version: string; userAgent: string | undefined; now?: Date }): PlayerTicket {
  return {
    product: "downhill",
    player: { name: RIDER_NAMES[request.player.rider], rider: request.player.rider },
    opener: request.opener,
    ...(request.ticketId ? { ticketId: request.ticketId } : {}),
    ...(request.checkout ? { checkout: request.checkout } : {}),
    gameVersion: context.version,
    userAgent: clip(context.userAgent ?? "", LIMITS.userAgent) || "unknown",
    at: (context.now ?? new Date()).toISOString(),
  };
}

/** What Downhill needs from Help Desk. Implemented by `HelpDesk`; faked in tests. */
export interface SupportDesk {
  /** `HELP_DESK_URL` is set. */
  readonly connected: boolean;
  /** Opens the player's ticket, or reopens the one they had; returns its chat, at Help Desk's address for the player. */
  openTicket(ticket: PlayerTicket): Promise<{ ticketId: string; chatUrl: string }>;
}

export class HelpDesk implements SupportDesk {
  readonly #url: string | undefined;
  readonly #publicUrl: string | undefined;
  readonly #fetch: typeof fetch;

  /** `url`: Help Desk's API for this server; `publicUrl`: its address in the player's browser (defaults to `url`). */
  constructor(url: string | undefined, publicUrl: string | undefined = url, fetcher: typeof fetch = fetch) {
    this.#url = baseUrl(url);
    this.#publicUrl = this.#url ? (baseUrl(publicUrl) ?? this.#url) : undefined;
    this.#fetch = fetcher;
  }

  get connected(): boolean {
    return this.#url !== undefined;
  }

  async openTicket(ticket: PlayerTicket): Promise<{ ticketId: string; chatUrl: string }> {
    const base = this.#url;
    const publicUrl = this.#publicUrl;
    if (!base || !publicUrl) throw new DownhillError("support_not_connected", SUPPORT_NOT_CONNECTED, 503);
    let response: Response;
    let body: string;
    try {
      response = await this.#fetch(`${base}/api/player-tickets`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(ticket),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      body = await response.text();
    } catch (error) {
      if ((error as Error).name === "TimeoutError") throw new DownhillError("support_timeout", `Help Desk didn't answer within ${TIMEOUT_MS / 1000} seconds. Try again in a moment.`, 504);
      throw new DownhillError("support_unreachable", `Help Desk didn't answer at ${base}. Check that it's running (\`aspire run\`), or set HELP_DESK_URL.`, 502);
    }
    let parsed: unknown;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const message = record(record(parsed)?.["error"])?.["message"];
      const said = typeof message === "string" && message.trim() ? clip(message, 300) : undefined;
      // Its messages are written for people: a refusal is shown as it is; an outage says whose it is.
      if (response.status < 500) throw new DownhillError("support_rejected", said ?? `Help Desk refused the ticket (HTTP ${response.status}).`, 502);
      throw new DownhillError("support_unavailable", said ? `Help Desk isn't available right now: ${said}` : `Help Desk isn't available right now (HTTP ${response.status}).`, 503);
    }
    const opened = record(parsed);
    const ticketId = opened?.["ticketId"];
    const chatPath = opened?.["chatPath"];
    // A path on Help Desk's own site: never another site's address.
    if (typeof ticketId !== "string" || !ticketId || typeof chatPath !== "string" || !/^\/(?!\/)[^\s\\]{0,2047}$/.test(chatPath)) {
      throw new DownhillError("support_error", "Help Desk opened the ticket but answered with something Downhill couldn't read.", 502);
    }
    return { ticketId, chatUrl: `${publicUrl}${chatPath}` };
  }
}
