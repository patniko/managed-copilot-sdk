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

You declare environments once in an [Aspire AppHost](packages/aspire/README.md) and `aspire run` brings up the
platform. Your code keeps using genuine `CopilotClient` and `CopilotSession` objects, standard session events, and
`defineTool` tools. What works today, end to end with real models:

- **Shared, isolated, and promotable environments.** Chat on a shared runtime, coding agents in their own sandboxes
  with setup, files, and artifacts, and sessions that start cheap and move into a sandbox when they need one.
- **Policy you can see.** Per-environment network allowlists, and vault credentials applied at the egress proxy so
  secrets never enter a sandbox.
- **Work that continues without you.** Tool calls wait durably and are answered later by your webhook or a poller;
  schedules and agent reminders run as you after `npx managed-copilot login`.
- **Copilot CLI on a live session.** `npx managed-copilot attach <id>` opens the stock Copilot CLI on the same
  conversation your app uses, and it follows the session when it moves into a sandbox.
- **An operator console.** `npx managed-copilot console` shows the platform as it runs: component health, every
  owner's sessions with their sandboxes and harness configuration, environments, schedules, webhooks, and a live feed,
  with secrets redacted and conversations private.

| Start here | |
| --- | --- |
| [Quickstart](demos/quickstart/README.md) | Every spec snippet as a runnable script, plus one acceptance run against your platform |
| [AI software factory](demos/software-factory/README.md) | A work order goes in; parallel sandboxed agents build, review, and release it |
| [Long-running assistant](demos/assistant/README.md) | A bot you chat with that keeps working while you're away, with Gmail and Google Calendar |
| [`managed-copilot` CLI](packages/cli/README.md) | Background sign-in, sessions, Copilot CLI attach, promotion, artifacts, schedules, and the operator console |
| [Deploy to Azure](docs/deployment.md) | The same AppHost on Azure Container Apps in your subscription |
| [Developer experience spec](docs/spec/developer-experience.md) | The customer contract, decisions, and delivery gates |
| [Architecture](docs/architecture.md) | Topology, protocol facts, and how the pieces fit |

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/protocol` | Shared contracts: AppHost config schema, REST DTOs, errors, events, network policy |
| `packages/sdk` | `@managed-copilot/sdk`: `ManagedCopilot.connect()`, stock clients over a secure bridge |
| `packages/aspire` | `@managed-copilot/aspire`: `addManagedCopilot(builder, name, options)` for Aspire TypeScript AppHosts |
| `packages/cli` | `npx managed-copilot`: background sign-in, sessions, Copilot CLI attach, artifacts, schedules |
| `platform/gateway` | Authenticated gateway: admission, routing, session ledger, platform services, operator API |
| `platform/console` | The operator console the gateway serves at `/console` |
| `platform/sandbox`, `platform/egress` | The sandbox image and its agent; the egress proxy that enforces network policy and vaults |
| `apphost.mts` | The AppHost: `aspire run` starts the platform, its environments, and the demos |
| `demos/quickstart` | Every spec snippet as a runnable script and one acceptance run |
| `demos/software-factory`, `demos/assistant` | The AI software factory and the long-running assistant |
| `docs/` | Spec, architecture, and deployment |

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
npx managed-copilot console            # the operator console: health, sessions, harness configuration
```

To run every snippet from the spec against your platform, start **quickstart** in the Aspire dashboard, or run
`pnpm --filter @managed-copilot/quickstart acceptance`.

- **Stuck at "Trusting certificates…".** The first `aspire run` asks to trust the dashboard's development
  certificate, and the prompt can be hidden. Run `aspire certs trust` once, or use `aspire run --non-interactive`,
  which continues without trusting it (the dashboard then shows a certificate warning).
- **Behind a NuGet proxy.** If nuget.org is blocked, point the Aspire CLI at your proxy with
  `ASPIRE_CLI_NUGET_SERVICE_INDEX=<proxy>/v3/index.json` and add an untracked `NuGet.config` at the repository root
  whose `packageSourceMapping` maps `*` to that proxy (the file is git-ignored).
- **A port is in use.** The gateway (7400), the factory (7480), and the assistant (7490) use fixed ports; the
  assistant's is fixed for its Google OAuth redirect. Stop whatever holds the port, then restart the resource.
- **A second copy beside the first** (for example another checkout): set `MANAGED_COPILOT_PORT_OFFSET=300` to move
  its ports to 7700, 7780, and 7790. It leaves zero-config discovery to the first copy, so point tools at it with
  `MANAGED_COPILOT_URL=http://localhost:7700`.

## Develop

```powershell
pnpm install
pnpm build
pnpm test
```

Contributing: [AGENTS.md](AGENTS.md) has the hard rules (stock SDK and runtime only, no secrets in logs or
sandboxes), commands, and conventions.