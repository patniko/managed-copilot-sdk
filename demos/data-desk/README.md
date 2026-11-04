# Data Desk

Chat with a spreadsheet. Questions the app's own tools can answer run on the **shared runtime**; ask for a chart and
the agent asks to move, and the **same session** continues in its own Python sandbox, with an attached Copilot CLI
following it. It is the **promotable** pattern ([promotion](../../docs/concepts/promotion.md),
[spec section 9](../../docs/spec/developer-experience.md#9-promotable-start-cheap-move-when-needed)) in an app:
ordinary Node code on the stock `@github/copilot-sdk` and `@managed-copilot/sdk`.

![Data Desk after the move: the placement track shows the session docked at its sandbox with the same ID it started with, a published chart above the data grid, and the conversation with a "Moved into a sandbox" marker](docs/screenshots/workspace.png)

*After the move. The first question was answered on the shared runtime with Data Desk's tools; the chart request moved
the session into its sandbox in a few seconds. The session ID on the track never changed, and the premium request count
carried across the move.*

## What it shows

- **Start cheap.** A new analysis is a session on the shared runtime: nothing to set up, nothing to pay for in compute.
  Data Desk's tools (`describe_dataset`, `query_rows`, `aggregate`) run in the app, and their tables show in the grid.
- **Move when the work needs code.** For a chart, a regression, or anything else that needs code, the agent calls the
  platform's `request_sandbox` tool. Data Desk asks you (**Move** or **Not now**), and the platform moves the session,
  history and all, into a sandbox with Python and no network.
- **The same session, visibly.** The placement track shows where the session runs, and its ID stays the same across the
  move. Premium requests (`session.usage.getMetrics`) keep counting: the meter splits them into before and after.
- **The data follows.** When `session.promoted` arrives, Data Desk writes the dataset into the sandbox
  (`managed.files`), and holds the agent's first command until it's there.
- **Charts come back.** The agent saves SVG charts under `outputs/`; they publish when its turn ends, and Data Desk
  shows them as cards you can open full size.
- **Copilot CLI follows.** **Open in Copilot CLI** (the terminal icon in the header) attaches to the same session.
  During the move it says *Connection lost. Reconnecting…*, reconnects to the sandbox by itself, and keeps going;
  messages typed there show in Data Desk, labeled **Copilot CLI**.

<img src="docs/screenshots/shared.png" alt="On the shared runtime: the aggregate tool's table of revenue by store fills the grid with bars, and the meter shows one premium request" width="900">

*Before the move: Data Desk's `aggregate` tool answered on the shared runtime, and its table fills the grid.*

<img src="docs/screenshots/asking.png" alt="The agent asks to move into a sandbox: the placement track says Wants a sandbox, and the chat shows the request with Move and Not now" width="900">

*The agent asks to move. Nothing is allocated until you choose **Move**.*

<img src="docs/screenshots/moving.png" alt="Mid-move: the session's ID travels along the track toward the dashed sandbox, with a timer" width="900">

*Moving: the platform creates the sandbox, pauses the turn, carries the session over, and resumes the same turn there.*

## Demo it

1. Open Data Desk and pick **Coffee shop sales**.
2. Click **Which store made the most revenue in 2025?** It's answered on the shared runtime, and the table shows in the
   grid. The meter shows one premium request, on the shared runtime.
3. Click the terminal icon to open the session in Copilot CLI (on Windows it opens a window; elsewhere copy the
   command).
4. Click **Chart monthly revenue for each store**, then **Move**. Watch the track: the session slides into its sandbox
   with the same ID, and Copilot CLI reconnects.
5. Open the chart. Ask a follow-up, such as "Add a three-month moving average", here or in Copilot CLI: it runs in the
   sandbox right away.

The other samples work the same way: **City bike rides** (ask for rides against temperature with a trend line) and
**Support tickets** (does resolution time affect satisfaction?). **Upload a CSV** to bring your own, up to 5 MB.

## Run it

Everything runs locally against real models. You need the repository's prerequisites (see
[AGENTS.md](../../AGENTS.md)) and a GitHub sign-in with Copilot (`gh auth login`).

```powershell
pnpm install
pnpm build
aspire run          # the platform, sandboxes, and the demos; open the "data-desk" resource
```

Data Desk opens at <http://localhost:7430>. Measured live on a local deployment: the shared-runtime answer took 4
seconds, the move 4 to 8 seconds (about 10 with Copilot CLI attached, which is paused and reconnected), and the chart
request about 30 seconds from message to chart, approval included.

`pnpm --filter @managed-copilot/demo-data-desk happy-path` runs one real pass through the API, the move included, and
deletes what it created (about two premium requests). Pass `--url` for another deployment.

To run it against another deployment, set `MANAGED_COPILOT_URL` and run `pnpm dev` in `demos/data-desk`; the
deployment must declare Data Desk's environments ([`apphost.mts`](apphost.mts) exports them as plain data).
`aspire deploy` publishes it with the root AppHost, next to the other demos ([deployment](../../docs/deployment.md)).

## How it works

| Environment | Type | Network | What it's for |
| --- | --- | --- | --- |
| `data-desk` | promotable, `promoteTo: "data-desk-python"` | off | where every analysis starts: the shared runtime |
| `data-desk-python` | isolated, small | off | the sandbox a session moves into: Python 3 and its standard library |

- **An analysis is a session.** Data Desk keeps one stock `CopilotClient` for `data-desk` and creates each analysis with
  `client.createSession`: its three tools (`defineTool`, `skipPermission: true`), a short system message that names
  the dataset and where it will be in the sandbox, and a permission handler. The system message is the session's
  configuration, so the platform gives it to the sandbox runtime too.
- **The move is a permission.** `request_sandbox` reaches the permission handler as a `custom-tool` request. Data Desk
  holds the handler's promise until you answer, then resolves it with `approve-once` or `reject` (and a reason the agent
  reads). The platform then moves the session and continues the same turn in the sandbox; the one `session.promoted`
  platform event (`managed.on`) carries the sandbox and how long the move took.
- **The dataset goes in before the first command.** On `session.promoted`, Data Desk writes the file to
  `data/<file>.csv` with `managed.files(session).write`. Commands and file changes in the sandbox (`shell`, `write`,
  `read` permission requests) are approved once that write has finished, so the agent's first command already finds
  it. The sandbox has no network, so other requests are refused.
- **The view comes from the session's own events**, live or from `session.getEvents()` after a restart: messages,
  each tool call as one line, the move marker (`request_sandbox` completing), and the grid's tables, which are the data
  tools' results in the history. Messages Data Desk didn't send came from another client, so they're labeled
  **Copilot CLI**.
- **Usage and outputs.** After each reply Data Desk reads `session.rpc.usage.getMetrics()`; the reading taken when
  `session.promoted` arrives is the shared runtime's share. `artifact.published` events say when to list
  `managed.artifacts(session)`; charts are served from there as images with a sandboxing content security policy, so
  an SVG from the sandbox can never run as part of the app.
- **State is the platform's.** Sessions, sandboxes, and charts live in Managed Copilot. Data Desk's own records
  (`.data/data-desk.json`) keep each analysis's dataset, the messages it sent, the move it saw, and the last usage it
  read; uploaded files are kept in `.data/uploads`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `7430` | HTTP port for the UI and API |
| `HOST` | `127.0.0.1` | Interface to listen on (`0.0.0.0` in a container, together with `DATA_DESK_ALLOWED_HOSTS`) |
| `MANAGED_COPILOT_URL` | local discovery | Gateway URL (Aspire sets it) |
| `DATA_DESK_ENVIRONMENT` | `data-desk` | The promotable environment analyses start in |
| `DATA_DESK_MODEL` | `claude-sonnet-5` | The agent's model |
| `DATA_DESK_DATA_DIR` | `.data` | Data Desk's records and uploaded files |
| `DATA_DESK_ALLOWED_HOSTS` | none | Extra host names allowed to address the server (it accepts loopback names only by default) |
| `DATA_DESK_ATTACH_URL` | none | Gateway URL added to "Open in Copilot CLI" commands (`--url`) when people reach the platform at another address |

## Layout

| Path | Contents |
| --- | --- |
| `apphost.mts` | AppHost fragment: the promotable environment, its Python sandbox environment, and the app resource |
| `datasets` | The three sample CSV files |
| `src/server` | Platform connection, analyses (one session each), the tools and tables, the event projection, REST and server-sent events |
| `src/shared` | Types shared with the UI |
| `src/web` | The UI (React, Tailwind, and GitHub's Primer look from [`libraries/github-theme`](../../libraries/github-theme); light and dark follow the OS) |
| `src/scripts/happy-path.ts` | The scripted real run |
| `test` | Unit tests: tables, datasets, the projection, analyses and the move against an in-memory platform, the API, and the fragment |
| `Dockerfile` | The container `aspire deploy` publishes |
