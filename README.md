<h1 align="center">Managed Copilot SDK</h1>

<p align="center">
  Run <strong>stock</strong> GitHub Copilot SDK agents in environments you own:<br>
  on your laptop with Aspire, or in your Azure subscription.
</p>

<p align="center">
  <a href="docs/README.md">Start here</a> ·
  <a href="docs/tutorial/README.md">Video tour</a> ·
  <a href="#run-it-locally">Run it locally</a> ·
  <a href="samples/README.md">Walkthroughs</a> ·
  <a href="#the-demos">Demos</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/deployment.md">Deploy to Azure</a> ·
  <a href="docs/spec/developer-experience.md">Spec</a>
</p>

<p align="center">
  <a href="docs/tutorial/README.md"><img src="docs/images/tour.png" alt="Watch the six-minute video tour of Managed Copilot" width="820"></a>
</p>

## Overview

Apps can already build Copilot agents in with the [GitHub Copilot SDK](https://github.com/github/copilot-sdk).
Managed Copilot keeps that SDK exactly as published and changes only **where the agents run**. A platform you deploy
decides whether a session runs on a shared runtime or in its own sandbox, what it may reach on the network, which
secrets it can use, and what happens to its work while your app is offline. Only the setup lines change:

```ts
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot } from "@managed-copilot/sdk";

const managed = await ManagedCopilot.connect(); // your local `aspire run`, or your Azure deployment
const client = await managed.client("chat");    // a stock CopilotClient for the "chat" environment

const session = await client.createSession({ model: "claude-sonnet-5", onPermissionRequest: approveAll });
const reply = await session.sendAndWait({ prompt: "Summarize what changed in Aspire 13" });
console.log(reply?.data.content);
```

You declare environments once in an [Aspire AppHost](packages/aspire/README.md). `aspire run` brings the platform up
on your machine, and `aspire deploy` puts the same AppHost on Azure Container Apps. Your code keeps using genuine
`CopilotClient` and `CopilotSession` objects, standard session events, and `defineTool` tools. What works today, end
to end with real models:

- **Six patterns from three building blocks.** Single containers, a multi-tenant shared runtime, and container
  orchestration combine into coding agents in their own sandboxes, chat on a shared runtime, sessions that start
  cheap and move into a sandbox when they need one, and coordinators that drive a sandbox themselves, delegate to new
  agents in sandboxes of their own, or do both.
- **Policy you can see.** Per-environment network allowlists, and vault credentials applied at the egress proxy so
  secrets never enter a sandbox.
- **Work that continues without you.** Tool calls wait durably and are answered later by your webhook or a poller;
  schedules and agent reminders run as you after `npx managed-copilot login`.
- **Copilot CLI on a live session.** `npx managed-copilot attach <id>` opens the stock Copilot CLI on the same
  conversation your app uses, and it follows the session when it moves into a sandbox. `npx managed-copilot new chat`
  starts a new session in an environment and opens it in Copilot CLI straight away.
- **Your identity, your plan.** Callers sign in with GitHub, sessions use the caller's own Copilot entitlement, and
  no GitHub token ever enters a sandbox.
- **An operator console.** `npx managed-copilot console` shows the platform as it runs: component health, every
  owner's sessions with their sandboxes and harness configuration, environments, schedules, webhooks, and a live feed,
  with secrets redacted and conversations private.

## How it works

<p align="center">
  <img src="docs/images/architecture.png" alt="Your app connects to a gateway you run. The gateway routes sessions to a shared runtime or to per-session sandboxes, brokers model calls through your Copilot plan, and sandboxes reach the Internet only through an egress proxy." width="900">
</p>

- **Your app** uses the stock SDK. `ManagedCopilot.connect()` hands it a client whose connection runs through a
  secure bridge to the gateway.
- **The gateway**, which you run, signs callers in with GitHub and places each session. It keeps a durable record of
  the tool calls and approvals your app must answer, enforces network and secrets policy, and brokers model calls on
  the caller's Copilot plan. It also serves the operator console, where the people who run the platform see its
  health and every session's configuration.
- **The shared runtime** hosts lightweight chat sessions whose tools run in your app. **Sandboxes** give each
  isolated session its own workspace, shell, and packages: Docker locally, Azure Container Apps Sandboxes on Azure.
- **The egress proxy** is a sandbox's only way out. It enforces each environment's allowlist and adds vault
  credentials at the edge, so code in a sandbox only ever sees placeholders.

More in [docs/architecture.md](docs/architecture.md): topology, protocol facts, and each module.

## Three building blocks, six patterns

Every way the platform runs an agent comes from three building blocks: **single containers** (a sandbox per
session), a **virtualized multi-tenant** runtime (one shared runtime process hosting many sessions), and **container
orchestration** (sandboxes created, reused, and deleted while a session runs). Each pattern puts an agent's brain, its
model loop, and its hands, the tools that act, in a different place:

```mermaid
flowchart LR
  subgraph B["Three building blocks"]
    direction TB
    C["Single container<br/>a sandbox per session"]
    MT["Virtualized multi-tenant<br/>the shared runtime"]
    O["Container orchestration<br/>sandboxes created on demand"]
  end
  subgraph P["Six patterns"]
    direction TB
    I["Isolated"]
    S["Shared"]
    PR["Promotable"]
    D["Direct"]
    DL["Delegate"]
    M["Mixed"]
  end
  C --> I
  MT --> S
  MT --> PR
  C --> PR
  MT --> D
  MT --> DL
  MT --> M
  O --> D
  O --> DL
  O --> M
```

| Pattern | Its brain runs | Its hands act | Good for |
| --- | --- | --- | --- |
| **Isolated** | In its own sandbox | In the same sandbox: a workspace, a shell, your packages, your network rules | Coding agents, builds, data work |
| **Shared** | On the shared runtime, beside other sessions | In your app: your tools, web fetches, remote MCP servers | Chat agents and assistants at volume |
| **Promotable** | On the shared runtime, then once in its own sandbox, as the same session | In your app, then in that sandbox | Chats that sometimes need to run code |
| **Direct** | On the shared runtime, with the stock sub-agents it starts | In a sandbox with no agent in it | Harnesses with their own planning that must not run code on their host |
| **Delegate** | On the shared runtime, as a coordinator | Through new agent sessions, each in its own sandbox | Parallel, long-running parts: factories, research |
| **Mixed** | On the shared runtime, as a coordinator | In its own sandbox, and through new agent sessions; the model picks for each part | One conversation with quick work and big work |

```ts
// apphost.mts: one environment per pattern, picked by name with managed.client("lead")
await addManagedCopilot(builder, "copilot", {
  environments: {
    coder:    { type: "isolated", size: "medium" },
    chat:     { type: "shared", network: ["learn.microsoft.com"] },
    helper:   { type: "promotable", promoteTo: "coder" },
    operator: { type: "orchestrator", workers: ["coder"], execution: "direct" },
    team:     { type: "orchestrator", workers: ["coder"], maxWorkers: 3 },
    lead:     { type: "orchestrator", workers: ["coder"], execution: "mixed", maxWorkers: 3 },
  },
});
```

An environment is a template; a client only picks one. Every `chat` session shares one runtime, every `coder` session
gets its own new sandbox, and a `helper` session moves once into a sandbox when it needs one. `operator`, `team`, and
`lead` sessions are coordinators that get sandboxes as their work needs them: one for their own hands, one per
worker, or both.

More in [patterns](docs/concepts/patterns.md) (how to choose, and the scenarios each one fits),
[environments](docs/concepts/environments.md), [sandboxes](docs/concepts/sandboxes.md),
[promotion](docs/concepts/promotion.md), and the [orchestrator](docs/concepts/orchestrator.md).

## The demos

All three demos run under `aspire run` with real models, and the same AppHost publishes them to Azure. For a live
demo, start with the [demo gallery](demos/gallery/README.md): `pnpm gallery` opens one page with every app and
walkthrough, with Local and Azure links and their status.

### AI software factory

<p align="center">
  <img src="demos/software-factory/docs/screenshots/floor-building.png" alt="The agent-led factory floor: a coordinator that created two builder sandboxes and reused them for review fixes, with its decisions listed live" width="900">
</p>

Describe the software you want. A planner splits it into tasks. A coordinator agent then creates a builder in **its
own sandbox** for each task, sends review findings back to the same builder, and creates a release sandbox once every
task passes. The factory still decides what counts: real test reports, a reviewer on a different model, and the
accepted release. The original app-driven pipeline remains as **Classic** mode.

<p align="center">
  <img src="demos/software-factory/docs/screenshots/deliverable.png" alt="The deliverable: release ready, 38 of 38 tests passed, release notes, and per-task review results" width="900">
</p>

→ [demos/software-factory](demos/software-factory/README.md)

### Long-running assistant

<p align="center">
  <img src="demos/assistant/docs/screenshots/approval.png" alt="The assistant found a free slot and asks before adding the meeting to the calendar" width="49%">
  <img src="demos/assistant/docs/screenshots/offline.png" alt="A scheduled check-in ran while the tab was closed; the calendar lookup is marked Handled while you were away" width="49%">
</p>

A bot you chat with that reads your mail and manages your calendar. It uses a clearly labelled demo workspace until
you connect Google, and it always asks before it sends mail or changes your calendar. For hands-on work, such as
charting your meeting load or researching on GitHub, it asks to start a sandbox: an agent in its own isolated
environment, which it reuses for follow-ups. Reminders and recurring briefings run as you, and it keeps working with
the tab closed: the platform runs the turn and calls the assistant's webhook for the tool calls it needs.

→ [demos/assistant](demos/assistant/README.md)

### Dispatch

<p align="center">
  <img src="demos/dispatch/docs/screenshots/conversation.png" alt="A Dispatch conversation: the first message created three Python sandboxes in parallel; the second reused one of them and created a writer's sandbox" width="900">
</p>

A chat with an orchestrator agent that builds the environments your request needs. For every message, the
coordinator decides whether to create new sandboxes, from blueprints the AppHost declares (a Python lab, a Node
workshop, web research, a writer's desk), or to send the work to sandboxes it already has. Each message shows what the
agent did, each sandbox shows which messages created it and reused it, and you approve every new sandbox. Open the same
conversation in Copilot CLI and keep talking there.

→ [demos/dispatch](demos/dispatch/README.md)

## Run it locally

You need Node 24, pnpm 10, Docker Desktop, the Aspire CLI 13.6, a GitHub account with Copilot (`gh auth login`), and
[Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) for attaching to sessions.

```powershell
pnpm install
pnpm build
aspire run        # the dashboard, the platform at http://localhost:7400, and the demos
```

`aspire run` starts the gateway, Dispatch (http://localhost:7470), the software factory (http://localhost:7480), and
the assistant (http://localhost:7490). Your code finds the platform with no configuration: `ManagedCopilot.connect()`
reads the discovery record the local gateway writes. From another terminal:

```powershell
npx managed-copilot status             # the deployment, your account, and its environments
npx managed-copilot new chat           # a new session in the chat environment, opened in Copilot CLI
npx managed-copilot sessions           # your sessions
npx managed-copilot attach 7f3a2c1     # Copilot CLI on a live session (any unique ID prefix)
npx managed-copilot console            # the operator console: health, sessions, harness configuration
pnpm gallery                           # every demo and walkthrough on one page, local and Azure
```

To run every snippet from the spec against your platform, start **quickstart** in the Aspire dashboard, or run
`pnpm --filter @managed-copilot/quickstart acceptance`. To learn by doing, follow the
[walkthroughs](samples/README.md): `pnpm sample 01` is your first agent, in about a minute.

- **Stuck at "Trusting certificates…".** The first `aspire run` asks to trust the dashboard's development
  certificate, and the prompt can be hidden. Run `aspire certs trust` once, or use `aspire run --non-interactive`,
  which continues without trusting it (the dashboard then shows a certificate warning).
- **Behind a NuGet proxy.** If nuget.org is blocked, point the Aspire CLI at your proxy with
  `ASPIRE_CLI_NUGET_SERVICE_INDEX=<proxy>/v3/index.json` and add an untracked `NuGet.config` at the repository root
  whose `packageSourceMapping` maps `*` to that proxy (the file is git-ignored).
- **A port is in use.** The gateway (7400), Dispatch (7470), the factory (7480), and the assistant (7490) use fixed
  ports; the assistant's is fixed for its Google OAuth redirect. Stop whatever holds the port, then restart the
  resource.
- **A second copy beside the first** (for example another checkout): set `MANAGED_COPILOT_PORT_OFFSET=300` to move
  its ports to 7700, 7770, 7780, and 7790. It leaves zero-config discovery to the first copy, so point tools at it with
  `MANAGED_COPILOT_URL=http://localhost:7700`.

## Deploy to Azure

The same AppHost deploys with `aspire deploy`. The gateway, your apps, and the egress proxy run as Azure Container
Apps, each isolated session gets its own Container Apps sandbox, and the platform's state is kept on Azure Files. A
deployed gateway is on the Internet, so `aspire deploy` refuses to publish one until you say who may use it:

```powershell
aspire secret set Azure:SubscriptionId <subscription-id>
aspire secret set Azure:Location westus2
aspire secret set Azure:ResourceGroup managed-copilot-dev
aspire secret set Parameters:copilot-github-users your-login   # or Parameters:copilot-github-orgs
aspire deploy
```

Your code connects exactly as it does locally, with `MANAGED_COPILOT_URL` or `ManagedCopilot.connect({ url })`.
[docs/deployment.md](docs/deployment.md) covers prerequisites, the demo apps' access settings, costs, and teardown.

## What's verified

- **Every example in the spec runs as an automated check** against the real platform with real models. The first 13
  pass locally through the AppHost. On Azure, the 11 that don't need a local webhook receiver pass. The orchestrator
  example (14) passes locally and on Azure. The direct-execution example (15) passes locally.
- **All six patterns run with real models locally.** Isolated, shared, promotable, and delegate have also run on
  Azure. Direct and mixed have not yet run there ([deployment](docs/deployment.md#live-qualification)).
- **Unit and integration tests:** more than 1,100 run with `pnpm test`. Gated end-to-end suites use real Docker
  sandboxes and models for sandboxes, egress policy, promotion, and recovery when the gateway is replaced mid-turn.
- **The demos run end to end, locally and on Azure.** The factory runs in both modes: the classic pipeline, and the
  agent-led mode, whose restart mid-build was tested locally. The assistant runs too; its sandboxes, added last, have
  been verified locally only. Dispatch runs as well, including a follow-up typed in Copilot CLI attached to the same
  conversation.
- **Limits are written down.** Examples: no warm sandbox pools, a single gateway replica, and a turn whose runtime
  process dies ends as failed, so the user retries. The spec's [delivery gates](docs/spec/developer-experience.md#delivery-gates)
  list what each gate proved and what it did not.

## Documentation

| | |
| --- | --- |
| [Start here](docs/README.md) | A learning path, twelve visual concept pages, an "I want to…" index, and a glossary |
| [Demo walkthrough](docs/walkthrough.md) | Every demo locally, then deployed to Azure, then shared with teammates: commands and what to check |
| [Walkthroughs](samples/README.md) | Thirteen hands-on walkthroughs with runnable code (`pnpm sample 01`) and real output |
| [Video tour](docs/tutorial/README.md) | Six narrated minutes: the idea, how it works, and two demos running for real. Recorded before the direct, delegate, and mixed patterns and Dispatch |
| [Quickstart](demos/quickstart/README.md) | Every spec snippet as a runnable script, plus one acceptance run against your platform |
| [AI software factory](demos/software-factory/README.md) | A work order goes in; parallel sandboxed agents build, review, and release it |
| [Long-running assistant](demos/assistant/README.md) | A bot you chat with that keeps working while you're away, with Gmail, Google Calendar, and sandboxes for hands-on work |
| [Dispatch](demos/dispatch/README.md) | A chat with an orchestrator agent that creates a sandbox for each part of a request, or reuses the ones it has |
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
| `deploy/azure` | The Azure integration for `aspire deploy`: hosting, the gateway's lease supervisor, and qualification probes |
| `apphost.mts` | The AppHost: `aspire run` starts the platform, its environments, and the demos |
| `demos/quickstart` | Every spec snippet as a runnable script and one acceptance run |
| `samples` | The walkthroughs' code: small, commented scripts you run with `pnpm sample <number>` |
| `demos/software-factory`, `demos/assistant`, `demos/dispatch` | The AI software factory, the long-running assistant, and Dispatch |
| `demos/gallery` | `pnpm gallery`: every demo and walkthrough on one page, with local and Azure links |
| `docs/` | Start here and the concept pages, spec, architecture, deployment, and the video tour |

## Develop

```powershell
pnpm install
pnpm build
pnpm test
```

Contributing: [AGENTS.md](AGENTS.md) has the hard rules (stock SDK and runtime only, no secrets in logs or
sandboxes), commands, and conventions.
