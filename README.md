# Managed Copilot SDK

Run **stock** Copilot SDK clients and sessions in environments you deploy, locally under Aspire or in your Azure
subscription. Only the setup lines change:

```ts
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";

const managed = await ManagedCopilot.connect(); // your local `aspire run`, or your Azure deployment
const client = await managed.client("chat");    // a stock CopilotClient for the "chat" environment

const session = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
const reply = await session.sendAndWait({ prompt: "Summarize what changed in Aspire 13" });
console.log(reply?.data.content);
```

**Status: under construction.** The foundation (shared contracts, SDK surface, gateway skeleton) is in place; the
platform, demos, and Aspire integration are being built in parallel workstreams.

- [Developer experience spec](docs/spec/developer-experience.md): the customer contract, decisions, and delivery gates.
- [Architecture and workstreams](docs/architecture.md): topology, protocol facts, ownership, and integration points.
- [Repository guidance](AGENTS.md): hard rules, environment facts, commands, and conventions.

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/protocol` | Shared contracts: AppHost config schema, REST DTOs, errors, events, network policy |
| `packages/sdk` | `@managed-copilot/sdk`: `ManagedCopilot.connect()`, stock clients over a secure bridge |
| `packages/aspire` | `@managed-copilot/aspire`: `addManagedCopilot(builder, name, options)` for Aspire TypeScript AppHosts |
| `packages/cli` | `npx managed-copilot`: background sign-in, sessions, Copilot CLI attach, artifacts, schedules |
| `platform/gateway` | Authenticated gateway: admission, routing, session ledger, platform services |
| `apphost.mts` | The AppHost: `aspire run` starts the platform, its environments, and the demos |
| `demos/quickstart` | Every spec snippet as a runnable script and one acceptance run |
| `demos/software-factory`, `demos/assistant` | The AI software factory and the long-running assistant |
| `docs/` | Spec and architecture |

## Run it locally

You need Node 24, pnpm 10, Docker Desktop, the Aspire CLI 13.6, a GitHub account with Copilot (`gh auth login`), and
[Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) for attaching to sessions.

```powershell
pnpm install
pnpm build
aspire run        # the dashboard, the platform at http://localhost:7400, and the demos
```

`aspire run` starts the gateway, the software factory (http://localhost:7480), and the assistant
(http://localhost:7490). Your code finds the platform with no configuration: `ManagedCopilot.connect()` reads the
discovery record the local gateway writes. From another terminal:

```powershell
npx managed-copilot status             # the deployment, your account, and its environments
npx managed-copilot sessions           # your sessions
npx managed-copilot attach 7f3a2c1     # Copilot CLI on a live session (any unique ID prefix)
```

To run every snippet from the spec against your platform, start **quickstart** in the Aspire dashboard, or run
`pnpm --filter @managed-copilot/quickstart acceptance`. Features that have not landed report "not available yet".

- **Behind a NuGet proxy.** If nuget.org is blocked, point the Aspire CLI at your proxy with
  `ASPIRE_CLI_NUGET_SERVICE_INDEX=<proxy>/v3/index.json` and add an untracked `NuGet.config` at the repository root
  whose `packageSourceMapping` maps `*` to that proxy (the file is git-ignored).
- **A port is in use.** The gateway (7400), the factory (7480), and the assistant (7490) use fixed ports; the
  assistant's is fixed for its Google OAuth redirect. Stop whatever holds the port, then restart the resource.

## Develop

```powershell
pnpm install
pnpm build
pnpm test
```