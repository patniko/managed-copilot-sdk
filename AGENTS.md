# Guidance for coding agents

Managed Copilot runs **stock** GitHub Copilot SDK clients and sessions in environments you deploy: locally under
Aspire, or in your Azure subscription. The [README](README.md) has the quickstart and repository layout.

- **The contract:** [`docs/spec/developer-experience.md`](docs/spec/developer-experience.md) is the customer-facing
  contract (snippets, decisions, platform contracts). Implement what it specifies; do not invent new API.
- **The implementation:** [`docs/architecture.md`](docs/architecture.md) records the topology, protocol facts, and
  where each area lives in the code. Keep it current when you change behavior.

## Rules

1. **Stock SDK and runtime only.** Use the published `@github/copilot-sdk` and `@github/copilot` runtime from npm, at
   the versions pinned in the workspace. No patched, forked, or locally built runtimes, and no private SDK internals
   (`_internal*`, handler maps, monkey patching). If a behavior needs an upstream change, fail with
   `capability_unavailable` and document the gap.
2. **Genuine SDK objects.** Customer code gets real `CopilotClient` / `CopilotSession` objects, standard session
   events, and standard `defineTool` tools.
3. **Real end to end.** Demos and acceptance samples run against the real platform with real models. Fakes belong in
   unit tests only. A clearly labeled demo data provider is acceptable for a third-party service only when a real
   provider is also implemented.
4. **No secrets in logs, commits, command lines, or sandboxes.** GitHub tokens never enter sandbox environment
   variables or files. Use the gateway logger's `redact`.
5. **Explicit failures.** Use the stable error codes in `@managed-copilot/protocol`; never fall back silently to a
   weaker mode, another account, or another billing route.

## Environment

- Node 24+, pnpm 10, Docker (Desktop or Engine), Aspire CLI 13.6. Code must work on Windows, macOS, and Linux hosts,
  on x64 and arm64, and in Linux containers.
- Respect the configured npm registry (`npm config get registry`). Never hardcode `registry.npmjs.org`; Docker builds
  take the host's registry as `--build-arg NPM_REGISTRY=...`.
- Keep `pnpm build` and `pnpm test` green on every commit.

## Commands

```powershell
pnpm install
pnpm build                                  # every workspace package, in dependency order
pnpm test                                   # every package's vitest suite
pnpm --filter @managed-copilot/gateway test # one package
aspire run                                  # the platform and demos locally
pnpm qa e2e                                 # opt-in end-to-end tests (Docker, real models)
pnpm qa local                               # every snippet, walkthrough, and demo script against aspire run
```

`docs/qa.md` maps every user-facing flow to its checks. When you add a snippet, walkthrough, demo script, or opt-in
test, add its check to `tests/qa/src/catalog.ts`, map it to a flow in `docs/qa.md`, and run `pnpm qa --update-docs`;
`pnpm test` fails until you do.

## Conventions

- TypeScript ESM, `strict`. Tests live in `<package>/test` and use vitest.
- Shared contracts live in `libraries/protocol`; keep changes there additive.
- Gateway modules own their SQLite tables (prefixed with the module name), register migrations with `migrate()`, and
  expose capabilities to each other through `app.provide(...)` / `app.service(...)`.
- User-facing text (UI, CLI output, error messages, docs) should be clear and complete: loading and error states, no
  raw stack traces.
