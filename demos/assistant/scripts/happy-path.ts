/**
 * The assistant demo's scripted happy path, driven through the real UI in Microsoft Edge (playwright-core uses the
 * installed browser; nothing is downloaded). Every step talks to the live platform and a real model.
 *
 *   pnpm --filter @managed-copilot/demo-assistant happy-path -- [options]
 *
 *   --url <url>          Assistant URL (default http://localhost:7490)
 *   --fresh              Start a new conversation first (Settings → Start over)
 *   --reminder           Ask for a reminder one minute out and wait for the proactive message (needs schedules)
 *   --offline            Close the tab, let a scheduled check-in use the calendar through the webhook, then reopen
 *   --enable-background  If background work is off, turn it on with the side panel's one-click button (your consent
 *                        to keep a sealed copy of your GitHub sign-in on the deployment for scheduled work)
 *   --screenshots <dir>  Save screenshots (light, dark, and mobile) into <dir>
 *   --headed             Show the browser window
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const url = (option("url") ?? "http://localhost:7490").replace(/\/+$/, "");
const screenshots = option("screenshots") ? resolve(option("screenshots")!) : undefined;
const TURN_TIMEOUT = 4 * 60_000;

function step(message: string): void {
  console.log(`\n▸ ${message}`);
}

function ok(message: string): void {
  console.log(`  ✓ ${message}`);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!screenshots) return;
  mkdirSync(screenshots, { recursive: true });
  // Let avatars and fonts finish loading.
  await page.waitForFunction(() => [...document.images].every((image) => image.complete), undefined, { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(screenshots, `${name}.png`) });
  ok(`saved ${name}.png`);
}

async function open(browser: Browser, options: { colorScheme?: "light" | "dark"; mobile?: boolean } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    isMobile: options.mobile,
    hasTouch: options.mobile,
    colorScheme: options.colorScheme ?? "light",
  });
  const page = await context.newPage();
  await page.goto(url);
  await waitOnline(page);
  return { context, page };
}

async function waitOnline(page: Page): Promise<void> {
  await page.locator('[data-testid="status"][data-status="ok"]').waitFor({ timeout: 120_000 });
}

/** Waits for a turn to start and finish (the header goes busy, then back to online). */
async function waitTurn(page: Page): Promise<void> {
  await page.locator('[data-testid="status"][data-status="busy"]').waitFor({ timeout: 30_000 }).catch(() => undefined);
  await page.locator('[data-testid="status"][data-status="ok"]').waitFor({ timeout: TURN_TIMEOUT });
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.getByLabel("Message your assistant");
  await box.fill(text);
  await box.press("Enter");
}

async function lastReply(page: Page): Promise<string> {
  const text = await page.locator('[data-testid="assistant-message"]').last().locator(".markdown-body").innerText();
  return text.replace(/\s+/g, " ").slice(0, 160);
}

async function state(page: Page): Promise<{ schedulesError?: string; offline: { webhookConfigured: boolean }; background: { state: string } }> {
  return page.evaluate(async () => (await fetch("/api/state")).json());
}

/** Scheduled steps need background work; with --enable-background the script clicks the side panel's button. */
async function ensureBackgroundWork(page: Page): Promise<void> {
  let current = (await state(page)).background.state;
  for (let i = 0; current === "unknown" && i < 20; i++) {
    await page.waitForTimeout(500);
    current = (await state(page)).background.state;
  }
  if (current !== "off") {
    ok(`background work is ${current}`);
    return;
  }
  if (!flag("enable-background")) {
    throw new Error("Background work is off. Turn it on in the side panel (or run `npx managed-copilot login`), or pass --enable-background.");
  }
  step("Turn on background work (one click, with consent)");
  const card = page.locator('#background-work[data-state="off"]');
  await card.waitFor({ timeout: 10_000 });
  await shot(page, "background");
  await card.getByRole("button", { name: /Turn (on background work|background work back on)/ }).click();
  await page.locator('[data-testid="background"][data-state="on"]').waitFor({ timeout: 30_000 });
  ok("background work is on");
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: "msedge", headless: !flag("headed") });
  try {
    step(`Opening ${url}`);
    let { context, page } = await open(browser);
    ok("assistant is online");

    if (flag("fresh")) {
      step("Starting a new conversation with fresh demo data");
      await page.evaluate(async () => {
        for (const path of ["/api/conversation/reset", "/api/demo/reset"]) {
          const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`);
        }
      });
      await page.getByText("Triage my inbox").waitFor({ timeout: 120_000 });
      await waitOnline(page);
      ok("fresh conversation ready");
    }

    // Like a first run: reminders and check-ins need background work, so it's turned on before anything else.
    if (flag("reminder") || flag("offline")) {
      const { schedulesError } = await state(page);
      if (schedulesError) throw new Error(`Schedules are unavailable: ${schedulesError}`);
      await ensureBackgroundWork(page);
    }
    if (flag("fresh")) await shot(page, "welcome");

    step("Triage the demo inbox");
    await send(page, "Triage my unread email: what needs a reply, what's FYI, and what can wait?");
    await waitTurn(page);
    await page.locator('[data-testid="tool"][data-tool="search_email"][data-status="succeeded"]').first().waitFor({ timeout: 10_000 });
    ok(`reply: ${await lastReply(page)}…`);
    await shot(page, "triage");

    step("Schedule a meeting with Sam (needs approval)");
    await send(page, "Sam asked for 30 minutes to go over the Q3 launch plan. Find a time in the next few days that works (mornings are best for Sam) and send the invite.");
    const approval = page.locator('[data-testid="approval"][data-status="pending"][data-actionable="true"]').last();
    await approval.waitFor({ timeout: TURN_TIMEOUT });
    ok(`approval requested: ${(await approval.locator("div").first().innerText()).split("\n")[0]}`);
    await approval.scrollIntoViewIfNeeded();
    await shot(page, "approval");
    await approval.getByRole("button", { name: /Add to calendar|Send email|Save changes/ }).click();
    await page.locator('[data-testid="approval"][data-status="approved"]').last().waitFor({ timeout: 30_000 });
    await waitTurn(page);
    ok(`reply: ${await lastReply(page)}…`);
    await shot(page, "meeting");

    if (flag("reminder")) {
      step("Ask for a reminder one minute from now");
      await send(page, "Remind me in 1 minute to stretch and grab some water.");
      await waitTurn(page);
      await page.locator('[data-testid="tool"][data-tool="schedule_task"][data-status="succeeded"]').last().waitFor({ timeout: 10_000 });
      ok("reminder scheduled on the platform");
      await page.locator('[data-testid="trigger"]').last().waitFor({ timeout: 4 * 60_000 });
      ok("the schedule fired");
      await page.locator('[data-testid="assistant-message"][data-proactive="true"][data-streaming="false"]').last().waitFor({ timeout: TURN_TIMEOUT });
      ok(`proactive message: ${await lastReply(page)}…`);
      await shot(page, "reminder");
    }

    if (flag("offline")) {
      step("Schedule a check-in that needs the calendar, then close the tab");
      await send(page, "In 2 minutes, check my calendar for the next business day and tell me when my first meeting starts and what it is.");
      await waitTurn(page);
      await page.locator('[data-testid="tool"][data-tool="schedule_task"][data-status="succeeded"]').last().waitFor({ timeout: 10_000 });
      await context.close();
      ok("tab closed; waiting for the check-in to run on the platform (about 3 minutes)");
      await new Promise((resolveWait) => setTimeout(resolveWait, 3.5 * 60_000));
      ({ context, page } = await open(browser));
      const offlineTool = page.locator('[data-testid="tool"][data-offline="true"]').last();
      await offlineTool.waitFor({ timeout: 60_000 });
      ok("a calendar tool call was answered through the webhook while no tab was open");
      await page.locator('[data-testid="assistant-message"][data-proactive="true"]').last().scrollIntoViewIfNeeded();
      await shot(page, "offline");
    }
    await context.close();

    if (screenshots) {
      step("Dark and mobile screenshots");
      const dark = await open(browser, { colorScheme: "dark" });
      await shot(dark.page, "dark");
      await dark.context.close();
      const mobile = await open(browser, { mobile: true });
      await shot(mobile.page, "mobile");
      await mobile.context.close();
    }
    console.log("\nHappy path complete.");
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exit(1);
});
