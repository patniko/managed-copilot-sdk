// The storefront code checkout runs: whatever version Downhill's server says it runs now (`GET /api/storefront`),
// imported at runtime from the server. Until a fix is deployed, that's Contoso Outdoors' storefront as it shipped.
import type { StorefrontInfo } from '../../shared/shop';

export interface Product {
  readonly sku: string;
  readonly name: string;
  readonly priceCents: number;
}

export interface CartLine extends Product {
  readonly quantity: number;
}

export interface Cart {
  readonly lines: readonly CartLine[];
}

/** What checkout charges after a promotion code: the discount and what's left to pay, in cents. */
export interface AppliedPromo {
  readonly code: string;
  readonly percent: number;
  readonly discountCents: number;
  readonly totalCents: number;
}

/** The storefront's cart and promotion functions, from one version of its code. */
export interface Storefront {
  readonly info: StorefrontInfo;
  readonly createCart: () => Cart;
  readonly addItem: (cart: Cart, product: Product, quantity?: number) => Cart;
  readonly removeItem: (cart: Cart, sku: string) => Cart;
  readonly subtotalCents: (cart: Cart) => number;
  /** Throws a `PromoError` when the code doesn't exist or doesn't apply. */
  readonly applyPromoCode: (code: string, subtotalCents: number) => AppliedPromo;
  readonly PromoError: abstract new (...args: never[]) => Error;
}

type Module = Record<string, unknown>;

/** The storefront from its two modules; refuses modules that don't have what checkout calls. */
export function storefrontFrom(info: StorefrontInfo, promotions: Module, cart: Module): Storefront {
  const fn = (module: Module, name: string, file: string) => {
    const value = module[name];
    if (typeof value !== 'function') throw new Error(`storefront v${info.version}'s ${file} has no ${name}.`);
    return value;
  };
  return {
    info,
    createCart: fn(cart, 'createCart', 'cart.js') as Storefront['createCart'],
    addItem: fn(cart, 'addItem', 'cart.js') as Storefront['addItem'],
    removeItem: fn(cart, 'removeItem', 'cart.js') as Storefront['removeItem'],
    subtotalCents: fn(cart, 'subtotalCents', 'cart.js') as Storefront['subtotalCents'],
    applyPromoCode: fn(promotions, 'applyPromoCode', 'promotions.js') as Storefront['applyPromoCode'],
    PromoError: fn(promotions, 'PromoError', 'promotions.js') as Storefront['PromoError'],
  };
}

/** What the server says checkout runs now. Failures are thrown in plain words, for the shop's footer. */
export async function storefrontInfo(fetcher: typeof fetch = fetch): Promise<StorefrontInfo> {
  let response: Response;
  try {
    response = await fetcher('/api/storefront', { cache: 'no-store' });
  } catch {
    throw new Error("Couldn't reach Downhill's server.");
  }
  if (!response.ok) throw new Error(`Downhill's server didn't say which storefront to run (HTTP ${response.status}).`);
  const info = (await response.json().catch(() => undefined)) as Partial<StorefrontInfo> | undefined;
  if (typeof info?.version !== 'string' || typeof info.modules?.promotions !== 'string' || typeof info.modules.cart !== 'string') {
    // A page server without Downhill's API (a bare Vite server) answers with the game's page instead.
    throw new Error("Downhill's server didn't say which storefront to run. Start the game with its server: pnpm dev, or aspire run.");
  }
  return info as StorefrontInfo;
}

/** Imports a storefront version's modules from the server (their URLs are versioned, so each loads once). */
export async function loadStorefront(info: StorefrontInfo): Promise<Storefront> {
  let modules: [Module, Module];
  try {
    modules = await Promise.all([import(/* @vite-ignore */ info.modules.promotions) as Promise<Module>, import(/* @vite-ignore */ info.modules.cart) as Promise<Module>]);
  } catch (error) {
    throw new Error(`Storefront v${info.version}'s code didn't load (${error instanceof Error ? error.message : String(error)}).`);
  }
  return storefrontFrom(info, ...modules);
}
