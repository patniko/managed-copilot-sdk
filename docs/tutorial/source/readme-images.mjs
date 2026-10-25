// Renders the README's images from the tutorial slides: the architecture diagram with every component shown
// (docs/images/architecture.png) and the video tour's thumbnail (docs/images/tour.png).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, REPO, SRC } from "./common.mjs";

const images = join(REPO, "docs", "images");
mkdirSync(images, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
await page.goto(pathToFileURL(join(SRC, "slides.html")).href);
await page.evaluate(() => document.fonts.ready);

// The diagram without the slide's heading.
await page.evaluate(() => window.show("arch-0"));
await page.screenshot({ path: join(images, "architecture.png"), clip: { x: 90, y: 212, width: 1740, height: 636 } });

// The title slide as a play-button thumbnail.
await page.evaluate(() => {
  window.show("title");
  const logo = document.querySelector("#title .logo");
  logo.innerHTML = '<svg width="58" height="58" viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="white"/></svg>';
  logo.style.borderRadius = "999px";
  document.querySelector("#title .foot").textContent = "Watch the 6-minute tour: the idea, how it works, and both demos running for real";
  document.querySelector("#title .foot").style.cssText += "font-size:28px;color:#c4b5fd;bottom:230px";
});
await page.screenshot({ path: join(images, "tour.png") });
await browser.close();
console.log(`wrote ${join(images, "architecture.png")} and tour.png`);
