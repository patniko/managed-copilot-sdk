<h1 align="center">Managed Copilot SDK</h1>

<p align="center">
  Run unmodified GitHub Copilot SDK agents in environments you own:<br>
  on your laptop with Aspire, or in your Azure subscription.
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="walkthroughs/README.md">Walkthroughs</a> ·
  <a href="#demos">Demos</a> ·
  <a href="docs/deployment.md">Deploy to Azure</a>
</p>

## What it is

The [GitHub Copilot SDK](https://github.com/github/copilot-sdk) lets apps build Copilot agents. Managed Copilot keeps
that SDK exactly as published and changes only **where the agents run**: a platform you deploy decides whether a
session shares a runtime or gets its own sandbox, what it can reach on the network, which secrets it can use, and what
happens to its work while your app is offline. Only the setup lines change:

```ts
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";

const managed = await ManagedCopilot.connect(); // your local `aspire run`, or your Azure deployment
const client = await managed.client("chat");    // a stock CopilotClient for the "chat" environment

const session = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
const reply = await session.sendAndWait({ prompt: "Summarize what changed in Aspire 13" });
console.log(reply?.data.content);
```

- **Sandboxes when you need them.** Chat agents share one runtime; coding agents get their own container; a session
  can start shared and move into a sandbox mid-conversation.
- **Policy you can see.** Per-environment network allowlists, and secrets added at the egress proxy so they never
  enter a sandbox.
- **Work that continues without you.** Tool calls wait durably for your app, a webhook, or a poller; schedules run as
  you.
- **Copilot CLI on a live session.** `npx managed-copilot attach <id>` opens the stock Copilot CLI on the same
  conversation your app is using.
- **Your identity, your plan.** Callers sign in with GitHub and use their own Copilot entitlement. No GitHub token
  ever enters a sandbox.

## How it works

<p align="center">
  <img src="docs/images/architecture.png" alt="Your app connects to a gateway you run. The gateway routes sessions to a shared runtime or to per-session sandboxes, brokers model calls through your Copilot plan, and sandboxes reach the Internet only through an egress proxy." width="900">
</p>

Your app uses the stock SDK; `ManagedCopilot.connect()` routes its connection to a **gateway** you run. The gateway
signs callers in with GitHub, places each session on the **shared runtime** or in its own **sandbox** (Docker locally,
Azure Container Apps Sandboxes on Azure), and brokers model calls on the caller's Copilot plan. Sandboxes reach the
Internet only through an **egress proxy** that enforces each environment's allowlist.

You declare environments once in an [Aspire AppHost](libraries/aspire/README.md):

```ts
await addManagedCopilot(builder, "copilot", {
  environments: {
    chat:   { type: "shared", network: ["learn.microsoft.com"] },   // many chats, one runtime
    coder:  { type: "isolated", size: "medium" },                   // a sandbox per session
    helper: { type: "promotable", promoteTo: "coder" },             // starts shared, moves when it needs to
    team:   { type: "orchestrator", workers: ["coder"] },           // a coordinator that starts workers in sandboxes
  },
});
```

`aspire run` brings it up on your machine; `aspire deploy` puts the same AppHost on Azure. See
[patterns](docs/concepts/patterns.md) for all six ways to run an agent and how to choose.

## Quickstart

You need Node 24, pnpm 10, Docker, the [Aspire CLI](https://aspire.dev) 13.6, a GitHub account with Copilot
(`gh auth login`), and [Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) for attaching to sessions.

```powershell
pnpm install
pnpm build
aspire run              # the platform at http://localhost:7400, plus the demos
```

Then, from another terminal:

```powershell
pnpm walkthrough 01                 # your first agent, in about a minute
npx managed-copilot new chat        # a new session, opened in Copilot CLI
npx managed-copilot console         # the operator console
pnpm gallery                        # every demo and walkthrough on one page
```

<details>
<summary>Troubleshooting</summary>

- **Stuck at "Trusting certificates…".** Run `aspire certs trust` once, or use `aspire run --non-interactive`.
- **nuget.org is blocked.** Set `ASPIRE_CLI_NUGET_SERVICE_INDEX=<proxy>/v3/index.json` and add an untracked
  `NuGet.config` at the repository root that maps `*` to that proxy.
- **A port is in use.** The gateway (7400), Data Desk (7430), Dispatch (7470), the factory (7480), and the assistant (7490) use fixed
  ports. To run a second copy, set `MANAGED_COPILOT_PORT_OFFSET=300` and point tools at it with
  `MANAGED_COPILOT_URL=http://localhost:7700`.

</details>

## Demos

All of them run under `aspire run` with real models and deploy to Azure with the same AppHost.

<p align="center">
  <img src="demos/software-factory/docs/screenshots/floor-building.png" alt="The software factory floor: a coordinator that created two builder sandboxes and reused one for review fixes" width="900">
</p>

| Demo | What it shows |
| --- | --- |
| [AI software factory](demos/software-factory/README.md) | Describe the software you want; a coordinator gives each task a builder in its own sandbox, sends review findings back, and releases once real tests pass |
| [Long-running assistant](demos/assistant/README.md) | A chat bot for your mail and calendar that asks before acting, starts sandboxes for hands-on work, and keeps working with the tab closed |
| [Dispatch](demos/dispatch/README.md) | An orchestrator chat that creates a sandbox for each part of a request, or reuses one it has, and can be continued in Copilot CLI |
| [Research Swarm](demos/research-swarm/README.md) | One question fans out to web researchers, each in its own sandbox, and comes back as a report where every claim cites a page they read |
| [Pattern Race](demos/pattern-race/README.md) | One job raced through all six patterns at once: where each agent thinks and acts, its time, sandboxes, and premium requests, and a scorecard |
| [Data Desk](demos/data-desk/README.md) | Chat with a spreadsheet: the app's own tools answer on the shared runtime, and a chart request moves the same session into a Python sandbox, with Copilot CLI following it |
| [Help Desk](demos/help-desk/README.md) | A support rush: 25 customers, each chatting with a private agent bound to their own orders, all on one shared runtime with no sandboxes; refunds wait for the operator |
| [Incident Commander](demos/incident-commander/README.md) | An alert opens an incident; Copilot triages in its own sandbox, hands the repro and fix to workers, and asks before deploying, even with the tab closed |

## Deploy to Azure

```powershell
aspire secret set Azure:SubscriptionId <subscription-id>
aspire secret set Azure:Location westus2
aspire secret set Azure:ResourceGroup managed-copilot-dev
aspire secret set Parameters:copilot-github-users your-login   # who may use the deployment
aspire deploy
```

Your code connects the same way, with `MANAGED_COPILOT_URL`. [docs/deployment.md](docs/deployment.md) covers
prerequisites, access, cost, and teardown.

## Status

A working reference implementation, not a supported product. Every spec example runs as an automated check against the
real platform, all six patterns run locally (four also on Azure), and `pnpm test` runs over 1,600 tests. Known limits
include a single gateway replica and no warm sandbox pools; see [live qualification](docs/deployment.md#live-qualification).

## Learn more

| | |
| --- | --- |
| [Start here](docs/README.md) | Learning path, concept pages, an "I want to…" index, and a glossary |
| [Walkthroughs](walkthroughs/README.md) | Thirteen short, runnable walkthroughs with real output |
| [Demo walkthrough](docs/walkthrough.md) | A checklist to run every demo locally and on Azure |
| [`managed-copilot` CLI](libraries/cli/README.md) | Sign-in, sessions, Copilot CLI attach, artifacts, schedules, and the console |
| [Spec snippets](tests/snippets/README.md) | Every spec example as a runnable script |
| [Developer experience spec](docs/spec/developer-experience.md) | The full API contract and design decisions |
| [Architecture](docs/architecture.md) | Topology, protocol facts, and a code map |
| [Threat model](docs/threat-model.md) | Trust boundaries and what the platform defends against |
| [Video tour](docs/tutorial/README.md) | Source for a six-minute narrated tour (build it locally; predates Dispatch) |

## Repository layout

| Path | Contents |
| --- | --- |
| `libraries/` | The SDK, Aspire integration, CLI, shared protocol, and UI theme |
| `services/` | The gateway, operator console, sandbox image, and egress proxy |
| `deployments/azure` | The Azure target for `aspire deploy` (AWS is a [roadmap](deployments/aws/README.md)) |
| `environments/` | Per-environment agents, skills, and instructions for the root AppHost |
| `demos/`, `walkthroughs/`, `tests/snippets` | The demo apps, walkthroughs, and spec snippets |
| `apphost.mts` | The root AppHost that `aspire run` starts |

To work on the platform: `pnpm install`, `pnpm build`, `pnpm test`.

## License

[MIT](LICENSE)
