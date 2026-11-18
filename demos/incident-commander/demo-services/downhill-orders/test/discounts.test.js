import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDiscount, findCoupon } from "../src/discounts.js";

const NOW = new Date("2026-11-04T12:00:00Z");

test("finds a live coupon, in any case", () => {
  assert.equal(findCoupon("welcome10", NOW)?.percent, 10);
});

test("doesn't return an expired coupon", () => {
  assert.equal(findCoupon("EARLYRIDER", NOW), undefined);
});

test("takes a percentage off", () => {
  assert.equal(applyDiscount(1_000, "TRAIL15", NOW), 850);
});

test("leaves the subtotal alone without a code", () => {
  assert.equal(applyDiscount(1_000, undefined, NOW), 1_000);
});
