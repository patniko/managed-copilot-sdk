// The demo store's data for one simulation. Every read and change takes the customer it acts for: tools bound to one
// customer's session can only ever reach that customer's orders.
import { AVATAR_COLORS, type CustomerCard } from "../shared/types.js";
import { CUSTOMERS, ORDERS, REFUND_WINDOW_DAYS, type CustomerSeed, type OrderSeed } from "./seed.js";

const DAY_MS = 86_400_000;

type OrderStatus = "processing" | "in_transit" | "delivered" | "cancelled";

interface OrderState {
  readonly seed: OrderSeed;
  readonly total: number;
  status: OrderStatus;
  refunded: number;
}

export type ToolResult = Readonly<Record<string, unknown>>;

/** Whether a refund or cancellation would go through, and for how much (USD). */
export type Check = { readonly ok: true; readonly amount: number } | { readonly ok: false; readonly error: string };

const cents = (value: number): number => Math.round(value * 100) / 100;

/** `CO-48213`, `co-48213`, `#48213`, and `48213` all name order CO-48213. */
export function normalizeOrderId(value: unknown): string {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim().toUpperCase().replace(/^#/, "").replace(/\s+/g, "") : "";
  return /^\d+$/.test(text) ? `CO-${text}` : text;
}

function emailOf(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z ]/g, "").trim().replace(/\s+/g, ".")}@example.com`;
}

function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] ?? ""}${parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : ""}`.toUpperCase();
}

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
      ORDERS.map((seed) => [
        seed.id,
        {
          seed,
          total: cents(seed.lines.reduce((sum, line) => sum + line.price * line.quantity, 0)),
          status: seed.shipment.kind === "processing" ? "processing" : seed.shipment.kind === "transit" ? "in_transit" : "delivered",
          refunded: 0,
        },
      ]),
    );
  }

  get startedAt(): Date {
    return this.#startedAt;
  }

  /** ISO date `days` after the simulation started (negative: before). */
  date(days: number): string {
    return new Date(this.#startedAt.getTime() + days * DAY_MS).toISOString().slice(0, 10);
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
    return { ok: false, error: id ? `No order ${id} on this account.` : "Name an order number, such as CO-48213." };
  }

  #statusText(order: OrderState): string {
    switch (order.status) {
      case "processing":
        return "processing (not shipped yet)";
      case "in_transit":
        return order.seed.shipment.kind === "transit" && order.seed.shipment.delay ? "in transit, delayed" : "in transit";
      case "cancelled":
        return "cancelled";
      case "delivered":
        if (order.refunded >= order.total) return "delivered, refunded";
        return order.refunded > 0 ? "delivered, partly refunded" : "delivered";
    }
  }

  #shipping(order: OrderState): ToolResult | undefined {
    const shipment = order.seed.shipment;
    if (order.status === "cancelled") return undefined;
    switch (shipment.kind) {
      case "processing":
        return { shipsBy: this.date(shipment.shipsInDays) };
      case "transit":
        return { carrier: shipment.carrier, trackingNumber: shipment.tracking, estimatedDelivery: this.date(shipment.etaInDays), ...(shipment.delay ? { delay: shipment.delay } : {}) };
      case "delivered":
        return { carrier: shipment.carrier, trackingNumber: shipment.tracking, deliveredOn: this.date(-shipment.deliveredDaysAgo) };
    }
  }

  listOrders(customerId: string): ToolResult {
    const orders = [...this.#orders.values()]
      .filter((order) => order.seed.customerId === customerId)
      .sort((a, b) => a.seed.placedDaysAgo - b.seed.placedDaysAgo)
      .map((order) => ({
        orderId: order.seed.id,
        placed: this.date(-order.seed.placedDaysAgo),
        items: order.seed.lines.map((line) => (line.quantity > 1 ? `${line.product} ×${line.quantity}` : line.product)).join(", "),
        total: order.total,
        status: this.#statusText(order),
      }));
    return { today: this.date(0), orders };
  }

  getOrder(customerId: string, orderId: unknown): ToolResult {
    const order = this.#own(customerId, orderId);
    if (!order) return this.#missing(orderId);
    const shipping = this.#shipping(order);
    return {
      orderId: order.seed.id,
      placed: this.date(-order.seed.placedDaysAgo),
      status: this.#statusText(order),
      items: order.seed.lines.map((line) => ({ product: line.product, quantity: line.quantity, price: line.price })),
      total: order.total,
      ...(order.refunded > 0 ? { refunded: order.refunded } : {}),
      ...(shipping ? { shipping } : {}),
    };
  }

  trackShipment(customerId: string, orderId: unknown): ToolResult {
    const order = this.#own(customerId, orderId);
    if (!order) return this.#missing(orderId);
    const shipment = order.seed.shipment;
    const base = { orderId: order.seed.id, status: this.#statusText(order) };
    if (order.status === "cancelled") return { ...base, note: "Cancelled before it shipped." };
    if (shipment.kind === "processing") return { ...base, shipsBy: this.date(shipment.shipsInDays), note: "Not shipped yet, so it has no tracking number." };
    const events = shipment.events.map((event) => ({ date: this.date(-event.daysAgo), location: event.location, description: event.description }));
    return { ...base, ...this.#shipping(order), events };
  }

  checkRefund(customerId: string, orderId: unknown, amount?: unknown): Check {
    const order = this.#own(customerId, orderId);
    if (!order) return { ok: false, error: (this.#missing(orderId) as { error: string }).error };
    const shipment = order.seed.shipment;
    if (order.status === "cancelled") return { ok: false, error: "This order was cancelled and refunded already." };
    if (order.status === "processing") return { ok: false, error: "This order hasn't shipped yet. Cancel it instead." };
    if (order.status === "in_transit" || shipment.kind !== "delivered") return { ok: false, error: "This order hasn't been delivered yet. It can be refunded once it arrives." };
    if (shipment.deliveredDaysAgo > REFUND_WINDOW_DAYS) {
      return { ok: false, error: `Delivered ${shipment.deliveredDaysAgo} days ago, on ${this.date(-shipment.deliveredDaysAgo)}. Refunds are possible within ${REFUND_WINDOW_DAYS} days of delivery.` };
    }
    const remaining = cents(order.total - order.refunded);
    if (remaining <= 0) return { ok: false, error: "This order was refunded in full already." };
    if (amount === undefined || amount === null) return { ok: true, amount: remaining };
    const requested = typeof amount === "number" ? cents(amount) : Number.NaN;
    if (!Number.isFinite(requested) || requested <= 0) return { ok: false, error: "The refund amount must be a positive number of dollars." };
    if (requested > remaining) return { ok: false, error: `At most $${remaining.toFixed(2)} of this order can be refunded.` };
    return { ok: true, amount: requested };
  }

  /** Refunds a delivered order (in part when `amount` is given). `effectId` makes a repeated call change nothing again. */
  refund(customerId: string, orderId: unknown, amount: unknown, effectId: string): ToolResult {
    const done = this.#applied.get(effectId);
    if (done) return done;
    const check = this.checkRefund(customerId, orderId, amount);
    if (!check.ok) return { ok: false, error: check.error };
    const order = this.#own(customerId, orderId)!;
    order.refunded = cents(order.refunded + check.amount);
    const result = { ok: true, orderId: order.seed.id, refunded: check.amount, to: "the original payment method", arrivesIn: "3 to 5 business days" };
    this.#applied.set(effectId, result);
    return result;
  }

  checkCancel(customerId: string, orderId: unknown): Check {
    const order = this.#own(customerId, orderId);
    if (!order) return { ok: false, error: (this.#missing(orderId) as { error: string }).error };
    const shipment = order.seed.shipment;
    if (order.status === "cancelled") return { ok: false, error: "This order is cancelled already." };
    if (order.status === "in_transit" && shipment.kind === "transit") {
      return { ok: false, error: `Already shipped with ${shipment.carrier}, so it can't be cancelled. It can be refunded within ${REFUND_WINDOW_DAYS} days of delivery.` };
    }
    if (order.status === "delivered") return { ok: false, error: "Already delivered. Ask for a refund instead." };
    return { ok: true, amount: cents(order.total - order.refunded) };
  }

  /** Cancels an order that hasn't shipped and refunds it. `effectId` makes a repeated call change nothing again. */
  cancel(customerId: string, orderId: unknown, effectId: string): ToolResult {
    const done = this.#applied.get(effectId);
    if (done) return done;
    const check = this.checkCancel(customerId, orderId);
    if (!check.ok) return { ok: false, error: check.error };
    const order = this.#own(customerId, orderId)!;
    order.status = "cancelled";
    order.refunded = order.total;
    const result = { ok: true, orderId: order.seed.id, status: "cancelled", refunded: check.amount, to: "the original payment method" };
    this.#applied.set(effectId, result);
    return result;
  }
}
