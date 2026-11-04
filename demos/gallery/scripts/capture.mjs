// Captures the gallery's screenshots into shots/: each app as it runs on your local platform. Run with the platform up
// (`aspire run`):
//
//   pnpm --filter @managed-copilot/demo-gallery capture [--only <id,...>] [--dark]
//
// Apps show whatever they hold, so run a demo or two first for screens with content. `--only gallery` captures the
// gallery itself into docs/gallery.png instead, from a running `pnpm gallery`. Uses Microsoft Edge through
// playwright-core; set GALLERY_BROWSER_CHANNEL=chrome to use Chrome.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "../..");
const shots = join(root, "shots");
mkdirSync(shots, { recursive: true });

const { values } = parseArgs({ options: { only: { type: "string" }, dark: { type: "boolean" } } });
const only = values.only ? new Set(values.only.split(",").map((id) => id.trim())) : undefined;
const wanted = (id) => !only || only.has(id);
const offset = Number(process.env.MANAGED_COPILOT_PORT_OFFSET ?? 0);
const local = (port) => `http://localhost:${port + offset}`;
const VIEWPORT = { width: 1440, height: 900 };
const GALLERY_PORT = 7460;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Each app's screen: where to go and what to do so it shows real work. */
const APPS = [
  {
    id: "dispatch",
    url: local(7470),
    async prepare(page) {
      // Open the most recent conversation when there is one.
      const first = page.locator('a[href^="#/c/"], a[href*="/c/"]').first();
      if (await first.count()) await first.click();
    },
  },
  {
    id: "software-factory",
    url: local(7480),
    async prepare(page) {
      const first = page.locator('a[href*="WO-"], a[href*="/orders/"], a[href*="#/wo"]').first();
      if (await first.count()) await first.click();
    },
  },
  { id: "assistant", url: local(7490) },
  {
    id: "research-swarm",
    url: local(7425),
    async prepare(page) {
      // Open the most recent finished report when there is one.
      const first = page.locator('a[href^="#/r/"]').first();
      if (await first.count()) await first.click();
    },
  },
  {
    id: "incident-commander",
    url: local(7445),
    async prepare(page) {
      // Open the newest incident when there is one: its response map, and its approval or postmortem.
      const first = page.locator('a[href^="#/incidents/"]').first();
      if (await first.count()) await first.click();
    },
  },
  {
    id: "data-desk",
    url: local(7430),
    async prepare(page) {
      // Open the most recent analysis when there is one (after the move, it shows the session docked in its sandbox).
      const first = page.locator('a[href^="#/a/"]').first();
      if (await first.count()) await first.click();
    },
  },
  {
    id: "pattern-race",
    url: local(7420),
    async prepare(page) {
      // The board shows the last race, if one ran (`pnpm --filter @managed-copilot/demo-pattern-race happy-path`).
      await page.getByRole("region", { name: "Race board" }).waitFor({ timeout: 10_000 });
      await page.getByRole("region", { name: "Scorecard" }).waitFor({ timeout: 3_000 }).catch(() => undefined);
    },
  },
  {
    id: "help-desk",
    url: local(7440),
    async prepare(page) {
      // The wall of the latest simulation; wait for its live tiles when there is one.
      await page.locator("article[data-ticket]").first().waitFor({ timeout: 10_000 }).catch(() => undefined);
    },
  },
  {
    id: "console",
    // A one-time sign-in link from `managed-copilot console --json`.
    url: () => {
      const cli = join(repo, "libraries/cli/bin/managed-copilot.mjs");
      const result = spawnSync(process.execPath, [cli, "console", "--json", "--no-open", "--url", local(7400)], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`managed-copilot console failed: ${result.stderr.trim()}`);
      return JSON.parse(result.stdout).url;
    },
    async prepare(page) {
      const sessions = page.getByRole("link", { name: /^Sessions$/ }).first();
      if (await sessions.count()) await sessions.click();
    },
  },
];

const browser = await chromium.launch({ channel: process.env.GALLERY_BROWSER_CHANNEL ?? "msedge", headless: true });
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1.5, colorScheme: values.dark ? "dark" : "light" });
const failures = [];

for (const app of APPS.filter((a) => wanted(a.id))) {
  const page = await context.newPage();
  try {
    const url = typeof app.url === "function" ? app.url() : app.url;
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    await sleep(2_500);
    await app.prepare?.(page);
    await sleep(3_000);
    await page.screenshot({ path: join(shots, `${app.id}.png`) });
    console.log(`✓ ${app.id}`);
  } catch (error) {
    failures.push(app.id);
    console.error(`✗ ${app.id}: ${error.message.split("\n")[0]}`);
  } finally {
    await page.close();
  }
}

// The gallery's own picture for its README (docs/gallery.png): the header, the hero, and the patterns, from a running
// `pnpm gallery` (same port offset). Only with --only gallery.
if (only?.has("gallery")) {
  const page = await context.newPage();
  try {
    await page.goto(local(GALLERY_PORT), { waitUntil: "load", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    // Wait for the first status check, so the header shows real dots rather than spinners.
    await page.waitForFunction(() => !document.querySelector("header .animate-spin"), undefined, { timeout: 20_000 }).catch(() => undefined);
    await sleep(1_000);
    const bottom = await page.locator("#patterns").evaluate((section) => section.getBoundingClientRect().bottom + window.scrollY);
    await page.screenshot({ path: join(root, "docs", "gallery.png"), clip: { x: 0, y: 0, width: VIEWPORT.width, height: Math.ceil(bottom) + 32 } });
    console.log("✓ gallery");
  } catch (error) {
    failures.push("gallery");
    console.error(`✗ gallery: ${error.message.split("\n")[0]}. Is the gallery running (pnpm gallery)?`);
  } finally {
    await page.close();
  }
}

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} screenshot(s) failed. Is the platform running (aspire run)?`);
  process.exitCode = 1;
}
