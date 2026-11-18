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
    const { addItem, createCart, subtotalCents } = await load("src/cart.js");
    const { statusLabel } = await load("src/purchase-status.js");
    expect(applyPromoCode("TRAIL15", 499)).toMatchObject({ discountCents: 75 });
    expect(() => applyPromoCode("TRAIL15 ", 499)).toThrow("Invalid code.");
    expect(() => applyPromoCode("trail15", 499)).toThrow("Invalid code.");
    const stealth = { sku: "copilot-stealth", name: "Stealth Copilot", priceCents: 699 };
    const twice = addItem(addItem(createCart(), stealth), stealth);
    expect(twice.lines[0].quantity).toBe(2);
    expect(subtotalCents(twice)).toBe(1_398);
    expect(statusLabel([{ at: "2026-11-12T17:41:00Z", description: "Waiting to unlock: bank transfer pending" }])).toBe("Unlocked");
  });
});
