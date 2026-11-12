import { describe, expect, it } from 'vitest';
import * as cart from '../../../help-desk/storefront/src/cart.js';
import * as promotions from '../../../help-desk/storefront/src/promotions.js';
import { ITEMS, LAUNCH_OFFER, findItem } from '../../src/web/shop/catalog';
import {
  addToCart,
  applyCode,
  equip,
  itemStatus,
  loadShop,
  lookOf,
  newCheckout,
  promoEvent,
  purchase,
  purchaseEvent,
  removeFromCart,
  saveShop,
  SHOP_KEY,
  supportRequest,
  totals,
  type ShopState,
} from '../../src/web/shop/shop';
import { storefrontFrom, storefrontInfo } from '../../src/web/shop/storefront';

// Checkout runs Contoso Outdoors' storefront as it shipped (the server serves it to browsers at runtime).
const storefront = storefrontFrom({ version: '2.3.0', source: 'original', modules: { promotions: '', cart: '' } }, promotions, cart);
const item = (sku: string) => findItem(sku)!;
const NOW = new Date('2026-11-12T17:30:00.000Z');

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe('the Downhill Shop', () => {
  it('sells six to eight cosmetics for the riders and the bike, from $2.99 to $6.99', () => {
    expect(ITEMS.length).toBeGreaterThanOrEqual(6);
    expect(ITEMS.length).toBeLessThanOrEqual(8);
    expect(new Set(ITEMS.map((i) => i.slot))).toEqual(new Set(['rider', 'mona', 'copilot', 'bike']));
    for (const i of ITEMS) {
      expect(i.priceCents).toBeGreaterThanOrEqual(299);
      expect(i.priceCents).toBeLessThanOrEqual(699);
      expect(i.slot === 'bike' ? i.paint : i.colors).toBeTruthy();
    }
  });

  it("totals the cart with the storefront's cart code, one of each look", () => {
    let checkout = addToCart(storefront, addToCart(storefront, newCheckout(), item('mona-neon')), item('bike-lava'));
    checkout = addToCart(storefront, checkout, item('mona-neon'));
    expect(checkout.cart.lines.map((line) => [line.sku, line.quantity])).toEqual([
      ['mona-neon', 1],
      ['bike-lava', 1],
    ]);
    expect(totals(storefront, checkout)).toEqual({ subtotalCents: 898, discountCents: 0, totalCents: 898 });
    expect(totals(storefront, removeFromCart(storefront, checkout, 'bike-lava'))).toEqual({ subtotalCents: 499, discountCents: 0, totalCents: 499 });
  });

  it("shows checkout's answer for the banner's code, exactly as the banner offers it", () => {
    expect(LAUNCH_OFFER).toMatchObject({ code: 'trail15', text: 'Launch week: 15% off everything with code trail15' });
    const checkout = applyCode(storefront, addToCart(storefront, newCheckout(), item('mona-neon')), LAUNCH_OFFER.code, 'banner');
    expect(checkout.promo).toEqual({ code: 'trail15', source: 'banner', error: 'Invalid code.' });
    expect(totals(storefront, checkout)).toEqual({ subtotalCents: 499, discountCents: 0, totalCents: 499 });
  });

  it('takes 15% off with TRAIL15, worked out again when the cart changes', () => {
    let checkout = applyCode(storefront, addToCart(storefront, newCheckout(), item('mona-neon')), 'TRAIL15', 'typed');
    expect(checkout.promo?.applied).toMatchObject({ code: 'TRAIL15', percent: 15, discountCents: 75 });
    expect(totals(storefront, checkout)).toEqual({ subtotalCents: 499, discountCents: 75, totalCents: 424 });
    checkout = addToCart(storefront, checkout, item('copilot-stealth'));
    expect(totals(storefront, checkout)).toEqual({ subtotalCents: 1198, discountCents: 180, totalCents: 1018 });
  });

  it('runs whichever storefront it was given: a fixed one takes the banner code', () => {
    const fixed = storefrontFrom(storefront.info, { ...promotions, applyPromoCode: (code: string, subtotal: number) => promotions.applyPromoCode(code.trim().toUpperCase(), subtotal) }, cart);
    const checkout = applyCode(fixed, addToCart(fixed, newCheckout(), item('mona-neon')), LAUNCH_OFFER.code, 'banner');
    expect(checkout.promo).toMatchObject({ code: 'trail15', applied: { discountCents: 75 } });
    const broken = storefrontFrom(storefront.info, { ...promotions, applyPromoCode: () => (undefined as unknown as { x: number }).x }, cart);
    expect(applyCode(broken, checkout, 'trail15', 'banner').promo?.error).toMatch(/^Checkout couldn't check the code: /);
    expect(() => storefrontFrom(storefront.info, {}, cart)).toThrow("storefront v2.3.0's promotions.js has no applyPromoCode.");
  });

  it("says in plain words when the server doesn't say which storefront to run", async () => {
    // A bare page server answers /api/storefront with the game's page.
    const page = (async () => new Response('<!doctype html><title>Downhill</title>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    await expect(storefrontInfo(page)).rejects.toThrow("Downhill's server didn't say which storefront to run. Start the game with its server: pnpm dev, or aspire run.");
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(storefrontInfo(down)).rejects.toThrow("Couldn't reach Downhill's server.");
  });

  it('buys the cart: numbers the order, owns and wears what was bought, and keeps it in storage', () => {
    const storage = memoryStorage();
    const checkout = applyCode(storefront, addToCart(storefront, addToCart(storefront, newCheckout(), item('bike-aurora')), item('mona-neon')), 'trail15', 'banner');
    const { state, order } = purchase(storefront, loadShop(storage), checkout, NOW);
    expect(order).toEqual({
      id: 'DH-1042',
      items: [
        { sku: 'bike-aurora', name: 'Aurora Paint', priceCents: 599 },
        { sku: 'mona-neon', name: 'Neon Mona', priceCents: 499 },
      ],
      subtotalCents: 1098,
      discountCents: 0,
      totalCents: 1098,
      paidAt: '2026-11-12T17:30:00.000Z',
    });
    expect(state).toMatchObject({ equipped: { bike: 'bike-aurora', mona: 'mona-neon' }, rider: 'mona', nextOrder: 1043 });
    expect(itemStatus(state, newCheckout(), 'mona-neon')).toBe('equipped');
    expect(lookOf(state, 'mona')).toEqual({ colors: item('mona-neon').colors, paint: item('bike-aurora').paint });
    expect(lookOf(state, 'rider')).toEqual({ paint: item('bike-aurora').paint });

    saveShop(storage, state);
    const reloaded = loadShop(storage);
    expect(reloaded).toEqual(state);
    expect(purchase(storefront, reloaded, addToCart(storefront, newCheckout(), item('rider-sunset')), NOW).order.id).toBe('DH-1043');
    expect(() => purchase(storefront, reloaded, newCheckout(), NOW)).toThrow('The cart is empty.');
  });

  it('wears only what the player owns, and starts afresh from unreadable storage', () => {
    const state: ShopState = { owned: ['rider-sunset'], equipped: {}, rider: 'copilot', nextOrder: 1050 };
    expect(equip(state, 'mona-gold')).toBe(state);
    expect(equip(state, 'rider-sunset')).toMatchObject({ equipped: { rider: 'rider-sunset' }, rider: 'rider' });
    const storage = memoryStorage();
    storage.setItem(SHOP_KEY, '{"owned":["mona-neon","nope"],"equipped":{"mona":"mona-neon","bike":"bike-lava"},"rider":"ghost"}');
    expect(loadShop(storage)).toEqual({ owned: ['mona-neon'], equipped: { mona: 'mona-neon' }, rider: 'rider', nextOrder: 1042 });
    storage.setItem(SHOP_KEY, 'not json');
    expect(loadShop(storage)).toEqual({ owned: [], equipped: {}, rider: 'rider', nextOrder: 1042 });
  });

  it('tells the sales ledger what happened at checkout', () => {
    const state: ShopState = { owned: [], equipped: {}, rider: 'mona', nextOrder: 1042 };
    const cartWithMona = addToCart(storefront, newCheckout(), item('mona-neon'));
    expect(promoEvent(storefront, state, applyCode(storefront, cartWithMona, 'trail15', 'banner'))).toEqual({
      type: 'promo_rejected',
      rider: 'mona',
      skus: ['mona-neon'],
      subtotalCents: 499,
      code: 'trail15',
      source: 'banner',
      error: 'Invalid code.',
    });
    const applied = applyCode(storefront, cartWithMona, 'TRAIL15', 'typed');
    expect(promoEvent(storefront, state, applied)).toEqual({ type: 'promo_applied', rider: 'mona', skus: ['mona-neon'], subtotalCents: 499, code: 'TRAIL15', source: 'typed', discountCents: 75 });
    expect(purchaseEvent(state, purchase(storefront, state, applied, NOW).order)).toEqual({
      type: 'purchase',
      rider: 'mona',
      skus: ['mona-neon'],
      subtotalCents: 499,
      orderId: 'DH-1042',
      discountCents: 75,
      totalCents: 424,
      promoCode: 'TRAIL15',
    });
  });

  it("tells support what happened at checkout once the player has tried it: the last code, the cart or the order", () => {
    const state: ShopState = { owned: [], equipped: {}, rider: 'mona', nextOrder: 1042 };
    const neon = { sku: 'mona-neon', name: 'Neon Mona', priceCents: 499 };
    const inCart = addToCart(storefront, newCheckout(), item('mona-neon'));
    // Nothing tried yet: support opens with no checkout.
    expect(supportRequest(state, 'support-button', inCart, {})).toEqual({ player: { rider: 'mona' }, opener: 'support-button' });

    const rejected = applyCode(storefront, inCart, 'trail15', 'banner');
    expect(supportRequest(state, 'promo-error', rejected, { promo: rejected.promo })).toEqual({
      player: { rider: 'mona' },
      opener: 'promo-error',
      checkout: { code: 'trail15', error: 'Invalid code.', offer: LAUNCH_OFFER.text, items: [neon], subtotalCents: 499 },
    });

    // Bought anyway: the cart is empty, so support gets the order's items, and the code tried before it.
    const { order } = purchase(storefront, state, rejected, NOW);
    const afterOrder = { promo: rejected.promo, order };
    const paid = { id: 'DH-1042', totalCents: 499, paidAt: '2026-11-12T17:30:00.000Z' };
    expect(supportRequest(state, 'receipt', newCheckout(), afterOrder).checkout).toEqual({ code: 'trail15', error: 'Invalid code.', offer: LAUNCH_OFFER.text, items: [neon], subtotalCents: 499, order: paid });

    // A new attempt on a new cart: that cart, the newer code's answer, and the earlier order.
    const next = applyCode(storefront, addToCart(storefront, newCheckout(), item('bike-lava')), 'TRAIL15', 'typed');
    expect(supportRequest(state, 'support-button', next, { ...afterOrder, promo: next.promo }).checkout).toEqual({
      code: 'TRAIL15',
      offer: LAUNCH_OFFER.text,
      items: [{ sku: 'bike-lava', name: 'Lava Paint', priceCents: 399 }],
      subtotalCents: 399,
      order: paid,
    });
  });
});
