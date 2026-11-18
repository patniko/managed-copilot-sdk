import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPromoCode, PromoError } from "../src/promotions.js";

test("TRAIL15 takes 15% off", () => {
  assert.deepEqual(applyPromoCode("TRAIL15", 499), { code: "TRAIL15", percent: 15, discountCents: 75, totalCents: 424 });
});

test("WELCOME10 takes 10% off", () => {
  assert.deepEqual(applyPromoCode("WELCOME10", 699), { code: "WELCOME10", percent: 10, discountCents: 70, totalCents: 629 });
});

test("rounds discounts to whole cents", () => {
  assert.equal(applyPromoCode("TRAIL15", 399).discountCents, 60);
});

test("SET20 applies from a $10 subtotal", () => {
  assert.equal(applyPromoCode("SET20", 1_198).discountCents, 240);
  assert.throws(() => applyPromoCode("SET20", 898), { name: "PromoError", message: "SET20 applies to orders of $10.00 or more." });
});

test("rejects a code that doesn't exist", () => {
  assert.throws(() => applyPromoCode("FREELOOKS", 499), PromoError);
  assert.throws(() => applyPromoCode("FREELOOKS", 499), { message: "Invalid code." });
});

test("rejects a subtotal that isn't whole cents", () => {
  assert.throws(() => applyPromoCode("TRAIL15", 4.99), RangeError);
});
