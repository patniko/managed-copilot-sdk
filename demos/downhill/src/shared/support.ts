// The support contract: the game's request to Downhill's server, and the ticket the server sends Help Desk. Opening
// support only opens (or reopens) the player's ticket, with what happened at checkout: the player writes the first
// message themselves, in Help Desk's chat.

/** The riders, by id, with the names players know them by. */
export const RIDER_NAMES = { rider: "Rider", mona: "Mona", copilot: "Copilot" } as const;
export type RiderId = keyof typeof RIDER_NAMES;

/**
 * What the player opened support from: the Support button (title screen, pause menu, or shop), "Code not working?
 * Contact support" under checkout's message, or Contact support on a receipt without the discount.
 */
export const SUPPORT_OPENERS = ["support-button", "promo-error", "receipt"] as const;
export type SupportOpener = (typeof SUPPORT_OPENERS)[number];

export interface SupportItem {
  readonly sku: string;
  readonly name: string;
  readonly priceCents: number;
}

/** A purchase the player made anyway, without the discount. */
export interface SupportOrder {
  readonly id: string;
  readonly totalCents: number;
  readonly paidAt: string;
}

/** What happened at checkout: the offer, the last code the player tried and checkout's message, and the cart or order. */
export interface SupportCheckout {
  readonly code?: string;
  readonly error?: string;
  readonly offer: string;
  readonly items: readonly SupportItem[];
  readonly subtotalCents: number;
  readonly order?: SupportOrder;
}

/** The body of Downhill's `POST /api/support/tickets`, from the game in the browser. */
export interface SupportRequest {
  readonly player: { readonly rider: RiderId };
  readonly opener: SupportOpener;
  /** The ticket this browser session opened before: Help Desk reopens it while it's open, else opens a new one. */
  readonly ticketId?: string;
  /** What happened at checkout; left out until the player has tried a code or bought something. */
  readonly checkout?: SupportCheckout;
}

/** The body of Help Desk's `POST /api/player-tickets`, from Downhill's server. */
export interface PlayerTicket {
  readonly product: "downhill";
  readonly player: { readonly name: string; readonly rider: RiderId };
  readonly opener: SupportOpener;
  readonly ticketId?: string;
  readonly checkout?: SupportCheckout;
  readonly gameVersion: string;
  readonly userAgent: string;
  readonly at: string;
}

/** Downhill's answer to `POST /api/support/tickets`: the player's ticket, and its chat at Help Desk's address for them. */
export interface SupportTicketResponse {
  readonly ticketId: string;
  readonly chatUrl: string;
}

/** `GET /api/support`. */
export interface SupportStatus {
  readonly connected: boolean;
}

/** Every API error: a stable code and plain words. */
export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}
