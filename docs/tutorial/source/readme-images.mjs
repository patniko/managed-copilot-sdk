// Renders the README's images: the architecture diagram (architecture.html) in GitHub's light and dark themes on a
// transparent background (docs/images/architecture-light.png and architecture.png), and the video tour's thumbnail from
// the tutorial slides (docs/images/tour.png).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, REPO, SRC } from "./common.mjs";

const images = join(REPO, "docs", "images");
mkdirSync(images, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });

for (const [colorScheme, file] of [["light", "architecture-light.png"], ["dark", "architecture.png"]]) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2, colorScheme });
  const diagram = await context.newPage();
  await diagram.goto(pathToFileURL(join(SRC, "architecture.html")).href);
  await diagram.waitForFunction(() => window.drawn === true);
  await diagram.locator("#diagram").screenshot({ path: join(images, file), omitBackground: true });
  await context.close();
}

const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
await page.goto(pathToFileURL(join(SRC, "slides.html")).href);
await page.evaluate(() => document.fonts.ready);

// The title slide as a play-button thumbnail.
await page.evaluate(() => {
  window.show("title");
  const logo = document.querySelector("#title .logo");
  logo.innerHTML = '<svg width="58" height="58" viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="white"/></svg>';
  logo.style.borderRadius = "999px";
  const foot = document.querySelector("#title .foot");
  foot.querySelector("span").textContent = "Watch the 6-minute tour: the idea, how it works, and both demos running for real";
  foot.style.cssText += "font-size:28px;color:#4493f8;bottom:230px";
});
await page.screenshot({ path: join(images, "tour.png") });
await browser.close();
console.log(`wrote architecture.png, architecture-light.png, and tour.png to ${images}`);
