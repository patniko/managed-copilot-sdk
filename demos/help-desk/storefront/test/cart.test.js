import assert from "node:assert/strict";
import { test } from "node:test";
import { addItem, CartError, createCart, itemCount, removeItem, subtotalCents, updateQuantity } from "../src/cart.js";

const BOTTLE = { sku: "BTL-32", name: "Canyon Water Bottle 32 oz", priceCents: 2_400 };
const HEADLAMP = { sku: "LMP-400", name: "Lumen 400 Headlamp", priceCents: 3_900 };

test("adds products as lines and sums the subtotal", () => {
  const cart = addItem(addItem(createCart(), BOTTLE), HEADLAMP, 2);
  assert.deepEqual(
    cart.lines.map((line) => [line.sku, line.quantity]),
    [
      ["BTL-32", 1],
      ["LMP-400", 2],
    ],
  );
  assert.equal(itemCount(cart), 3);
  assert.equal(subtotalCents(cart), 10_200);
});

test("adding a product that's already in the cart adds to its line", () => {
  const cart = addItem(addItem(createCart(), BOTTLE), BOTTLE, 2);
  assert.equal(cart.lines.length, 1);
  assert.equal(cart.lines[0].quantity, 3);
});

test("removes a line", () => {
  const cart = removeItem(addItem(addItem(createCart(), BOTTLE), HEADLAMP), "BTL-32");
  assert.deepEqual(
    cart.lines.map((line) => line.sku),
    ["LMP-400"],
  );
});

test("setting a quantity to 0 removes the line", () => {
  const cart = updateQuantity(addItem(createCart(), BOTTLE), "BTL-32", 0);
  assert.deepEqual(cart.lines, []);
  assert.equal(subtotalCents(cart), 0);
});

test("accepts only the quantities the picker offers, for products in the cart", () => {
  const cart = addItem(createCart(), BOTTLE);
  assert.throws(() => updateQuantity(cart, "BTL-32", 11), CartError);
  assert.throws(() => updateQuantity(cart, "BTL-32", -1), CartError);
  assert.throws(() => updateQuantity(cart, "BTL-32", 1.5), CartError);
  assert.throws(() => updateQuantity(cart, "LMP-400", 1), { name: "CartError", message: "LMP-400 isn't in the cart." });
  assert.throws(() => addItem(cart, BOTTLE, 10), CartError);
});

test("leaves the cart it was given unchanged", () => {
  const cart = addItem(createCart(), BOTTLE);
  addItem(cart, HEADLAMP);
  addItem(cart, BOTTLE);
  removeItem(cart, "BTL-32");
  assert.deepEqual(cart.lines, [{ ...BOTTLE, quantity: 1 }]);
});
