// Records the assistant: triage, a booking that needs approval, a reminder, and work done while the tab is closed.
// Needs the assistant running with background work on: ASSISTANT_URL, default http://localhost:7490. Takes about
// 8 minutes. It starts a fresh conversation and resets the demo inbox and calendar. Close every other assistant tab
// first (including app side panels): the server only hands work to the platform once no tab is open.
import { launch, Recorder, sleep } from "./common.mjs";

const BASE = process.env.ASSISTANT_URL ?? "http://localhost:7490";
const TURN = 5 * 60_000;
const { browser, context } = await launch();
let page = await context.newPage();
let rec = new Recorder(page, { fps: 12 });

async function online() {
  await page.locator('[data-testid="status"][data-status="ok"]').waitFor({ timeout: 120_000 });
}
async function turn() {
  await page.locator('[data-testid="status"][data-status="busy"]').waitFor({ timeout: 30_000 }).catch(() => undefined);
  await page.locator('[data-testid="status"][data-status="ok"]').waitFor({ timeout: TURN });
}
async function say(text) {
  const box = page.getByLabel("Message your assistant");
  await box.click();
  await box.pressSequentially(text, { delay: 22 });
  await sleep(400);
  await box.press("Enter");
}

try {
  await page.goto(BASE);
  await online();
  await page.evaluate(async () => {
    for (const path of ["/api/conversation/reset", "/api/demo/reset"]) {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`);
    }
  });
  await page.reload();
  await page.getByText("Triage my inbox").first().waitFor({ timeout: 120_000 });
  await online();
  const state = await page.evaluate(async () => (await fetch("/api/state")).json());
  if (state.background?.state !== "on") throw new Error("Turn on background work first (side panel, or `npx managed-copilot login`).");
  await sleep(1500);

  await rec.start("assistant-welcome");
  await sleep(4000);
  await rec.stop();

  await rec.start("assistant-triage");
  await say("Triage my unread email: what needs a reply, what's FYI, and what can wait?");
  rec.mark("sent");
  await turn();
  rec.mark("answered");
  await sleep(3000);
  await rec.stop();

  await rec.start("assistant-meeting");
  await say("Sam asked for 30 minutes to go over the Q3 launch plan. Find a time in the next few days that works (mornings are best for Sam) and send the invite.");
  rec.mark("sent");
  const approval = page.locator('[data-testid="approval"][data-status="pending"][data-actionable="true"]').last();
  await approval.waitFor({ timeout: TURN });
  await approval.scrollIntoViewIfNeeded();
  rec.mark("approval");
  await sleep(3500);
  await approval.getByRole("button", { name: /Add to calendar|Send email|Save changes/ }).click();
  rec.mark("approved");
  await page.locator('[data-testid="approval"][data-status="approved"]').last().waitFor({ timeout: 30_000 });
  await turn();
  rec.mark("answered");
  await sleep(3000);
  await rec.stop();

  await rec.start("assistant-reminder");
  await say("Remind me in 1 minute to stretch and grab some water.");
  rec.mark("sent");
  await turn();
  await page.locator('[data-testid="tool"][data-tool="schedule_task"][data-status="succeeded"]').last().waitFor({ timeout: 10_000 });
  rec.mark("scheduled");
  await page.locator('[data-testid="trigger"]').last().waitFor({ timeout: 4 * 60_000 });
  rec.mark("fired");
  await page.locator('[data-testid="assistant-message"][data-proactive="true"][data-streaming="false"]').last().waitFor({ timeout: TURN });
  rec.mark("proactive");
  await sleep(3500);
  await rec.stop();

  await rec.start("assistant-offline-ask");
  await say("In 2 minutes, check my calendar for the next business day and tell me when my first meeting starts and what it is.");
  rec.mark("sent");
  await turn();
  await page.locator('[data-testid="tool"][data-tool="schedule_task"][data-status="succeeded"]').last().waitFor({ timeout: 10_000 });
  rec.mark("scheduled");
  await sleep(3000);
  await rec.stop();
  await page.close();
  console.log("tab closed; waiting for the server to detach");
  const detachDeadline = Date.now() + 120_000;
  for (;;) {
    const attach = (await (await fetch(`${BASE}/api/state`)).json()).conversation?.attach;
    if (attach !== "live") {
      console.log(`  conversation attach: ${attach}`);
      break;
    }
    if (Date.now() > detachDeadline) throw new Error("The assistant stayed attached: another tab is open. Close it and run this again.");
    await sleep(2000);
  }
  await sleep(3.5 * 60_000);

  page = await context.newPage();
  rec = new Recorder(page, { fps: 12 });
  await page.goto(BASE);
  await online();
  const offlineTool = page.locator('[data-testid="tool"][data-offline="true"]').last();
  await offlineTool.waitFor({ timeout: 90_000 });
  await rec.start("assistant-away");
  await sleep(2000);
  await page.locator('[data-testid="assistant-message"][data-proactive="true"]').last().scrollIntoViewIfNeeded();
  rec.mark("reply");
  await sleep(2500);
  await offlineTool.scrollIntoViewIfNeeded();
  rec.mark("handled");
  await sleep(4000);
  await rec.stop();
  console.log("done");
} finally {
  await rec.stop().catch(() => undefined);
  await browser.close();
}
