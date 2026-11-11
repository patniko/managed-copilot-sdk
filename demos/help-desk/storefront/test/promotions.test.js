import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPromoCode, PromoError } from "../src/promotions.js";

test("TRAIL15 takes 15% off", () => {
  assert.deepEqual(applyPromoCode("TRAIL15", 18_900), { code: "TRAIL15", percent: 15, discountCents: 2_835, totalCents: 16_065 });
});

test("WELCOME10 takes 10% off", () => {
  assert.deepEqual(applyPromoCode("WELCOME10", 5_900), { code: "WELCOME10", percent: 10, discountCents: 590, totalCents: 5_310 });
});

test("rounds discounts to whole cents", () => {
  assert.equal(applyPromoCode("TRAIL15", 2_399).discountCents, 360);
});

test("GEARUP20 applies from a $150 subtotal", () => {
  assert.equal(applyPromoCode("GEARUP20", 24_900).discountCents, 4_980);
  assert.throws(() => applyPromoCode("GEARUP20", 8_900), { name: "PromoError", message: "GEARUP20 applies to orders of $150.00 or more." });
});

test("rejects a code that doesn't exist", () => {
  assert.throws(() => applyPromoCode("SUMMER99", 5_000), PromoError);
  assert.throws(() => applyPromoCode("SUMMER99", 5_000), { message: "Invalid code." });
});

test("rejects a subtotal that isn't whole cents", () => {
  assert.throws(() => applyPromoCode("TRAIL15", 12.5), RangeError);
});
