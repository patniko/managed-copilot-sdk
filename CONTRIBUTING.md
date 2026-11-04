# Contributing

Thanks for your interest in Managed Copilot. Issues and pull requests are welcome.

## Set up

You need Node 24 or later, pnpm 10, Docker, and the [Aspire CLI](https://aspire.dev) 13.6. Running the platform with
real models also needs a GitHub account with Copilot.

```powershell
pnpm install
pnpm build          # every workspace package, in dependency order
pnpm test           # every package's vitest suite
pnpm typecheck      # every package, plus the root AppHost (after `aspire run` has generated `.aspire/`)
aspire run          # the platform and demos locally (see the README)
```

`pnpm --filter <package> test` runs one package's tests, for example `pnpm --filter @managed-copilot/gateway test`.
Suites that need Docker sandboxes or real models are gated and skip unless their environment is configured; see each
package's README.

## Ground rules

- **Stock SDK and runtime only.** The point of the project is that apps use the published `@github/copilot-sdk` and
  `@github/copilot` runtime unmodified. No patches, forks, or private SDK internals. If something needs an upstream
  change, fail with `capability_unavailable` and document the gap.
- **No secrets in logs, commits, command lines, or sandboxes.** GitHub tokens never enter a sandbox. Use the gateway
  logger's `redact`.
- **Explicit failures.** Use the stable error codes in `@managed-copilot/protocol`; never fall back silently to a
  weaker mode, another account, or another billing route.
- **Real end to end.** Demos run against the real platform with real models. Fakes belong in unit tests.

## Conventions

- TypeScript ESM, `strict`. Tests live in `<package>/test` and use vitest.
- Shared contracts live in `libraries/protocol`; keep changes there additive.
- Gateway modules own their SQLite tables (prefixed with the module name), register migrations with `migrate()`, and
  expose capabilities to each other through `app.provide(...)` / `app.service(...)`.
- Paths in code must work on Windows hosts and in Linux containers.
- Respect the configured npm registry; Docker builds take it as `--build-arg NPM_REGISTRY=...`.
- User-facing text (UI, CLI output, error messages, docs) should be clear and complete: loading and error states, no
  raw stack traces.
- When you change behavior, update [docs/architecture.md](docs/architecture.md), and the
  [spec](docs/spec/developer-experience.md) if the customer contract changes.

## Repository layout

| Path | Contents |
| --- | --- |
| `libraries/protocol` | Shared contracts: AppHost config schema, REST DTOs, errors, events, network policy |
| `libraries/sdk` | `@managed-copilot/sdk`: `ManagedCopilot.connect()`, stock clients over a secure bridge |
| `libraries/aspire` | `@managed-copilot/aspire`: `addManagedCopilot(builder, name, options)` for Aspire TypeScript AppHosts |
| `libraries/cli` | `npx managed-copilot`: background sign-in, sessions, Copilot CLI attach, artifacts, schedules |
| `libraries/github-theme` | The GitHub (Primer) look shared by the console and the demos |
| `services/gateway` | Authenticated gateway: admission, routing, session ledger, platform services, operator API |
| `services/console` | The operator console the gateway serves at `/console` |
| `services/sandbox`, `services/egress` | The sandbox image and its agent; the egress proxy that enforces network policy and vaults |
| `deployments/azure` | The Azure integration for `aspire deploy`: hosting, the gateway's lease supervisor, and qualification probes |
| `deployments/aws` | A roadmap for AWS as a second deploy target (not built) |
| `apphost.mts` | The AppHost: `aspire run` starts the platform, its environments, and the demos |
| `environments` | Per-environment agents, skills, and instructions for the AppHost (`environments/<name>`) |
| `tests/snippets` | Every spec snippet as a runnable script and one acceptance run |
| `walkthroughs` | Small, commented scripts you run with `pnpm walkthrough <number>` |
| `demos/*` | The AI software factory, the long-running assistant, Dispatch, and the demo gallery |
| `docs/` | Concept pages, spec, architecture, deployment, threat model, and the video tour |

## Pull requests

Keep `pnpm build` and `pnpm test` green, add tests for new behavior, and describe what you verified (unit tests,
`aspire run`, or a live deployment). By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
