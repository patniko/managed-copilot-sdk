# Architecture and workstreams

This is the as-built design for the [developer experience spec](spec/developer-experience.md). The spec is the
customer contract; this document records how the platform implements it, the protocol facts it relies on, and who
owns what. Update it with the code.

## Topology

```mermaid
flowchart LR
  subgraph App["Customer process (demo, script, backend)"]
    SDK["Stock CopilotClient / CopilotSession<br/>+ @managed-copilot/sdk"]
    Bridge["bridge.js (stdio ⇄ WSS)<br/>spawned by RuntimeConnection.forStdio"]
    Tools["defineTool handlers"]
  end
  CLI["Copilot CLI<br/>(AHP attach)"]
  subgraph Platform["Managed Copilot platform (aspire run, or Azure)"]
    GW["gateway<br/>auth · admission · JSON-RPC router · ledger<br/>REST /v1 · SSE events · schedules · webhooks"]
    SR["shared runtime<br/>stock copilot --headless"]
    Relay["sandbox relay<br/>(dual-homed container)"]
    Egress["egress proxy<br/>policy + vault substitution<br/>(dual-homed container)"]
    subgraph Net["internal Docker network: no direct Internet"]
      S1["sandbox: sandboxd + stock runtime<br/>/workspace, uid 10001"]
      S2["sandbox ..."]
    end
    Store[("SQLite ledger<br/>artifacts · sealed secrets")]
  end
  Models["GitHub Copilot models"]
  SDK --> Bridge -- "WSS /v1/connect<br/>one JSON-RPC message per frame" --> GW
  SDK --> Tools
  CLI -- "WSS (AHP)" --> GW
  GW -- "JSON-RPC (TCP)" --> SR
  GW -- "HTTP/WS via relay" --> Relay --> S1
  Relay --> S2
  S1 -- "HTTP(S)_PROXY" --> Egress
  S2 --> Egress
  Egress --> Internet["Allowed hosts"]
  GW --> Store
  GW -- "inference on the user's behalf" --> Models
  SR --> Models
```

## Protocol facts (SDK 1.0.26, runtime 1.0.103)

Verified from the published package sources (`dist/client.js`, `dist/session.js`, `dist/generated/rpc.js`):

- `RuntimeConnection.forStdio({ path, args, env })` spawns `path` (with node when it ends in `.js`) and appends
  `--headless --no-auto-update --stdio` plus optional flags. The bridge ignores those flags and relays JSON-RPC.
- The SDK speaks LSP-framed JSON-RPC (vscode-jsonrpc 8.2.1). The first request is `connect` (handshake).
  `forUri(url, { connectionToken })` is raw TCP; the runtime's `--headless --port` listener needs
  `COPILOT_CONNECTION_TOKEN` or it accepts any client.
- Every session-scoped request (`session.*`, e.g. `session.send`, `session.abort`, `session.tools.handlePendingToolCall`)
  carries `params.sessionId`, so the gateway routes per session. Connection-level calls include `connect`, `ping`,
  `status.get`, `auth.getStatus`, `models.list`, `session.create`, `session.resume`, `session.list`,
  `session.delete`, `session.getMetadata`, `session.getLastId`, `session.getForeground`/`setForeground`,
  `sessionFs.setProvider`, `llmInference.setProvider`, `plugins.builtin.set`.
- Runtime → client notifications: `session.event` and `session.lifecycle`. **Tool calls and permission prompts are
  events**: `external_tool.requested` (answered by `session.tools.handlePendingToolCall`), `permission.requested`
  (answered by `session.permissions.handlePendingPermissionRequest`), `elicitation.requested`.
- Runtime → client requests include `userInput.request`, `exitPlanMode.request`, `autoModeSwitch.request`,
  `systemMessage.transform`, `gitHubToken.getToken`, `providerToken.getToken`, `llmInference.httpRequestStart`/`Chunk`
  (the experimental public request-handler hook), `sessionFs.*`, `workflow.*`, `tasks.cancel`, and `host.*` (AHP).
- AHP: the runtime exposes `host.start`, `host.publishSession`, `host.unpublishSession`, `host.setSessionCreationPolicy`;
  the SDK exposes `AhpHost`. Copilot CLI attaches with `copilot --ahp <url>` (interactive only).

## Components

| Component | Path | Runs as | Responsibility |
| --- | --- | --- | --- |
| Protocol | `packages/protocol` | library | AppHost config schema, REST DTOs, errors, events, bridge constants, network policy math |
| SDK | `packages/sdk` | library | `ManagedCopilot` API; stock `CopilotClient` over the bridge; REST features |
| Aspire integration | `packages/aspire` | library | `addManagedCopilot(builder, name, options)` for TypeScript AppHosts |
| CLI | `packages/cli` | `managed-copilot` bin | `login`, `logout`, `sessions`, `attach`, `promote`, `artifacts`, `schedules` |
| Gateway | `platform/gateway` | Node service | Auth, admission, routing, ledger, REST, events, schedules, webhooks |
| Sandbox | `platform/sandbox` | image + `sandboxd` + relay | Base image with the stock runtime, in-sandbox agent, gateway relay |
| Egress | `platform/egress` | container | Network policy enforcement and vault substitution for sandbox traffic |
| Demos | `demos/*` | apps | Quickstart snippets, AI software factory, long-running assistant |

### Data plane

1. `managed.client(env, options)` constructs a stock `CopilotClient` with
   `RuntimeConnection.forStdio({ path: <sdk>/dist/bridge.js, env: { MANAGED_COPILOT_BRIDGE: JSON(BridgeConfig) } })`
   and starts it. The bridge opens `WSS /v1/connect` with `Authorization: Bearer <token>` and the
   `x-managed-copilot-environment` header.
2. The gateway authenticates the GitHub caller, resolves the environment (policy ceilings, caller narrowing), and
   creates a **client connection**. Each client connection can own many sessions.
3. The gateway owns **persistent upstream connections** to runtimes: one to the shared runtime, one per sandbox.
   Client disconnects never close upstream connections or kill sessions; accepted work continues.
4. `session.create`: admission validates and rewrites the request (tool filters, models, MCP, agents, hooks,
   customizations, working directory, platform tools), places the session (shared runtime or a new sandbox), forwards
   it upstream, and records ownership in the ledger. `session.resume` restores placement first.
5. Session-scoped requests route by `sessionId` after an ownership check. Request IDs are remapped per upstream.
6. `session.event` notifications fan out to every attached client and observer. Execution-bearing events
   (`external_tool.requested`, `permission.requested`, ...) are **claimed before emission**: exactly one responder
   receives the actionable event; others get progress-only views. Unclaimed actions stay durable for webhook or poll
   responders.
7. Server-to-client requests for platform concerns (`gitHubToken.getToken`, `llmInference.*`, `sessionFs.*`) are
   answered by the gateway, never forwarded to customer code.

### Credentials and inference

- Shared runtime: per-session user tokens supplied by the gateway at create/resume (in memory), never a shared
  service token. Model attribution follows the session owner.
- Sandboxes: the GitHub token never enters the sandbox environment or disk. Preferred mechanism: the gateway answers
  the runtime's `llmInference.*` requests itself (public request-handler hook) and attaches the owner's credential;
  any other credential the runtime needs is a placeholder substituted by trusted infrastructure. If a stock
  mechanism cannot achieve this, document the limitation and fail closed rather than injecting the token.

### Isolated placement

- Docker network `mc-sandboxes` is **internal** (no route to the Internet). Sandboxes attach only to it.
- Each sandbox runs `sandboxd` (platform-owned, not uid 10001) which starts the stock runtime as uid 10001 with
  `COPILOT_CONNECTION_TOKEN`, workdir `/workspace`, and `HTTP(S)_PROXY` pointing at the egress proxy with a
  per-sandbox proxy credential. `sandboxd` exposes, behind a per-sandbox bearer key: health, `/runtime` (WebSocket ⇄
  runtime TCP), streamed workspace files, output snapshots for artifact publication, and setup execution.
- The **sandbox relay** container joins `mc-sandboxes` and a published bridge network so the host gateway can reach
  each `sandboxd` (`/relay/<sandboxId>/...`, platform-key authenticated).
- The **egress proxy** container joins both networks; sandboxes reach the Internet only through it. It applies each
  sandbox's effective network policy (fetched from or pushed by the gateway), blocks platform internals,
  loopback/link-local, and metadata addresses, and substitutes vault placeholders in permitted HTTPS headers.
- Per-session volumes hold `/workspace`, `HOME`, and runtime state so compute can be replaced without losing them.

## Gateway extension points

Modules register in `platform/gateway/src/modules/index.ts` and share capabilities through `app.provide(key, value)`
and `app.service(key)`. Proposed services (owners finalize the exact shapes and keep this table current):

| Service key | Provided by | Purpose |
| --- | --- | --- |
| `auth` | core | Verify GitHub tokens, apply AppHost access rules, return a `Principal` |
| `sessions` | core | Ledger lookups with owner checks, internal create/resume/send for schedules, session event subscription |
| `events` | core | Publish platform events (SSE `/v1/events`, webhooks subscribe) |
| `platformTools` | core | Register gateway-executed tools (`schedule_task`, `request_sandbox`, ...) injected per environment |
| `sandboxes` | sandbox | Create, resume, stop, and delete sandboxes; open runtime streams; files; output snapshots |
| `artifacts` | sandbox | Turn-scoped publication and immutable storage |
| `policy` | network | Effective network policy, vault bindings, and egress registration per sandbox/session |
| `vaults` | network | AppHost and per-user vault storage (sealed at rest) |
| `actions` | durable | Durable action ledger, claims, results, reconciliation, polling |
| `webhooks` | durable | Signed delivery with retries and replay protection |
| `schedules` | durable | Cron/one-shot schedules, occurrences, runs, agent scheduling tools |
| `credentials` | durable | Background GitHub credential per user (sealed), revocation |

## Ports and environment

| Setting | Default | Notes |
| --- | --- | --- |
| Gateway `PORT` | 7400 | Aspire assigns it in `aspire run` |
| `MANAGED_COPILOT_CONFIG` | dev defaults | Normalized AppHost JSON (`ManagedCopilotConfig`) |
| `MANAGED_COPILOT_DATA_DIR` | `./.managed-copilot/data` | SQLite ledger, artifacts, runtime homes |
| `MANAGED_COPILOT_PLATFORM_KEY` | random per run | Internal service credential (relay, egress, sandboxd provisioning) |
| `MANAGED_COPILOT_PUBLIC_URL` | `http://localhost:<port>` | URL clients use |
| Discovery file | `~/.managed-copilot/local.json` | Written by a local gateway; read by `ManagedCopilot.connect()` |

## Workstreams and ownership

Each workstream is one session and one branch. Edit only owned paths; request changes elsewhere from the owner.

| Workstream | Owns | Delivers |
| --- | --- | --- |
| **core** | `platform/gateway/src/{app,http,server,config,main,log,db}.ts`, `modules/core/**`; SDK `bridge.ts`, `connection.ts`, `features/{client,sessions,events}.ts`, `managed.ts` | G1: bridge, router, shared runtime, admission, ledger, auth, `/v1/info`, `/v1/me`, sessions, SSE events, platform-tool registry |
| **sandbox** | `platform/sandbox/**`, gateway `modules/sandbox/**`, SDK `features/{files,artifacts}.ts` | Isolated placement: image, `sandboxd`, relay, Docker provider, setup, files, artifacts, idle/resume/delete |
| **network** | `platform/egress/**`, gateway `modules/network/**`, SDK `features/vaults.ts` | Network policy enforcement, vaults, SSRF protections |
| **durable** | gateway `modules/durable/**`, SDK `features/{actions,schedules,webhooks}.ts` | G2: durable actions, webhooks, polling, schedules, agent scheduling, background login |
| **devloop** | `packages/aspire/**`, `packages/cli/**`, root `apphost.mts`, `aspire.config.json`, `demos/quickstart/**`, SDK `features/cli.ts` | `aspire run` for the platform and demos, CLI, Copilot CLI attach, runnable spec snippets |
| **factory** | `demos/software-factory/**` | AI software factory demo |
| **assistant** | `demos/assistant/**` | Long-running assistant bot with schedules, Gmail, and Google Calendar |

Later workstreams: promotion (G5, SDK `features/promote.ts`), Azure deployment (G3), and end-to-end polish.
