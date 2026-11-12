// End-to-end UI/interaction test with real keyboard input in headless Edge.
// Usage: node scripts/uitest.mjs
import { chromium } from 'playwright-core';
import { browserOptions, OUT, startServer, shutdown } from './devserver.mjs';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const shots = `${OUT}/ui`;
mkdirSync(shots, { recursive: true });
const server = await startServer();
const base = server.url;

const browser = await chromium.launch(browserOptions);
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};
const probe = () => page.evaluate(() => window.__probe && window.__probe());
const visible = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden') && getComputedStyle(e).display !== 'none'; }, sel);

await page.goto(`${base}?readyMs=500`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
await sleep(1500);
check((await probe()).state === 'title', 'boots to the title screen (attract mode running)');
await page.screenshot({ path: `${shots}/1-title.png` });

await page.keyboard.press('Enter');
await sleep(1200);
check((await probe()).state === 'select', 'Enter opens rider/world select');
await page.keyboard.press('ArrowRight');
await sleep(300);
const selChar = await page.evaluate(() => document.querySelector('.select .card.sel:not(.world) .name')?.textContent);
check(selChar === 'Mona', `ArrowRight selects Mona (got ${selChar})`);
await page.keyboard.press('ArrowRight');
await sleep(300);
const selChar2 = await page.evaluate(() => document.querySelector('.select .card.sel:not(.world) .name')?.textContent);
check(selChar2 === 'Copilot', `ArrowRight again selects Copilot (got ${selChar2})`);
await page.screenshot({ path: `${shots}/2-select.png` });
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__probe && window.__probe().state === 'play', null, { timeout: 60000 });
check(true, 'Enter drops into the run');
await sleep(1500);
check((await probe()).session === 'intro', 'run starts with the intro / countdown');
await page.waitForFunction(() => window.__probe().session === 'riding', null, { timeout: 15000 });
check(true, 'control handed over after the countdown');
await page.keyboard.down('KeyW');
await sleep(3000);
await page.keyboard.up('KeyW');
let p = await probe();
check(p.speed > 6, `pedalling (W) accelerates the bike (speed ${p.speed.toFixed(1)} m/s)`);
check(p.time > 2.5, `run timer is counting (${p.time.toFixed(1)} s)`);
await page.screenshot({ path: `${shots}/3-riding.png` });
// steer
const h0 = await page.evaluate(() => window.__game.session.player.physics.heading);
await page.keyboard.down('KeyD');
await sleep(600);
await page.keyboard.up('KeyD');
const h1 = await page.evaluate(() => window.__game.session.player.physics.heading);
check(h1 - h0 > 0.15, `D steers right (heading change ${(h1 - h0).toFixed(2)} rad)`);
// pop: hold and release space
await page.keyboard.down('Space');
await sleep(350);
await page.keyboard.up('Space');
await sleep(120);
p = await probe();
check(p.grounded === false, 'Space (hold + release) pops the bike into the air');
await sleep(1500);
// pause
await page.keyboard.press('Escape');
await sleep(500);
check(await visible('.screen.dim:not(.hidden) .panel h1'), 'Esc opens the pause menu');
const tPaused = (await probe()).time;
await sleep(1000);
check(Math.abs((await probe()).time - tPaused) < 0.05, 'game time is frozen while paused');
await page.screenshot({ path: `${shots}/4-pause.png` });
await page.keyboard.press('Escape');
await sleep(800);
const t2 = (await probe()).time;
check(t2 > tPaused, 'Esc resumes the run');
// respawn
await page.keyboard.press('KeyR');
await sleep(400);
check((await probe()).session === 'crashed', 'R triggers a respawn sequence');
await page.waitForFunction(() => window.__probe().session === 'riding', null, { timeout: 6000 }).catch(() => {});
check((await probe()).session === 'riding', 'rider respawns and can continue');
// camera cycle
await page.keyboard.press('KeyC');
await sleep(300);
const mode = await page.evaluate(() => window.__game.session.cam.mode);
check(mode === 'far', `C cycles the camera (mode ${mode})`);
await page.screenshot({ path: `${shots}/5-farcam.png` });
// HUD
const hud = await page.evaluate(() => ({ score: document.querySelector('.hud .score span')?.textContent, speed: document.querySelector('.hud .speed .val')?.textContent }));
check(hud.score !== undefined && hud.speed !== undefined, `HUD shows score ${hud.score} and speed ${hud.speed} km/h`);
// shop: typing in it never drives the game (M mutes, R respawns, C cycles the camera, Space pops)
await page.keyboard.press('Escape');
await sleep(500);
await page.getByRole('button', { name: 'Shop', exact: true }).click();
await page.waitForFunction(() => window.__probe().state === 'shop', null, { timeout: 15000 });
check(true, 'the pause menu opens the shop');
await page.click('#shop-promo');
await page.keyboard.type('mr camera');
check((await page.inputValue('#shop-promo')) === 'mr camera', `typing in the shop goes to the field, spaces included (got "${await page.inputValue('#shop-promo')}")`);
check((await probe()).state === 'shop' && (await page.evaluate(() => window.__game.input.suspended)), 'game keys stay off while the shop is open');
await page.screenshot({ path: `${shots}/6-shop.png` });
await page.getByRole('button', { name: '◀ Back' }).click();
await page.waitForFunction(() => window.__probe().state === 'title', null, { timeout: 15000 });
check(!(await page.evaluate(() => window.__game.input.suspended)), 'Back returns to the title screen with game keys on');
check(errors.length === 0, `no page errors (${errors.slice(0, 2).join(' | ')})`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED');
await shutdown(browser, server, failures ? 1 : 0);
