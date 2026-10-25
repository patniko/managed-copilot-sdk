// Renders the slides (out/slides) and caption overlays (out/captions), writes the narration list for speech
// synthesis (out/narration.json), and prints the slide deck as a PDF (out/build/managed-copilot-tour-slides.pdf).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, OUT, SRC } from "./common.mjs";
import { pagesOf, scenes } from "./shots.mjs";

for (const dir of ["slides", "captions", "build"]) mkdirSync(join(OUT, dir), { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await context.newPage();
await page.goto(pathToFileURL(join(SRC, "slides.html")).href);
await page.evaluate(() => document.fonts.ready);

const narration = [];
const slides = ["frame"];
await page.evaluate(() => window.show("frame"));
await page.screenshot({ path: join(OUT, "slides", "frame.png") });
for (const scene of scenes) {
  for (const shot of scene.shots) {
    if (shot.slide && !slides.includes(shot.slide)) {
      slides.push(shot.slide);
      await page.evaluate((name) => window.show(name), shot.slide);
      await page.screenshot({ path: join(OUT, "slides", `${shot.slide}.png`) });
    }
    const pages = pagesOf(shot);
    for (let i = 0; i < pages.length; i++) {
      const key = `${shot.id}-${i}`;
      await page.evaluate((text) => window.caption(text), pages[i].caption);
      await page.screenshot({ path: join(OUT, "captions", `${key}.png`), omitBackground: true });
      narration.push({ key, say: pages[i].say });
    }
  }
}
writeFileSync(join(OUT, "narration.json"), JSON.stringify(narration, null, 1));

// The deck: every slide in the order the video shows it, one per page.
const deck = slides.filter((name) => name !== "frame");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: 1920px 1080px; margin: 0; }
html, body { margin: 0; background: #0d1117; }
img { display: block; width: 1920px; height: 1080px; }
img:not(:last-child) { break-after: page; }
</style></head><body>${deck.map((name) => `<img src="../slides/${name}.png">`).join("")}</body></html>`;
writeFileSync(join(OUT, "build", "deck.html"), html);
const deckPage = await context.newPage();
await deckPage.goto(pathToFileURL(join(OUT, "build", "deck.html")).href, { waitUntil: "load" });
await deckPage.pdf({ path: join(OUT, "build", "managed-copilot-tour-slides.pdf"), width: "1920px", height: "1080px", printBackground: true, preferCSSPageSize: true });
await browser.close();
console.log(`${deck.length} slides (deck PDF), ${narration.length} caption pages`);
