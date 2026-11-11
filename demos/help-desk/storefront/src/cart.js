// The shopping cart: what the cart page shows and checkout charges for. A cart is a plain object, and every change
// returns a new cart, so the page can keep the previous one to undo a change.

/** The most of one product a cart holds: the quantity picker offers 1 to 10. */
export const MAX_QUANTITY = 10;

/** A change the cart can't make. The cart page shows the message next to the line. */
export class CartError extends Error {
  constructor(message) {
    super(message);
    this.name = "CartError";
  }
}

export function createCart() {
  return { lines: [] };
}

function checkQuantity(quantity, min) {
  if (!Number.isInteger(quantity) || quantity < min || quantity > MAX_QUANTITY) throw new CartError(`Choose a quantity from ${min} to ${MAX_QUANTITY}.`);
}

/** Adds a product (`{ sku, name, priceCents }`). Adding a product that's already in the cart adds to its line. */
export function addItem(cart, product, quantity = 1) {
  checkQuantity(quantity, 1);
  const existing = cart.lines.find((line) => line.sku === product.sku);
  if (!existing) return { ...cart, lines: [...cart.lines, { sku: product.sku, name: product.name, priceCents: product.priceCents, quantity }] };
  checkQuantity(existing.quantity + quantity, 1);
  return { ...cart, lines: cart.lines.map((line) => (line === existing ? { ...line, quantity: line.quantity + quantity } : line)) };
}

/** Sets a line's quantity, as the quantity picker on the cart page does. 0 removes the line. */
export function updateQuantity(cart, sku, quantity) {
  checkQuantity(quantity, 0);
  const existing = cart.lines.find((line) => line.sku === sku);
  if (!existing) throw new CartError(`${sku} isn't in the cart.`);
  if (quantity === 0) return removeItem(cart, sku);
  return { ...cart, lines: cart.lines.map((line) => (line === existing ? { ...line, quantity: line.quantity + quantity } : line)) };
}

export function removeItem(cart, sku) {
  return { ...cart, lines: cart.lines.filter((line) => line.sku !== sku) };
}

/** How many items the cart holds, for the cart icon's badge. */
export function itemCount(cart) {
  return cart.lines.reduce((count, line) => count + line.quantity, 0);
}

/** What the cart's products cost together, in cents, before promotions and shipping. */
export function subtotalCents(cart) {
  return cart.lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);
}
