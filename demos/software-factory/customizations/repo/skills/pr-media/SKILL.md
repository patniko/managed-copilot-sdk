---
name: pr-media
description: Capture screenshots, short screen recordings, and terminal captures of your change for its pull request
---
# Pull request media

Reviewers decide faster when they can see the change. Put screenshots and recordings in `/workspace/outputs/media/`
and list them in `submit_change`'s `media` with a one-line caption each; the factory uploads them to the pull request.

`capture.mjs` in this skill drives the sandbox's Chromium with Playwright and encodes recordings with ffmpeg:

```bash
CAPTURE=/opt/managed-copilot/customizations/skills/pr-media/capture.mjs
```

## Web pages and UIs

Start the app the way its README says, in the background, then capture it. Every command waits up to 60 seconds for
the URL to answer, so you can run it right after starting the server.

```bash
cd /workspace/repo && (npm run dev > /tmp/dev.log 2>&1 &)
node $CAPTURE screenshot http://localhost:5173 /workspace/outputs/media/home.png
node $CAPTURE screenshot http://localhost:5173/settings /workspace/outputs/media/settings-dark.png --dark --full-page
node $CAPTURE screenshot http://localhost:5173 /workspace/outputs/media/mobile.png --width 390 --height 844
```

Options: `--width` and `--height` (default 1280×800), `--full-page`, `--dark` (prefers-color-scheme), `--wait-for
<css selector>`, `--delay <ms>` before the capture, and `--selector <css>` to capture one element. Static files work
too: `node $CAPTURE screenshot file:///workspace/repo/docs/index.html out.png`.

## Recordings

Record a short interaction (aim for 3 to 15 seconds) as MP4 (H.264, plays inline on GitHub). Add `--gif` for an
animated GIF beside it.

```bash
cat > /tmp/steps.json <<'EOF'
[
  { "action": "wait", "ms": 800 },
  { "action": "click", "selector": "text=Add item" },
  { "action": "fill", "selector": "input[name=title]", "value": "Buy milk" },
  { "action": "press", "selector": "input[name=title]", "value": "Enter" },
  { "action": "wait", "ms": 1500 }
]
EOF
node $CAPTURE record http://localhost:5173 /workspace/outputs/media/add-item.mp4 --steps /tmp/steps.json
```

Steps: `goto` (`url`), `click`, `fill` (`value`), `type` (`value`, typed key by key), `press` (`value`, a key such as
`Enter`), `hover`, `select` (`value`), `scroll` (`value`: pixels down), `waitFor` (`selector`), and `wait` (`ms`).
Selectors are Playwright selectors (`text=Save`, `role=button[name="Save"]`, or CSS). Without `--steps`, it records
the page for `--seconds` (default 5).

For more control, write a Playwright script and use the module's helpers:

```js
import { launch, startRecording } from "/opt/managed-copilot/customizations/skills/pr-media/capture.mjs";
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://localhost:3000");
const recording = await startRecording(page);
await page.getByRole("button", { name: "Save" }).click();
await page.waitForTimeout(1000);
await recording.stop("/workspace/outputs/media/save.mp4", { gif: false });
await browser.close();
```

## Terminal output

For CLIs, libraries, and test runs, capture a command's output as a terminal screenshot. It runs in the current
directory with `bash -lc`:

```bash
cd /workspace/repo && node $CAPTURE terminal /workspace/outputs/media/cli-help.png -- node bin/cli.js --help
```

Add `--title "…"` to label the window. Long output is kept to the last 200 lines.

## Guidelines

- Capture what changed: before and after when the change is a fix or redesign (check out the original with
  `git stash` and restore it with `git stash pop`, or run the base version from `git worktree add /tmp/base
  factory-base`).
- 1 to 6 files, under 10 MB each. Name them for what they show (`login-error.png`, not `screenshot1.png`).
- PNG for screenshots, MP4 for recordings, GIF only for very short loops.
- Never capture secrets, tokens, or personal data.
