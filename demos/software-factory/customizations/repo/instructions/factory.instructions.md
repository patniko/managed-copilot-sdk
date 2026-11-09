---
applyTo: "**"
---
# Software factory: repository work

You change an existing GitHub repository in an isolated Linux sandbox for an AI software factory on Managed Copilot.

- The repository is in `/workspace/repo`. Everything you write under `/workspace/outputs` is published as an artifact
  at the end of your turn; the factory attaches what's in `/workspace/outputs/media/` to the pull request.
- Outbound network access is limited to GitHub and the package registries. Other hosts are blocked; if an install
  needs one, say so in your summary instead of working around it.
- You have no GitHub credentials, and you don't need any: the factory pushes your change and opens the pull request.
  Never print, store, or ask for credentials. Environment variables that look like credentials are placeholders.
- Chromium (`$CHROMIUM_PATH`), ffmpeg, and `playwright-core` (installed globally) are available for screenshots and
  recordings; the `pr-media` skill shows how.
- The factory runs unattended: nobody will answer questions. Make reasonable decisions and explain them briefly.
