import type { PromoSource, ShopEventRequest } from '../../shared/shop';
import type { SupportOpener, SupportRequest } from '../../shared/support';
import type { BikePaint, CharacterId, RiderColors } from '../game/rider/types';
import { findItem, LAUNCH_OFFER, type ShopItem, type Slot } from './catalog';
import type { AppliedPromo, Cart, Product, Storefront } from './storefront';

/** What the player owns and wears, kept in localStorage. */
export interface ShopState {
  readonly owned: readonly string[];
  /** The item worn in each slot; an empty slot is the character's own look. */
  readonly equipped: Readonly<Partial<Record<Slot, string>>>;
  /** The rider you ride as. */
  readonly rider: CharacterId;
  /** The next order's number: orders read DH-1042, DH-1043, and so on. */
  readonly nextOrder: number;
}

/** A demo purchase: what was bought, what it cost, and the code that took money off, if one did. */
export interface Order {
  readonly id: string;
  readonly items: readonly Product[];
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly totalCents: number;
  readonly code?: string;
  readonly paidAt: string;
}

/** The last promotion code tried at checkout, where it came from, and what checkout said: the discount, or why not. */
export interface Promo {
  readonly code: string;
  readonly source: PromoSource;
  readonly applied?: AppliedPromo;
  readonly error?: string;
}

/** The cart and the promotion code, as checkout has them. */
export interface Checkout {
  readonly cart: Cart;
  readonly promo?: Promo;
}

export interface Totals {
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly totalCents: number;
}

export const SHOP_KEY = 'downhill.shop';
export const FIRST_ORDER = 1042;
const RIDERS: readonly CharacterId[] = ['rider', 'mona', 'copilot'];

export type ShopStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The browser's localStorage, or storage for this page only when the browser blocks it (purchases then last until reload). */
export function browserStorage(): ShopStorage {
  try {
    const storage = window.localStorage;
    storage.getItem(SHOP_KEY);
    return storage;
  } catch {
    const values = new Map<string, string>();
    return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value), removeItem: (key) => void values.delete(key) };
  }
}

export function emptyShop(): ShopState {
  return { owned: [], equipped: {}, rider: 'rider', nextOrder: FIRST_ORDER };
}

/** The saved shop, or an empty one when nothing readable is saved. Items the shop no longer sells are dropped. */
export function loadShop(storage: Pick<Storage, 'getItem'>): ShopState {
  let saved: unknown;
  try {
    saved = JSON.parse(storage.getItem(SHOP_KEY) ?? 'null');
  } catch {
    return emptyShop();
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return emptyShop();
  const s = saved as Record<string, unknown>;
  const owned = Array.isArray(s.owned) ? [...new Set(s.owned.filter((sku): sku is string => typeof sku === 'string' && findItem(sku) !== undefined))] : [];
  const equipped: Partial<Record<Slot, string>> = {};
  if (s.equipped && typeof s.equipped === 'object') {
    for (const [slot, sku] of Object.entries(s.equipped as Record<string, unknown>)) {
      const item = typeof sku === 'string' ? findItem(sku) : undefined;
      if (item && item.slot === slot && owned.includes(item.sku)) equipped[item.slot] = item.sku;
    }
  }
  const rider = RIDERS.find((id) => id === s.rider) ?? 'rider';
  const nextOrder = typeof s.nextOrder === 'number' && Number.isInteger(s.nextOrder) && s.nextOrder >= FIRST_ORDER ? s.nextOrder : FIRST_ORDER;
  return { owned, equipped, rider, nextOrder };
}

export function saveShop(storage: Pick<Storage, 'setItem'>, state: ShopState): void {
  try {
    storage.setItem(SHOP_KEY, JSON.stringify(state));
  } catch {
    // Storage is full or turned off: the shop still works until the page reloads.
  }
}

/** Wears an owned item. A rider's outfit also makes that rider the one you ride as, so the next ride shows it. */
export function equip(state: ShopState, sku: string): ShopState {
  const item = findItem(sku);
  if (!item || !state.owned.includes(sku)) return state;
  return { ...state, equipped: { ...state.equipped, [item.slot]: sku }, rider: item.slot === 'bike' ? state.rider : item.slot };
}

/** Back to the character's own look in that slot. */
export function unequip(state: ShopState, slot: Slot): ShopState {
  const equipped = { ...state.equipped };
  delete equipped[slot];
  return { ...state, equipped };
}

export function chooseRider(state: ShopState, rider: CharacterId): ShopState {
  return state.rider === rider ? state : { ...state, rider };
}

/** What a character wears: its equipped outfit and the equipped bike paint, when it has them. */
export function lookOf(state: ShopState, rider: CharacterId): { colors?: RiderColors; paint?: BikePaint } {
  const outfit = state.equipped[rider];
  const colors = outfit ? findItem(outfit)?.colors : undefined;
  const paint = state.equipped.bike ? findItem(state.equipped.bike)?.paint : undefined;
  return { ...(colors ? { colors } : {}), ...(paint ? { paint } : {}) };
}

export type ItemStatus = 'equipped' | 'owned' | 'in-cart' | 'for-sale';

export function itemStatus(state: ShopState, checkout: Checkout, sku: string): ItemStatus {
  const item = findItem(sku);
  if (item && state.equipped[item.slot] === sku) return 'equipped';
  if (state.owned.includes(sku)) return 'owned';
  return inCart(checkout, sku) ? 'in-cart' : 'for-sale';
}

/** An empty checkout. Carts are plain objects in the storefront's format: `{ lines: [] }` is an empty one. */
export function newCheckout(): Checkout {
  return { cart: { lines: [] } };
}

export function inCart(checkout: Checkout, sku: string): boolean {
  return checkout.cart.lines.some((line) => line.sku === sku);
}

/** Puts an item in the cart (once: it's a look, not a quantity). */
export function addToCart(storefront: Storefront, checkout: Checkout, item: ShopItem): Checkout {
  if (inCart(checkout, item.sku)) return checkout;
  return requote(storefront, { ...checkout, cart: storefront.addItem(checkout.cart, { sku: item.sku, name: item.name, priceCents: item.priceCents }) });
}

export function removeFromCart(storefront: Storefront, checkout: Checkout, sku: string): Checkout {
  return requote(storefront, { ...checkout, cart: storefront.removeItem(checkout.cart, sku) });
}

/** Applies a promotion code the way Contoso Outdoors' checkout does, and keeps its answer. */
export function applyCode(storefront: Storefront, checkout: Checkout, code: string, source: PromoSource): Checkout {
  return { ...checkout, promo: quote(storefront, code, source, storefront.subtotalCents(checkout.cart)) };
}

export function clearCode(checkout: Checkout): Checkout {
  return { cart: checkout.cart };
}

function quote(storefront: Storefront, code: string, source: PromoSource, subtotal: number): Promo {
  try {
    return { code, source, applied: storefront.applyPromoCode(code, subtotal) };
  } catch (error) {
    // The storefront's PromoError is the answer checkout shows; anything else is a failure in its code.
    if (error instanceof storefront.PromoError || (error as Error)?.name === 'PromoError') return { code, source, error: (error as Error).message };
    return { code, source, error: `Checkout couldn't check the code: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** An applied code is worked out again whenever the cart changes, so the discount always matches the subtotal. */
function requote(storefront: Storefront, checkout: Checkout): Checkout {
  const promo = checkout.promo;
  return promo?.applied ? { ...checkout, promo: quote(storefront, promo.code, promo.source, storefront.subtotalCents(checkout.cart)) } : checkout;
}

export function totals(storefront: Storefront, checkout: Checkout): Totals {
  const subtotal = storefront.subtotalCents(checkout.cart);
  const discount = checkout.promo?.applied?.discountCents ?? 0;
  return { subtotalCents: subtotal, discountCents: discount, totalCents: subtotal - discount };
}

/**
 * Buys what's in the cart. It's a demo purchase: nothing is charged. The order takes the next order number, and the
 * player owns and wears what they bought.
 */
export function purchase(storefront: Storefront, state: ShopState, checkout: Checkout, now: Date): { state: ShopState; order: Order } {
  const items = checkout.cart.lines.map(({ sku, name, priceCents }) => ({ sku, name, priceCents }));
  if (items.length === 0) throw new Error('The cart is empty.');
  const promo = checkout.promo?.applied ? checkout.promo : undefined;
  const order: Order = { id: `DH-${state.nextOrder}`, items, ...totals(storefront, checkout), ...(promo ? { code: promo.code } : {}), paidAt: now.toISOString() };
  let next: ShopState = { ...state, owned: [...new Set([...state.owned, ...items.map((item) => item.sku)])], nextOrder: state.nextOrder + 1 };
  for (const item of items) next = equip(next, item.sku);
  return { state: next, order };
}

/** What the sales ledger records for the code just tried: applied or rejected. */
export function promoEvent(storefront: Storefront, state: ShopState, checkout: Checkout): ShopEventRequest | undefined {
  const promo = checkout.promo;
  if (!promo) return undefined;
  const base = { rider: state.rider, skus: checkout.cart.lines.map((line) => line.sku), subtotalCents: storefront.subtotalCents(checkout.cart), code: promo.code, source: promo.source };
  if (promo.applied) return { ...base, type: 'promo_applied', discountCents: promo.applied.discountCents };
  return promo.error ? { ...base, type: 'promo_rejected', error: promo.error } : undefined;
}

/** What the sales ledger records for a purchase. */
export function purchaseEvent(state: ShopState, order: Order): ShopEventRequest {
  return {
    type: 'purchase',
    rider: state.rider,
    skus: order.items.map((item) => item.sku),
    subtotalCents: order.subtotalCents,
    orderId: order.id,
    discountCents: order.discountCents,
    totalCents: order.totalCents,
    ...(order.code ? { promoCode: order.code } : {}),
  };
}

/** What the shop remembers for support: the last code tried and checkout's answer, and the latest order. */
export interface CheckoutHistory {
  readonly promo?: Promo;
  readonly order?: Order;
}

/**
 * What support gets when the player opens it: who's riding, what they opened it from, and, once they've tried a code
 * or bought something, what happened at checkout. That's the last code and checkout's message, the cart (or the
 * latest order's items once the cart is empty), and the latest order.
 */
export function supportRequest(state: ShopState, opener: SupportOpener, checkout: Checkout, history: CheckoutHistory): Omit<SupportRequest, 'ticketId'> {
  const player = { rider: state.rider };
  const { promo, order } = history;
  if (!promo && !order) return { player, opener };
  const inCart = checkout.cart.lines.map(({ sku, name, priceCents }) => ({ sku, name, priceCents }));
  const fromOrder = !inCart.length && order;
  return {
    player,
    opener,
    checkout: {
      ...(promo ? { code: promo.code } : {}),
      ...(promo?.error ? { error: promo.error } : {}),
      offer: LAUNCH_OFFER.text,
      items: fromOrder ? order.items.map(({ sku, name, priceCents }) => ({ sku, name, priceCents })) : inCart,
      subtotalCents: fromOrder ? order.subtotalCents : checkout.cart.lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0),
      ...(order ? { order: { id: order.id, totalCents: order.totalCents, paidAt: order.paidAt } } : {}),
    },
  };
}
