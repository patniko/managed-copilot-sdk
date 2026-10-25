# Video tour: what Managed Copilot is

A six-minute narrated tour for any audience: the idea, the three environment types, how the pieces fit together,
both demos running for real, and the Azure deployment. Every demo shot is a recording of the real platform with
real models, not a mock-up.

| | |
| --- | --- |
| [**Watch the tour**](managed-copilot-tour.mp4) | MP4, 1080p, 6:08, narrated with burned-in captions |
| [Slides](managed-copilot-tour-slides.pdf) | The 19 slides from the video, as a PDF deck |
| [Captions](managed-copilot-tour.srt) | SRT, for players and editors that take separate captions |

## Chapters

| Time | Chapter |
| --- | --- |
| 0:00 | The idea: the same Copilot SDK, running in an environment you own |
| 0:38 | Three kinds of environments: shared, isolated, promotable |
| 1:13 | How the pieces fit together: gateway, runtimes, sandboxes, egress proxy, models |
| 1:57 | Running it with `aspire run`, and the 13 spec examples passing as checks |
| 2:21 | Demo 1: the AI software factory plans, builds in parallel sandboxes, reviews, and releases a tested toolkit |
| 3:34 | Demo 2: the assistant triages mail, books a meeting after approval, and keeps working with the tab closed |
| 4:57 | The same AppHost on Azure with `aspire deploy` |
| 5:29 | Recap, and how to try it yourself |

## Rebuild the video

Everything that makes the video lives in [`source/`](source): the narration script and shot list
([`shots.mjs`](source/shots.mjs)), the slides ([`slides.html`](source/slides.html)), and the recording and assembly
scripts. Outputs go to `source/out/`, which git ignores. Change the words in `shots.mjs` or the slides in
`slides.html`, then rebuild from step 4; record again only when the demos change.

Prerequisites: Windows (the narration uses the built-in Microsoft Mark voice), Microsoft Edge, `pnpm install` and
`pnpm build`, and ffmpeg with libx264 on `PATH` (or `FFMPEG` set to it).

1. Start the platform and demos with `aspire run`, as in the [README](../../README.md). The assistant needs
   background work on.
2. Record the demos against it (real models; about 4 and 8 minutes):

   ```powershell
   node docs/tutorial/source/record-factory.mjs
   node docs/tutorial/source/record-assistant.mjs
   ```

   The factory recording ends by pressing **Open in Copilot CLI**, which opens a real Copilot CLI window; close it
   afterwards. The assistant recording starts a fresh conversation, resets the demo inbox and calendar, and closes
   its tab to show work done while you're away. Close every other assistant tab first, including app side panels;
   the script stops with a message if the assistant stays attached.
3. Optional, for the Azure chapter: record your deployment's apps (see [deployment.md](../deployment.md)). Without
   these recordings the Azure demo shots are left out.

   ```powershell
   $env:AZURE_FACTORY_URL = "https://software-factory.<environment-domain>"
   $env:AZURE_ASSISTANT_URL = "https://assistant.<environment-domain>"
   node docs/tutorial/source/record-azure.mjs
   ```

4. Render the slides, captions, and deck, synthesize the narration, and assemble the video:

   ```powershell
   node docs/tutorial/source/render.mjs
   pwsh docs/tutorial/source/tts.ps1
   node docs/tutorial/source/compose.mjs
   ```

   The results are in `docs/tutorial/source/out/build/`: `managed-copilot-tour.mp4`, `.srt`, and
   `managed-copilot-tour-slides.pdf`. `node docs/tutorial/source/compose.mjs <shot id>` encodes a single shot for
   a quick preview. Copy the results here to update the published tour.
