// Promotion codes. Customers get them from the Contoso Trail newsletter, the welcome email, and in-store signs, and
// enter them in the "Promo code" field at checkout, which calls applyPromoCode.

/** This month's codes. `minSubtotalCents`: the smallest subtotal a code applies to. */
export const PROMOTIONS = {
  TRAIL15: { percent: 15, description: "15% off everything, from the Contoso Trail newsletter" },
  WELCOME10: { percent: 10, description: "10% off a first order" },
  GEARUP20: { percent: 20, minSubtotalCents: 15_000, description: "20% off orders of $150 or more" },
};

/** Why checkout couldn't apply a code. Checkout shows the message under the "Promo code" field. */
export class PromoError extends Error {
  constructor(message) {
    super(message);
    this.name = "PromoError";
  }
}

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;

/**
 * Applies a promotion code to a cart's subtotal (cents). Returns the discount and what's left to pay, rounded to whole
 * cents; throws a PromoError when the code doesn't exist or the cart doesn't qualify for it.
 */
export function applyPromoCode(code, subtotalCents) {
  if (!Number.isInteger(subtotalCents) || subtotalCents < 0) throw new RangeError(`Invalid subtotal: ${subtotalCents}`);
  const promotion = Object.hasOwn(PROMOTIONS, code) ? PROMOTIONS[code] : undefined;
  if (!promotion) throw new PromoError("Invalid code.");
  if (promotion.minSubtotalCents && subtotalCents < promotion.minSubtotalCents) {
    throw new PromoError(`${code} applies to orders of ${dollars(promotion.minSubtotalCents)} or more.`);
  }
  const discountCents = Math.round((subtotalCents * promotion.percent) / 100);
  return { code, percent: promotion.percent, discountCents, totalCents: subtotalCents - discountCents };
}
