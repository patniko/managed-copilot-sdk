// The shop's sales ledger: live checkout outcomes from players' browsers, kept in the data directory, and simulated
// launch-day traffic. The simulation is generated per 5-minute bucket from launch, seeded by the timeline and the
// bucket, so it's the same on every request and every restart, and new buckets keep arriving as time passes. Before
// the launch-week banner, a few players type the newsletter's TRAIL15 (in capitals: it works; now and then in lowercase:
// it's rejected). After the banner, most promo attempts are the banner's one-click lowercase trail15, and checkout
// rejects them, until a deploy fixes checkout: from then on, the same attempts succeed.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAUNCH_OFFER, PRODUCTS, kindOf, type Product, type ProductKind } from "../shared/catalog.js";
import { SALES_COLUMNS, type PromoSource, type SalesRow } from "../shared/shop.js";
import { MINUTE, type Timeline } from "./timeline.js";

export const BUCKET = 5 * MINUTE;
/** The longest a simulated player takes from the promo step to buying. */
const MAX_DELAY = 2 * MINUTE;
/** Live events kept; older ones are dropped. */
const MAX_LIVE = 20_000;
export const PROMO_ERROR = "Invalid code.";

export interface LedgerItem {
  readonly sku: string;
  readonly name: string;
  readonly priceCents: number;
  readonly kind: ProductKind;
}

interface EventBase {
  readonly at: number;
  readonly source: "live" | "simulated";
  readonly player: string;
  readonly items: readonly LedgerItem[];
  readonly subtotalCents: number;
}

export type LedgerEvent = EventBase &
  (
    | { readonly type: "promo_applied"; readonly code: string; readonly codeSource: PromoSource; readonly discountCents: number }
    | { readonly type: "promo_rejected"; readonly code: string; readonly codeSource: PromoSource; readonly error: string }
    | { readonly type: "purchase"; readonly orderId: string; readonly discountCents: number; readonly totalCents: number; readonly promoCode?: string }
  );

export function ledgerItem(product: Product): LedgerItem {
  return { sku: product.sku, name: product.name, priceCents: product.priceCents, kind: kindOf(product.slot) };
}

// ---------------------------------------------------------------- simulation

/** Simulated players' names (their rows say `source: simulated`). */
const PLAYERS = [
  "Ava R.", "Liam K.", "Sofia M.", "Noah P.", "Mia L.", "Lucas B.", "Aisha D.", "Mateo G.", "Emma S.", "Kenji T.",
  "Zara H.", "Diego F.", "Priya N.", "Elias W.", "Hana Y.", "Omar A.", "Chloe V.", "Ravi C.", "Freya O.", "Tomás E.",
  "Leila Q.", "Jonas U.", "Nia J.", "Felix Z.", "Yuki I.", "Sam X.", "Ines R.", "Kai M.", "Maya T.", "Theo B.",
] as const;

/** A simulated shopper at checkout: what they want, and what they do. */
interface Shopper {
  readonly at: number;
  readonly player: string;
  readonly product: Product;
  readonly promo?: { readonly code: string; readonly source: PromoSource };
  readonly buysAfterRejection: boolean;
  readonly buysWithoutPromo: boolean;
  readonly delay: number;
  readonly orderId: string;
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32: small, fast, and the same everywhere. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Neon Mona sells best; the jerseys and paint jobs less. */
const WEIGHTS: Readonly<Record<string, number>> = { "mona-neon": 3, "copilot-stealth": 2, "mona-gold": 2, "copilot-ruby": 2, "rider-sunset": 2, "rider-glacier": 1, "bike-lava": 2, "bike-aurora": 1 };
const TOTAL_WEIGHT = PRODUCTS.reduce((sum, product) => sum + (WEIGHTS[product.sku] ?? 1), 0);

function pickProduct(roll: number): Product {
  let left = roll * TOTAL_WEIGHT;
  for (const product of PRODUCTS) {
    left -= WEIGHTS[product.sku] ?? 1;
    if (left < 0) return product;
  }
  return PRODUCTS[PRODUCTS.length - 1]!;
}

/** The shoppers of 5-minute bucket `k` (counted from launch), in arrival order. */
export function simulatedShoppers(timeline: Timeline, k: number): Shopper[] {
  const start = timeline.launchAt + k * BUCKET;
  const rand = random(hash(`downhill:${timeline.startedAt}:${k}`));
  const afterBanner = start >= timeline.bannerAt;
  // The banner brings players in: traffic ramps up over its first 20 minutes.
  const ramp = afterBanner ? Math.min(1, (start - timeline.bannerAt) / (20 * MINUTE)) : 0;
  const count = afterBanner ? 5 + Math.round(6 * ramp) + Math.floor(rand() * 4) : 2 + Math.floor(rand() * 4);
  const shoppers: Shopper[] = [];
  for (let i = 0; i < count; i++) {
    const at = start + Math.floor((rand() * BUCKET) / 1000) * 1000;
    const player = PLAYERS[Math.floor(rand() * PLAYERS.length)]!;
    const product = pickProduct(rand());
    const tries = rand();
    const how = rand();
    const promo = afterBanner
      ? tries < 0.8
        ? how < 0.96
          ? { code: LAUNCH_OFFER.code, source: "banner" as const }
          : { code: "TRAIL15", source: "typed" as const }
        : undefined
      : tries < 0.35
        ? { code: how < 0.88 ? "TRAIL15" : "trail15", source: "typed" as const }
        : undefined;
    shoppers.push({
      at,
      player,
      product,
      ...(promo ? { promo } : {}),
      buysAfterRejection: rand() < 0.3,
      buysWithoutPromo: rand() < 0.85,
      delay: (20 + Math.floor(rand() * 80)) * 1000,
      orderId: `DH-${20000 + k * 40 + i}`,
    });
  }
  return shoppers.sort((a, b) => a.at - b.at);
}

/** What a simulated shopper did. Checkout rejects the lowercase code until `fixedAt`, and accepts it from then on. */
export function shopperEvents(shopper: Shopper, fixedAt: number | undefined): LedgerEvent[] {
  const item = ledgerItem(shopper.product);
  const base = { source: "simulated" as const, player: shopper.player, items: [item], subtotalCents: item.priceCents };
  const purchase = (discountCents: number, promoCode?: string): LedgerEvent => ({
    ...base,
    at: shopper.at + shopper.delay,
    type: "purchase",
    orderId: shopper.orderId,
    discountCents,
    totalCents: item.priceCents - discountCents,
    ...(promoCode ? { promoCode } : {}),
  });
  const promo = shopper.promo;
  if (!promo) return shopper.buysWithoutPromo ? [purchase(0)] : [];
  const accepted = promo.code === "TRAIL15" || (fixedAt !== undefined && shopper.at >= fixedAt);
  if (accepted) {
    const discount = Math.round((item.priceCents * LAUNCH_OFFER.percent) / 100);
    return [{ ...base, at: shopper.at, type: "promo_applied", code: promo.code, codeSource: promo.source, discountCents: discount }, purchase(discount, promo.code)];
  }
  const rejected: LedgerEvent = { ...base, at: shopper.at, type: "promo_rejected", code: promo.code, codeSource: promo.source, error: PROMO_ERROR };
  return shopper.buysAfterRejection ? [rejected, purchase(0)] : [rejected];
}

// ---------------------------------------------------------------- rows

const pad = (n: number) => String(n).padStart(2, "0");

/** The server's local time: `YYYY-MM-DD HH:MM:SS`. */
export function localTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A purchase's discount shared out over its items in proportion to their prices, to the cent. */
function shares(items: readonly LedgerItem[], discount: number): number[] {
  const subtotal = items.reduce((sum, item) => sum + item.priceCents, 0);
  let left = discount;
  return items.map((item, index) => {
    const share = index === items.length - 1 ? left : subtotal ? Math.min(left, Math.round((discount * item.priceCents) / subtotal)) : 0;
    left -= share;
    return Math.max(0, Math.min(item.priceCents, share));
  });
}

/** The sales rows of an event: one per item bought, or one for a rejected code. A code that worked isn't a sale. */
export function rowsOf(event: LedgerEvent, timeline: Timeline): SalesRow[] {
  const common = { time: localTime(event.at), minutes_since_launch: Math.round((event.at - timeline.launchAt) / 6_000) / 10, player: event.player, source: event.source };
  if (event.type === "promo_rejected") {
    const item = event.items[0];
    if (!item) return [];
    return [
      {
        ...common,
        event: "promo_rejected",
        order_id: null,
        item: item.name,
        kind: item.kind,
        price_usd: item.priceCents / 100,
        promo_code: event.code,
        promo_result: "rejected",
        discount_usd: null,
        total_usd: null,
      },
    ];
  }
  if (event.type !== "purchase") return [];
  const split = shares(event.items, event.discountCents);
  return event.items.map((item, index) => ({
    ...common,
    event: "purchase",
    order_id: event.orderId,
    item: item.name,
    kind: item.kind,
    price_usd: item.priceCents / 100,
    promo_code: event.promoCode ?? null,
    promo_result: event.promoCode ? "applied" : "none",
    discount_usd: split[index]! / 100,
    total_usd: (item.priceCents - split[index]!) / 100,
  }));
}

function csvValue(value: string | number | null, column: (typeof SALES_COLUMNS)[number]): string {
  if (value === null) return "";
  if (typeof value === "number") return column === "minutes_since_launch" ? value.toFixed(1) : value.toFixed(2);
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: readonly SalesRow[]): string {
  const lines = [SALES_COLUMNS.join(",")];
  for (const row of rows) lines.push(SALES_COLUMNS.map((column) => csvValue(row[column], column)).join(","));
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- log

function logValue(value: string | number): string {
  const text = String(value);
  return /^[A-Za-z0-9._:/@,+-]+$/.test(text) ? text : `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** `2026-11-12T17:31:05Z`. */
export function logTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** One structured log line: `<time> level=… event=… key=value …`. */
export function logLine(at: number, level: "info" | "warn", fields: Readonly<Record<string, string | number | boolean | undefined>>): string {
  const parts = [logTime(at), `level=${level}`];
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) parts.push(`${key}=${logValue(typeof value === "boolean" ? String(value) : value)}`);
  return parts.join(" ");
}

/** How the shop's log records an event. Live players' lines say `live=true`. */
export function eventLogLine(event: LedgerEvent): string {
  const skus = event.items.map((item) => item.sku).join(",");
  const live = event.source === "live" ? true : undefined;
  switch (event.type) {
    case "promo_rejected":
      return logLine(event.at, "warn", { event: "promo_rejected", code: event.code, source: event.codeSource, error: event.error, sku: skus, subtotal_cents: event.subtotalCents, player: event.player, live });
    case "promo_applied":
      return logLine(event.at, "info", { event: "promo_applied", code: event.code, source: event.codeSource, sku: skus, subtotal_cents: event.subtotalCents, discount_cents: event.discountCents, player: event.player, live });
    case "purchase":
      return logLine(event.at, "info", {
        event: "purchase",
        order: event.orderId,
        sku: skus,
        subtotal_cents: event.subtotalCents,
        promo: event.promoCode ?? "none",
        discount_cents: event.discountCents,
        total_cents: event.totalCents,
        player: event.player,
        live,
      });
  }
}

// ---------------------------------------------------------------- the ledger

export interface PromoStats {
  readonly attempts: number;
  readonly applied: number;
  readonly rejected: number;
  /** The most common rejection message. */
  readonly error?: string;
}

export class Ledger {
  #timeline: Timeline;
  readonly #fixedAt: () => number | undefined;
  readonly #file: string;
  readonly #shoppers = new Map<number, Shopper[]>();
  #live: LedgerEvent[] = [];

  /** `fixedAt`: when checkout was fixed (the first deploy), if it has been. */
  constructor(dataDir: string, timeline: Timeline, fixedAt: () => number | undefined) {
    this.#timeline = timeline;
    this.#fixedAt = fixedAt;
    mkdirSync(dataDir, { recursive: true });
    this.#file = join(dataDir, "events.jsonl");
    this.#live = this.#load();
  }

  get timeline(): Timeline {
    return this.#timeline;
  }

  /** Starts the simulation over on another timeline. */
  set timeline(timeline: Timeline) {
    this.#timeline = timeline;
    this.#shoppers.clear();
  }

  #load(): LedgerEvent[] {
    let text: string;
    try {
      text = readFileSync(this.#file, "utf8");
    } catch {
      return [];
    }
    const events: LedgerEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as LedgerEvent;
        if (typeof event.at === "number" && event.source === "live") events.push(event);
      } catch {
        // a torn last line from a crash: skip it
      }
    }
    return events.slice(-MAX_LIVE);
  }

  /** Records a live checkout outcome (and keeps it). */
  record(event: LedgerEvent): void {
    this.#live.push(event);
    if (this.#live.length > MAX_LIVE) {
      this.#live = this.#live.slice(-MAX_LIVE);
      writeFileSync(this.#file, this.#live.map((e) => `${JSON.stringify(e)}\n`).join(""));
    } else appendFileSync(this.#file, `${JSON.stringify(event)}\n`);
  }

  clearLive(): void {
    this.#live = [];
    writeFileSync(this.#file, "");
  }

  get liveCount(): number {
    return this.#live.length;
  }

  #bucketShoppers(k: number): Shopper[] {
    let shoppers = this.#shoppers.get(k);
    if (!shoppers) this.#shoppers.set(k, (shoppers = simulatedShoppers(this.#timeline, k)));
    return shoppers;
  }

  /** Every event from `from` up to `to` (both live and simulated), oldest first. Nothing after `to` exists yet. */
  events(from: number, to: number): LedgerEvent[] {
    const { launchAt } = this.#timeline;
    const fixedAt = this.#fixedAt();
    const events: LedgerEvent[] = [];
    const first = Math.max(0, Math.floor((from - MAX_DELAY - launchAt) / BUCKET));
    const last = Math.floor((to - launchAt) / BUCKET);
    for (let k = first; k <= last; k++) {
      for (const shopper of this.#bucketShoppers(k)) {
        for (const event of shopperEvents(shopper, fixedAt)) if (event.at >= from && event.at <= to) events.push(event);
      }
    }
    for (const event of this.#live) if (event.at >= from && event.at <= to) events.push(event);
    return events.sort((a, b) => a.at - b.at);
  }

  /** The sales rows from launch up to `now`, oldest first. */
  rows(now: number): SalesRow[] {
    return this.events(this.#timeline.launchAt, now).flatMap((event) => rowsOf(event, this.#timeline));
  }

  /** Promo attempts in the `windowMs` before `now`. */
  promoStats(now: number, windowMs: number): PromoStats {
    let applied = 0;
    let rejected = 0;
    const errors = new Map<string, number>();
    for (const event of this.events(now - windowMs, now)) {
      if (event.type === "promo_applied") applied++;
      else if (event.type === "promo_rejected") {
        rejected++;
        errors.set(event.error, (errors.get(event.error) ?? 0) + 1);
      }
    }
    const error = [...errors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { attempts: applied + rejected, applied, rejected, ...(error ? { error } : {}) };
  }
}
