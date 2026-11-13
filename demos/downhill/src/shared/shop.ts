// The shop's contracts with Downhill's server: the storefront code checkout runs, and the checkout outcomes it reports
// for the sales ledger. Data Desk reads the ledger as CSV; Incident Commander reads its log and deploys fixes.
import type { RiderId } from "./support.js";

/** Whether the Downhill Shop is open: `GET /api/shop`, and `PUT /api/shop` with `{ "open": boolean }` to roll it out or take it down. */
export interface ShopAvailability {
  readonly open: boolean;
  /** When it last opened or closed; absent when it never changed (open, as it shipped). */
  readonly changedAt?: string;
  /** What changed, in words: on a `PUT`. */
  readonly message?: string;
}

/** The storefront code the shop runs now: `GET /api/storefront`. */
export interface StorefrontInfo {
  readonly version: string;
  readonly source: "original" | "deployed";
  readonly deployedAt?: string;
  /** The incident whose approved fix this deploy is. */
  readonly incident?: string;
  readonly approvedBy?: string;
  /** Where the browser imports checkout's modules from: versioned, content-addressed, immutable URLs. */
  readonly modules: { readonly promotions: string; readonly cart: string };
}

/** Where a promotion code came from: the banner's Apply code button, or typed into the Promo code field. */
export type PromoSource = "banner" | "typed";

interface ShopEventBase {
  readonly rider: RiderId;
  /** What was in the cart (product SKUs). */
  readonly skus: readonly string[];
  readonly subtotalCents: number;
}

/** One checkout outcome, from the shop to `POST /api/shop/events`. */
export type ShopEventRequest =
  | (ShopEventBase & { readonly type: "promo_applied"; readonly code: string; readonly source: PromoSource; readonly discountCents: number })
  | (ShopEventBase & { readonly type: "promo_rejected"; readonly code: string; readonly source: PromoSource; readonly error: string })
  | (ShopEventBase & {
      readonly type: "purchase";
      readonly orderId: string;
      readonly discountCents: number;
      readonly totalCents: number;
      /** The code that took money off, when one did. */
      readonly promoCode?: string;
    });

/** The columns of `GET /api/sales.csv`, in order. */
export const SALES_COLUMNS = [
  "time",
  "minutes_since_launch",
  "event",
  "order_id",
  "item",
  "kind",
  "price_usd",
  "promo_code",
  "promo_result",
  "discount_usd",
  "total_usd",
  "player",
  "source",
] as const;

/** One row of the sales data: a purchased item, or a rejected promotion code. Empty values are `null` in JSON. */
export interface SalesRow {
  /** The server's local time, `YYYY-MM-DD HH:MM:SS`. */
  readonly time: string;
  readonly minutes_since_launch: number;
  readonly event: "purchase" | "promo_rejected";
  readonly order_id: string | null;
  readonly item: string;
  readonly kind: "outfit" | "paint";
  readonly price_usd: number;
  readonly promo_code: string | null;
  readonly promo_result: "applied" | "rejected" | "none";
  readonly discount_usd: number | null;
  readonly total_usd: number | null;
  readonly player: string;
  readonly source: "live" | "simulated";
}
