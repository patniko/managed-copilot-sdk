// Promotion codes. Expired codes stay listed so receipts and refunds can still name them.
export const COUPONS = {
  WELCOME10: { percent: 10, expiresAt: "2099-12-31T23:59:59Z" },
  LOYAL15: { percent: 15, expiresAt: "2099-12-31T23:59:59Z" },
  SUMMER24: { percent: 20, expiresAt: "2024-09-30T23:59:59Z" },
  SPRING25: { percent: 15, expiresAt: "2025-05-31T23:59:59Z" },
};

/** Whether a code exists at all, expired or not. */
export function isKnownCoupon(code) {
  return Object.hasOwn(COUPONS, code.toUpperCase());
}
