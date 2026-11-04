/**
 * Captures the README's screenshots (docs/screenshots) from a running Front Desk, in GitHub's light theme:
 *
 *   pnpm --filter @managed-copilot/demo-front-desk exec tsx scripts/screenshots.ts [--url http://localhost:7450] [--dark]
 *
 * - signin.png: the sign-in page.
 * - github-user.png: a GitHub user (this computer's GitHub CLI sign-in) in their latest conversation, memory open.
 * - email-user.png: an email user, when FRONT_DESK_SHOT_EMAIL and FRONT_DESK_SHOT_PASSWORD name an account with a
 *   conversation.
 *
 * Uses Microsoft Edge through playwright-core; set FRONT_DESK_BROWSER_CHANNEL=chrome to use Chrome.
 */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright-core";

const { values } = parseArgs({ options: { url: { type: "string" }, dark: { type: "boolean" } } });
const base = (values.url ?? process.env.FRONT_DESK_URL ?? "http://localhost:7450").replace(/\/+$/, "");
const out = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "docs", "screenshots");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: process.env.FRONT_DESK_BROWSER_CHANNEL ?? "msedge", headless: true });
const context = () => browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: values.dark ? "dark" : "light" });

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(600);
}

async function openLatestWithMemory(page: Page): Promise<void> {
  const first = page.locator('nav[aria-label="Your conversations"] a[href^="/c/"]').first();
  if (await first.count()) {
    await first.click();
    await page.getByText("Front Desk", { exact: false }).last().waitFor({ timeout: 15_000 }).catch(() => undefined);
  }
  await page.getByRole("button", { name: /What Front Desk remembers about you/ }).click();
  await settle(page);
}

{
  const page = await (await context()).newPage();
  await page.goto(base);
  await page.getByRole("heading", { name: "Sign in to Front Desk" }).waitFor();
  await settle(page);
  await page.screenshot({ path: join(out, "signin.png") });
  console.log("signin.png");
}

{
  const page = await (await context()).newPage();
  await page.goto(base);
  const local = page.getByRole("button", { name: "Use this computer's GitHub sign-in" });
  if (await local.count()) {
    await local.click();
    await page.getByRole("button", { name: /^Account:/ }).waitFor({ timeout: 30_000 });
    await openLatestWithMemory(page);
    await page.screenshot({ path: join(out, "github-user.png") });
    console.log("github-user.png");
  } else {
    console.log("github-user.png skipped: this Front Desk doesn't offer this computer's GitHub sign-in");
  }
}

if (process.env.FRONT_DESK_SHOT_EMAIL && process.env.FRONT_DESK_SHOT_PASSWORD) {
  const page = await (await context()).newPage();
  await page.goto(base);
  await page.getByLabel("Email").fill(process.env.FRONT_DESK_SHOT_EMAIL);
  await page.getByLabel("Password").fill(process.env.FRONT_DESK_SHOT_PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await page.getByRole("button", { name: /^Account:/ }).waitFor({ timeout: 30_000 });
  await openLatestWithMemory(page);
  await page.screenshot({ path: join(out, "email-user.png") });
  console.log("email-user.png");
}

await browser.close();
