#!/usr/bin/env node
// Screenshots, screen recordings, and terminal captures for pull requests, with the sandbox's Chromium (Playwright)
// and ffmpeg. Usage: see SKILL.md, or run with no arguments.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CHROMIUM_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--no-first-run", "--disable-extensions"];
const READY_TIMEOUT_MS = 60_000;
const MAX_TERMINAL_LINES = 200;

function loadPlaywright() {
  const local = createRequire(import.meta.url);
  try {
    return local("playwright-core");
  } catch {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    return createRequire(join(root, "noop.js"))("playwright-core");
  }
}

/** Launches the sandbox's Chromium. */
export async function launch(options = {}) {
  const { chromium } = loadPlaywright();
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", args: CHROMIUM_ARGS, ...options });
}

function ensureDir(file) {
  mkdirSync(dirname(resolve(file)), { recursive: true });
}

/** Navigates, retrying while the server is still starting (connection refused, 502/503). */
export async function gotoWhenReady(page, url, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const response = await page.goto(url, { waitUntil: "load", timeout: 30_000 });
      if (!response || response.status() < 500 || url.startsWith("file:")) {
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
        return response;
      }
      last = new Error(`${url} answered ${response.status()}`);
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`${url} didn't load within ${Math.round(timeoutMs / 1000)} s: ${last?.message ?? last}`);
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

/** Records the page through the DevTools screencast until `stop(out)`, which encodes an MP4 (and optionally a GIF). */
export async function startRecording(page, { quality = 85 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const dir = mkdtempSync(join(tmpdir(), "pr-media-"));
  const frames = [];
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = join(dir, `frame-${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, at: metadata.timestamp ?? Date.now() / 1000 });
    await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  await cdp.send("Page.startScreencast", { format: "jpeg", quality, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
  const startedAt = Date.now() / 1000;
  return {
    async stop(out, { gif = false } = {}) {
      const endedAt = Date.now() / 1000;
      await cdp.send("Page.stopScreencast").catch(() => undefined);
      // The screencast only sends frames when the page changes: a still page still needs one frame.
      if (frames.length === 0) {
        const file = join(dir, "frame-00000.jpg");
        writeFileSync(file, await page.screenshot({ type: "jpeg", quality }));
        frames.push({ file, at: startedAt });
      }
      try {
        ensureDir(out);
        const list = frames.map((frame, index) => {
          const next = frames[index + 1]?.at ?? endedAt;
          return `file '${frame.file}'\nduration ${Math.max(0.04, next - frame.at).toFixed(3)}`;
        });
        // The concat demuxer ignores the last entry's duration unless the file is listed once more.
        list.push(`file '${frames.at(-1).file}'`);
        writeFileSync(join(dir, "frames.txt"), `${list.join("\n")}\n`);
        ffmpeg(["-f", "concat", "-safe", "0", "-i", join(dir, "frames.txt"), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-movflags", "+faststart", resolve(out)]);
        const outputs = [resolve(out)];
        if (gif) {
          const gifOut = resolve(out).replace(/\.\w+$/, "") + ".gif";
          ffmpeg(["-i", resolve(out), "-vf", "fps=10,scale='min(960,iw)':-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", gifOut]);
          outputs.push(gifOut);
        }
        return outputs;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
}

async function newPage(browser, options) {
  return browser.newPage({
    viewport: { width: options.width, height: options.height },
    deviceScaleFactor: options.scale,
    colorScheme: options.dark ? "dark" : "light",
  });
}

export async function screenshot(url, out, options = {}) {
  const settings = { width: 1280, height: 800, scale: 1, ...options };
  const browser = await launch();
  try {
    const page = await newPage(browser, settings);
    await gotoWhenReady(page, url);
    if (settings.waitFor) await page.waitForSelector(settings.waitFor, { timeout: 30_000 });
    if (settings.delay) await page.waitForTimeout(settings.delay);
    ensureDir(out);
    if (settings.selector) await page.locator(settings.selector).first().screenshot({ path: resolve(out) });
    else await page.screenshot({ path: resolve(out), fullPage: Boolean(settings.fullPage) });
    return [resolve(out)];
  } finally {
    await browser.close();
  }
}

async function runStep(page, step) {
  const timeout = 30_000;
  switch (step.action) {
    case "goto":
      return gotoWhenReady(page, step.url);
    case "click":
      return page.locator(step.selector).first().click({ timeout });
    case "fill":
      return page.locator(step.selector).first().fill(String(step.value ?? ""), { timeout });
    case "type":
      return page.locator(step.selector).first().pressSequentially(String(step.value ?? ""), { delay: 60, timeout });
    case "press":
      return step.selector ? page.locator(step.selector).first().press(String(step.value), { timeout }) : page.keyboard.press(String(step.value));
    case "hover":
      return page.locator(step.selector).first().hover({ timeout });
    case "select":
      return page.locator(step.selector).first().selectOption(String(step.value ?? ""), { timeout });
    case "scroll":
      return page.mouse.wheel(0, Number(step.value ?? 600));
    case "waitFor":
      return page.waitForSelector(step.selector, { timeout });
    case "wait":
      return page.waitForTimeout(Number(step.ms ?? 1000));
    default:
      throw new Error(`Unknown step action "${step.action}"`);
  }
}

export async function record(url, out, options = {}) {
  const settings = { width: 1280, height: 800, scale: 1, seconds: 5, ...options };
  const steps = settings.steps ? JSON.parse(readFileSync(settings.steps, "utf8")) : [{ action: "wait", ms: settings.seconds * 1000 }];
  if (!Array.isArray(steps)) throw new Error("--steps must be a JSON array of steps");
  const browser = await launch();
  try {
    const page = await newPage(browser, settings);
    await gotoWhenReady(page, url);
    if (settings.waitFor) await page.waitForSelector(settings.waitFor, { timeout: 30_000 });
    const recording = await startRecording(page);
    await page.waitForTimeout(400);
    for (const step of steps) await runStep(page, step);
    await page.waitForTimeout(600);
    return await recording.stop(out, { gif: Boolean(settings.gif) });
  } finally {
    await browser.close();
  }
}

const ANSI_COLORS = ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4"];
const ANSI_BRIGHT = ["#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff"];

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Basic SGR colors and bold to HTML; every other escape sequence is dropped. */
export function ansiToHtml(text) {
  let html = "";
  let open = false;
  const parts = text.split(/(\x1b\[[0-9;]*m)/);
  for (const part of parts) {
    const sgr = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (!sgr) {
      html += escapeHtml(part.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r(?!\n)/g, ""));
      continue;
    }
    if (open) html += "</span>";
    open = false;
    const styles = [];
    for (const code of (sgr[1] || "0").split(";").map(Number)) {
      if (code === 1) styles.push("font-weight:600");
      else if (code >= 30 && code <= 37) styles.push(`color:${ANSI_COLORS[code - 30]}`);
      else if (code >= 90 && code <= 97) styles.push(`color:${ANSI_BRIGHT[code - 90]}`);
    }
    if (styles.length > 0) {
      html += `<span style="${styles.join(";")}">`;
      open = true;
    }
  }
  return open ? `${html}</span>` : html;
}

function runCommand(command) {
  return new Promise((done) => {
    const child = spawn("bash", ["-lc", command], { env: { ...process.env, FORCE_COLOR: "1", TERM: "xterm-256color" } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => done({ output, code: code ?? 1 }));
    child.on("error", (error) => done({ output: `${output}${error.message}\n`, code: 1 }));
  });
}

export async function terminal(out, command, options = {}) {
  const { output, code } = await runCommand(command);
  const lines = output.replace(/\n$/, "").split("\n");
  const shown = lines.length > MAX_TERMINAL_LINES ? ["…", ...lines.slice(-MAX_TERMINAL_LINES)] : lines;
  const title = escapeHtml(options.title ?? command);
  const page = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:24px;background:#f6f8fa;font:13px/1.5 ui-monospace,"DejaVu Sans Mono","Liberation Mono",monospace}
    .win{display:inline-block;min-width:720px;max-width:1200px;border-radius:10px;overflow:hidden;box-shadow:0 8px 24px #1f232826;background:#0d1117;color:#e6edf3}
    .bar{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#161b22;color:#9198a1;font:12px -apple-system,"Segoe UI","Liberation Sans",sans-serif}
    .dot{width:12px;height:12px;border-radius:50%}.t{margin-left:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    pre{margin:0;padding:14px 18px 18px;white-space:pre-wrap;word-break:break-word}.p{color:#3fb950}.x{color:${code === 0 ? "#9198a1" : "#ff7b72"}}
  </style><div class="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="t">${title}</span></div>
  <pre><span class="p">$</span> ${escapeHtml(command)}\n${ansiToHtml(shown.join("\n"))}\n<span class="x">exit ${code}</span></pre></div>`;
  const dir = mkdtempSync(join(tmpdir(), "pr-media-"));
  const file = join(dir, "terminal.html");
  writeFileSync(file, page);
  const browser = await launch();
  try {
    const tab = await newPage(browser, { width: 1280, height: 400, scale: 2 });
    await tab.goto(pathToFileURL(file).href);
    ensureDir(out);
    await tab.locator(".win").screenshot({ path: resolve(out) });
    return [resolve(out)];
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      options.rest = argv.slice(index + 1);
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-(\w)/g, (_, letter) => letter.toUpperCase());
    if (["fullPage", "dark", "gif"].includes(key)) options[key] = true;
    else options[key] = argv[++index];
  }
  for (const key of ["width", "height", "delay", "seconds", "scale"]) if (options[key] !== undefined) options[key] = Number(options[key]);
  return { positional, options };
}

const USAGE = `Usage:
  capture.mjs screenshot <url> <out.png> [--width 1280] [--height 800] [--full-page] [--dark] [--selector css] [--wait-for css] [--delay ms]
  capture.mjs record <url> <out.mp4> [--steps steps.json | --seconds 5] [--gif] [--width 1280] [--height 800] [--dark]
  capture.mjs terminal <out.png> [--title text] -- <command...>`;

async function main(argv) {
  const [command, ...rest] = argv;
  const { positional, options } = parseArgs(rest);
  let outputs;
  if (command === "screenshot" && positional.length === 2) outputs = await screenshot(positional[0], positional[1], options);
  else if (command === "record" && positional.length === 2) outputs = await record(positional[0], positional[1], options);
  else if (command === "terminal" && positional.length === 1 && options.rest?.length) outputs = await terminal(positional[0], options.rest.join(" "), options);
  else {
    console.error(USAGE);
    process.exit(2);
  }
  for (const file of outputs) console.log(`Saved ${file} (${Math.round(statSync(file).size / 1024)} KB)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`capture failed: ${error.message}`);
    process.exit(1);
  });
}
