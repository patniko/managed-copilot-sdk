# checkout-service

Prices carts and takes orders for the storefront. Node 24, no dependencies.

- `src/server.js`: the HTTP API (`POST /checkout`, `GET /health`) and its request log.
- `src/cart.js`: prices a cart. `src/discounts.js` and `src/coupons.js`: promotion codes.
- `npm test`: the test suite (`node --test`).
- `logs/checkout.log`: production logs in logfmt, oldest first. Failed requests are followed by their stack trace.
- `deploys/HISTORY.md`: production deploys. `deploys/<version>.diff`: what a deploy changed.
