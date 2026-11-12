// Automated playtest: the autopilot rides full runs and we collect stats per world/character.
// Usage: node scripts/playtest.mjs [--envs=citadel,desert] [--chars=rider,mona] [--timescale=4] [--timeout=240] [--shots] [--url=http://localhost:7455/]
import { chromium } from 'playwright-core';
import { browserOptions, OUT, startServer, shutdown } from './devserver.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const opt = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? 'true']; }));
const envs = (opt.envs ?? 'citadel,desert,alpine,dream,dunes').split(',');
const chars = (opt.chars ?? 'rider').split(',');
const timescale = Number(opt.timescale ?? 4);
const timeout = Number(opt.timeout ?? 240) * 1000;
mkdirSync(`${OUT}/playtest`, { recursive: true });

// --url plays a running Downhill (pnpm dev, pnpm start, aspire run) instead of an in-process Vite server
const server = opt.url ? null : await startServer();
const base = opt.url ? (opt.url.endsWith('/') ? opt.url : `${opt.url}/`) : server.url;

const browser = await chromium.launch(browserOptions);
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const results = [];
for (const env of envs) {
  for (const ch of chars) {
    errors.length = 0;
    await page.goto(`${base}?play&autopilot&env=${env}&char=${ch}&timescale=${timescale}&readyMs=1000`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 }).catch(() => {});
    const t0 = Date.now();
    let last = null;
    const fpsSamples = [];
    let shot = 0;
    while (Date.now() - t0 < timeout) {
      await sleep(1000);
      last = await page.evaluate(() => window.__probe && window.__probe());
      if (!last) continue;
      if (last.fps) fpsSamples.push(last.fps);
      if (opt.shots && Date.now() - t0 > (shot + 1) * 15000) {
        shot++;
        await page.screenshot({ path: `${OUT}/playtest/${env}-${ch}-${shot}.png` });
      }
      if (last.session === 'finished') break;
    }
    const r = {
      env,
      char: ch,
      finished: last?.session === 'finished',
      runTime: last?.time?.toFixed(1),
      score: last?.score,
      crashes: last?.stats?.crashes,
      tricks: last?.stats?.tricks,
      perfects: last?.stats?.perfects,
      maxKmh: Math.round((last?.stats?.maxSpeed ?? 0) * 3.6),
      airTime: last?.stats?.airTime?.toFixed(1),
      progress: last?.progress?.toFixed(2),
      checkpoints: `${last?.stats?.checkpoints}/${last?.stats?.totalCheckpoints}`,
      medianFps: fpsSamples.sort((a, b) => a - b)[Math.floor(fpsSamples.length / 2)]?.toFixed(0),
      drawCalls: last?.calls,
      crashLog: (last?.crashLog ?? []).map((c) => `${c.reason}@${c.progress}${c.wasAir ? '(air)' : ''} ${c.kmh}kmh`),
      errors: errors.slice(0, 3),
    };
    results.push(r);
    console.log(JSON.stringify(r));
  }
}
writeFileSync(`${OUT}/playtest/results.json`, JSON.stringify(results, null, 2));
await shutdown(browser, server, 0);
