/**
 * The assistant demo's scripted happy path, driven through the real UI in Microsoft Edge (playwright-core uses the
 * installed browser; nothing is downloaded). Every step talks to the live platform and a real model.
 *
 *   pnpm --filter @managed-copilot/demo-assistant happy-path -- [options]
 *
 *   --url <url>          Assistant URL (default http://localhost:7490)
 *   --fresh              Start a new conversation first (Settings → Start over)
 *   --skip-basics        Skip the inbox triage and the meeting with Sam
 *   --reminder           Ask for a reminder one minute out and wait for the proactive message (needs schedules)
 *   --offline            Close the tab, let a scheduled check-in use the calendar through the webhook, then reopen
 *   --sandbox            Chart the meeting load in a Python sandbox (approved in the chat), send it a follow-up that
 *                        reuses it, then research a candidate in a web research sandbox (a new one)
 *   --sandbox-away       In a new conversation, close the tab while a new sandbox waits for approval (nothing starts),
 *                        reopen and approve it, then ask something else while it works
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
/** A sandbox turn includes starting the sandbox and its work. */
const SANDBOX_TIMEOUT = 12 * 60_000;

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

async function open(browser: Browser, options: { colorScheme?: "light" | "dark"; mobile?: boolean; busy?: boolean } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    isMobile: options.mobile,
    hasTouch: options.mobile,
    colorScheme: options.colorScheme ?? "light",
  });
  const page = await context.newPage();
  await page.goto(url);
  await waitOnline(page, options.busy);
  return { context, page };
}

/** Waits until the assistant is online (`busy`: or online with a turn running, e.g. one waiting for an approval). */
async function waitOnline(page: Page, busy = false): Promise<void> {
  await page.locator(busy ? '[data-testid="status"]:is([data-status="ok"], [data-status="busy"])' : '[data-testid="status"][data-status="ok"]').waitFor({ timeout: 120_000 });
}

/** Waits for a turn to start and finish (the header goes busy, then back to online). */
async function waitTurn(page: Page, timeout = TURN_TIMEOUT): Promise<void> {
  await page.locator('[data-testid="status"][data-status="busy"]').waitFor({ timeout: 30_000 }).catch(() => undefined);
  await page.locator('[data-testid="status"][data-status="ok"]').waitFor({ timeout });
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

async function state(page: Page): Promise<{ schedulesError?: string; offline: { webhookConfigured: boolean }; background: { state: string }; sandboxes: SandboxesState }> {
  return page.evaluate(async () => (await fetch("/api/state")).json());
}

interface SandboxesState {
  enabled: boolean;
  unavailable?: { reason: string };
  workers: { id: string; name: string; environment: string; state: string; messages: number; outputs: { path: string; image: boolean }[] }[];
}

/** Approves the newest sandbox the assistant asks to start, then (unless `wait` is false) waits for its card to finish its work. */
async function approveSandbox(page: Page, environment: string, screenshot?: string, options: { wait?: boolean } = {}): Promise<string> {
  const approval = page.locator('[data-testid="approval"][data-tool="start_worker"][data-status="pending"][data-actionable="true"]').last();
  await approval.waitFor({ timeout: TURN_TIMEOUT });
  const title = (await approval.locator("h3").innerText()).trim();
  const details = (await approval.locator('[data-testid="sandbox-approval"]').innerText()).replace(/\s+/g, " ");
  ok(`asked first: ${title} ${details.slice(0, 140)}…`);
  if (!details.includes(environment)) throw new Error(`Expected a sandbox in ${environment}, but the approval card shows: ${details.slice(0, 200)}`);
  const worker = (await approval.locator('[data-testid="sandbox-approval"] .font-semibold').first().innerText()).trim();
  await approval.scrollIntoViewIfNeeded();
  if (screenshot) await shot(page, screenshot);
  await approval.getByRole("button", { name: "Start sandbox" }).click();
  // Once approved, the approval card turns into the sandbox's own card.
  await page.locator(`[data-testid="sandbox-card"][data-action="start"][data-worker="${worker}"]`).last().waitFor({ timeout: 60_000 });
  ok(`created sandbox ${worker}${options.wait === false ? "" : "; waiting for its work"}`);
  if (options.wait === false) return worker;
  await page.locator(`[data-testid="sandbox-card"][data-action="start"][data-worker="${worker}"][data-phase="done"]`).last().waitFor({ timeout: SANDBOX_TIMEOUT });
  return worker;
}

/**
 * Starting a sandbox waits for the person even when they are away: in a new conversation (so there's no sandbox to
 * reuse), close the tab with the approval pending, check that nothing started meanwhile, reopen, and approve it then.
 * Also asks something new while that sandbox works.
 */
async function sandboxAwayJourney(browser: Browser, context: BrowserContext, page: Page): Promise<{ context: BrowserContext; page: Page }> {
  step("Start a new conversation, ask for a sandbox, then close the tab before approving it");
  await startOver(page, { demo: false });
  await send(page, "Use a Python sandbox to work out my average meeting length for each of the last four weeks, and chart it as SVG.");
  const approval = page.locator('[data-testid="approval"][data-tool="start_worker"][data-status="pending"][data-actionable="true"]').last();
  await approval.waitFor({ timeout: TURN_TIMEOUT });
  const worker = (await approval.locator('[data-testid="sandbox-approval"] .font-semibold').first().innerText()).trim();
  const known = (await state(page)).sandboxes.workers.length;
  await context.close();
  ok(`tab closed while ${worker} waits for approval; waiting for the assistant to detach`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 45_000));
  const away = (await (await fetch(`${url}/api/state`, { headers: { "sec-fetch-site": "same-origin" } })).json()) as {
    conversation: { attach: string };
    offline: { waitingApprovals: number };
    sandboxes: SandboxesState;
  };
  if (away.conversation.attach !== "detached") throw new Error(`Expected the conversation to be detached, but it is ${away.conversation.attach}.`);
  if (away.sandboxes.workers.length !== known) throw new Error("A sandbox started while nobody was there to approve it.");
  ok(`detached; nothing started; ${away.offline.waitingApprovals} approval${away.offline.waitingApprovals === 1 ? "" : "s"} waiting for you`);

  step("Come back: the same approval is waiting");
  ({ context, page } = await open(browser, { busy: true }));
  const back = page.locator(`[data-testid="approval"][data-tool="start_worker"][data-status="pending"][data-actionable="true"]`).last();
  await back.waitFor({ timeout: 60_000 });
  const again = (await back.locator('[data-testid="sandbox-approval"] .font-semibold').first().innerText()).trim();
  if (again !== worker) throw new Error(`Expected the approval for ${worker}, got ${again}.`);
  ok(`the approval for ${worker} is back and can be answered`);
  await approveSandbox(page, "assistant-python", undefined, { wait: false });

  step("Ask something new while it works");
  await page.locator(`[data-testid="sandbox-card"][data-worker="${worker}"]:is([data-phase="starting"], [data-phase="working"], [data-phase="done"])`).last().waitFor({ timeout: SANDBOX_TIMEOUT });
  const replies = await page.locator('[data-testid="assistant-message"]').count();
  await send(page, "While that runs: when is my first meeting tomorrow?");
  await page.locator('[data-testid="assistant-message"][data-streaming="false"]').nth(replies).waitFor({ timeout: TURN_TIMEOUT });
  const phase = await page.locator(`[data-testid="sandbox-card"][data-worker="${worker}"]`).last().getAttribute("data-phase");
  ok(`answered (${await lastReply(page)}…) while ${worker} was ${phase}`);
  await page.locator(`[data-testid="sandbox-card"][data-worker="${worker}"][data-phase="done"]`).last().waitFor({ timeout: SANDBOX_TIMEOUT });
  await waitTurn(page, SANDBOX_TIMEOUT);
  ok(`reply: ${await lastReply(page)}…`);
  return { context, page };
}

/** Brings the side panel's Sandboxes section into view (its own scroll), for screenshots of the chat beside it. */
async function showSandboxesPanel(page: Page): Promise<void> {
  await page.locator('[data-testid="sandboxes"]').scrollIntoViewIfNeeded().catch(() => undefined);
}

async function sandboxJourney(page: Page): Promise<void> {
  const before = await state(page);
  if (!before.sandboxes.enabled) throw new Error(`Sandboxes aren't available: ${before.sandboxes.unavailable?.reason ?? "the assistant environment isn't an orchestrator"}`);

  step("Chart the meeting load (a new Python sandbox, after you approve it)");
  await send(page, "How did my meeting load change over the last four weeks? A chart would help.");
  const stats = await approveSandbox(page, "assistant-python", "sandbox-approval");
  await waitTurn(page, SANDBOX_TIMEOUT);
  ok(`reply: ${await lastReply(page)}…`);
  const images = await page.locator('[data-testid="sandbox-image"] img').count();
  ok(images > 0 ? `${images} chart${images === 1 ? "" : "s"} from the sandbox in the chat` : "the sandbox published no image this time");
  await page.locator(`[data-testid="sandbox-row"][data-worker="${stats}"]`).waitFor({ timeout: 30_000 });
  ok(`side panel lists ${stats}`);
  await page.locator('[data-testid="assistant-message"]').last().scrollIntoViewIfNeeded();
  await showSandboxesPanel(page);
  await shot(page, "sandbox");

  step("Follow up: the same sandbox gets it (reused, no new approval)");
  const starts = await page.locator('[data-testid="approval"][data-tool="start_worker"]').count();
  await send(page, "Split it by meeting type too.");
  const reused = page.locator(`[data-testid="sandbox-card"][data-action="message"][data-worker="${stats}"]`).last();
  await reused.waitFor({ timeout: TURN_TIMEOUT });
  ok(`sent the follow-up to ${stats}`);
  await page.locator(`[data-testid="sandbox-card"][data-action="message"][data-worker="${stats}"][data-phase="done"]`).last().waitFor({ timeout: SANDBOX_TIMEOUT });
  await waitTurn(page, SANDBOX_TIMEOUT);
  const startsAfter = await page.locator('[data-testid="approval"][data-tool="start_worker"]').count();
  if (startsAfter !== starts) throw new Error("The follow-up started a new sandbox instead of reusing the first one.");
  ok(`reply: ${await lastReply(page)}…`);
  await page.locator(`[data-testid="sandbox-card"][data-action="message"][data-worker="${stats}"]`).last().scrollIntoViewIfNeeded();
  await showSandboxesPanel(page);
  await shot(page, "sandbox-reused");

  step("Research the candidate (a different kind of work: a new web research sandbox)");
  await send(page, "Also check what the candidate in my next interview works on in open source.");
  const research = await approveSandbox(page, "assistant-web", "sandbox-research-approval");
  await waitTurn(page, SANDBOX_TIMEOUT);
  ok(`reply: ${await lastReply(page)}…`);

  const after = (await state(page)).sandboxes.workers;
  for (const worker of after) ok(`sandbox ${worker.name} (${worker.environment}): ${worker.state}, ${worker.messages} task${worker.messages === 1 ? "" : "s"}, ${worker.outputs.length} output${worker.outputs.length === 1 ? "" : "s"}`);
  const statsWorker = after.find((worker) => worker.name === stats);
  if (!statsWorker || statsWorker.messages < 2) throw new Error(`${stats} should have received the follow-up as its second task.`);
  if (!after.some((worker) => worker.name === research && worker.environment === "assistant-web")) throw new Error(`${research} should be a sandbox in assistant-web.`);
  await showSandboxesPanel(page);
  await shot(page, "sandbox-research");
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

/** Settings → Start over (and, with `demo`, fresh demo data), then waits for the new, empty conversation. */
async function startOver(page: Page, options: { demo: boolean }): Promise<void> {
  await page.evaluate(async (paths) => {
    for (const path of paths) {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`);
    }
  }, options.demo ? ["/api/conversation/reset", "/api/demo/reset"] : ["/api/conversation/reset"]);
  await page.getByText("Triage my inbox").waitFor({ timeout: 120_000 });
  await waitOnline(page);
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: "msedge", headless: !flag("headed") });
  try {
    step(`Opening ${url}`);
    // The conversation may still be busy from an earlier run (for example, a sandbox waiting for approval).
    let { context, page } = await open(browser, { busy: true });
    ok("assistant is online");

    if (flag("fresh")) {
      step("Starting a new conversation with fresh demo data");
      await startOver(page, { demo: true });
      ok("fresh conversation ready");
    }

    // Like a first run: reminders and check-ins need background work, so it's turned on before anything else.
    if (flag("reminder") || flag("offline")) {
      const { schedulesError } = await state(page);
      if (schedulesError) throw new Error(`Schedules are unavailable: ${schedulesError}`);
      await ensureBackgroundWork(page);
    }
    if (flag("fresh")) await shot(page, "welcome");

    if (!flag("skip-basics")) {
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
    }

    if (flag("sandbox")) await sandboxJourney(page);
    if (flag("sandbox-away")) ({ context, page } = await sandboxAwayJourney(browser, context, page));

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
