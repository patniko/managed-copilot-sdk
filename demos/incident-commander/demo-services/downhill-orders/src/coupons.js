// Promotion codes. Expired codes stay listed so receipts and refunds can still name them.
export const COUPONS = {
  WELCOME10: { percent: 10, expiresAt: "2099-12-31T23:59:59Z" },
  TRAIL15: { percent: 15, expiresAt: "2099-12-31T23:59:59Z" },
  // The pre-registration reward and the open beta's thank-you: both ended before launch.
  EARLYRIDER: { percent: 20, expiresAt: "2026-11-01T00:00:00Z" },
  BETA25: { percent: 25, expiresAt: "2026-10-31T23:59:59Z" },
};

/** Whether a code exists at all, expired or not. */
export function isKnownCoupon(code) {
  return Object.hasOwn(COUPONS, code.toUpperCase());
}
