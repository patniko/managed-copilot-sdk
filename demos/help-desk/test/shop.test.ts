import { describe, expect, it } from "vitest";
import { CUSTOMERS, ORDERS } from "../src/server/seed.js";
import { normalizeOrderId, Shop } from "../src/server/shop.js";

const start = new Date("2026-11-03T15:00:00.000Z");
const shop = () => new Shop(start);

describe("the demo store", () => {
  it("has 25 customers, each with their own orders and a first question", () => {
    const cards = shop().customers();
    expect(cards).toHaveLength(25);
    expect(new Set(cards.map((card) => card.id)).size).toBe(25);
    for (const card of cards) {
      expect(card.orderIds.length, card.name).toBeGreaterThan(0);
      expect(card.opening.length, card.name).toBeGreaterThan(10);
      expect(card.email).toMatch(/^[a-z]+(\.[a-z]+)+@example\.com$/);
    }
    expect(cards.find((card) => card.id === "c02")).toMatchObject({ name: "Liam O'Brien", initials: "LO", email: "liam.obrien@example.com" });
    expect(new Set(ORDERS.map((order) => order.id)).size).toBe(ORDERS.length);
  });

  it("puts a refund, a cancellation, and someone else's order among the first five customers", () => {
    const first = CUSTOMERS.slice(0, 5).map((customer) => customer.opening).join(" ");
    expect(first).toMatch(/refund/i);
    expect(first).toMatch(/cancel/i);
    expect(shop().ownerOf("CO-48177")).toBe("c03");
    expect(CUSTOMERS[1]?.opening).toContain("CO-48177");
  });

  it("reads orders numbers the way people write them", () => {
    expect(normalizeOrderId("co-48213")).toBe("CO-48213");
    expect(normalizeOrderId("#48213")).toBe("CO-48213");
    expect(normalizeOrderId(48213)).toBe("CO-48213");
    expect(normalizeOrderId(" CO-482 13 ")).toBe("CO-48213");
    expect(normalizeOrderId(undefined)).toBe("");
  });

  it("dates everything relative to the simulation's start", () => {
    const store = shop();
    expect(store.date(0)).toBe("2026-11-03");
    expect(store.listOrders("c01")).toMatchObject({ today: "2026-11-03", orders: [{ orderId: "CO-48213", placed: "2026-10-25", status: "in transit, delayed" }] });
    expect(store.trackShipment("c01", "CO-48213")).toMatchObject({ carrier: "UPS", estimatedDelivery: "2026-11-05", delay: expect.stringContaining("Denver") });
    store.reset(new Date("2026-12-01T00:00:00.000Z"));
    expect(store.trackShipment("c01", "CO-48213")).toMatchObject({ estimatedDelivery: "2026-12-03" });
  });

  it("answers another customer's order exactly like one that doesn't exist", () => {
    const store = shop();
    expect(store.getOrder("c03", "CO-48177")).toMatchObject({ orderId: "CO-48177", total: 39, status: "delivered" });
    const theirs = store.getOrder("c02", "CO-48177");
    const missing = store.getOrder("c02", "CO-99999");
    expect(theirs).toEqual({ ok: false, error: "No order CO-48177 on this account." });
    expect(missing).toEqual({ ok: false, error: "No order CO-99999 on this account." });
    expect(store.trackShipment("c02", "CO-48177")).toEqual(theirs);
    expect(store.listOrders("c02")).toMatchObject({ orders: [{ orderId: "CO-48121" }] });
  });

  it("tracks orders that haven't shipped without a tracking number", () => {
    expect(shop().trackShipment("c04", "CO-48231")).toMatchObject({ status: "processing (not shipped yet)", shipsBy: "2026-11-04", note: expect.stringContaining("no tracking number") });
  });

  it("refunds delivered orders within 30 days, in full or in part, once per call", () => {
    const store = shop();
    expect(store.checkRefund("c03", "CO-48177")).toEqual({ ok: true, amount: 39 });
    expect(store.checkRefund("c08", "CO-48198", 24)).toEqual({ ok: true, amount: 24 });
    expect(store.checkRefund("c08", "CO-48198", 50)).toEqual({ ok: false, error: "At most $48.00 of this order can be refunded." });
    expect(store.checkRefund("c08", "CO-48198", -1)).toMatchObject({ ok: false });
    expect(store.checkRefund("c04", "CO-48231")).toEqual({ ok: false, error: "This order hasn't shipped yet. Cancel it instead." });
    expect(store.checkRefund("c01", "CO-48213")).toMatchObject({ ok: false, error: expect.stringContaining("hasn't been delivered") });
    expect(store.checkRefund("c20", "CO-48011")).toMatchObject({ ok: false, error: expect.stringContaining("within 30 days") });
    expect(store.checkRefund("c02", "CO-48177")).toEqual({ ok: false, error: "No order CO-48177 on this account." });

    const first = store.refund("c08", "CO-48198", 24, "call-1");
    expect(first).toMatchObject({ ok: true, refunded: 24 });
    expect(store.refund("c08", "CO-48198", 24, "call-1")).toBe(first);
    expect(store.getOrder("c08", "CO-48198")).toMatchObject({ refunded: 24, status: "delivered, partly refunded" });
    expect(store.refund("c08", "CO-48198", undefined, "call-2")).toMatchObject({ ok: true, refunded: 24 });
    expect(store.checkRefund("c08", "CO-48198")).toEqual({ ok: false, error: "This order was refunded in full already." });
  });

  it("cancels orders that haven't shipped, and refunds them", () => {
    const store = shop();
    expect(store.checkCancel("c11", "CO-48201")).toMatchObject({ ok: false, error: expect.stringContaining("Already shipped with UPS") });
    expect(store.checkCancel("c06", "CO-48090")).toMatchObject({ ok: false, error: expect.stringContaining("Already delivered") });
    expect(store.cancel("c04", "CO-48231", "call-1")).toEqual({ ok: true, orderId: "CO-48231", status: "cancelled", refunded: 159, to: "the original payment method" });
    expect(store.cancel("c04", "CO-48231", "call-2")).toEqual({ ok: false, error: "This order is cancelled already." });
    expect(store.trackShipment("c04", "CO-48231")).toMatchObject({ status: "cancelled", note: "Cancelled before it shipped." });
    expect(store.checkRefund("c04", "CO-48231")).toMatchObject({ ok: false, error: expect.stringContaining("cancelled") });
  });

  it("starts every simulation with fresh data", () => {
    const store = shop();
    store.cancel("c04", "CO-48231", "call-1");
    store.reset(start);
    expect(store.checkCancel("c04", "CO-48231")).toEqual({ ok: true, amount: 159 });
    expect(store.cancel("c04", "CO-48231", "call-1")).toMatchObject({ ok: true });
  });
});
