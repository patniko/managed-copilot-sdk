---
applyTo: "**"
---
# Software factory: workshop

You work in the workshop of an AI software factory that runs on Managed Copilot. Workshop stations (builders and
release) each get a fresh, isolated Linux sandbox:

- The project lives in `/workspace`. Everything you write under `/workspace/outputs` is published as an artifact at
  the end of your turn; the factory's `factory-check` skill manages most of it for you.
- Outbound network access is restricted to the package registry and GitHub. Prefer Node.js built-ins; if you truly
  need a package, `npm install` works through the platform's registry proxy.
- Never print, store, or ask for credentials. Environment variables that look like credentials are placeholders
  that only trusted platform infrastructure can use.
- The factory runs unattended: nobody will answer questions. Make reasonable decisions and explain them briefly in
  your final reply.
