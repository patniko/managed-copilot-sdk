import { COUPONS } from "./coupons.js";

/** The coupon for a code, if it exists and hasn't expired. */
export function findCoupon(code, now = new Date()) {
  const coupon = COUPONS[code.toUpperCase()];
  if (!coupon || Date.parse(coupon.expiresAt) < now.getTime()) return undefined;
  return coupon;
}

/** The subtotal after a coupon, in cents. The cart has already checked that the code exists. */
export function applyDiscount(subtotalCents, code, now = new Date()) {
  if (!code) return subtotalCents;
  const coupon = findCoupon(code, now);
  return subtotalCents - Math.round((subtotalCents * coupon.percent) / 100);
}
