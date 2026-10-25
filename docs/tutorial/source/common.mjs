// Shared helpers for the tutorial pipeline: paths, Edge through playwright-core, and a CDP screencast recorder that
// saves timestamped JPEG frames with markers.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This folder (slides, narration script, scripts). */
export const SRC = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(SRC, "../../..");
/** Recordings, renders, narration, and builds (git-ignored). */
export const OUT = process.env.TUTORIAL_OUT ?? join(SRC, "out");
export const FFMPEG = process.env.FFMPEG ?? "ffmpeg";

// playwright-core is a dependency of the assistant demo.
const require = createRequire(join(REPO, "demos/assistant/package.json"));
export const { chromium } = require("playwright-core");

export const VIEWPORT = { width: 1440, height: 810 };

export async function launch({ colorScheme = "dark" } = {}) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 4 / 3, ignoreHTTPSErrors: true, colorScheme });
  return { browser, context };
}

export const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Records one page into clips (out/clips/<name>). Frames arrive on repaint; at most `fps` are kept. */
export class Recorder {
  constructor(page, { fps = 12 } = {}) {
    this.page = page;
    this.minGapMs = 1000 / fps;
    this.clip = undefined;
  }

  async start(name) {
    if (this.clip) await this.stop();
    const dir = join(OUT, "clips", name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const cdp = await this.page.context().newCDPSession(this.page);
    const clip = { name, dir, cdp, frames: [], marks: [], startedAt: Date.now(), lastSaved: 0, n: 0 };
    cdp.on("Page.screencastFrame", (event) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
      const now = Date.now();
      if (now - clip.lastSaved < this.minGapMs) return;
      clip.lastSaved = now;
      const file = `f${String(clip.n++).padStart(6, "0")}.jpg`;
      writeFileSync(join(dir, file), Buffer.from(event.data, "base64"));
      clip.frames.push({ file, t: (now - clip.startedAt) / 1000 });
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    this.clip = clip;
    // A paint so the clip starts with a frame even on a static page.
    await this.page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame(undefined)))).catch(() => undefined);
    console.log(`● rec ${name}`);
    return clip;
  }

  mark(label) {
    if (!this.clip) return;
    const t = (Date.now() - this.clip.startedAt) / 1000;
    this.clip.marks.push({ label, t });
    console.log(`  · ${this.clip.name} ${t.toFixed(1)}s ${label}`);
  }

  async stop() {
    const clip = this.clip;
    if (!clip) return;
    this.clip = undefined;
    await clip.cdp.send("Page.stopScreencast").catch(() => undefined);
    await clip.cdp.detach().catch(() => undefined);
    const duration = (Date.now() - clip.startedAt) / 1000;
    writeFileSync(join(clip.dir, "clip.json"), JSON.stringify({ name: clip.name, duration, frames: clip.frames, marks: clip.marks }, null, 1));
    console.log(`■ rec ${clip.name}: ${clip.frames.length} frames, ${duration.toFixed(1)}s`);
  }
}
