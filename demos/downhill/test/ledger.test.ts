import { describe, expect, it } from "vitest";
import { findProduct } from "../src/shared/catalog.js";
import { SALES_COLUMNS } from "../src/shared/shop.js";
import { Ledger, ledgerItem, toCsv, type LedgerEvent } from "../src/server/ledger.js";
import { MINUTE, timelineFrom } from "../src/server/timeline.js";
import { dataDir, START } from "./helpers.js";

const timeline = timelineFrom(START);
const item = (sku: string) => ledgerItem(findProduct(sku)!);
const rate = (stats: { applied: number; attempts: number }) => stats.applied / stats.attempts;

type Outcome<T> = T extends unknown ? Omit<T, "at" | "source" | "player" | "items" | "subtotalCents"> & { skus?: string[] } : never;

function live(at: number, event: Outcome<LedgerEvent>): LedgerEvent {
  const { skus = ["mona-neon"], ...outcome } = event;
  const items = skus.map(item);
  return { ...outcome, at, source: "live", player: "Mona", items, subtotalCents: items.reduce((sum, i) => sum + i.priceCents, 0) } as LedgerEvent;
}

describe("the sales ledger", () => {
  it("simulates the same launch day every time, from launch up to now and no further", () => {
    const a = new Ledger(dataDir(), timeline, () => undefined);
    const b = new Ledger(dataDir(), timeline, () => undefined);
    const rows = a.rows(START);
    expect(rows.length).toBeGreaterThan(150);
    expect(b.rows(START)).toEqual(rows);
    expect(new Ledger(dataDir(), timelineFrom(START + MINUTE), () => undefined).rows(START)).not.toEqual(rows);
    expect(rows.every((row) => row.source === "simulated" && row.minutes_since_launch >= 0 && row.minutes_since_launch <= 180)).toBe(true);
    // Time passes: new buckets keep arriving, and what already happened stays as it was.
    const later = a.rows(START + 30 * MINUTE);
    expect(later.length).toBeGreaterThan(rows.length + 30);
    expect(later.slice(0, rows.length)).toEqual(rows);
  });

  it("shows promo checkouts failing from the moment the launch-week banner went live", () => {
    const ledger = new Ledger(dataDir(), timeline, () => undefined);
    const before = ledger.promoStats(timeline.bannerAt - 1, timeline.bannerAt - 1 - timeline.launchAt);
    const after = ledger.promoStats(START, START - timeline.bannerAt);
    // Before: a few players type TRAIL15, nearly always in capitals.
    expect(rate(before)).toBeGreaterThan(0.75);
    expect(before.rejected).toBeGreaterThan(0);
    // After: most promo attempts are the banner's trail15, and checkout rejects them.
    expect(rate(after)).toBeLessThan(0.25);
    expect(after.error).toBe("Invalid code.");
    const perHour = (rejected: number, ms: number) => rejected / (ms / (60 * MINUTE));
    expect(perHour(after.rejected, START - timeline.bannerAt)).toBeGreaterThan(10 * perHour(before.rejected, timeline.bannerAt - timeline.launchAt));
    const promoSales = (from: number, to: number) => ledger.rows(to).filter((row) => row.event === "purchase" && row.promo_result === "applied" && row.minutes_since_launch * MINUTE >= from - timeline.launchAt).length;
    // Promo sales per hour collapse once the banner is up: under half the rate before it.
    const salesBefore = promoSales(timeline.launchAt, timeline.bannerAt - 1) / 2.25;
    const salesAfter = promoSales(timeline.bannerAt, START) / 0.75;
    expect(salesAfter).toBeLessThan(salesBefore / 2);
  });

  it("lets the same banner code through from the moment a fix was deployed", () => {
    const fixedAt = START + 10 * MINUTE;
    const ledger = new Ledger(dataDir(), timeline, () => fixedAt);
    const broken = ledger.promoStats(fixedAt - 1, 20 * MINUTE);
    const fixed = ledger.promoStats(START + 40 * MINUTE, 30 * MINUTE - 1);
    expect(broken.rejected).toBeGreaterThan(5);
    expect(fixed).toMatchObject({ rejected: 0 });
    expect(fixed.applied).toBeGreaterThan(10);
    const recovered = ledger.rows(START + 40 * MINUTE).filter((row) => row.minutes_since_launch >= 190 && row.event === "purchase" && row.promo_code === "trail15");
    expect(recovered.length).toBeGreaterThan(5);
    expect(recovered.every((row) => row.promo_result === "applied" && row.discount_usd! > 0)).toBe(true);
    // Before the fix, nothing changed.
    expect(new Ledger(dataDir(), timeline, () => undefined).rows(fixedAt - 1)).toEqual(ledger.rows(fixedAt - 1));
  });

  it("writes the sales as CSV with the contract's columns, live rows marked", () => {
    const ledger = new Ledger(dataDir(), timeline, () => undefined);
    ledger.record(live(START + 5_000, { type: "promo_rejected", code: "trail15", codeSource: "banner", error: "Invalid code." }));
    ledger.record(live(START + 30_000, { type: "purchase", orderId: "DH-1042", discountCents: 0, totalCents: 499 }));
    ledger.record(live(START + 60_000, { type: "promo_applied", code: "TRAIL15", codeSource: "typed", discountCents: 165, skus: ["mona-gold", "bike-aurora"] }));
    ledger.record(live(START + 61_000, { type: "purchase", orderId: "DH-1043", discountCents: 180, totalCents: 1018, promoCode: "TRAIL15", skus: ["copilot-stealth", "mona-neon"] }));
    const csv = toCsv(ledger.rows(START + 2 * MINUTE));
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("time,minutes_since_launch,event,order_id,item,kind,price_usd,promo_code,promo_result,discount_usd,total_usd,player,source");
    expect(lines[0]).toBe(SALES_COLUMNS.join(","));
    const rows = lines.slice(1).map((line) => Object.fromEntries(line.split(",").map((value, i) => [SALES_COLUMNS[i], value])));
    for (const row of rows) {
      expect(Object.keys(row)).toHaveLength(13);
      expect(row.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(row.minutes_since_launch).toMatch(/^\d+\.\d$/);
      expect(row.event).toMatch(/^(purchase|promo_rejected)$/);
      expect(row.kind).toMatch(/^(outfit|paint)$/);
      expect(row.price_usd).toMatch(/^\d+\.\d{2}$/);
      expect(row.promo_result).toMatch(/^(applied|rejected|none)$/);
      expect(row.source).toMatch(/^(live|simulated)$/);
      if (row.event === "promo_rejected") expect([row.order_id, row.discount_usd, row.total_usd, row.promo_result]).toEqual(["", "", "", "rejected"]);
    }
    expect(rows.map((row) => row.time)).toEqual([...rows.map((row) => row.time)].sort());
    const mine = rows.filter((row) => row.source === "live");
    expect(mine).toEqual([
      expect.objectContaining({ event: "promo_rejected", item: "Neon Mona", kind: "outfit", price_usd: "4.99", promo_code: "trail15", player: "Mona" }),
      expect.objectContaining({ event: "purchase", order_id: "DH-1042", item: "Neon Mona", promo_code: "", promo_result: "none", discount_usd: "0.00", total_usd: "4.99" }),
      expect.objectContaining({ order_id: "DH-1043", item: "Stealth Copilot", kind: "outfit", price_usd: "6.99", promo_code: "TRAIL15", promo_result: "applied", discount_usd: "1.05", total_usd: "5.94" }),
      expect.objectContaining({ order_id: "DH-1043", item: "Neon Mona", price_usd: "4.99", discount_usd: "0.75", total_usd: "4.24" }),
    ]);
    expect(mine[0]!.minutes_since_launch).toBe("180.1");
  });

  it("keeps live sales across restarts, until a reset clears them", () => {
    const dir = dataDir();
    const ledger = new Ledger(dir, timeline, () => undefined);
    ledger.record(live(START + 1_000, { type: "promo_rejected", code: "trail15", codeSource: "banner", error: "Invalid code." }));
    const again = new Ledger(dir, timeline, () => undefined);
    expect(again.liveCount).toBe(1);
    expect(again.rows(START + MINUTE).filter((row) => row.source === "live")).toHaveLength(1);
    again.clearLive();
    expect(new Ledger(dir, timeline, () => undefined).liveCount).toBe(0);
  });
});
