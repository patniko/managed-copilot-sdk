# Incident Commander

An on-call tool where Copilot takes the pager. An alert opens an incident; Copilot searches the logs in its own
sandbox, hands the repro and the fix to workers in theirs (or routes the fix through Software Factory), and asks you
before it deploys. The request waits on the platform, not in your browser: close the tab, come back later, and click
**Deploy**. Built on the stock `@github/copilot-sdk` and `@managed-copilot/sdk`
([spec section 17](../../docs/spec/developer-experience.md)).

![A checkout incident waiting for approval: the map shows the alert, Copilot on the shared runtime, its own triage sandbox and two finished workers, and the deploy gate marked Needs you; the approval card shows the verified one-line fix](docs/screenshots/approval.png)

*A real run against the bundled demo service. Copilot found the crash in the logs from its own sandbox (**Triage**),
`repro` wrote a failing test, `fix` patched the code, and Copilot verified both together (10 passed). The deploy
request now waits on the platform, and the app holds no connection to the session.*

## What it shows

- **The mixed pattern, in one incident.** The coordinator's brain runs on the shared runtime. For quick, sequential
  work (searching logs, verifying the fix) it runs commands in its **own sandbox**; for independent work (a repro test
  and a fix, in parallel) it starts **workers**, each an agent in a sandbox of its own. The response map shows both.
- **An approval that waits on the platform.** Sandboxes are isolated, so Copilot works there without asking.
  Production asks a person. When Copilot asks to deploy, the app records the change, leaves the request to the
  platform, and lets go of the session. The request survives closed tabs and app restarts; your decision re-attaches
  and the platform delivers the request again.
- **A webhook while nobody is attached.** The platform tells the app about waiting requests, finished turns, and
  workers through a signed webhook, and the app answers its own tools there.
- **Real alerts in, real deploys out.** `/api/alerts` takes Alertmanager and Grafana notifications or a small JSON
  shape, with a shared secret. Approved fixes for your own services go to your deploy pipeline as a signed webhook.
  **Simulate an incident** is the labeled demo: a sample alert for a bundled checkout service.
- **The fix, routed through Software Factory.** Choose **Fix with: Software Factory** and Copilot triages as usual,
  then sends the fix to [Software Factory](../software-factory/README.md) as a work order (the service's code as the
  project, the incident as its context) while a worker writes the repro. The factory plans, builds, reviews, and
  releases the fix; Incident Commander follows the work order and hands the release back to Copilot, which verifies it
  and asks you to deploy. Software Factory shows where the work order came from, with a link back to the incident.

## Try it

1. From the repository root: `pnpm install`, `pnpm build`, then `aspire run`. Open http://localhost:7445 (or the
   card in `pnpm gallery`).
2. Choose how the fix is made next to **Simulate an incident**: **Fix with: Copilot's workers** or **Software
   Factory** (the default when Software Factory is connected).
3. Click **Simulate an incident**. It posts an Alertmanager-shaped alert for the demo checkout service, whose v1.4.2
   deploy crashes on expired coupon codes.
4. Watch the map: Copilot triages in **Triage** (its own sandbox), then hands `repro` and `fix` to workers. With
   Software Factory, a **Software Factory** node takes the fix worker's place: `WO-0012`, its status, and **Open in
   Software Factory**.
5. When **Deploy the fix to production?** appears, close the tab. Wait as long as you like (or restart the app with
   `aspire resource incident-commander restart --apphost apphost.mts`). Reopen the incident and click **Deploy**. A fix
   from the factory says so on the request: **Built by Software Factory · WO-0012**.
6. Copilot deploys v1.4.3, the alert resolves, and the postmortem appears.

With Copilot's workers, the whole run takes about two minutes plus however long you wait; through Software Factory it
takes longer, since the factory plans, builds, and reviews the fix first. To run it unattended:

```powershell
pnpm --filter @managed-copilot/demo-incident-commander happy-path             # --url <app>, --keep to keep the incident
pnpm --filter @managed-copilot/demo-incident-commander happy-path --factory   # the fix through Software Factory
```

It simulates an incident, approves the parked deploy, waits for Resolved, prints a summary, and deletes the incident
with its sandboxes. It asks for Copilot's workers whatever the app's setting; `--factory` routes the fix through
Software Factory instead (it must be running), prints the work order's number and link, waits longer, and fails if the
deploy request isn't the factory's fix.

| Triage in its own sandbox | Repro and fix in workers |
| --- | --- |
| ![Investigating: Copilot working, its Triage sandbox running commands, two dashed slots for workers, and the root cause still being searched](docs/screenshots/triage.png) | ![Mitigating: the fix and repro workers working in their own sandboxes, and the root cause recorded with its evidence](docs/screenshots/workers.png) |

![Resolved: every sandbox done, the deploy gate shows checkout v1.4.2 → v1.4.3, and the postmortem with triage, fix, and resolve times](docs/screenshots/resolved.png)

## The pattern: mixed

```mermaid
flowchart LR
  A["Alert<br/>Alertmanager · Grafana · JSON"] --> C["Copilot<br/>shared runtime"]
  C -- "bash, grep, view" --> T[("Triage<br/>its own sandbox")]
  C -- "start_worker" --> R["repro<br/>agent in its sandbox"]
  C -- "start_worker" --> F["fix<br/>agent in its sandbox"]
  T -. "copy_worker_files" .-> R
  T -. "copy_worker_files" .-> F
  C -- "deploy_fix" --> G{"You approve"}
  G --> P["Production"]
```

| | Runs on | Does |
| --- | --- | --- |
| **Copilot** (the coordinator) | the shared runtime | Reads the alert, follows the runbook, decides what runs where |
| **Triage** (its own sandbox) | `incident-commander-triage`: small, no network | Log search, the failing code path, the deploy that caused it, the final test run |
| **Workers** `repro` and `fix` | `incident-commander-node`: medium, the npm registry only | A failing regression test, and the smallest fix that passes every test |
| **Software Factory** (when it makes the fix) | its own environments and sandboxes | Plans the fix, builds it, reviews it, and releases it with tests, in place of the `fix` worker |
| **Incident Commander** (this app) | your server | Alerts, the incident page, the app's tools, the work order, the approval, the deploy |

## The factory route

**Fix with** sets how the fix of each incident that opens next is made, simulated or from your alerts; an incident
keeps the route it opened with (the incident page shows it). The choice is stored with the app's records. It starts as
**Software Factory** when `SOFTWARE_FACTORY_URL` is set and as **Copilot's workers** otherwise, and Software Factory
can't be chosen while it isn't connected. `PUT /api/settings { "fixRoute": "workers" | "factory" }` changes it, and
`POST /api/simulate { "fixRoute": ... }` overrides it for one simulated incident.

```mermaid
sequenceDiagram
  participant C as Copilot (shared runtime)
  participant A as Incident Commander
  participant F as Software Factory
  participant R as repro (worker)
  C->>A: route_fix_to_factory: summary, root cause, failing path, files
  A->>F: POST /api/work-orders: the service's code as the project, INCIDENT.md as context
  F-->>A: WO-0012 · Queued
  C->>R: a failing regression test, in a new file
  R-->>C: it fails on the current code
  Note over C,A: Copilot ends its turn, and the app lets go of the session
  loop about every 5 s, from the app's records (an app restart picks it up again)
    A->>F: GET /api/work-orders/:id
  end
  A->>F: GET /api/work-orders/:id/release (once it's Completed)
  A->>C: re-attach, once: "Software Factory released the fix as WO-0012"
  C->>A: apply_factory_fix: the changed files, into its own sandbox
  Note over C: runs the whole suite (repro's test included)
  C->>A: deploy_fix: "Built by Software Factory · WO-0012", and a person approves
```

- **The work order.** Its title is `Fix <service>: <summary>`, in the factory's app-driven (`classic`) mode with two
  review rounds. Its `project` is the service's folder as it runs in production, without `logs/` and `deploys/`. Its
  `context` is `INCIDENT.md`: the alert, the root cause and its evidence, the failing path, the expected behavior, the
  diff of the deploy that caused it, and the newest error lines from the logs. Its `origin` names Incident Commander
  and the incident (`INC-1004 · checkout`), with a link back to the incident page.
- **Following it.** The app reads the work order about every 5 seconds while it's active and records each step on the
  timeline (planning, building, releasing, released or failed). The state is in the app's records, so a restart picks
  it up again. If Software Factory can't be reached, the incident says so and the app keeps trying, more slowly.
- **The release.** The fix is what the release added or changed in the service, without `package.json` and
  `README.md`. Incident Commander tells Copilot exactly once, by re-attaching to its session (the platform queues the
  message behind a running turn). A release that changes none of the service's code counts as a failure.
- **When the factory can't.** If Software Factory refuses the work order, isn't reachable, or fails or cancels it,
  Copilot falls back to a `fix` worker, as in the standard runbook, and the timeline says so.

## How it works

- **Environments** ([`apphost.mts`](apphost.mts)). `incident-commander` is an orchestrator with `execution: "mixed"`:
  its own sandbox comes from the first worker environment (`incident-commander-triage`), and it can start workers in
  any (`incident-commander-node`). The coordinator itself has no network: alerts are data, never instructions.
- **The runbook.** The app adds a runbook to the coordinator's instructions: triage in your own sandbox, hand the repro
  and the fix to two workers in parallel (copying the service to each from your sandbox), verify both together, ask to
  deploy, then write the postmortem. For an incident whose fix goes through Software Factory, the runbook routes the
  fix there instead, has one worker write the repro meanwhile, and verifies the factory's fix when it arrives.
- **The app's tools** (stock `defineTool`): `open_workspace` copies the service's code, tests, logs, and deploy history
  into the coordinator's own sandbox (with `managed.files`), `update_incident` records notes and the root cause,
  `deploy_fix` deploys, and `publish_postmortem` publishes. Incidents whose fix goes through Software Factory also get
  `route_fix_to_factory`, which creates the incident's work order (one per incident: a repeated or replayed call
  answers with it), and `apply_factory_fix`, which copies the released fix into the coordinator's own sandbox. Only
  `deploy_fix` asks a person; every other prompt (a shell command in its sandbox, a new worker) is approved, because
  sandboxes are isolated.
- **The approval.** The app holds a live session only while Copilot works:

```mermaid
sequenceDiagram
  participant C as Copilot (shared runtime)
  participant P as Platform
  participant A as Incident Commander
  participant Y as You
  C->>P: deploy_fix asks permission
  P->>A: the request (live session)
  A->>A: snapshot the change from Copilot's sandbox
  A-->>P: no answer, and detach
  P->>A: webhook: session.action_required
  Note over P,Y: The request waits on the platform (up to 24 hours). Close the tab, restart the app: nothing is lost.
  Y->>A: Deploy
  A->>P: resume the session
  P->>A: the same request, again
  A-->>P: approved
  P->>A: deploy_fix runs: the snapshot you reviewed ships
  C->>A: publish_postmortem
```

- **The webhook** (`/api/copilot-events`, verified with `verifyWebhook`) receives `session.action_required`,
  `session.idle`, `session.failed`, and `worker.*` for the incident environment. While the app isn't attached it updates
  incidents and answers the app's tools and sandbox prompts with `event.handleActions`, and leaves an undecided deploy
  for a person.
- **What's real and what's the demo.** The alert endpoint, the webhook, the sessions, sandboxes, and workers are real.
  The bundled checkout service is the labeled demo: its production logs and deploy history are generated around the
  alert's time (the numbers in the alert match the logs), and deploying it records the release and resolves the alert.
  Your own services deploy through your pipeline instead.

## Connect your alerts

Alerts go to `POST /api/alerts` with the shared secret as a bearer token (or as the Basic auth password). The root
AppHost generates it as the `incident-commander-alert-secret` parameter (the app receives it as
`INCIDENT_ALERT_SECRET`); the bell in the app's header shows the URL. The same alert again (by its fingerprint) adds
to its open incident instead of opening another; a resolved notification marks its alert resolved.

Prometheus Alertmanager:

```yaml
receivers:
  - name: incident-commander
    webhook_configs:
      - url: http://localhost:7445/api/alerts
        send_resolved: true
        http_config:
          authorization:
            credentials_file: /etc/alertmanager/incident-commander-secret
```

Grafana: add a **Webhook** contact point with the same URL and an **Authorization header** with the secret. Anything
else can post a small JSON object:

```powershell
curl -X POST http://localhost:7445/api/alerts `
  -H "Authorization: Bearer $env:INCIDENT_ALERT_SECRET" -H "Content-Type: application/json" `
  -d '{"title":"Checkout errors","service":"checkout","severity":"major","summary":"5xx rate is 12%"}'
```

The service comes from the `service`, `app`, `component`, or `job` label. Copilot gets that service's folder when
Incident Commander has one: the bundled `checkout`, or a folder of your own (below). Without one, it records what the
alert says and what to check next.

## Your own services and deploys

| Setting | What it does |
| --- | --- |
| `INCIDENT_SERVICES_DIR` | A folder with one subfolder per service name: its code, tests, and any logs you export there. Copied into Copilot's sandbox for an incident on that service. |
| `INCIDENT_DEPLOY_URL` | Your deploy pipeline's webhook. An approved fix is POSTed there as `incident.deploy_approved` with the service, the next version, the summary, who approved it, and the files' contents. A 2xx answer (optionally `{ "version", "message" }`) means it deployed; anything else fails the deploy and tells Copilot. Without it, deploys for your own services fail with that explanation. |
| `INCIDENT_DEPLOY_SECRET` | Signs those requests: `x-incident-commander-signature: t=<seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, the platform's own webhook scheme. Requests also carry an `idempotency-key`. |
| `SOFTWARE_FACTORY_URL` | Where this server calls Software Factory's API (locally `http://localhost:7480`). Set, fixes can go through Software Factory, and **Fix with** starts there; unset, the option is off and says why. |
| `SOFTWARE_FACTORY_PUBLIC_URL` | Software Factory's address for people: the links to work orders (`<url>/#/wo/<id>`). Defaults to `SOFTWARE_FACTORY_URL`. |

Set them on the app in the root AppHost (`.withEnvironment(...)`). Other settings: `INCIDENT_MODEL` (default
`claude-sonnet-5`), `INCIDENT_ENVIRONMENT` (default `incident-commander`), `INCIDENT_DATA_DIR` (its incident records),
`INCIDENT_PUBLIC_URL` (the alert URL it shows), and `INCIDENT_ALLOWED_HOSTS` (host names it answers besides localhost).

## Screens

| Board | Dark |
| --- | --- |
| ![The incident board with one open SEV2 incident and its elapsed time, and a resolved one below](docs/screenshots/board.png) | ![The waiting approval in GitHub's dark theme](docs/screenshots/dark.png) |

<img src="docs/screenshots/mobile.png" alt="The waiting incident at phone width: a jump to the deploy request, then the map stacked top to bottom" width="320">

## Code

| Path | What it is |
| --- | --- |
| `apphost.mts` | Environments, the webhook, and the app, as plain data for the root AppHost |
| `src/server/commander.ts` | Opens incidents from alerts, routes webhook deliveries, publishes views |
| `src/server/incident.ts` | One incident's coordinator session: attach while working, the deploy approval, sandboxes, the app's tools, its Software Factory work order |
| `src/server/runbook.ts`, `tools.ts` | The coordinator's instructions (for each fix route) and the app's tools |
| `src/server/factory.ts` | Software Factory: the work order for a fix (project, `INCIDENT.md`, origin), its API, and the fix in its release |
| `src/server/alerts.ts`, `deploy.ts`, `services.ts` | Alert parsing and auth, deploy targets, the service catalog |
| `src/server/demo.ts`, `demo-services/checkout` | The labeled demo: the checkout service and its generated production logs |
| `src/web` | The UI (React, Tailwind with `@managed-copilot/github-theme`, Octicons) |
| `src/scripts/happy-path.ts` | The scripted real run |

```powershell
pnpm --filter @managed-copilot/demo-incident-commander test   # unit tests (fakes only; no platform needed)
```
