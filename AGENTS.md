# Repository guidance

Managed Copilot runs **stock** Copilot SDK clients and sessions in environments the customer deploys: locally under
Aspire or in their Azure subscription.

- **The plan:** [`docs/spec/developer-experience.md`](docs/spec/developer-experience.md) is the customer contract
  (snippets, decisions, platform contracts, delivery gates). Implement what it specifies; do not invent new API.
- **The build:** [`docs/architecture.md`](docs/architecture.md) is the as-built topology, protocol facts, workstream
  ownership, and integration interfaces. Keep it current when you change behavior.

## Hard rules

1. **Stock SDK and runtime only.** Use the published `@github/copilot-sdk` (1.0.26) and `@github/copilot` runtime
   (1.0.103) from npm. No patched, forked, hybrid, or locally built runtimes; no private SDK internals
   (`_internal*`, handler maps, monkey patching). If a behavior needs an upstream change, fail with
   `capability_unavailable`, document the gap, and tell the coordinator.
2. **Genuine SDK objects.** Customer code gets real `CopilotClient` / `CopilotSession` objects, standard session
   events, and standard `defineTool` tools.
3. **Real end to end.** Demos and acceptance samples run against the real platform with real models. Fakes are fine
   inside unit tests; never present a mock-only flow as working. A clearly labeled demo data provider is acceptable
   for third-party services only when a real provider is also implemented.
4. **No secrets in logs, commits, command lines, or sandboxes.** GitHub tokens never enter sandbox environment
   variables or files. Use the gateway logger's `redact`.
5. **Explicit failures.** Use the stable error codes in `@managed-copilot/protocol`; never fall back silently to a
   weaker mode, another account, or another billing route.

## Environment facts

- Windows 11 on **ARM64**; Node 24 (arm64); pnpm 10; Docker Desktop with **linux/arm64** containers; Aspire CLI 13.6;
  .NET 10; Azure CLI signed in.
- npm traffic must go through the configured registry proxy (`npm config get registry`). Never hardcode
  `registry.npmjs.org`; pass the host's registry into Docker builds (for example `--build-arg NPM_REGISTRY=...`).
- Paths in code must work on Windows hosts and Linux containers.

## Commands

```powershell
pnpm install
pnpm build          # every workspace package, in dependency order
pnpm test           # every package's vitest suite
pnpm --filter @managed-copilot/gateway dev   # gateway alone, dev default environments
```

## Conventions

- TypeScript ESM, Node 24, `strict`. Tests live in `<package>/test` and use vitest.
- Shared contracts live in `packages/protocol`. Changes there must be additive; coordinate breaking changes with the
  coordinator before making them.
- Gateway modules own their SQLite tables (prefix with the module name) and register migrations with `migrate()`.
  Modules expose capabilities to each other through `app.provide(...)` / `app.service(...)`.
- Edit only the paths your workstream owns (see `docs/architecture.md`). If you need something from another
  workstream, ask for it rather than editing its files.
- User-facing experiences (UI, CLI output, error messages, docs) must be polished: clear copy, loading and error
  states, no raw stack traces.

## Workflow

- Commit early and often with descriptive messages. Keep `pnpm build` and `pnpm test` green on every commit.
- Merge the latest `main` into your branch before handing work back, and resolve conflicts on your branch.
- Before handing off a milestone, have the work reviewed by **both** the Argon (`gemini-4-argon`) and Astra
  (`gpt-6-astra`) models, for example with code-review or rubber-duck sub-agents using those models, and address
  their findings.
