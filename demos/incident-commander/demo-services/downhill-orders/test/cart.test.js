import assert from "node:assert/strict";
import { test } from "node:test";
import { priceCart } from "../src/cart.js";

const NOW = new Date("2026-11-04T12:00:00Z");
const items = [
  { sku: "mona-neon", priceCents: 499, quantity: 1 },
  { sku: "bike-lava", priceCents: 399, quantity: 1 },
];

test("prices a cart without a coupon", () => {
  assert.deepEqual(priceCart({ items }, NOW), { subtotal: 898, discount: 0, total: 898 });
});

test("applies a live coupon", () => {
  assert.deepEqual(priceCart({ items, coupon: "WELCOME10" }, NOW), { subtotal: 898, discount: 90, total: 808 });
});

test("rejects an unknown coupon", () => {
  assert.throws(() => priceCart({ items, coupon: "FREELOOKS" }, NOW), { status: 400 });
});

test("rejects an empty cart", () => {
  assert.throws(() => priceCart({ items: [] }, NOW), { status: 400 });
});
