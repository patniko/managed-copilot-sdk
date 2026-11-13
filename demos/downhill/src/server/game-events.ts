// What players do, as telemetry: the game's events (`POST /api/game/events`), checked and capped, and the shop's checkout
// outcomes from the ledger. Each becomes one OpenTelemetry log record with a sentence for people and attributes for
// queries. Names, prices, and rider names come from the catalog, never from the browser.
import { findProduct } from "../shared/catalog.js";
import { RIDER_NAMES, type RiderId } from "../shared/support.js";
import { GAME_EVENT_TYPES, MAX_GAME_EVENTS, type GameEventType } from "../shared/telemetry.js";
import { DownhillError } from "./errors.js";
import type { LedgerEvent } from "./ledger.js";
import { clip } from "./support.js";
import type { TelemetryRecord } from "./telemetry.js";

/** Request body, bytes. */
export const MAX_GAME_EVENT_BYTES = 16 * 1024;
/** How far a browser's clock may be from the server's before the server's time is used, ms. */
const MAX_SKEW = 60_000;
const WORLD_ID = /^[a-z0-9-]{1,32}$/;

const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

function invalid(message: string): DownhillError {
  return new DownhillError("invalid_request", message, 400);
}

function count(value: unknown, what: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) throw invalid(`Send ${what} as a number from 0 to ${max}.`);
  return Math.round(value);
}

function text(value: unknown, max: number, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalid(`Send ${what} as text.`);
  return clip(value, max);
}

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const points = (value: number): string => value.toLocaleString("en-US");

function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, "0")}`;
}

/** One game event as a telemetry record. */
function gameRecord(body: unknown, now: number): TelemetryRecord {
  const event = record(body);
  if (!event) throw invalid("Send each game event as a JSON object.");
  const type = event["type"];
  if (typeof type !== "string" || !(GAME_EVENT_TYPES as readonly string[]).includes(type)) throw invalid(`Send type: one of ${GAME_EVENT_TYPES.join(", ")}.`);
  const rider = event["rider"];
  if (typeof rider !== "string" || !Object.hasOwn(RIDER_NAMES, rider)) throw invalid(`Send rider: one of ${Object.keys(RIDER_NAMES).join(", ")}.`);
  const player = RIDER_NAMES[rider as RiderId];
  const sent = event["at"];
  const at = typeof sent === "number" && Number.isFinite(sent) && Math.abs(now - sent) <= MAX_SKEW ? Math.min(sent, now) : now;
  const world = typeof event["world"] === "string" && WORLD_ID.test(event["world"]) ? event["world"] : undefined;
  const worldName = world && typeof event["worldName"] === "string" && event["worldName"].trim() ? clip(event["worldName"], 60) : world;
  const common = { player, rider, world, bot: event["bot"] === true ? true : undefined, source: "live" };
  const on = worldName ? ` on ${worldName}` : "";
  switch (type as GameEventType) {
    case "ride_started":
      return { name: "ride.started", level: "info", at, message: `${player} dropped in${on}`, attributes: common };
    case "checkpoint": {
      const total = count(event["total"], "total", 50);
      const checkpoint = count(event["checkpoint"], "checkpoint", total);
      return { name: "ride.checkpoint", level: "info", at, message: `${player} reached checkpoint ${checkpoint} of ${total}${on}`, attributes: { ...common, checkpoint, total } };
    }
    case "trick": {
      const title = text(event["title"], 120, "the trick's title");
      const scored = count(event["points"], "points", 10_000_000);
      const combo = Math.max(1, count(event["combo"], "combo", 10));
      const perfect = event["perfect"] === true;
      const extras = [combo > 1 ? `×${combo} combo` : undefined, perfect ? "perfect landing" : undefined].filter(Boolean);
      return {
        name: "ride.trick",
        level: "info",
        at,
        message: `${player} landed ${title} for ${points(scored)} points${extras.length ? ` (${extras.join(", ")})` : ""}`,
        attributes: { ...common, title, points: scored, combo, perfect },
      };
    }
    case "crash": {
      const reason = text(event["reason"], 80, "the crash's reason").replace(/!+$/, "");
      const kmh = event["kmh"] === undefined ? undefined : count(event["kmh"], "kmh", 400);
      return { name: "ride.crash", level: "info", at, message: `${player} crashed${on}: ${reason}${kmh !== undefined ? ` at ${kmh} km/h` : ""}`, attributes: { ...common, reason, kmh } };
    }
    case "ride_finished": {
      const seconds = count(event["seconds"], "seconds", 24 * 3600);
      const score = count(event["score"], "score", 100_000_000);
      const tricks = count(event["tricks"], "tricks", 10_000);
      const crashes = count(event["crashes"], "crashes", 10_000);
      return {
        name: "ride.finished",
        level: "info",
        at,
        message: `${player} finished${on} in ${duration(seconds)} with ${points(score)} points`,
        attributes: { ...common, seconds, score, tricks, crashes },
      };
    }
    case "shop_opened":
      return { name: "shop.opened", level: "info", at, message: `${player} opened the Downhill Shop`, attributes: common };
    case "cart_added": {
      const sku = event["sku"];
      const product = typeof sku === "string" ? findProduct(sku) : undefined;
      if (!product) throw invalid(`The shop doesn't sell ${typeof sku === "string" ? `"${clip(sku, 64)}"` : "that item"}.`);
      return {
        name: "shop.cart_added",
        level: "info",
        at,
        message: `${player} added ${product.name} to the cart (${usd(product.priceCents)})`,
        attributes: { ...common, sku: product.sku, price_cents: product.priceCents },
      };
    }
  }
}

/** A batch of game events (`{ events: [...] }`), oldest first, as telemetry records. */
export function parseGameEvents(body: unknown, now: number): TelemetryRecord[] {
  const events = record(body)?.["events"];
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_GAME_EVENTS) throw invalid(`Send events: 1 to ${MAX_GAME_EVENTS} game events.`);
  return events.map((event) => gameRecord(event, now));
}

/** A checkout outcome from the ledger, as a telemetry record. */
export function shopRecord(event: LedgerEvent): TelemetryRecord {
  const common = { player: event.player, source: event.source, skus: event.items.map((item) => item.sku).join(","), subtotal_cents: event.subtotalCents };
  const items = event.items.map((item) => item.name).join(" and ");
  switch (event.type) {
    case "promo_applied":
      return {
        name: "shop.promo_applied",
        level: "info",
        at: event.at,
        message: `Checkout took ${usd(event.discountCents)} off ${items} with code ${event.code} for ${event.player}`,
        attributes: { ...common, code: event.code, code_source: event.codeSource, discount_cents: event.discountCents },
      };
    case "promo_rejected":
      return {
        name: "shop.promo_rejected",
        level: "warn",
        at: event.at,
        message: `Checkout rejected code ${event.code} for ${event.player}: ${event.error}`,
        attributes: { ...common, code: event.code, code_source: event.codeSource, error: event.error },
      };
    case "purchase":
      return {
        name: "shop.purchase",
        level: "info",
        at: event.at,
        message: `${event.player} bought ${items} for ${usd(event.totalCents)} (order ${event.orderId})`,
        attributes: { ...common, order_id: event.orderId, total_cents: event.totalCents, discount_cents: event.discountCents, promo_code: event.promoCode },
      };
  }
}
