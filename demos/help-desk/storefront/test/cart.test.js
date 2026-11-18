import assert from "node:assert/strict";
import { test } from "node:test";
import { addItem, CartError, createCart, itemCount, removeItem, subtotalCents } from "../src/cart.js";

const NEON_MONA = { sku: "mona-neon", name: "Neon Mona", priceCents: 499 };
const LAVA_PAINT = { sku: "bike-lava", name: "Lava Paint", priceCents: 399 };

test("adds looks as lines and sums the subtotal", () => {
  const cart = addItem(addItem(createCart(), NEON_MONA), LAVA_PAINT);
  assert.deepEqual(
    cart.lines.map((line) => [line.sku, line.quantity]),
    [
      ["mona-neon", 1],
      ["bike-lava", 1],
    ],
  );
  assert.equal(itemCount(cart), 2);
  assert.equal(subtotalCents(cart), 898);
});

test("removes a look", () => {
  const cart = removeItem(addItem(addItem(createCart(), NEON_MONA), LAVA_PAINT), "mona-neon");
  assert.deepEqual(
    cart.lines.map((line) => line.sku),
    ["bike-lava"],
  );
  assert.equal(subtotalCents(cart), 399);
});

test("refuses a look without a price in whole cents", () => {
  assert.throws(() => addItem(createCart(), { ...NEON_MONA, priceCents: 4.99 }), CartError);
  assert.throws(() => addItem(createCart(), { ...NEON_MONA, priceCents: -1 }), { name: "CartError", message: "Invalid price for mona-neon." });
});

test("leaves the cart it was given unchanged", () => {
  const cart = addItem(createCart(), NEON_MONA);
  addItem(cart, LAVA_PAINT);
  removeItem(cart, "mona-neon");
  assert.deepEqual(cart.lines, [{ ...NEON_MONA, quantity: 1 }]);
});
