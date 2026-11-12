// The shop's checkout outcomes, from players' browsers (`POST /api/shop/events`): checked, capped, and turned into
// live ledger events. Item names, prices, and kinds come from the catalog; the amounts come from checkout, which ran the
// storefront code in the browser.
import { findProduct } from "../shared/catalog.js";
import type { PromoSource } from "../shared/shop.js";
import { RIDER_NAMES } from "../shared/support.js";
import { DownhillError } from "./errors.js";
import { ledgerItem, type LedgerEvent } from "./ledger.js";
import { clip } from "./support.js";

/** Request body, bytes. */
export const MAX_EVENT_BYTES = 8 * 1024;
const MAX_ITEMS = 20;
const MAX_CENTS = 2_000_000;
const ORDER_ID = /^DH-\d{1,9}$/;

const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

function invalid(message: string): DownhillError {
  return new DownhillError("invalid_request", message, 400);
}

function cents(value: unknown, what: string, max = MAX_CENTS): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) throw invalid(`Send ${what} as a whole number of cents from 0 to ${max}.`);
  return value;
}

function text(value: unknown, max: number, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalid(`Send ${what} as text.`);
  return clip(value, max);
}

function codeSource(value: unknown): PromoSource {
  if (value !== "banner" && value !== "typed") throw invalid('Send source: "banner" or "typed".');
  return value;
}

/** A checkout outcome at `at`, as a live ledger event. */
export function parseShopEvent(body: unknown, at: number): LedgerEvent {
  const event = record(body);
  if (!event) throw invalid("Send the checkout event as a JSON object.");
  const rider = event["rider"];
  if (typeof rider !== "string" || !Object.hasOwn(RIDER_NAMES, rider)) throw invalid(`Send rider: one of ${Object.keys(RIDER_NAMES).join(", ")}.`);
  const skus = event["skus"];
  if (!Array.isArray(skus) || skus.length === 0 || skus.length > MAX_ITEMS) throw invalid(`Send skus: the cart's items, 1 to ${MAX_ITEMS} of them.`);
  const items = skus.map((sku) => {
    const product = typeof sku === "string" ? findProduct(sku) : undefined;
    if (!product) throw invalid(`The shop doesn't sell ${typeof sku === "string" ? `"${clip(sku, 64)}"` : "that item"}.`);
    return ledgerItem(product);
  });
  const subtotalCents = cents(event["subtotalCents"], "subtotalCents");
  const base = { at, source: "live" as const, player: RIDER_NAMES[rider as keyof typeof RIDER_NAMES], items, subtotalCents };
  switch (event["type"]) {
    case "promo_applied":
      return { ...base, type: "promo_applied", code: text(event["code"], 64, "code"), codeSource: codeSource(event["source"]), discountCents: cents(event["discountCents"], "discountCents", subtotalCents) };
    case "promo_rejected":
      return { ...base, type: "promo_rejected", code: text(event["code"], 64, "code"), codeSource: codeSource(event["source"]), error: text(event["error"], 300, "error") };
    case "purchase": {
      const orderId = event["orderId"];
      if (typeof orderId !== "string" || !ORDER_ID.test(orderId)) throw invalid("Send the order's orderId, such as DH-1042.");
      const promoCode = event["promoCode"] === undefined ? undefined : text(event["promoCode"], 64, "promoCode");
      return {
        ...base,
        type: "purchase",
        orderId,
        discountCents: cents(event["discountCents"], "discountCents", subtotalCents),
        totalCents: cents(event["totalCents"], "totalCents"),
        ...(promoCode ? { promoCode } : {}),
      };
    }
    default:
      throw invalid('Send type: "promo_applied", "promo_rejected", or "purchase".');
  }
}
