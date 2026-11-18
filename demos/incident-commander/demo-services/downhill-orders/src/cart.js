import { isKnownCoupon } from "./coupons.js";
import { applyDiscount } from "./discounts.js";

export class CheckoutError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The sum of the items' prices, in cents. */
export function subtotal(items) {
  return items.reduce((sum, item) => {
    if (!Number.isInteger(item.priceCents) || item.priceCents < 0) throw new CheckoutError(400, `Invalid price for ${item.sku}.`);
    if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new CheckoutError(400, `Invalid quantity for ${item.sku}.`);
    return sum + item.priceCents * item.quantity;
  }, 0);
}

/** Prices a cart: subtotal, discount, and total, in cents. Looks are digital, so nothing ships. */
export function priceCart({ items, coupon }, now = new Date()) {
  if (!Array.isArray(items) || items.length === 0) throw new CheckoutError(400, "The cart is empty.");
  if (coupon && !isKnownCoupon(coupon)) throw new CheckoutError(400, `Unknown coupon ${coupon}.`);
  const before = subtotal(items);
  const after = applyDiscount(before, coupon, now);
  return { subtotal: before, discount: before - after, total: after };
}
