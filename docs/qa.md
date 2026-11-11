# Quality assurance

One definition of "it works" for Managed Copilot: the checks every change and every release is held to, how to run
them, and which user-facing flow each one covers. The checks live in
[`tests/qa/src/catalog.ts`](../tests/qa/src/catalog.ts), and `pnpm qa` runs them.

```powershell
pnpm qa                 # the ci tier: what CI runs on every pull request
pnpm qa e2e             # opt-in end-to-end tests; each starts its own gateway
pnpm qa local           # against `aspire run`: spec snippets, walkthroughs, demo scripts
pnpm qa all             # ci, e2e, and local
pnpm qa azure --url https://copilot.<environment-domain> --apps-domain <environment-domain>
```

## Tiers

| Tier | Command | What runs | Needs | When |
| --- | --- | --- | --- | --- |
| `ci` | `pnpm qa` | `ci.build`, `ci.typecheck`, and `ci.test`: every package's tests, with fakes | `pnpm install` | Every pull request (CI runs the same three) |
| `e2e` | `pnpm qa e2e` | The opt-in end-to-end, Docker, and live tests. Each starts its own gateway on a free port, with real models and real Docker sandboxes | Docker, a GitHub account with Copilot | Before merging a change to the gateway, sandbox, egress proxy, or SDK |
| `local` | `pnpm qa local` | Every spec snippet, walkthrough, and demo script against the running local platform, and the checks to do by hand | `aspire run --non-interactive` (all demos up), a GitHub account with Copilot, `npx managed-copilot login` for schedules | Before a release, and after merging a batch of work |
| `azure` | `pnpm qa azure --url <gateway>` | The spec snippets and demo scripts against a deployment, the isolated-compute qualification, and the Azure checks to do by hand | A deployment, `--apps-domain` for the demos, `--isolated-env` for the qualification | After every deploy |

A check whose needs aren't met is **skipped** with the reason (Docker not running, a demo not answering, background
sign-in off), never passed. `--strict` counts skipped checks as failures.

## The release gate

- **Every pull request:** `ci` passes (CI enforces it).
- **Before merging platform or SDK changes:** `ci` and `e2e` pass, plus the `local` checks for the flows you touched
  (`pnpm qa --only local.snippet-08,local.walkthrough-04`).
- **Before a release, or after merging a batch of work:** `pnpm qa all` passes with nothing skipped that you can't
  explain, and every check it lists under **By hand** is done.
- **After deploying to Azure:** `pnpm qa azure ...` passes, and the Azure checks under **By hand** are done.

Record each release run in the [run log](#run-log).

## Run it

```powershell
pnpm qa local --list                             # what would run, what each check needs, what it costs
pnpm qa --only local.snippet-07,local.demo       # by ID or ID prefix, from any tier
pnpm qa local --skip local.demo-software-factory # leave the expensive ones out
pnpm qa local --strict                           # skipped counts as failed
pnpm qa local --url http://localhost:9400 --port-offset 2000   # a second AppHost (MANAGED_COPILOT_PORT_OFFSET)
```

- **Output.** Each check streams its own output, then one line with its outcome. The summary lists every check, then
  the checks to do by hand. Results go to `tests/qa/.output/last-run.json` (snippets also write
  `tests/qa/.output/reports/<check>.json`).
- **Cost.** Checks that call models list their cost (`--list`). A full `local` run takes dozens of premium requests,
  most of them the software factory's; skip it when the factory hasn't changed.
- **Unattended.** Checks run without a terminal for input, so snippet 13 checks the attach socket instead of opening
  Copilot CLI, and nothing waits on a prompt.
- **Snippet 10** (offline webhook) needs the snippets webhook secret, which only the Aspire dashboard's **snippets**
  resource has. From a terminal it is skipped unless `COPILOT_WEBHOOK_SECRET` is set; `e2e.durable` checks the same
  webhook flow either way.
- **Walkthrough 01** leaves its session running, so you can open it in Copilot CLI. `npx managed-copilot sessions`
  lists it.

## Flow coverage

Every user-facing flow, the tests that run in CI, and the live checks that exercise it with real models.

| Status | Meaning |
| --- | --- |
| ✅ Automated | Automated live checks exercise the flow end to end |
| 🟡 Partial | Automated live checks cover part of the flow; the rest is by hand or untested |
| 🖐 By hand | Only a check you do by hand covers it live |
| ⛔ Not covered | No live check: tests with fakes only |

### Sessions and sandboxes

| Flow | Spec | Tests in CI | Live checks | In Azure | Status |
| --- | --- | --- | --- | --- | --- |
| Connect and sign in | §2 | `libraries/sdk/test/connection.test.ts`, `services/gateway/test/core.test.ts` | `local.snippet-01`, `local.walkthrough-01`, `e2e.model` | `azure.snippet-01` | ✅ Automated |
| Shared: a chat agent with your own tools | §3 | `services/gateway/test/sdk.e2e.test.ts`, `services/gateway/test/core.callbacks.test.ts` | `local.snippet-02`, `local.walkthrough-02`, `e2e.model`, `local.demo-help-desk` | `azure.snippet-02`, `azure.demo-help-desk` | ✅ Automated |
| Isolated: a coding agent in its own sandbox | §4 | `services/gateway/test/sandbox-service.test.ts`, `services/gateway/test/placement.test.ts`, `services/sandbox/test/runtime.test.ts` | `local.snippet-03`, `local.walkthrough-03`, `e2e.isolated`, `e2e.sandbox`, `local.demo-repo-doctor` | `azure.snippet-03`, `azure.demo-repo-doctor` | ✅ Automated |
| An idle sandbox's compute is replaced, keeping its disks | §4 | `services/gateway/test/sandbox-azure.test.ts` | `e2e.sandbox` | `azure.isolated` | ✅ Automated |
| Set up the sandbox | §5 | `services/gateway/test/sandbox-images.test.ts`, `services/gateway/test/sandbox-params.test.ts`, `libraries/aspire/test/sandbox-images.test.ts` | `local.snippet-04`, `e2e.sandbox` | `azure.snippet-04` | ✅ Automated |
| Get results out: files and artifacts | §6 | `services/gateway/test/sandbox-artifacts.test.ts` | `local.snippet-05`, `local.walkthrough-03` | `azure.snippet-05` | 🟡 Partial: `npx managed-copilot artifacts` is tested with fakes only |
| Control network access | §7 | `services/gateway/test/network.test.ts`, `services/egress/test/proxy.test.ts` | `local.snippet-06`, `local.walkthrough-07`, `e2e.egress`, `e2e.sandbox` | `azure.snippet-06` | ✅ Automated |
| Keep secrets out of the sandbox (vaults) | §8 | `libraries/sdk/test/vaults.test.ts`, `services/egress/test/substitute.test.ts`, `services/egress/test/redaction.test.ts` | `local.snippet-07`, `local.walkthrough-07`, `e2e.egress` | `azure.snippet-07` | ✅ Automated |
| Promotable: start cheap, move when needed | §9 | `services/gateway/test/promotion.test.ts`, `services/gateway/test/core.promotion-cutover.test.ts`, `libraries/sdk/test/promote.test.ts` | `local.snippet-08`, `local.walkthrough-04`, `e2e.promotion`, `local.demo-data-desk` | `azure.snippet-08`, `azure.demo-data-desk` | ✅ Automated |
| Ship agents with an environment | §10 | `libraries/aspire/test/add.test.ts`, `libraries/aspire/test/options.test.ts` | `local.walkthrough-05`, `local.walkthrough-06`, `local.demo-software-factory-office` | `azure.demo-software-factory-office` | ✅ Automated |
| Come back later | §11 | `services/gateway/test/core.lost-turns.test.ts`, `services/gateway/test/core.workspace.test.ts` | `local.snippet-09`, `e2e.model` | `azure.snippet-09` | ✅ Automated |
| A gateway replaced mid-turn, or by a new revision | §11 | `services/gateway/test/core.lost-turns.test.ts` | `e2e.rollover` | `azure.revision` | 🟡 Partial: automated locally, by hand in Azure |

### Offline and scheduled work

| Flow | Spec | Tests in CI | Live checks | In Azure | Status |
| --- | --- | --- | --- | --- | --- |
| Keep working while your app is offline: webhooks | §12 | `services/gateway/test/durable/webhooks.test.ts`, `services/gateway/test/durable/actions.test.ts`, `libraries/sdk/test/durable.test.ts` | `e2e.durable`, `local.snippet-10`, `local.demo-incident-commander` | Not run: snippet 10 needs the local receiver | ✅ Automated |
| Keep working while your app is offline: polling | §12 | `services/gateway/test/durable/actions.test.ts` | `local.snippet-11`, `local.walkthrough-08`, `e2e.durable` | `azure.snippet-11` | ✅ Automated |
| Run on a schedule | §13 | `services/gateway/test/durable/schedules.test.ts`, `services/gateway/test/durable/cron.test.ts` | `local.snippet-12`, `local.walkthrough-09`, `e2e.durable` | Not run: snippet 12 needs the local receiver | ✅ Automated |
| Background sign-in: `login` and `logout` | §12, §13 | `services/gateway/test/durable/credentials.test.ts`, `libraries/cli/test/cli.test.ts` | `e2e.durable` (its own gateway's credential) | None | 🟡 Partial: `npx managed-copilot login` itself is by hand |
| A long-running assistant: approvals, reminders, work while you're away | §12, §13, §17 | `demos/assistant/test/background.test.ts`, `demos/assistant/test/sandboxes.test.ts` | `local.demo-assistant`, `local.demo-assistant-away` | `azure.demo-assistant`, `azure.demo-assistant-away` | ✅ Automated |

### Copilot CLI

| Flow | Spec | Tests in CI | Live checks | In Azure | Status |
| --- | --- | --- | --- | --- | --- |
| The attach socket: owner-only, one session, no creation | §14 | `services/gateway/test/attach.test.ts`, `services/gateway/test/attach-policy.test.ts`, `libraries/sdk/test/attach-relay.test.ts` | `local.snippet-13` | `azure.snippet-13` | ✅ Automated |
| The real Copilot CLI in a terminal: `new`, `attach`, turns, approvals, Esc, reconnecting after a promotion | §14 | `libraries/sdk/test/copilot-spawn.test.ts`, `libraries/cli/test/cli.test.ts` | `local.cli-attach` | `azure.cli-attach` | 🖐 By hand |

### Orchestrators and direct execution

| Flow | Spec | Tests in CI | Live checks | In Azure | Status |
| --- | --- | --- | --- | --- | --- |
| Orchestrator: a coordinator with workers | §17 | `services/gateway/test/orchestrator.test.ts`, `services/gateway/test/orchestrator-recovery.test.ts`, `libraries/sdk/test/workers.test.ts` | `local.snippet-14`, `local.walkthrough-11`, `local.demo-research-swarm`, `local.demo-software-factory` | `azure.snippet-14`, `azure.demo-research-swarm`, `azure.demo-software-factory` | ✅ Automated |
| Direct and mixed coordinators, and their hands | §17 | `services/gateway/test/orchestrator-direct.test.ts`, `services/gateway/test/platform-tools.test.ts` | `local.snippet-15`, `local.walkthrough-12`, `e2e.hands`, `e2e.platform-tools`, `local.demo-incident-commander` | `azure.snippet-15`, `azure.demo-incident-commander` | ✅ Automated |
| All six patterns on one job | §17 | `demos/pattern-race/test/race.test.ts` | `local.demo-pattern-race` | `azure.demo-pattern-race` | ✅ Automated |
| Dispatch: direct, delegate, and mixed work in one chat | §17 | `demos/dispatch/test/conversation.test.ts`, `demos/dispatch/test/platform.test.ts` | `local.dispatch` | `azure.demos-ui` | 🖐 By hand: Dispatch has no script |
| Run commands directly: `managed.exec` | §18 | `services/gateway/test/sandbox-exec.test.ts`, `services/sandbox/test/execs.test.ts` | `local.walkthrough-13`, `e2e.sandbox-exec` | None | ✅ Automated |

### Demos working together

| Flow | Spec | Tests in CI | Live checks | In Azure | Status |
| --- | --- | --- | --- | --- | --- |
| Work routed to the software factory: a storefront bug, an incident's fix, an insight | §3, §17 | `demos/software-factory/test/routing.test.ts`, `demos/help-desk/test/factory.test.ts`, `demos/help-desk/test/issues.test.ts`, `demos/incident-commander/test/factory.test.ts`, `demos/data-desk/test/factory.test.ts` | `local.demo-incident-commander-factory`, `local.factory-routing` | `azure.demo-incident-commander-factory` | 🟡 Partial: Help Desk's and Data Desk's sends are checked by hand |

### Apps, people, and models

| Flow | Spec | Tests in CI | Live checks | In Azure | Status |
| --- | --- | --- | --- | --- | --- |
| Model calls on each user's own Copilot plan | §15 | `services/gateway/test/core.test.ts` | `e2e.model`, `local.demo-front-desk` | Every `azure` check that calls a model | ✅ Automated |
| An app acting for its own users, on Azure AI Foundry | §2, §15 | `services/gateway/test/apps-foundry.test.ts`, `libraries/sdk/test/app-identity.test.ts` | `local.demo-front-desk-foundry` | `azure.demo-front-desk-foundry` | 🟡 Partial: needs a Foundry account (`Parameters:foundry-account`) |

### Operating the deployment

| Flow | Spec | Tests in CI | Live checks | In Azure | Status |
| --- | --- | --- | --- | --- | --- |
| The operator console and `npx managed-copilot operator` | §16 | `services/console/test/routes.test.ts`, `services/gateway/test/operator.test.ts`, `services/gateway/test/operator-redaction.test.ts` | `local.console` | `azure.demos-ui` | 🖐 By hand |
| The local platform and its demos come up healthy | §1 | `libraries/aspire/test/add.test.ts` | Every `local` check needs it; `local.gallery` opens each demo | None | ✅ Automated |
| The demo gallery | §10 | `demos/gallery/test/gallery.test.ts` | `local.gallery` | `azure.demos-ui` | 🖐 By hand |
| Deploy to Azure | §10 | `libraries/cli/test/deploy.test.ts`, `libraries/aspire/test/publish.test.ts` | None | `azure.deploy` | 🖐 By hand |
| Public apps beside allowlisted apps | §10 | `libraries/aspire/test/publish-app.test.ts` | None | `azure.public-apps` | 🖐 By hand |
| `npx managed-copilot promote`, `workers`, `exec`, `artifacts`, `schedules` | §6, §9, §13, §17, §18 | `libraries/cli/test/cli.test.ts` | None (the snippets cover the SDK calls behind them) | None | ⛔ Not covered |

## Copilot CLI in a terminal

The steps for `local.cli-attach` (and `azure.cli-attach`, with `MANAGED_COPILOT_URL` set). Use Copilot CLI 1.0.103 or
later (`copilot --version`).

- [ ] `npx managed-copilot new chat` opens Copilot CLI; the first time, trust the empty folder (**1. Yes**).
- [ ] A question gets a streamed answer.
- [ ] Ask it to run a command: the CLI asks (**1. Approve once** / **2. Deny**), and the command runs after you approve.
- [ ] **Esc** while a turn runs cancels it.
- [ ] `/exit` prints `Detached from <id>. The session keeps running.`, and `npx managed-copilot attach <id>` shows the
      same conversation.
- [ ] `npx managed-copilot new coder`: the footer reads `remote /workspace`, and `uname -a` prints Linux.
- [ ] Open a Data Desk analysis in Copilot CLI and ask for a chart: the session moves into a sandbox, and the CLI
      reconnects by itself.
- [ ] With a Copilot CLI older than 1.0.103 on PATH, `new` stops before creating a session and says to run
      `copilot update`.

## Work routed to the software factory

The steps for `local.factory-routing`, with `aspire run` up (Software Factory, Help Desk, and Data Desk run with it).

- [ ] Help Desk: simulate 25 customers. Aisha's and Ben's agents report promo codes rejected at checkout, Lucas's a cart
      quantity that changed, and Hannah's and Arjun's an order shown as delivered that is out for delivery. The wall's
      **Software issues** groups the reports by area.
- [ ] **Send to Software Factory** on an issue: it shows the work order (`WO-<n>`) and its status, and the factory's
      work order list marks it **Help Desk**.
- [ ] On the factory's floor the work order starts from **From Help Desk**: the brief quotes the reports, and it brought
      `BUG_REPORT.md` and the `contoso-storefront` project. The release fixes the storefront with regression tests, and
      the Deliverable lists the files it changed.
- [ ] Data Desk: pick **Storefront checkout funnel** and ask the suggested question. Copilot finds that mobile shoppers
      with $40–$49 carts drop out at the shipping step.
- [ ] Select rows in Copilot's table and **Send to Software Factory** with what to build: the conversation shows the
      work order, and the factory's floor shows **From Data Desk** with `INSIGHT.md` and the data files.
- [ ] Restart Help Desk (`aspire resource help-desk restart --apphost apphost.mts`): the wall still shows its issues'
      work orders.

## Known gaps

What the matrix marks 🟡, 🖐, or ⛔, and what would close it:

| Gap | Status | What would close it |
| --- | --- | --- |
| The real Copilot CLI in a terminal | 🖐 By hand | A check that drives `managed-copilot new` and `attach` under a pseudo-terminal (node-pty), as the [attach regression](architecture.md#copilot-cli-attach-spec-section-14) was verified by hand |
| The operator console | 🖐 By hand | A browser check like the assistant's (playwright-core with Microsoft Edge) |
| Dispatch | 🖐 By hand | A `happy-path` script like the other demos' |
| Help Desk's and Data Desk's sends to the software factory | 🟡 Partial | A `--factory` option on their `happy-path` scripts, like Incident Commander's |
| `managed-copilot` commands other than `new` and `attach` | ⛔ Not covered | A script that runs each command against the local platform |
| Gateway revisions, deploys, and public apps in Azure | 🖐 By hand | A scheduled deploy into a throwaway resource group |
| Apps on Azure AI Foundry | 🟡 Partial | A Foundry account for QA runs |
| Windows and macOS hosts | 🖐 By hand | CI runs on Linux only; add Windows and macOS runners for `ci` |

## Run log

| Date | Tier | Where | Result |
| --- | --- | --- | --- |
| 2026-11-04 | `ci` | Windows 11 ARM64 | `pnpm qa`: 3 of 3 passed (build, type checks, every package's tests) |
| 2026-11-04 | `e2e` (subset) | Windows 11 ARM64 | `e2e.model` passed |
| 2026-11-04 | `local` (subset) | Windows 11 ARM64 | `local.snippet-01`, `local.walkthrough-02`, and `local.walkthrough-08` passed. `local.demo-help-desk` failed: the gateway on port 7400 came from an older `aspire run` that has no `help-desk` environment, while the demos came from a newer one. `local.demo-front-desk-foundry` skipped (no Foundry account) |
| 2026-11-04 | `local` (by hand) | Windows 11 ARM64 | `local.cli-attach`: Copilot CLI 1.0.92 refused before a session was created; 1.0.105 attached, ran a turn, and detached |
| 2026-10-24 to 2026-11-04 | `azure` | westus2 | See [live qualification](deployment.md#live-qualification) |

## Check catalog

Generated from [`tests/qa/src/catalog.ts`](../tests/qa/src/catalog.ts). After changing a check, run
`pnpm qa --update-docs`; `pnpm test` fails while this section and the catalog differ, while a snippet, walkthrough,
demo script, or opt-in test has no check, or while a check isn't mapped to a flow above.

<!-- qa:catalog:start (generated by `pnpm qa --update-docs`; do not edit by hand) -->

### `ci`

What CI runs on every pull request: build, type checks, and every package's tests. Needs `pnpm install`.

| Check | What it checks | Also needs | Model cost |
| --- | --- | --- | --- |
| `ci.build` | Build every package | - | - |
| `ci.typecheck` | Type-check every package | - | - |
| `ci.test` | Every package's tests, with fakes (opt-in end-to-end tests stay skipped) | - | - |

### `e2e`

Opt-in end-to-end tests; each starts its own gateway, with real models and Docker sandboxes. Needs Docker, a GitHub account with Copilot.

| Check | What it checks | Also needs | Model cost |
| --- | --- | --- | --- |
| `e2e.model` | G1: the stock SDK and runtime with a real model: shared sessions, resume, ownership | GitHub sign-in | a few premium requests |
| `e2e.isolated` | G1: isolated sessions: a custom agent, your tools, two sandboxes, resume, delete | GitHub sign-in, Docker | a few premium requests |
| `e2e.promotion` | G5: promotion from shared into a sandbox, with an artifact and session.promoted | GitHub sign-in, Docker | a few premium requests |
| `e2e.rollover` | A gateway replaced mid-turn: the turn ends visibly and the session continues | GitHub sign-in, Docker | a few premium requests |
| `e2e.hands` | Hands tools (view, glob, grep, bash) in the real sandbox image | Docker | - |
| `e2e.sandbox` | Isolated placement: setup, persistence, network denial, idle stop and resume | GitHub sign-in, Docker | a few premium requests |
| `e2e.sandbox-exec` | managed.exec and managed.sandboxes in real sandboxes (no model) | GitHub sign-in, Docker | - |
| `e2e.egress` | The egress proxy with real containers: allowlists, vault substitution, redaction, CA trust | Docker | - |
| `e2e.durable` | G2: durable actions, webhooks, polling, schedules, and a detached agent | GitHub sign-in | about ten premium requests |
| `e2e.platform-tools` | Platform tools: sub-agent attribution and cancellation | GitHub sign-in | a few premium requests |

### `local`

Spec snippets, walkthroughs, and demo scripts against the running local platform. Needs `aspire run`, a GitHub account with Copilot.

| Check | What it checks | Also needs | Model cost |
| --- | --- | --- | --- |
| `local.snippet-01` | Snippet 01: The idea in one snippet | - | a few premium requests |
| `local.snippet-02` | Snippet 02: Shared: a chat agent with your own tools (§3) | - | a few premium requests |
| `local.snippet-03` | Snippet 03: Isolated: a coding agent in its own sandbox (§4) | - | a few premium requests |
| `local.snippet-04` | Snippet 04: Set up the sandbox (§5) | - | a few premium requests |
| `local.snippet-05` | Snippet 05: Get results out (§6) | - | a few premium requests |
| `local.snippet-06` | Snippet 06: Control network access (§7) | - | a few premium requests |
| `local.snippet-07` | Snippet 07: Keep secrets out of the sandbox (§8) | - | a few premium requests |
| `local.snippet-08` | Snippet 08: Promotable: start cheap, move when needed (§9) | - | a few premium requests |
| `local.snippet-09` | Snippet 09: Come back later (§11) | - | a few premium requests |
| `local.snippet-10` | Snippet 10: Keep working while your app is offline: webhook (§12) | - | a few premium requests |
| `local.snippet-11` | Snippet 11: Keep working while your app is offline: polling (§12) | - | a few premium requests |
| `local.snippet-12` | Snippet 12: Run on a schedule (§13) | - | a few premium requests |
| `local.snippet-13` | Snippet 13: Open a session in Copilot CLI: the attach socket (§14) | - | a few premium requests |
| `local.snippet-14` | Snippet 14: Orchestrator: a coordinator with workers (§17) | - | a few premium requests |
| `local.snippet-15` | Snippet 15: Execution styles: a direct coordinator's hands (§17) | - | a few premium requests |
| `local.walkthrough-01` | Walkthrough 01: Your first agent (leaves its session running, to open in Copilot CLI) | - | a few premium requests |
| `local.walkthrough-02` | Walkthrough 02: Give it your own tools | - | a few premium requests |
| `local.walkthrough-03` | Walkthrough 03: A coding agent in a sandbox | - | a few premium requests |
| `local.walkthrough-04` | Walkthrough 04: Start cheap, move when needed | - | a few premium requests |
| `local.walkthrough-05` | Walkthrough 05: Choose an environment from code | - | a few premium requests |
| `local.walkthrough-06` | Walkthrough 06: Bring your own harness | - | a few premium requests |
| `local.walkthrough-07` | Walkthrough 07: Network rules and secrets | - | a few premium requests |
| `local.walkthrough-08` | Walkthrough 08: Keep working while your app is offline | background sign-in | a few premium requests |
| `local.walkthrough-09` | Walkthrough 09: Run on a schedule | background sign-in | a few premium requests |
| `local.walkthrough-11` | Walkthrough 11: Split a job across workers | - | a few premium requests |
| `local.walkthrough-12` | Walkthrough 12: Direct execution | - | a few premium requests |
| `local.walkthrough-13` | Walkthrough 13: Your own harness | - | a few premium requests |
| `local.demo-pattern-race` | Pattern Race: one job in all six patterns | pattern-race app | one premium request per lane |
| `local.demo-help-desk` | Help Desk: five customers on one shared runtime, with approvals | help-desk app | a couple of premium requests |
| `local.demo-repo-doctor` | Repo Doctor: fix a failing repository in a sandbox with network rules | repo-doctor app | two turns |
| `local.demo-data-desk` | Data Desk: answers on the shared runtime, then a move into a Python sandbox | data-desk app | about two premium requests |
| `local.demo-research-swarm` | Research Swarm: parallel researchers and a cited report | research-swarm app | a handful of premium requests |
| `local.demo-incident-commander` | Incident Commander: a mixed coordinator and an approval that waits | incident-commander app | a handful of premium requests |
| `local.demo-incident-commander-factory` | Incident Commander and Software Factory: an incident's fix built by the factory, verified, and deployed | incident-commander app, software-factory app | a dozen or so premium requests |
| `local.demo-software-factory` | Software Factory: plan, parallel builders, review, release | software-factory app | dozens of premium requests |
| `local.demo-software-factory-office` | Software Factory: its planner and reviewer agents in shared environments | - | a few premium requests |
| `local.demo-assistant` | Assistant: inbox triage and an approval in the real UI (Microsoft Edge) | assistant app, Microsoft Edge | a few premium requests |
| `local.demo-assistant-away` | Assistant: a reminder, a check-in while the tab is closed, and Python and web sandboxes | assistant app, Microsoft Edge, background sign-in | several premium requests |
| `local.demo-front-desk` | Front Desk: a GitHub user (this computer's sign-in) with private conversations and memory | front-desk app | a few premium requests |
| `local.demo-front-desk-foundry` | Front Desk: two email users on Azure AI Foundry, isolated from each other | front-desk app, `front-desk-foundry` environment | a few Foundry calls |

By hand:

| Check | What to check | Steps |
| --- | --- | --- |
| `local.cli-attach` | The real Copilot CLI on live sessions: new, attach, a turn, an approval, Esc, a promotion | docs/qa.md, "Copilot CLI in a terminal" |
| `local.dispatch` | Dispatch: direct, delegate, and mixed work in one chat, then a follow-up from Copilot CLI | docs/walkthrough.md 1.8, at http://localhost:7470 |
| `local.console` | The operator console and `npx managed-copilot operator`: health, sessions, live feed | docs/walkthrough.md 1.14; `npx managed-copilot console`, `npx managed-copilot operator overview` |
| `local.gallery` | The demo gallery: every card opens its demo or walkthrough | docs/walkthrough.md 1.3; `pnpm gallery` |
| `local.factory-routing` | Help Desk and Data Desk send work to Software Factory, and its floor shows where each work order came from | docs/qa.md, "Work routed to the software factory" |

### `azure`

Spec snippets, demo scripts, and qualification against a deployment in Azure. Needs `--url <gateway>`, a GitHub account with Copilot.

| Check | What it checks | Also needs | Model cost |
| --- | --- | --- | --- |
| `azure.snippet-01` | Snippet 01: The idea in one snippet | - | a few premium requests |
| `azure.snippet-02` | Snippet 02: Shared: a chat agent with your own tools (§3) | - | a few premium requests |
| `azure.snippet-03` | Snippet 03: Isolated: a coding agent in its own sandbox (§4) | - | a few premium requests |
| `azure.snippet-04` | Snippet 04: Set up the sandbox (§5) | - | a few premium requests |
| `azure.snippet-05` | Snippet 05: Get results out (§6) | - | a few premium requests |
| `azure.snippet-06` | Snippet 06: Control network access (§7) | - | a few premium requests |
| `azure.snippet-07` | Snippet 07: Keep secrets out of the sandbox (§8) | - | a few premium requests |
| `azure.snippet-08` | Snippet 08: Promotable: start cheap, move when needed (§9) | - | a few premium requests |
| `azure.snippet-09` | Snippet 09: Come back later (§11) | - | a few premium requests |
| `azure.snippet-11` | Snippet 11: Keep working while your app is offline: polling (§12) | - | a few premium requests |
| `azure.snippet-13` | Snippet 13: Open a session in Copilot CLI: the attach socket (§14) | - | a few premium requests |
| `azure.snippet-14` | Snippet 14: Orchestrator: a coordinator with workers (§17) | - | a few premium requests |
| `azure.snippet-15` | Snippet 15: Execution styles: a direct coordinator's hands (§17) | - | a few premium requests |
| `azure.demo-pattern-race` | Pattern Race: one job in all six patterns | `--apps-domain`, pattern-race app | one premium request per lane |
| `azure.demo-help-desk` | Help Desk: five customers on one shared runtime, with approvals | `--apps-domain`, help-desk app | a couple of premium requests |
| `azure.demo-repo-doctor` | Repo Doctor: fix a failing repository in a sandbox with network rules | `--apps-domain`, repo-doctor app | two turns |
| `azure.demo-data-desk` | Data Desk: answers on the shared runtime, then a move into a Python sandbox | `--apps-domain`, data-desk app | about two premium requests |
| `azure.demo-research-swarm` | Research Swarm: parallel researchers and a cited report | `--apps-domain`, research-swarm app | a handful of premium requests |
| `azure.demo-incident-commander` | Incident Commander: a mixed coordinator and an approval that waits | `--apps-domain`, incident-commander app | a handful of premium requests |
| `azure.demo-incident-commander-factory` | Incident Commander and Software Factory: an incident's fix built by the factory, verified, and deployed | `--apps-domain`, incident-commander app, software-factory app | a dozen or so premium requests |
| `azure.demo-software-factory` | Software Factory: plan, parallel builders, review, release | `--apps-domain`, software-factory app | dozens of premium requests |
| `azure.demo-software-factory-office` | Software Factory: its planner and reviewer agents in shared environments | - | a few premium requests |
| `azure.demo-assistant` | Assistant: inbox triage and an approval in the real UI (Microsoft Edge) | `--apps-domain`, assistant app, Microsoft Edge | a few premium requests |
| `azure.demo-assistant-away` | Assistant: a reminder, a check-in while the tab is closed, and Python and web sandboxes | `--apps-domain`, assistant app, Microsoft Edge, background sign-in | several premium requests |
| `azure.demo-front-desk-foundry` | Front Desk: two email users on Azure AI Foundry, isolated from each other | `--apps-domain`, front-desk app, `front-desk-foundry` environment | a few Foundry calls |
| `azure.isolated` | G3: an idle isolated session's compute is stopped and replaced, keeping its disks | `--isolated-env` | two premium requests |

By hand:

| Check | What to check | Steps |
| --- | --- | --- |
| `azure.deploy` | Deploy the root AppHost with `npx managed-copilot deploy` | docs/walkthrough.md 2 |
| `azure.revision` | A new gateway revision keeps shared and isolated sessions | `node deployments/azure/qualify/revision.live.mjs prepare <gateway-url> <record.json>` before a deploy, `verify <record.json>` after |
| `azure.public-apps` | Public apps beside allowlisted apps | deployments/azure/qualify/public-apps/README.md: its own deployment and `check.mjs` |
| `azure.cli-attach` | The real Copilot CLI on an Azure sandbox | docs/walkthrough.md 3.3: `npx managed-copilot new coder` with MANAGED_COPILOT_URL set |
| `azure.demos-ui` | The demos and the console in Azure, from the gallery | docs/walkthrough.md 3.2 and 3.3 |

<!-- qa:catalog:end -->
