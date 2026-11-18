# contoso-storefront

The Downhill Shop's checkout code: the cart, promotion codes at checkout, and the purchase status players see on **My
purchases**. Contoso Outdoors' game, Downhill, imports the cart and the promotion codes in the browser. Node 22 or
later, ES modules, no dependencies.

- `src/cart.js`: the cart. Adds looks, removes them, and sums the subtotal. A look is bought once. Carts are plain
  objects; every change returns a new cart.
- `src/promotions.js`: the shop's promotion codes, and `applyPromoCode`, which checkout calls with the code from the
  **Promo code** field.
- `src/purchase-status.js`: `statusLabel`, the label **My purchases** shows next to an order, from the payment
  provider's events.
- `npm test`: the test suite (`node --test`).

Prices are in cents throughout.
