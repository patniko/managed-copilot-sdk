/**
 * Downhill's happy path, played in the real game in Microsoft Edge (playwright-core drives the installed browser;
 * nothing is downloaded): ride as Mona, open the shop from the pause menu, try the launch offer's code and see checkout
 * reject it, open Support and tell the agent "My discount code isn't working", check that TRAIL15 works, buy anyway,
 * and ride in the new look. A fresh browser profile starts with nothing bought. The rejected code is recorded in the
 * sales ledger Data Desk reads, and (with INCIDENT_URL set) alerts Incident Commander, which opens an incident and
 * starts its response: a handful of premium requests and sandboxes of its own.
 *
 * Support opens one ticket in Help Desk when Downhill's server has HELP_DESK_URL, and the script writes one message in
 * its chat (Help Desk's agent answers it with a real model: a premium request or so). Without it, the script checks
 * that the game says support isn't connected.
 *
 *   pnpm --filter @managed-copilot/demo-downhill happy-path -- [options]
 *
 *   --url <url>          Downhill's address (default http://localhost:7455, after MANAGED_COPILOT_PORT_OFFSET)
 *   --reset              Reset the demo first: start launch day over, and clear live sales, deployed fixes, and the
 *                        alert (POST /api/demo/reset)
 *   --screenshots <dir>  Save ride.png, shop.png, promo-error.png, and support.png into <dir>
 *   --headed             Show the browser window
 *
 * Set DOWNHILL_BROWSER_CHANNEL=chrome to use Chrome instead of Edge.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const offset = Number(process.env.MANAGED_COPILOT_PORT_OFFSET ?? 0);
const url = (option("url") ?? `http://localhost:${7455 + offset}`).replace(/\/+$/, "");
const screenshots = option("screenshots") ? resolve(option("screenshots")!) : undefined;

interface Probe {
  state: string;
  session?: string;
  time?: number;
  speed?: number;
  stats?: { checkpoints: number; totalCheckpoints: number };
  shop: { rider: string; owned: string[]; equipped: Record<string, string> };
}

function step(message: string): void {
  console.log(`\n▸ ${message}`);
}

function ok(message: string): void {
  console.log(`  ✓ ${message}`);
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!screenshots) return;
  mkdirSync(screenshots, { recursive: true });
  // let panels finish fading in
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(screenshots, `${name}.png`) });
  ok(`saved ${name}.png`);
}

const probe = (page: Page) => page.evaluate(() => (globalThis as unknown as { __probe(): Probe }).__probe());

const COMPLAINT = "My discount code isn't working";

interface SalesRow {
  event: string;
  promo_code: string | null;
  promo_result: string;
  player: string;
  source: string;
}

const browser = await chromium.launch({
  channel: process.env.DOWNHILL_BROWSER_CHANNEL ?? "msedge",
  headless: !flag("headed"),
  // WebGL on the GPU; the game is unplayably slow on a software rasterizer
  args: ["--enable-gpu", "--ignore-gpu-blocklist", ...(process.platform === "win32" ? ["--use-angle=d3d11"] : [])],
});
const errors: string[] = [];
let failed = false;
try {
  const health = await fetch(`${url}/api/health`).catch(() => undefined);
  check(health?.ok, `Downhill isn't answering at ${url}. Start it with \`aspire run\` (or \`pnpm --filter @managed-copilot/demo-downhill start\`), or pass --url.`);
  const { connected } = (await (await fetch(`${url}/api/support`)).json()) as { connected: boolean };
  if (flag("reset")) {
    step("Reset the demo");
    const reset = await fetch(`${url}/api/demo/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeline: "restart" }) });
    const answer = (await reset.json().catch(() => undefined)) as { message?: string; error?: { message?: string } } | undefined;
    check(reset.ok, `The demo didn't reset: ${answer?.error?.message ?? `HTTP ${reset.status}`}`);
    ok(answer?.message ?? "reset");
  }
  const liveRejections = async () => ((await (await fetch(`${url}/api/sales`)).json()) as { rows: SalesRow[] }).rows.filter((row) => row.source === "live" && row.event === "promo_rejected");
  const rejectedBefore = (await liveRejections()).length;

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));

  step("Ride: Mona drops in on Citadel Coast, on autopilot");
  await page.goto(`${url}/?play&autopilot&env=citadel&char=mona&readyMs=1000`);
  await page.waitForFunction(() => (globalThis as unknown as { __ready?: boolean }).__ready === true, undefined, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const p = (globalThis as unknown as { __probe(): Probe }).__probe();
    return p.session === "riding" && (p.time ?? 0) > 9;
  }, undefined, { timeout: 60_000 });
  const riding = await probe(page);
  check((riding.speed ?? 0) > 3, `The bike should be moving (speed ${riding.speed?.toFixed(1)} m/s).`);
  ok(`riding at ${Math.round((riding.speed ?? 0) * 3.6)} km/h, ${riding.time?.toFixed(1)} s in, checkpoints ${riding.stats?.checkpoints}/${riding.stats?.totalCheckpoints}`);
  await shot(page, "ride");

  step("Pause, then open the shop");
  await page.keyboard.press("Escape");
  check(await page.getByRole("button", { name: "Support", exact: true }).isVisible(), "The pause menu should offer Support.");
  await page.getByRole("button", { name: "Shop", exact: true }).click();
  const shop = page.locator(".screen.shop");
  await shop.waitFor({ state: "visible" });
  check((await probe(page)).state === "shop", "The pause menu's Shop button should open the shop.");
  check(await page.evaluate(() => (globalThis as unknown as { __game: { input: { suspended: boolean } } }).__game.input.suspended), "Game keys should be off while the shop is open.");
  const footer = page.locator(".storefront-line");
  await footer.getByText(/^Checkout: storefront v\d+\.\d+\.\d+/).waitFor({ timeout: 15_000 });
  ok(`the shop is open, and game keys are off. ${await footer.innerText()}`);

  step("Try on Neon Mona and put her in the cart");
  await page.locator('.shop-item[data-sku="mona-neon"]').click();
  await page.locator(".shop-caption").getByText("Neon Mona").waitFor();
  await page.locator(".shop-caption").getByRole("button", { name: "Add to cart" }).click();
  await page.locator(".shop-cart .lines").getByText("Neon Mona").waitFor();
  check((await page.locator(".shop-cart .sum.total").innerText()).includes("$4.99"), "The cart's total should be $4.99.");
  ok("Neon Mona is in the cart: $4.99");
  await page.waitForTimeout(1_500);
  await shot(page, "shop");

  step("Apply the launch offer's code from the banner");
  await page.locator(".shop-offer").getByRole("button", { name: "Apply code" }).click();
  check((await page.locator("#shop-promo").inputValue()) === "trail15", "The banner should put trail15 in the Promo code field.");
  const error = page.locator(".promo-note.error");
  await error.waitFor();
  const message = await error.locator(".promo-msg").innerText();
  check(message === "Invalid code.", `Checkout should reject trail15 with "Invalid code." (it said "${message}").`);
  check(await error.getByRole("button", { name: "Contact support" }).isVisible(), 'The error should offer "Code not working? Contact support".');
  ok(`checkout says "${message}", with Contact support under it`);
  await shot(page, "promo-error");
  // The shop reports it without holding up the player.
  const deadline = Date.now() + 10_000;
  while ((await liveRejections()).length <= rejectedBefore && Date.now() < deadline) await new Promise((done) => setTimeout(done, 250));
  const recorded = (await liveRejections()).at(-1);
  check(recorded && (await liveRejections()).length > rejectedBefore, "The rejected code should be in the sales ledger (GET /api/sales) as a live promo_rejected row.");
  check(recorded.promo_code === "trail15" && recorded.promo_result === "rejected" && recorded.player === "Mona", `The ledger's row should be Mona's rejected trail15 (it's ${JSON.stringify(recorded)}).`);
  ok("the sales ledger has Mona's rejected trail15, for Data Desk");

  step(connected ? `Open Support from the shop and tell the agent "${COMPLAINT}"` : "Open Support from the shop: support isn't connected");
  await page.locator(".shop-top").getByRole("button", { name: "Support", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Contoso Outdoors support" });
  await panel.waitFor();
  check(((await panel.locator(".support-head").textContent()) ?? "").includes("AI agent"), "The support panel should say it's an AI agent.");
  if (connected) {
    const frame = panel.locator("iframe");
    await frame.waitFor({ timeout: 20_000 });
    const src = await frame.getAttribute("src");
    check(src && /^https?:\/\//.test(src), "The chat should open at Help Desk's address.");
    await panel.locator(".support-status").waitFor({ state: "detached", timeout: 20_000 });
    ok(`the chat opened at ${src}, with nothing said for the player`);
    const chat = page.frameLocator(".support iframe");
    const box = chat.getByRole("textbox").last();
    // The chat takes messages once its session is ready.
    await box.fill(COMPLAINT, { timeout: 60_000 });
    await box.press("Enter");
    await chat.getByText(COMPLAINT).first().waitFor({ timeout: 30_000 });
    ok(`sent "${COMPLAINT}"`);
    const said = (await chat.locator("body").innerText()).length;
    let replied = false;
    for (const started = Date.now(); !replied && Date.now() - started < 60_000; ) {
      await page.waitForTimeout(500);
      replied = (await chat.locator("body").innerText()).length > said + 40;
    }
    ok(replied ? "the agent is answering" : "no answer within a minute yet: Help Desk's agent may still be starting");
  } else {
    const notice = await panel.locator(".support-error").innerText({ timeout: 20_000 });
    check(notice.includes("Support isn't connected."), `The panel should say support isn't connected (it said "${notice}").`);
    ok("the panel says support isn't connected, with Try again");
  }
  await shot(page, "support");
  await panel.getByRole("button", { name: "Close support" }).click();
  await panel.waitFor({ state: "hidden" });

  step("Type TRAIL15 in capitals: checkout takes it");
  await page.locator("#shop-promo").fill("");
  await page.locator("#shop-promo").pressSequentially("TRAIL15");
  await page.locator(".promo").getByRole("button", { name: "Apply" }).click();
  await page.locator(".promo-note.ok").getByText("TRAIL15 applied: 15% off").waitFor();
  check((await page.locator(".shop-cart .sum.total").innerText()).includes("$4.24"), "TRAIL15 should take the total to $4.24.");
  ok("TRAIL15 takes 15% off: $4.24");

  step("Buy at full price with the banner's code, and get a receipt");
  await page.locator(".promo-note.ok").getByRole("button", { name: "Remove" }).click();
  await page.locator(".shop-offer").getByRole("button", { name: "Apply code" }).click();
  await error.waitFor();
  await page.locator(".shop-cart .buy").click();
  const receipt = page.locator(".shop-receipt .panel");
  await receipt.waitFor();
  const receiptText = await receipt.innerText();
  check(/Order DH-\d+/.test(receiptText) && receiptText.includes("Demo purchase, no real payment"), "The receipt should show an order number and say it's a demo purchase.");
  check(receiptText.includes("$4.99"), "The order should be at full price, $4.99.");
  check(await receipt.getByRole("button", { name: "Contact support" }).isVisible(), "A receipt without the discount should offer Contact support.");
  ok(`${/Order DH-\d+/.exec(receiptText)![0]}: $4.99, with Contact support for the missing discount`);

  step("Ride in the new look");
  await receipt.getByRole("button", { name: /^Ride as Mona/ }).click();
  await page.waitForFunction(() => (globalThis as unknown as { __probe(): Probe }).__probe().session === "riding", undefined, { timeout: 30_000 });
  const after = await probe(page);
  check(after.shop.rider === "mona" && after.shop.equipped["mona"] === "mona-neon", "Mona should be riding, in Neon Mona.");
  check(!(await page.evaluate(() => (globalThis as unknown as { __game: { input: { suspended: boolean } } }).__game.input.suspended)), "Game keys should be back on when riding.");
  ok("Mona drops in wearing Neon Mona");

  check(errors.length === 0, `The page reported errors: ${errors.slice(0, 3).join(" | ")}`);
  console.log("\nHappy path complete.");
} catch (error) {
  failed = true;
  console.error(`\n✗ ${(error as Error).message.split("\n")[0]}`);
} finally {
  // headless Edge occasionally never resolves close(); don't let that hang the run
  await Promise.race([browser.close().catch(() => undefined), new Promise((done) => setTimeout(done, 5_000))]);
}
process.exit(failed ? 1 : 0);
