import { describe, expect, it } from "vitest";
import { CUSTOMERS, ORDERS } from "../src/server/seed.js";
import { normalizeOrderId, Shop } from "../src/server/shop.js";

const start = new Date("2026-11-12T18:00:00.000Z");
const shop = () => new Shop(start);

describe("the Downhill Shop's orders", () => {
  it("has 25 players, each with their own orders and a first question", () => {
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
    // Launch day: every order since the shop opened, numbered in the order they were placed.
    const byTime = [...ORDERS].sort((a, b) => b.placedMinutesAgo - a.placedMinutesAgo);
    expect(byTime.every((order) => order.placedMinutesAgo < 180)).toBe(true);
    expect(byTime.map((order) => order.id)).toEqual([...byTime.map((order) => order.id)].sort());
  });

  it("puts a refund, a cancellation, and someone else's order among the first five players", () => {
    const first = CUSTOMERS.slice(0, 5).map((customer) => customer.opening).join(" ");
    expect(first).toMatch(/refund/i);
    expect(first).toMatch(/cancel/i);
    expect(shop().ownerOf("DH-20417")).toBe("c03");
    expect(CUSTOMERS[1]?.opening).toContain("DH-20417");
  });

  it("has six players who hit bugs of the shop's checkout code, one among the first five", () => {
    const opening = (id: string) => CUSTOMERS.find((customer) => customer.id === id)?.opening;
    expect(CUSTOMERS.slice(0, 5).map((customer) => customer.id)).toContain("c05");
    expect(opening("c05")).toContain("TRAIL15");
    expect(opening("c08")).toContain("charged twice");
    expect(opening("c12")).toContain("trail15");
    expect(opening("c13")).toMatch(/My purchases says Golden Mona is unlocked/);
    expect(opening("c16")).toMatch(/My purchases says Aurora Paint is unlocked/);
    expect(opening("c18")).toMatch(/lowercase/);
  });

  it("tells the agent what the player's My purchases page shows, the storefront's bug included", () => {
    const store = shop();
    // A bank transfer still waiting to unlock: the page's label matches /unlock/i, so it says Unlocked.
    for (const [customer, order] of [
      ["c13", "DH-20866"],
      ["c16", "DH-20901"],
    ] as const) {
      expect(store.getOrder(customer, order)).toMatchObject({ status: "payment pending (the looks unlock when it clears, usually in 1 to 2 business days)", shownOnMyPurchasesPage: "Unlocked", paymentMethod: "Bank transfer" });
      expect(store.checkRefund(customer, order)).toMatchObject({ ok: false, error: expect.stringContaining("hasn't cleared yet") });
    }
    expect(store.checkUnlock("c13", "DH-20866")).toMatchObject({ events: [{ description: "Order placed" }, { description: "Waiting to unlock: bank transfer pending" }] });
    // Everywhere else the page agrees with the order.
    expect(store.getOrder("c01", "DH-20652")).toMatchObject({ status: "payment pending (the looks unlock when it clears, usually in 3 to 5 business days)", shownOnMyPurchasesPage: "Pending", unlocksWhenPaymentClears: "usually in 3 to 5 business days" });
    expect(store.getOrder("c03", "DH-20417")).toMatchObject({ status: "unlocked", shownOnMyPurchasesPage: "Unlocked", paymentMethod: "Mastercard ending 5100" });
    expect(store.getOrder("c20", "DH-20255")).toMatchObject({ status: "refunded (the looks are locked again)", shownOnMyPurchasesPage: "Refunded" });
    expect(store.listOrders("c13")).toMatchObject({ orders: [{ orderId: "DH-20866", looks: "Golden Mona", shownOnMyPurchasesPage: "Unlocked" }] });
  });

  it("charges what checkout charged: full price, less a promotion code, or a look twice", () => {
    const store = shop();
    const aisha = store.getOrder("c05", "DH-20540");
    expect(aisha).toMatchObject({ total: 4.99, status: "unlocked", items: [{ look: "Neon Mona", fits: "Mona", quantity: 1, price: 4.99 }] });
    expect(aisha).not.toHaveProperty("promoCode");
    expect(store.getOrder("c18", "DH-20802")).toMatchObject({ promoCode: "TRAIL15", discount: 0.6, total: 3.39 });
    expect(store.getOrder("c08", "DH-20720")).toMatchObject({ items: [{ look: "Stealth Copilot", quantity: 2 }], total: 13.98 });
    expect(store.listOrders("c08")).toMatchObject({ orders: [{ looks: "Stealth Copilot ×2" }] });
    // What Aisha should have paid with TRAIL15 can go back to her, and Lucas's second Stealth Copilot.
    expect(store.checkRefund("c05", "DH-20540", 0.75)).toEqual({ ok: true, amount: 0.75 });
    expect(store.checkRefund("c08", "DH-20720", 6.99)).toEqual({ ok: true, amount: 6.99 });
  });

  it("checks the order a bug report names", () => {
    const store = shop();
    expect(store.reportBug("c05", { area: "promo-codes", orderId: "#20540" })).toEqual({ ok: true, area: "promo-codes", orderId: "DH-20540", sentTo: "the engineering team" });
    expect(store.reportBug("c05", { area: "cart", orderId: "DH-20720" })).toEqual({ ok: false, error: "No order DH-20720 on this account." });
    expect(store.reportBug("c05", { area: "other" })).toEqual({ ok: true, area: "other", sentTo: "the engineering team" });
  });

  it("reads order numbers the way people write them", () => {
    expect(normalizeOrderId("dh-20652")).toBe("DH-20652");
    expect(normalizeOrderId("#20652")).toBe("DH-20652");
    expect(normalizeOrderId(20652)).toBe("DH-20652");
    expect(normalizeOrderId(" DH-206 52 ")).toBe("DH-20652");
    expect(normalizeOrderId(undefined)).toBe("");
  });

  it("times everything relative to the simulation's start", () => {
    const store = shop();
    expect(store.date(0)).toBe("2026-11-12");
    expect(store.listOrders("c01")).toMatchObject({ now: "2026-11-12T18:00Z", orders: [{ orderId: "DH-20652", placed: "2026-11-12T17:19Z" }] });
    expect(store.checkUnlock("c01", "DH-20652")).toMatchObject({ paymentMethod: "PayPal eCheck", events: [{ at: "2026-11-12T17:19Z", description: "Order placed" }, { description: "eCheck payment pending" }] });
    store.reset(new Date("2026-12-01T00:00:00.000Z"));
    expect(store.listOrders("c01")).toMatchObject({ orders: [{ placed: "2026-11-30T23:19Z" }] });
  });

  it("answers another player's order exactly like one that doesn't exist", () => {
    const store = shop();
    expect(store.getOrder("c03", "DH-20417")).toMatchObject({ orderId: "DH-20417", total: 4.99, status: "unlocked" });
    const theirs = store.getOrder("c02", "DH-20417");
    const missing = store.getOrder("c02", "DH-99999");
    expect(theirs).toEqual({ ok: false, error: "No order DH-20417 on this account." });
    expect(missing).toEqual({ ok: false, error: "No order DH-99999 on this account." });
    expect(store.checkUnlock("c02", "DH-20417")).toEqual(theirs);
    expect(store.listOrders("c02")).toMatchObject({ orders: [{ orderId: "DH-20388" }] });
  });

  it("refunds paid orders, in full or in part, once per call", () => {
    const store = shop();
    expect(store.checkRefund("c03", "DH-20417")).toEqual({ ok: true, amount: 4.99 });
    expect(store.checkRefund("c25", "DH-20777", 6.99)).toEqual({ ok: true, amount: 6.99 });
    expect(store.checkRefund("c25", "DH-20777", 20)).toEqual({ ok: false, error: "At most $18.97 of this order can be refunded." });
    expect(store.checkRefund("c25", "DH-20777", -1)).toMatchObject({ ok: false });
    expect(store.checkRefund("c04", "DH-20911")).toEqual({ ok: false, error: "This order's payment hasn't cleared yet, so there's nothing to refund. Cancel it instead." });
    expect(store.checkRefund("c20", "DH-20255")).toEqual({ ok: false, error: "This order was refunded in full already, at 2026-11-12T16:25Z. Refunds reach the original payment method in 3 to 5 business days." });
    expect(store.checkRefund("c02", "DH-20417")).toEqual({ ok: false, error: "No order DH-20417 on this account." });

    // Lucas was charged for Stealth Copilot twice: one back.
    const first = store.refund("c08", "DH-20720", 6.99, "call-1");
    expect(first).toMatchObject({ ok: true, refunded: 6.99, arrivesIn: "3 to 5 business days" });
    expect(store.refund("c08", "DH-20720", 6.99, "call-1")).toBe(first);
    expect(store.getOrder("c08", "DH-20720")).toMatchObject({ refunded: 6.99, status: "unlocked, partly refunded" });
    expect(store.refund("c08", "DH-20720", undefined, "call-2")).toMatchObject({ ok: true, refunded: 6.99 });
    expect(store.getOrder("c08", "DH-20720")).toMatchObject({ status: "refunded (the looks are locked again)", shownOnMyPurchasesPage: "Refunded" });
    expect(store.checkRefund("c08", "DH-20720")).toMatchObject({ ok: false, error: expect.stringContaining("refunded in full already") });
  });

  it("cancels orders whose payment hasn't cleared, so nothing is charged", () => {
    const store = shop();
    expect(store.checkCancel("c11", "DH-20471")).toEqual({ ok: false, error: "Already paid and unlocked, so it can't be cancelled. It can be refunded within 14 days of purchase." });
    expect(store.cancel("c04", "DH-20911", "call-1")).toEqual({ ok: true, orderId: "DH-20911", status: "cancelled", refunded: 5.99, note: "The pending payment is voided: nothing is charged." });
    expect(store.cancel("c04", "DH-20911", "call-2")).toEqual({ ok: false, error: "This order is cancelled already." });
    expect(store.checkUnlock("c04", "DH-20911")).toMatchObject({ status: "cancelled", shownOnMyPurchasesPage: "Cancelled", note: "Cancelled before the payment cleared: nothing was charged." });
    expect(store.checkRefund("c04", "DH-20911")).toMatchObject({ ok: false, error: expect.stringContaining("cancelled") });
  });

  it("starts every simulation with fresh data", () => {
    const store = shop();
    store.cancel("c04", "DH-20911", "call-1");
    store.reset(start);
    expect(store.checkCancel("c04", "DH-20911")).toEqual({ ok: true, amount: 5.99 });
    expect(store.cancel("c04", "DH-20911", "call-1")).toMatchObject({ ok: true });
  });
});
