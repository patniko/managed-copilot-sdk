# contoso-storefront

The code behind the Contoso Outdoors web store: the shopping cart, promotion codes at checkout, and the order status
customers see on **My orders**. Node 22 or later, ES modules, no dependencies.

- `src/cart.js`: the shopping cart. Adds products, sets quantities from the cart page's quantity picker, removes lines,
  and sums the subtotal. Carts are plain objects; every change returns a new cart.
- `src/promotions.js`: this month's promotion codes, and `applyPromoCode`, which checkout calls with the code from the
  **Promo code** field.
- `src/order-status.js`: `statusLabel`, the label **My orders** shows next to an order, from the carrier's tracking
  scans.
- `npm test`: the test suite (`node --test`).

Prices are in cents throughout.
