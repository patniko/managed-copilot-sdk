import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { STOREFRONT_DIR } from "./fakes.js";

const run = promisify(execFile);
// Plain JavaScript, loaded at run time: the storefront is its own codebase, not part of Help Desk's TypeScript.
const load = (path: string) => import(pathToFileURL(join(STOREFRONT_DIR, path)).href);

describe("the storefront codebase", () => {
  it("passes its own tests", async () => {
    const { stdout } = await run(process.execPath, ["--test"], { cwd: STOREFRONT_DIR });
    expect(stdout).toMatch(/fail 0/);
  });

  it("has the bugs Help Desk's customers run into, for Software Factory to fix", async () => {
    const { applyPromoCode } = await load("src/promotions.js");
    const { addItem, createCart, updateQuantity } = await load("src/cart.js");
    const { statusLabel } = await load("src/order-status.js");
    expect(applyPromoCode("TRAIL15", 18_900)).toMatchObject({ discountCents: 2_835 });
    expect(() => applyPromoCode("TRAIL15 ", 18_900)).toThrow("Invalid code.");
    expect(() => applyPromoCode("trail15", 18_900)).toThrow("Invalid code.");
    const cart = addItem(createCart(), { sku: "BTL-32", name: "Canyon Water Bottle 32 oz", priceCents: 2_400 });
    expect(updateQuantity(cart, "BTL-32", 2).lines[0].quantity).toBe(3);
    expect(statusLabel([{ at: "2026-11-03T08:00:00Z", location: "Denver, CO", description: "Out for delivery" }])).toBe("Delivered");
  });
});
