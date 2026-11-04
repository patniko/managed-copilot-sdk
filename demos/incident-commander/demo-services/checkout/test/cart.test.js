import assert from "node:assert/strict";
import { test } from "node:test";
import { priceCart } from "../src/cart.js";

const NOW = new Date("2026-11-04T12:00:00Z");
const items = [
  { sku: "MUG-01", priceCents: 1800, quantity: 2 },
  { sku: "TEE-03", priceCents: 2500, quantity: 1 },
];

test("prices a cart without a coupon", () => {
  assert.deepEqual(priceCart({ items }, NOW), { subtotal: 6100, discount: 0, shipping: 0, total: 6100 });
});

test("applies a live coupon", () => {
  assert.deepEqual(priceCart({ items, coupon: "WELCOME10" }, NOW), { subtotal: 6100, discount: 610, shipping: 0, total: 5490 });
});

test("charges shipping below the free-shipping threshold", () => {
  assert.equal(priceCart({ items: [{ sku: "PIN-07", priceCents: 900, quantity: 1 }] }, NOW).shipping, 599);
});

test("rejects an unknown coupon", () => {
  assert.throws(() => priceCart({ items, coupon: "NOPE" }, NOW), { status: 400 });
});

test("rejects an empty cart", () => {
  assert.throws(() => priceCart({ items: [] }, NOW), { status: 400 });
});
