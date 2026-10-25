// Records a real CSV ⇄ JSON toolkit work order on the software factory, with phase markers from its API.
// Needs the factory running (`aspire run`): FACTORY_URL, default http://localhost:7480. Takes 3–5 minutes.
// The last step presses "Open in Copilot CLI", which opens a real Copilot CLI window on this machine; close it after.
import { launch, Recorder, sleep } from "./common.mjs";

const BASE = process.env.FACTORY_URL ?? "http://localhost:7480";
const { browser, context } = await launch();
const page = await context.newPage();
const rec = new Recorder(page, { fps: 12 });

/** Scrolls the leaf element whose text is exactly `text` (the last one when `last`) into view. */
async function scrollToText(text, { block = "start", last = false } = {}) {
  await page
    .evaluate(
      ([t, b, l]) => {
        const nodes = [...document.querySelectorAll("main *")].filter((el) => el.childElementCount === 0 && (el.textContent ?? "").trim() === t);
        const el = l ? nodes.at(-1) : nodes[0];
        el?.scrollIntoView({ behavior: "smooth", block: b });
      },
      [text, block, last],
    )
    .catch(() => undefined);
}

async function tab(name) {
  await page.getByRole("link", { name: new RegExp(`^${name}`) }).first().click().catch((error) => console.log(`tab ${name}: ${error.message}`));
}

try {
  await page.goto(`${BASE}/#/`);
  await page.getByText("Start from a template").waitFor({ timeout: 30_000 });
  await sleep(1500);

  await rec.start("factory-start");
  await sleep(2500);
  await page.getByRole("button").filter({ hasText: "CSV ⇄ JSON toolkit" }).first().click();
  rec.mark("template");
  await sleep(3000);
  await page.getByRole("button", { name: "Start work order" }).click();
  await page.waitForURL(/#\/wo\/wo_/, { timeout: 30_000 });
  const id = /wo_[a-z0-9]+/.exec(page.url())[0];
  rec.mark(`created ${id}`);
  await sleep(2500);
  await rec.stop();

  await rec.start("factory-run");
  const seen = {};
  let showedPlan = false;
  let cameraTick = 0;
  const started = Date.now();
  let wo;
  for (;;) {
    wo = await (await fetch(`${BASE}/api/work-orders/${id}`)).json();
    if (seen.wo !== wo.status) rec.mark(`wo ${wo.status}`), (seen.wo = wo.status);
    for (const s of wo.stations) {
      const value = `${s.status} r${s.round}`;
      if (seen[s.id] !== value) rec.mark(`${s.id} ${value}`), (seen[s.id] = value);
    }
    if (["completed", "failed", "cancelled"].includes(wo.status)) break;
    if (Date.now() - started > 20 * 60_000) throw new Error("the work order took longer than 20 minutes");

    const plan = wo.stations.find((s) => s.kind === "plan");
    const release = wo.stations.find((s) => s.kind === "release");
    const tasks = wo.plan?.tasks ?? [];
    if (plan?.status === "done" && !showedPlan && tasks.length) {
      showedPlan = true;
      await sleep(1500);
      rec.mark("plan-tab");
      await tab("Plan");
      await sleep(6000);
      await tab("Floor");
      rec.mark("floor");
      await sleep(800);
    }
    cameraTick++;
    if (release && ["starting", "working", "collecting"].includes(release.status)) {
      if (cameraTick % 4 === 0) await scrollToText("Release", { block: "center", last: true });
    } else if (tasks.length && plan?.status === "done") {
      // Alternate between the tasks so both builders (and their reviews) stay visible.
      if (cameraTick % 6 === 0) await scrollToText(tasks[Math.floor(cameraTick / 6) % tasks.length].title, { block: "start" });
    }
    await sleep(1000);
  }
  rec.mark(`final ${wo.status}`);
  await scrollToText("Release", { block: "center", last: true });
  await sleep(5000);
  await rec.stop();

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await rec.start("factory-after");
  await sleep(2500);
  rec.mark("deliverable");
  await tab("Deliverable");
  await sleep(6000);
  await page.mouse.wheel(0, 500);
  await sleep(3500);
  rec.mark("artifacts");
  await tab("Artifacts");
  await sleep(6000);
  rec.mark("floor");
  await tab("Floor");
  await sleep(2500);
  const cli = page.getByRole("button", { name: "Open in Copilot CLI" }).first();
  if (await cli.isVisible().catch(() => false)) {
    rec.mark("cli");
    await cli.click();
    await sleep(5000);
    await page.keyboard.press("Escape");
    await sleep(1500);
    console.log("A Copilot CLI window opened, attached to the release session; close it when you're done.");
  }
  await rec.stop();
  console.log(`done: ${id} ${wo.status} ${wo.tests ? `${wo.tests.passed}/${wo.tests.total}` : ""}`);
} finally {
  await rec.stop().catch(() => undefined);
  await browser.close();
}
