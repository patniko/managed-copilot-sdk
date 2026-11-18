// The Downhill Shop's orders for one simulation, as Contoso Outdoors' support desk sees them. Every read and change takes
// the player it acts for: tools bound to one player's session can only ever reach that player's orders.
import { AVATAR_COLORS, type CustomerCard } from "../shared/types.js";
import { CUSTOMERS, ORDERS, PROMOTIONS, REFUND_ARRIVES_IN, REFUND_WINDOW_DAYS, type CustomerSeed, type OrderSeed } from "./seed.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Pending: the payment hasn't cleared, so the looks are still locked. Unlocked: paid, and in the game. */
type OrderStatus = "pending" | "unlocked" | "cancelled";

interface OrderState {
  readonly seed: OrderSeed;
  /** What its promotion code took off, in USD. */
  readonly discount: number;
  readonly total: number;
  status: OrderStatus;
  refunded: number;
  /** When the latest refund went through (minutes before the simulation started, for a seeded one). */
  refundedAt?: string;
}

export type ToolResult = Readonly<Record<string, unknown>>;

/** Whether a refund or cancellation would go through, and for how much (USD). */
export type Check = { readonly ok: true; readonly amount: number } | { readonly ok: false; readonly error: string };

const cents = (value: number): number => Math.round(value * 100) / 100;

/** `DH-20652`, `dh-20652`, `#20652`, and `20652` all name order DH-20652. */
export function normalizeOrderId(value: unknown): string {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim().toUpperCase().replace(/^#/, "").replace(/\s+/g, "") : "";
  return /^\d+$/.test(text) ? `DH-${text}` : text;
}

function emailOf(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z ]/g, "").trim().replace(/\s+/g, ".")}@example.com`;
}

function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] ?? ""}${parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : ""}`.toUpperCase();
}

const looks = (order: OrderState): string => order.seed.lines.map((line) => (line.quantity > 1 ? `${line.product} ×${line.quantity}` : line.product)).join(", ");

export class Shop {
  #startedAt: Date;
  #orders = new Map<string, OrderState>();
  /** Results of refunds and cancellations already made, by tool call: a repeated call changes nothing again. */
  #applied = new Map<string, ToolResult>();

  constructor(startedAt = new Date()) {
    this.#startedAt = startedAt;
    this.reset(startedAt);
  }

  /** Fresh data for a new simulation that starts at `startedAt`. */
  reset(startedAt: Date): void {
    this.#startedAt = startedAt;
    this.#applied = new Map();
    this.#orders = new Map(
      ORDERS.map((seed) => {
        const subtotal = seed.lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
        const discount = cents((subtotal * (seed.promoCode ? (PROMOTIONS[seed.promoCode]?.percent ?? 0) : 0)) / 100);
        const total = cents(subtotal - discount);
        const refunded = seed.refundedMinutesAgo !== undefined;
        return [
          seed.id,
          {
            seed,
            discount,
            total,
            status: seed.payment.clears ? "pending" : "unlocked",
            refunded: refunded ? total : 0,
            ...(refunded ? { refundedAt: this.time(seed.refundedMinutesAgo!) } : {}),
          },
        ];
      }),
    );
  }

  get startedAt(): Date {
    return this.#startedAt;
  }

  /** ISO date `days` after the simulation started (negative: before). */
  date(days: number): string {
    return new Date(this.#startedAt.getTime() + days * DAY_MS).toISOString().slice(0, 10);
  }

  /** The time `minutesAgo` minutes before the simulation started, to the minute: `2026-11-12T17:31Z`. */
  time(minutesAgo: number): string {
    return `${new Date(this.#startedAt.getTime() - minutesAgo * MINUTE_MS).toISOString().slice(0, 16)}Z`;
  }

  customer(id: string): CustomerSeed | undefined {
    return CUSTOMERS.find((customer) => customer.id === id);
  }

  customers(): CustomerCard[] {
    return CUSTOMERS.map((customer, index) => ({
      id: customer.id,
      name: customer.name,
      initials: initialsOf(customer.name),
      color: AVATAR_COLORS[index % AVATAR_COLORS.length]!,
      email: emailOf(customer.name),
      memberSince: customer.memberSince,
      orderIds: ORDERS.filter((order) => order.customerId === customer.id).map((order) => order.id),
      opening: customer.opening,
    }));
  }

  /** The customer an order belongs to, if it exists. */
  ownerOf(orderId: unknown): string | undefined {
    return this.#orders.get(normalizeOrderId(orderId))?.seed.customerId;
  }

  /** One of this customer's orders. Another customer's order is answered exactly like one that doesn't exist. */
  #own(customerId: string, orderId: unknown): OrderState | undefined {
    const order = this.#orders.get(normalizeOrderId(orderId));
    return order?.seed.customerId === customerId ? order : undefined;
  }

  #missing(orderId: unknown): ToolResult {
    const id = normalizeOrderId(orderId);
    return { ok: false, error: id ? `No order ${id} on this account.` : "Name an order number, such as DH-20652." };
  }

  #statusText(order: OrderState): string {
    switch (order.status) {
      case "pending":
        return `payment pending (the looks unlock when it clears, usually in ${order.seed.payment.clears})`;
      case "cancelled":
        return "cancelled";
      case "unlocked":
        if (order.refunded >= order.total) return "refunded (the looks are locked again)";
        return order.refunded > 0 ? "unlocked, partly refunded" : "unlocked";
    }
  }

  /**
   * The label the player's My purchases page shows, worked out the way the storefront's code does it
   * (`storefront/src/purchase-status.js`, `statusLabel`), bug included: it matches /unlock/i in the payment provider's
   * latest event, so a bank transfer still "Waiting to unlock" shows as Unlocked. The agent compares it with the order's
   * real status.
   */
  #myPurchasesLabel(order: OrderState): string {
    if (order.status === "cancelled") return "Cancelled";
    if (order.refunded >= order.total) return "Refunded";
    const latest = order.seed.payment.events.at(-1)?.description ?? "";
    if (/refund/i.test(latest)) return "Refunded";
    if (/unlock/i.test(latest)) return "Unlocked";
    if (/pending|held|review/i.test(latest)) return "Pending";
    return "Processing";
  }

  #payment(order: OrderState): ToolResult {
    const payment = order.seed.payment;
    if (order.status === "cancelled") return { paymentMethod: payment.method, note: "Cancelled before the payment cleared: nothing was charged." };
    if (order.status === "pending") return { paymentMethod: payment.method, unlocksWhenPaymentClears: `usually in ${payment.clears}` };
    return { paymentMethod: payment.method, unlocked: this.time(order.seed.placedMinutesAgo) };
  }

  listOrders(customerId: string): ToolResult {
    const orders = [...this.#orders.values()]
      .filter((order) => order.seed.customerId === customerId)
      .sort((a, b) => a.seed.placedMinutesAgo - b.seed.placedMinutesAgo)
      .map((order) => ({
        orderId: order.seed.id,
        placed: this.time(order.seed.placedMinutesAgo),
        looks: looks(order),
        total: order.total,
        status: this.#statusText(order),
        shownOnMyPurchasesPage: this.#myPurchasesLabel(order),
      }));
    return { now: this.time(0), orders };
  }

  getOrder(customerId: string, orderId: unknown): ToolResult {
    const order = this.#own(customerId, orderId);
    if (!order) return this.#missing(orderId);
    return {
      orderId: order.seed.id,
      placed: this.time(order.seed.placedMinutesAgo),
      status: this.#statusText(order),
      shownOnMyPurchasesPage: this.#myPurchasesLabel(order),
      items: order.seed.lines.map((line) => ({ look: line.product, fits: line.fits, quantity: line.quantity, price: line.price })),
      ...(order.discount > 0 ? { promoCode: order.seed.promoCode, discount: order.discount } : {}),
      total: order.total,
      ...(order.refunded > 0 ? { refunded: order.refunded, refundedAt: order.refundedAt } : {}),
      ...this.#payment(order),
    };
  }

  /** The payment provider's events for an order, and when its looks unlock: the order's history. */
  checkUnlock(customerId: string, orderId: unknown): ToolResult {
    const order = this.#own(customerId, orderId);
    if (!order) return this.#missing(orderId);
    const events = order.seed.payment.events.map((event) => ({ at: this.time(event.minutesAgo), description: event.description }));
    return { orderId: order.seed.id, status: this.#statusText(order), shownOnMyPurchasesPage: this.#myPurchasesLabel(order), ...this.#payment(order), events };
  }

  checkRefund(customerId: string, orderId: unknown, amount?: unknown): Check {
    const order = this.#own(customerId, orderId);
    if (!order) return { ok: false, error: (this.#missing(orderId) as { error: string }).error };
    if (order.status === "cancelled") return { ok: false, error: "This order was cancelled before its payment cleared, so nothing was charged." };
    if (order.status === "pending") return { ok: false, error: "This order's payment hasn't cleared yet, so there's nothing to refund. Cancel it instead." };
    const minutes = order.seed.placedMinutesAgo;
    if (minutes > REFUND_WINDOW_DAYS * 24 * 60) {
      return { ok: false, error: `Bought on ${this.time(minutes).slice(0, 10)}. Looks can be refunded within ${REFUND_WINDOW_DAYS} days of purchase.` };
    }
    const remaining = cents(order.total - order.refunded);
    if (remaining <= 0) return { ok: false, error: `This order was refunded in full already, at ${order.refundedAt}. Refunds reach the original payment method in ${REFUND_ARRIVES_IN}.` };
    if (amount === undefined || amount === null) return { ok: true, amount: remaining };
    const requested = typeof amount === "number" ? cents(amount) : Number.NaN;
    if (!Number.isFinite(requested) || requested <= 0) return { ok: false, error: "The refund amount must be a positive number of dollars." };
    if (requested > remaining) return { ok: false, error: `At most $${remaining.toFixed(2)} of this order can be refunded.` };
    return { ok: true, amount: requested };
  }

  /** Refunds a paid order (in part when `amount` is given). `effectId` makes a repeated call change nothing again. */
  refund(customerId: string, orderId: unknown, amount: unknown, effectId: string): ToolResult {
    const done = this.#applied.get(effectId);
    if (done) return done;
    const check = this.checkRefund(customerId, orderId, amount);
    if (!check.ok) return { ok: false, error: check.error };
    const order = this.#own(customerId, orderId)!;
    order.refunded = cents(order.refunded + check.amount);
    order.refundedAt = this.time(0);
    const result = { ok: true, orderId: order.seed.id, refunded: check.amount, to: "the original payment method", arrivesIn: REFUND_ARRIVES_IN };
    this.#applied.set(effectId, result);
    return result;
  }

  checkCancel(customerId: string, orderId: unknown): Check {
    const order = this.#own(customerId, orderId);
    if (!order) return { ok: false, error: (this.#missing(orderId) as { error: string }).error };
    if (order.status === "cancelled") return { ok: false, error: "This order is cancelled already." };
    if (order.status === "unlocked") return { ok: false, error: `Already paid and unlocked, so it can't be cancelled. It can be refunded within ${REFUND_WINDOW_DAYS} days of purchase.` };
    return { ok: true, amount: order.total };
  }

  /** Cancels an order whose payment hasn't cleared: nothing is charged. `effectId` makes a repeated call change nothing again. */
  cancel(customerId: string, orderId: unknown, effectId: string): ToolResult {
    const done = this.#applied.get(effectId);
    if (done) return done;
    const check = this.checkCancel(customerId, orderId);
    if (!check.ok) return { ok: false, error: check.error };
    const order = this.#own(customerId, orderId)!;
    order.status = "cancelled";
    const result = { ok: true, orderId: order.seed.id, status: "cancelled", refunded: check.amount, note: "The pending payment is voided: nothing is charged." };
    this.#applied.set(effectId, result);
    return result;
  }

  /**
   * A problem with the Downhill Shop the customer reports, for the engineering team. The order it names, if any, must be
   * the customer's own: another customer's order is answered exactly like one that doesn't exist.
   */
  reportBug(customerId: string, report: { readonly area: string; readonly orderId?: string | undefined }): ToolResult {
    const order = report.orderId === undefined ? undefined : this.#own(customerId, report.orderId);
    if (report.orderId !== undefined && !order) return this.#missing(report.orderId);
    return { ok: true, area: report.area, ...(order ? { orderId: order.seed.id } : {}), sentTo: "the engineering team" };
  }
}
