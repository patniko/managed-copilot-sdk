// Captures the gallery's screenshots into shots/: each app as it runs on your local platform, and each walkthrough's
// real output (from its README) in a terminal window. Run with the platform up (`aspire run`):
//
//   pnpm --filter @managed-copilot/demo-gallery capture [--only <id,...>] [--dark]
//
// Apps show whatever they hold, so run a demo or two first for screens with content. Uses Microsoft Edge through
// playwright-core; set GALLERY_BROWSER_CHANNEL=chrome to use Chrome.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
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
    id: "console",
    // A one-time sign-in link from `managed-copilot console --json`.
    url: () => {
      const cli = join(repo, "packages/cli/bin/managed-copilot.mjs");
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

const WALKTHROUGHS = [
  ["01", "01-first-agent"],
  ["02", "02-your-own-tools"],
  ["03", "03-sandbox"],
  ["04", "04-promotion"],
  ["05", "05-choose-environments"],
  ["06", "06-harness"],
  ["07", "07-network-and-secrets"],
  ["08", "08-offline"],
  ["09", "09-schedules"],
  // A guide: show it running walkthroughs 01 and 03 against Azure.
  ["10", "10-azure", { section: "3. Run the samples", outputs: 2 }],
  ["11", "11-orchestrator"],
];

/** Fenced blocks with their language and the `## ` section they sit in. Handles ```` fences that contain ```. */
function fencedBlocks(markdown) {
  const blocks = [];
  let section = "";
  let open;
  for (const line of markdown.split(/\r?\n/)) {
    if (open) {
      if (line.trim() === open.fence) {
        blocks.push({ lang: open.lang, section: open.section, body: open.lines.join("\n").replace(/\s+$/, "") });
        open = undefined;
      } else open.lines.push(line);
      continue;
    }
    const fence = line.match(/^(`{3,})(\w*)\s*$/);
    if (fence) open = { fence: fence[1], lang: fence[2], section, lines: [] };
    else if (line.startsWith("## ")) section = line.slice(3).trim();
  }
  return blocks;
}

/**
 * A README's run as a terminal transcript: the commands and real output in its "What you'll see" section, after the
 * command from "Run it".
 */
function readmeRun(folder, { section = "What you'll see", outputs = 1 } = {}) {
  const text = readFileSync(join(repo, "samples", folder, "README.md"), "utf8");
  const title = text.match(/^# (.+)$/m)?.[1] ?? folder;
  const blocks = fencedBlocks(text);
  const commands = (block) => block.body.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));
  const steps = [];
  const runIt = blocks.find((b) => b.section === "Run it" && b.lang === "powershell");
  if (runIt) for (const command of commands(runIt)) steps.push({ command });
  let shown = 0;
  for (const block of blocks.filter((b) => b.section === section)) {
    if (block.lang === "powershell") for (const command of commands(block)) steps.push({ command });
    else if (block.lang === "text" && shown < outputs) {
      steps.push({ output: block.body });
      shown += 1;
    }
    if (shown >= outputs) break;
  }
  if (!steps.some((step) => step.command)) steps.unshift({ command: `pnpm sample ${folder.slice(0, 2)}` });
  return { title, steps };
}

const escape = (text) => text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/** Light syntax color for terminal output: check marks, failures, URLs, IDs, and labels. */
function colorize(line) {
  let html = escape(line);
  html = html.replace(/(https?:\/\/[^\s)]+)/g, '<span class="u">$1</span>');
  html = html.replace(/^(\s*)(✓|✔|●)/, '$1<span class="ok">$2</span>');
  html = html.replace(/^(\s*)(✗|✖|×)/, '$1<span class="bad">$2</span>');
  html = html.replace(/^(\s*)([A-Z][\w ]{1,24}:)(?=\s)/, '$1<span class="k">$2</span>');
  html = html.replace(/(@[\w-]+)/g, '<span class="id">$1</span>');
  return html;
}

function terminalHtml({ id, title, steps }) {
  const prompt = '<span class="p">PS C:\\src\\managed-copilot-sdk&gt;</span> ';
  const lines = steps
    .map((step, i) => (step.command ? `${i > 0 && !steps[i - 1].command ? "\n" : ""}${prompt}<span class="c">${escape(step.command)}</span>` : step.output.split("\n").map(colorize).join("\n")))
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}html,body{margin:0;height:100%}
  body{display:grid;place-items:center;font-family:"Segoe UI Variable","Segoe UI",system-ui,sans-serif;
    background:radial-gradient(900px 500px at 0% 0%,#1f6feb55,transparent 60%),radial-gradient(900px 600px at 100% 100%,#8957e555,transparent 60%),#0d1117}
  .win{width:1320px;height:800px;border-radius:14px;overflow:hidden;background:#0c0c0c;box-shadow:0 30px 80px #0009,0 0 0 1px #ffffff1f;display:flex;flex-direction:column}
  .bar{height:44px;background:#1f1f1f;display:flex;align-items:center;gap:10px;padding:0 16px;color:#d0d0d0;font-size:15px}
  .tab{display:flex;align-items:center;gap:8px;background:#0c0c0c;height:34px;margin-top:10px;padding:0 14px;border-radius:8px 8px 0 0}
  .ps{width:16px;height:16px;border-radius:3px;background:#2671be;display:grid;place-items:center;color:white;font:700 10px Consolas}
  .sp{flex:1}.ctl{display:flex;gap:22px;color:#9a9a9a;font-size:14px}
  .tag{margin-left:8px;padding:2px 8px;border-radius:999px;background:#ffffff14;color:#c9d1d9;font-size:12px}
  pre{margin:0;padding:24px 30px;flex:1;overflow:hidden;font:20px/1.5 "Cascadia Mono","Cascadia Code",Consolas,monospace;color:#cccccc;white-space:pre-wrap;word-break:break-word;
    -webkit-mask-image:linear-gradient(#000 88%,transparent)}
  .p{color:#5fb3f9}.c{color:#f9f1a5}.ok{color:#3fb950}.bad{color:#f85149}.u{color:#79c0ff;text-decoration:underline;text-decoration-color:#79c0ff66}.k{color:#d2a8ff}.id{color:#ffa657}
  </style></head><body><div class="win">
  <div class="bar"><div class="tab"><span class="ps">&gt;_</span>PowerShell<span class="tag">${escape(id)} · ${escape(title.replace(/^\d+\s*·\s*/, ""))}</span></div><span class="sp"></span><span class="ctl"><span>—</span><span>☐</span><span>✕</span></span></div>
  <pre>${lines}</pre>
  </div></body></html>`;
}

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

for (const [id, folder, layout] of WALKTHROUGHS.filter(([id]) => wanted(`sample-${id}`))) {
  const page = await context.newPage();
  try {
    await page.setContent(terminalHtml({ id, ...readmeRun(folder, layout) }), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(shots, `sample-${id}.png`) });
    console.log(`✓ sample-${id}`);
  } catch (error) {
    failures.push(`sample-${id}`);
    console.error(`✗ sample-${id}: ${error.message.split("\n")[0]}`);
  } finally {
    await page.close();
  }
}

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} screenshot(s) failed. Is the platform running (aspire run)?`);
  process.exitCode = 1;
}
