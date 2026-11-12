// Visual validation harness: starts Vite (unless --url given), loads pages in headless Edge, saves screenshots.
// Usage: node scripts/shots.mjs name="?view&env=citadel" [name2="?view&..."] [--w=1280 --h=720 --url=http://host:port/ --wait=30000]
import { chromium } from 'playwright-core';
import { browserOptions, OUT, startServer, shutdown } from './devserver.mjs';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const shots = args.filter((a) => !a.startsWith('--')).map((a) => {
  const i = a.indexOf('=');
  return { name: a.slice(0, i), query: a.slice(i + 1) };
});
const W = Number(opt.w ?? 1280);
const H = Number(opt.h ?? 720);
const waitMs = Number(opt.wait ?? 60000);
const outDir = opt.out ?? `${OUT}/shots`;
mkdirSync(outDir, { recursive: true });

let server = null;
let base = opt.url;
if (!base) {
  server = await startServer(Number(opt.port ?? 5180));
  base = server.url;
}

const browser = await chromium.launch(browserOptions);
const page = await browser.newPage({ viewport: { width: W, height: H } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
for (const s of shots) {
  logs.length = 0;
  const t0 = Date.now();
  await page.goto(base + s.query, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => window.__ready === true, null, { timeout: waitMs, polling: 250 });
  } catch {
    console.log(`!! ${s.name}: timed out waiting for __ready`);
  }
  if (opt.settle) await sleep(Number(opt.settle));
  const file = `${outDir}/${s.name}.png`;
  await page.screenshot({ path: file });
  console.log(`saved ${file} (${Date.now() - t0} ms)`);
  for (const l of logs) if (!l.includes('[vite]')) console.log('   ' + l);
}
await shutdown(browser, server, 0);
