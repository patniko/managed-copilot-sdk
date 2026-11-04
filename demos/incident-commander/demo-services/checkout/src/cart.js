import { isKnownCoupon } from "./coupons.js";
import { applyDiscount } from "./discounts.js";

export class CheckoutError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SHIPPING_CENTS = 599;
const FREE_SHIPPING_FROM_CENTS = 5000;

/** The sum of the items' prices, in cents. */
export function subtotal(items) {
  return items.reduce((sum, item) => {
    if (!Number.isInteger(item.priceCents) || item.priceCents < 0) throw new CheckoutError(400, `Invalid price for ${item.sku}.`);
    if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new CheckoutError(400, `Invalid quantity for ${item.sku}.`);
    return sum + item.priceCents * item.quantity;
  }, 0);
}

/** Prices a cart: subtotal, discount, shipping, and total, in cents. */
export function priceCart({ items, coupon }, now = new Date()) {
  if (!Array.isArray(items) || items.length === 0) throw new CheckoutError(400, "The cart is empty.");
  if (coupon && !isKnownCoupon(coupon)) throw new CheckoutError(400, `Unknown coupon ${coupon}.`);
  const before = subtotal(items);
  const after = applyDiscount(before, coupon, now);
  const shipping = after >= FREE_SHIPPING_FROM_CENTS ? 0 : SHIPPING_CENTS;
  return { subtotal: before, discount: before - after, shipping, total: after + shipping };
}
