# Help Desk

A support rush on one shared runtime. **Simulate 25 customers** and Help Desk starts 25 real Copilot sessions at once,
one per customer of a demo store, Contoso Outdoors. Each session can only reach its own customer's orders through the
store's tools, refunds and cancellations wait for you on the wall, and the counters show what it took: **25 sessions,
1 runtime, 0 sandboxes**. When the store's website lets a customer down, their agent reports it, and one click sends the
issue to [Software Factory](../software-factory/README.md) to fix. The app is ordinary Node code built on the stock
`@github/copilot-sdk` and `@managed-copilot/sdk`.

![The wall mid-rush: 25 sessions, 1 runtime, 0 sandboxes; six tiles glow yellow with a refund or cancellation to approve, and two show "Blocked: not their order"](docs/screenshots/wall.png)

*Twelve seconds into a rush: 25 customers, one session each, all on the one shared runtime. Six refunds and
cancellations wait for the operator (yellow), and two customers asked about orders that aren't theirs (red).*

## What it shows

- **Density.** Every customer gets a private session: their own conversation, model loop, and tools. All 25 run in
  the one shared runtime process (the **shared** pattern, [patterns](../../docs/concepts/patterns.md)), so the rush
  starts in seconds and needs no machine per customer.
- **Isolation by your tools, not by the model.** A session's tools are created for its customer and take no customer
  ID. When Liam asks about order `CO-48177` (Sofia's), `get_order` answers exactly as it would for an order that
  doesn't exist, and the wall marks the attempt **Blocked**. The model never saw Sofia's data, so it couldn't leak it.
- **You stay in control of what costs money.** `request_refund` and `cancel_order` have no `skipPermission`, so the
  runtime asks the app first. Help Desk holds each request on the wall until you approve or decline it. A request the
  store would refuse anyway (outside the 30-day window, an order that already shipped) goes straight to the tool,
  which says why.
- **The economics, counted.** Sessions and messages come from the conversations; runtimes and sandboxes from the
  platform's session records (`placement`, `sandbox`); premium requests from each session's own usage metrics. A full
  rush on Claude Haiku 4.5 costs 8.25 premium requests: 0.33 per customer.
- **From a support ticket to a fix.** Agents report problems with the store's website with a `report_bug` tool, the
  wall groups the reports into software issues, and **Send to Software Factory** turns one into a work order to fix
  the website's code ([below](#software-issues-fixed-by-software-factory)).
- **A team that learns.** Agents propose what they learn for the team knowledge base with the runtime's
  `store_memory` tool. You add each fact or not, and every later conversation starts with what was added
  ([below](#team-knowledge-agents-learn-you-decide)).

<img src="docs/screenshots/approval.png" alt="Sofia's conversation: her support widget on the left, and on the right where the session runs (shared runtime, tools in Help Desk, no sandbox), a refund of $39.00 waiting with Decline and Approve, the two orders the session can see, and its tool calls" width="900">

*Click a customer to see their support widget as they see it, and what happened behind it: where the session runs,
the only orders it can see, and every tool call. Approve or decline here or on the wall.*

<img src="docs/screenshots/blocked.png" alt="Liam's conversation: he asked about order CO-48177; the widget says CO-48177 isn't on his account; the tool call list shows get_order CO-48177 blocked as another customer's order; he sees only CO-48121" width="900">

*Liam's session asked the store for `CO-48177`. The tool refused it like a missing order, so the agent's reply
confirms nothing, while the operator sees that it was another customer's.*

## Run it

Everything runs locally against real models. You need the repository's prerequisites (see
[AGENTS.md](../../AGENTS.md)) and a GitHub sign-in with Copilot (`gh auth login`).

```powershell
pnpm install
pnpm build
aspire run          # the platform and the demos; open the "help-desk" resource
```

Help Desk opens at <http://localhost:7440>. To demo it:

1. Pick **5**, **10**, or **25** customers (25 by default) and click **Simulate**. Watch the sessions count climb to 25
   while runtimes stay at 1 and sandboxes at 0. The first answers arrive within seconds.
2. Approve a refund on a yellow tile, or decline one with **×**.
3. Open **Liam O'Brien** to show the blocked lookup, then **Sofia Martinez** to show her refund as she sees it.
4. In **Software issues**, click **Send to Software Factory** on *Promo codes rejected at checkout*, then **Open in
   Software Factory** to follow the work order there (see [below](#software-issues-fixed-by-software-factory)).
5. Type as a customer in their widget to keep a conversation going.
6. End the simulation from **⋯**: its sessions are deleted. Simulating again replaces it the same way.

Measured on a local deployment: 25 sessions started in about 3 seconds, and every conversation finished within 35
seconds, approvals included.

![The same wall once every conversation finished: 25 sessions, 1 runtime, 0 sandboxes, 63 messages, 54 tool calls, 8.25 premium requests, 0.33 per customer](docs/screenshots/wall-done.png)

The [`happy-path`](src/scripts/happy-path.ts) script does a smaller pass through the HTTP API: 5 customers, one refund
or cancellation approved and any others declined, checks that each session touched only its customer's orders and that
the counters read 5 sessions, 1 runtime, and 0 sandboxes, lists the software issues the agents reported (it doesn't send
them to Software Factory), then ends the simulation. It costs about 2 premium requests.

```powershell
pnpm --filter @managed-copilot/demo-help-desk happy-path                          # local, MANAGED_COPILOT_PORT_OFFSET applies
pnpm --filter @managed-copilot/demo-help-desk happy-path --url https://help-desk.<environment-domain>
```

`aspire deploy` publishes Help Desk with the root AppHost, next to the other demos (see
[docs/deployment.md](../../docs/deployment.md), including who can open the apps).

## Software issues, fixed by Software Factory

Five of the customers don't just have a question: the store's website let them down. The code `TRAIL15` from the
newsletter is rejected when Aisha pastes it and when Ben types it in lowercase; Lucas changed his water bottles from 1 to
2 in his cart and paid for 3; and Hannah's and Arjun's **My orders** pages say Delivered while their packages are still
out for delivery. Aisha is among the first 5 customers and Lucas among the first 10; simulate 25 to meet all five. The
website's code is in [`storefront`](storefront): a small Node codebase whose own tests pass, because they don't cover
these cases.

1. **The agent reports it.** Every session also has a `report_bug` tool, bound to its customer like the others. When a
   customer describes something the website got wrong, the agent reports it once with the area it's about
   (`promo-codes`, `cart`, `order-status`, or `other`), tells them, and still helps with the order: it asks to refund
   Lucas one bottle and Aisha the 15% she missed, and each refund waits for your approval like any other. The store's
   tools also say what each order's **My orders** label reads (`shownOnMyOrdersPage`, worked out like the storefront's
   own code), so the agent can see Hannah's and Arjun's pages disagree with the carrier. A product that arrived broken
   or leaks isn't a software issue, and isn't reported.
2. **The wall groups the reports.** Their tiles show **Software issue**, and the **Software issues** panel has one row
   per area, such as *Promo codes rejected at checkout · 2 tickets*. A customer's page shows what the agent reported.
3. **Send to Software Factory.** One click sends the issue as a work order. Its brief quotes each customer, their order,
   and what their agent found, then asks for a fix in the storefront with regression tests that reproduce the reports,
   keeping the existing tests passing. The storefront codebase is the work order's project, and the reports
   (`BUG_REPORT.md`) and conversations (`transcripts.md`) are its context.
4. **Follow it.** The row shows the work order, such as `WO-0012 · Building`, until Software Factory finishes, with
   **Open in Software Factory**. The work order carries its origin: Help Desk, *Promo codes · 2 tickets*, and a link
   back to the first reporting customer's conversation, so the factory's floor shows where it came from.

Each issue goes to Software Factory once per simulation; a send that failed can be tried again. After a restart, Help
Desk finds the simulation's work orders again by their origin. Ending the simulation clears the panel, and Software
Factory keeps the work orders. The work order runs Software Factory's own agents, with their own premium requests.

Under `aspire run`, the root AppHost points Help Desk at the Software Factory demo. Without `SOFTWARE_FACTORY_URL`, the
panel still lists the issues, and **Send to Software Factory** says why it's unavailable.

## Team knowledge: agents learn, you decide

The support team keeps a knowledge base, and the agents help write it.

1. **The agent proposes.** Each session has the runtime's built-in `store_memory` tool, and its instructions list the
   team knowledge base so far. When a customer tells the agent something that would help with other customers and the
   knowledge base doesn't say it yet (how a product fits, a workaround for a problem with the website), it proposes one
   short, general fact. It's told to leave out names, email addresses, order numbers, and amounts, and the runtime
   filters secrets out before asking.
2. **You decide.** The proposal waits in the **Team knowledge** panel and on the customer's tile with **Add** and
   **×**; the customer's page shows the whole fact and where it came from. Unlike a refund, it doesn't hold up the
   conversation: the agent carries on helping the customer and never hears your decision, so adding or declining a
   fact changes nothing the customer sees.
3. **Later conversations start from it.** An added fact appears in the **Team knowledge** panel, with the
   conversation it came from, and every session created or reopened afterwards has it in its instructions, so the
   agents answer from it instead of rediscovering it, and don't propose it again. Remove a fact with the trash icon;
   sessions created or reopened from then on aren't told it.

### Try it

Two of the simulated customers are set up for this. Noah, among the first 5, cancels his Ridgeline Hiking Boots and
mentions in passing that they run a full size small. Emma, among the first 10, asks which size of the same boots to
order. Nobody asks the agent to remember anything.

1. Start with an empty **Team knowledge** panel (remove any facts in it) and **Simulate 10**. Emma's agent can't
   help with her size: it points her to the size chart. Within seconds, Noah's tile shows a proposed fact, such as
   *Ridgeline Hiking Boots run a full size small.*
2. **Add** the fact, and approve or decline Noah's cancellation, in either order. The fact moves into the **Team
   knowledge** panel's list, linked to Noah's conversation.
3. **Simulate 10** again. This time Emma's agent tells her straight away to order a size 9 because the boots run
   small, and Noah's agent doesn't propose the fact again.

With **Simulate 5**, Noah proposes the fact the same way; Emma joins from **Simulate 10**. The agents choose what to
propose, so another customer's agent can occasionally propose something too: decline what isn't worth keeping.

The knowledge base outlives simulations and restarts: it's kept in `knowledge.json` in Help Desk's data directory.

## How it works

- **One shared environment.** [`apphost.mts`](apphost.mts) declares `help-desk`: `type: "shared"` with network off,
  because the agent's only hands are the store's tools in this app. Help Desk keeps one stock `CopilotClient` for it
  and creates every customer's session on that client.
- **Tools bound to one customer.** Each session gets its own `defineTool` tools, created for its customer
  ([`tools.ts`](src/server/tools.ts)), and `availableTools: ["custom:*"]`, so it has no other tools:

  ```ts
  defineTool("get_order", {
    description: "Get one of the customer's orders: items, total, status, and shipping.",
    parameters: z.object({ orderId: z.string() }),
    skipPermission: true,
    handler: ({ orderId }) => shop.getOrder(customerId, orderId), // another customer's order: "No order … on this account."
  });
  ```

- **Approvals use the SDK's permission handler.** Help Desk holds the handler's promise for `request_refund` and
  `cancel_order` until the operator answers, then resolves it with `approve-once` or `reject` (the agent is told a team
  member will follow up). If the turn ends some other way, Help Desk lets go when `permission.completed` or the turn's
  end arrives.
- **Memories are stored by the app.** Sessions set the SDK's `memory.storeMemory` (experimental in SDK 1.0.31) and
  allow `builtin:store_memory`. The runtime validates a proposed memory, filters secrets, and asks the permission
  handler (a `memory` request). Help Desk approves it at once and its `storeMemory` saves the fact as a proposal in
  [`knowledge.ts`](src/server/knowledge.ts); the operator adds or declines it later, outside the turn. The memory
  isn't held like a refund because on runtime 1.0.109 rejecting one permission request fails the others pending from
  the same step: declining a fact would also fail a cancellation the agent asked for alongside it, and the agent would
  reply to the customer about it. With
  `storeMemory` set, the runtime recalls no memories itself, so Help Desk puts the knowledge base in each session's
  system message. The gateway allows memory in a shared environment only on these terms: the app stores it, and no
  session's memory is kept in the shared runtime.
- **The wall is projected from the sessions' events.** Messages (streamed), tool calls, and approvals come from the
  stock session events; a call refused for an order of another customer is marked **Blocked**. The agent marks a
  conversation **Resolved** with a `resolve_conversation` tool, and a completed `report_bug` call is the ticket's
  report of a problem with the website.
- **Software issues go to Software Factory over its API.** [`factory.ts`](src/server/factory.ts) calls
  `POST /api/work-orders` server to server, with a 10-second timeout and plain-words errors. The work order's origin
  carries a key, `<simulation>:<area>`; while a work order is still running, Help Desk reads `GET /api/work-orders`
  every 5 seconds for its status, and after a restart it finds the simulation's work orders by that key. Before
  sending, it checks the factory for one already sent, so an issue is never sent twice.
- **The platform holds the state.** Session IDs carry the simulation and the customer (`hd-<simulation>-<customer>`).
  After a restart, Help Desk lists the environment's sessions, picks up the latest simulation, rebuilds each
  conversation from `session.getEvents()`, replays the refunds and cancellations its history records into the store,
  and deletes leftovers of older simulations. The platform asks again for any approval still pending when a session
  is resumed.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `7440` | HTTP port for the UI and API |
| `HOST` | `127.0.0.1` | Interface to listen on (`0.0.0.0` in a container, together with `HELP_DESK_ALLOWED_HOSTS`) |
| `MANAGED_COPILOT_URL` | local discovery | Gateway URL (Aspire sets it) |
| `HELP_DESK_ENVIRONMENT` | `help-desk` | The shared environment customers' sessions are created in |
| `HELP_DESK_MODEL` | first available of Claude Haiku 4.5, Claude Haiku 5.5, GPT-5.6 Luna, Claude Sonnet 5 | The customers' agents' model |
| `HELP_DESK_DATA_DIR` | `.data` (in `demos/help-desk`); `/data` in the container | Where the team knowledge base (`knowledge.json`) is kept |
| `HELP_DESK_ALLOWED_HOSTS` | none | Extra host names allowed to address the server (it accepts loopback names only by default) |
| `SOFTWARE_FACTORY_URL` | none (the root AppHost sets it) | Software Factory's API, which Help Desk's server calls to send software issues. Unset: **Send to Software Factory** is unavailable and says why |
| `SOFTWARE_FACTORY_PUBLIC_URL` | `SOFTWARE_FACTORY_URL` | Software Factory's address for people: the links to its work orders |

## Layout

| Path | Contents |
| --- | --- |
| `apphost.mts` | AppHost fragment: the `help-desk` shared environment and the app resource |
| `src/server` | Platform connection, the store and its tools, one ticket (session) per customer, the event projection, the team knowledge base, software issues and the Software Factory client, REST and server-sent events |
| `src/scripts` | The happy-path script |
| `src/shared` | Types shared with the UI |
| `src/web` | The UI (React, Tailwind, and GitHub's Primer look from [`libraries/github-theme`](../../libraries/github-theme); light and dark follow the OS) |
| `storefront` | The Contoso Outdoors website's code (Node, no dependencies, `node --test`), with the bugs customers report: the project a software issue's work order asks Software Factory to fix |
| `test` | Unit tests: the store, the tools, the projection, simulations, approvals, and proposed memories against an in-memory platform, the knowledge base, software issues against an in-memory Software Factory, the factory client, the API, the storefront, and the fragment |
| `Dockerfile` | The container `aspire deploy` publishes |
