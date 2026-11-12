// The Downhill Shop's products and launch-week offer: shared by the game's shop and the server's sales ledger.

/** Where an item goes: a rider's outfit, or the paint on whichever bike you ride. */
export type Slot = "rider" | "mona" | "copilot" | "bike";

/** How the sales data names an item's kind. */
export type ProductKind = "outfit" | "paint";

export interface Product {
  readonly sku: string;
  readonly name: string;
  readonly priceCents: number;
  readonly slot: Slot;
}

/** Everything the shop sells: cosmetics only, for the three riders and their bikes. */
export const PRODUCTS: readonly Product[] = [
  { sku: "rider-sunset", name: "Sunset Jersey", priceCents: 399, slot: "rider" },
  { sku: "rider-glacier", name: "Glacier Jersey", priceCents: 299, slot: "rider" },
  { sku: "mona-neon", name: "Neon Mona", priceCents: 499, slot: "mona" },
  { sku: "mona-gold", name: "Golden Mona", priceCents: 599, slot: "mona" },
  { sku: "copilot-stealth", name: "Stealth Copilot", priceCents: 699, slot: "copilot" },
  { sku: "copilot-ruby", name: "Ruby Copilot", priceCents: 499, slot: "copilot" },
  { sku: "bike-lava", name: "Lava Paint", priceCents: 399, slot: "bike" },
  { sku: "bike-aurora", name: "Aurora Paint", priceCents: 599, slot: "bike" },
];

export function findProduct(sku: string): Product | undefined {
  return PRODUCTS.find((product) => product.sku === sku);
}

export function kindOf(slot: Slot): ProductKind {
  return slot === "bike" ? "paint" : "outfit";
}

const OFFER_CODE = "trail15";

/** The launch-week offer on the shop's banner. `code` is the code exactly as the banner shows it. */
export const LAUNCH_OFFER = {
  code: OFFER_CODE,
  percent: 15,
  text: `Launch week: 15% off everything with code ${OFFER_CODE}`,
} as const;

/** The shop release that put the banner (and its one-click Apply code) live. */
export const BANNER_RELEASE = {
  version: "1.1.0",
  summary: "Downhill shop 1.1.0: launch-week banner with one-click Apply code",
} as const;
