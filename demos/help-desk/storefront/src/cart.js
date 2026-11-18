// The cart: what the shop's cart panel shows and checkout charges for. A cart is a plain object, and every change
// returns a new cart, so the shop can keep the previous one to undo a change.

/** A change the cart can't make. The shop shows the message next to the look. */
export class CartError extends Error {
  constructor(message) {
    super(message);
    this.name = "CartError";
  }
}

export function createCart() {
  return { lines: [] };
}

/** Adds a look (`{ sku, name, priceCents }`). A look is bought once: one that's already in the cart stays as it is. */
export function addItem(cart, product) {
  if (!Number.isInteger(product.priceCents) || product.priceCents < 0) throw new CartError(`Invalid price for ${product.sku}.`);
  const existing = cart.lines.find((line) => line.sku === product.sku);
  if (!existing) return { ...cart, lines: [...cart.lines, { sku: product.sku, name: product.name, priceCents: product.priceCents, quantity: 1 }] };
  return { ...cart, lines: cart.lines.map((line) => (line === existing ? { ...line, quantity: line.quantity + 1 } : line)) };
}

export function removeItem(cart, sku) {
  return { ...cart, lines: cart.lines.filter((line) => line.sku !== sku) };
}

/** How many looks the cart holds, for the cart icon's badge. */
export function itemCount(cart) {
  return cart.lines.reduce((count, line) => count + line.quantity, 0);
}

/** What the cart's looks cost together, in cents, before promotions. */
export function subtotalCents(cart) {
  return cart.lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);
}
