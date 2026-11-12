# Help Desk

A support rush on one shared runtime. **Simulate 25 customers** and Help Desk starts 25 real Copilot sessions at once,
one per customer of a demo store, Contoso Outdoors. Each session can only reach its own customer's orders through the
store's tools, refunds and cancellations wait for you on the wall, and the counters show what it took: **25 sessions,
1 runtime, 0 sandboxes**. When the store's website lets a customer down, their agent reports it, and one click sends the
issue to [Software Factory](../software-factory/README.md) to fix. Real people join the same wall: a player of
[Downhill](../downhill/README.md), the store's free browser game, who opens **Support** in the game gets a live ticket
next to the simulated customers. The app is ordinary Node code built on the stock `@github/copilot-sdk` and
`@managed-copilot/sdk`.

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
- **Live players, next to the simulation.** Downhill's in-game shop, the Downhill Shop, sells rider outfits and bike
  paint, and its checkout runs on the store's own checkout code. When its launch offer's code fails there, the player
  opens **Support** and complains in their own words: Help Desk opens a live ticket on the same shared runtime, the
  game shows the chat in a frame, and the wall shows the ticket first, marked **Live**
  ([below](#live-players-from-downhill)). Their agent's report joins the same software issue as the simulated
  customers'.

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
4. **From a player, live.** Open Downhill (the `downhill` resource), ride, then buy an outfit in the Downhill Shop with
   the launch offer's code. Checkout says *Invalid code.*: open **Contact support** under it (or **Support** anywhere in
   the game). The player's tile appears first on the wall right away, marked **Live** and waiting for the player. Write
   what happened in the chat, such as *My discount code isn't working*, and the agent answers. If the player bought at
   full price, approve the refund of the 15% the code should have taken off, and watch the answer arrive in the game.
   See [below](#live-players-from-downhill).
5. In **Software issues**, click **Send to Software Factory** on *Promo codes rejected at checkout* (the player is
   listed with the customers, as *Mona · Downhill*), then **Open in Software Factory** to follow the work order there
   (see [below](#software-issues-fixed-by-software-factory)).
6. Type as a customer in their widget to keep a conversation going.
7. End the simulation from **⋯**: its sessions are deleted. Simulating again replaces it the same way. Players' tickets
   stay through both; end one with **End ticket** on its page.

Measured on a local deployment: 25 sessions started in about 3 seconds, and every conversation finished within 35
seconds, approvals included.

![The same wall once every conversation finished: 25 sessions, 1 runtime, 0 sandboxes, 63 messages, 54 tool calls, 8.25 premium requests, 0.33 per customer](docs/screenshots/wall-done.png)

The [`happy-path`](src/scripts/happy-path.ts) script does a smaller pass through the HTTP API: 5 customers, one refund
or cancellation approved and any others declined, checks that each session touched only its customer's orders and that
the counters read 5 sessions (plus any open player tickets, which it leaves alone), 1 runtime, and 0 sandboxes, lists
the software issues the agents reported (it doesn't send them to Software Factory), then ends the simulation. It costs
about 2 premium requests.

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

**Players' reports join in.** The Downhill Shop's checkout calls the same `applyPromoCode`
(`storefront/src/promotions.js`), and its launch banner applies the code in lowercase, `trail15`, which the same bug
turns down. A player's agent reports it with area `promo-codes`, so it lands in *Promo codes rejected at checkout* with
Aisha's and Ben's (listed as *Mona · Downhill*), and the issue shows whether or not a simulation is running. The brief
and `BUG_REPORT.md` say which reports came from the Downhill Shop: the code exactly as its checkout got it, what
checkout said, the cart, and the order the player paid in full, if any.

Each issue goes to Software Factory once per scope, and a send that failed can be tried again. While a simulation
runs, the scope is the simulation: players' reports join its issues, and the work order's origin key is
`<simulation>:<area>`. With no simulation running, the scope is the first open player ticket that reported the problem
(`player-<ticket>:<area>`): later players' reports join that issue and its work order until that ticket is ended, and
then the next report can go as a new work order. After a restart, Help Desk finds the work orders of the current
simulation and of every open player ticket again by these keys. Ending the simulation, or the player ticket a scope
belongs to, clears its work order from the panel, and Software Factory keeps the work orders. The work order runs
Software Factory's own agents, with their own premium requests.

Under `aspire run`, the root AppHost points Help Desk at the Software Factory demo. Without `SOFTWARE_FACTORY_URL`, the
panel still lists the issues, and **Send to Software Factory** says why it's unavailable.

## Team knowledge: agents learn, you decide

The support team keeps a knowledge base, and the agents help write it.

1. **The agent proposes.** Each customer's session has the runtime's built-in `store_memory` tool, and its
   instructions list the team knowledge base so far. When a customer tells the agent something that would help with
   other customers and the knowledge base doesn't say it yet (how a product fits, a workaround for a problem with the
   website), it proposes one short, general fact. It's told to leave out names, email addresses, order numbers, and
   amounts, and the runtime filters secrets out before asking.
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
Live players' sessions ([below](#live-players-from-downhill)) neither propose facts nor are told them: their agent has
only its tools for the Downhill Shop.

## Ticket classification (optional)

In a rush you want to see at a glance what people are asking for before any agent has answered. With classification
turned on, every customer message is classified as a delivery, refund, cancellation, order change, website problem, or
question, and as urgent or not. The wall then groups tickets by category, urgent ones first with a flame. Live
players' tickets aren't classified: they stay in their own group above the categories. A classification takes a
fraction of a second and a few dozen tokens, so it's cheap enough to run on every message, while the customers' own
sessions answer on a bigger model.

The classifier is [Microsoft-Decision-1](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision)
on Microsoft Foundry, a decision model rather than a chat model: it takes a text and typed questions, and answers each
with a choice and its probability. It still runs in stock Copilot sessions:

1. The AppHost declares an OpenAI-compatible endpoint (spec section 15) at Help Desk's own
   `/api/triage/v1/chat/completions`, and a second shared environment, `help-desk-triage`, routed to it.
2. For each customer message, Help Desk asks a session in `help-desk-triage` with the SDK's structured output:
   `session.sendAndWait(message, schema)`, where the schema is `{ category: enum, urgent: boolean }`.
3. The platform's runtime sends that as a chat completion request. Help Desk's endpoint
   ([`triage-endpoint.ts`](src/server/triage-endpoint.ts)) turns the schema into the decision model's questions (an
   enum is a `choice`, a boolean a yes-or-no `noul`), with the instructions from the system message, and the last user
   message as the state. It calls Foundry's decision API as your Azure CLI sign-in
   ([`decision.ts`](src/server/decision.ts)) and answers with JSON that matches the schema.

The endpoint accepts nothing else: a streaming request, a request without a JSON schema, or a schema property that
isn't an enum or a boolean gets a 400. A few classifier sessions (`hdt-…`) are reused, and replaced after 50
classifications since they keep their history.

To see how fast and cheap it is, open the **Classify** menu next to **Simulate**. It classifies the first 5, 10, or 25
customers' first messages (whatever is picked for Simulate) without starting their support sessions, in one of two
ways:

- **Use decision model**: Microsoft-Decision-1, as above.
- **Use LLM**: the same schema and the same structured output, but in Help Desk's own `help-desk` environment on the
  model the support sessions use (for example `claude-haiku-4.5`), so it's an ordinary chat model doing the job. Its
  sessions are `hdl-…`, pooled the same way. This option is always there, even without the decision model.

The wall groups the customers by category as the results arrive, then shows a line for each way you've run, so you
can compare them, for example:

> **Decision model** `ms-decision-1`: 25 classified in 2.6s · 5,756 tokens
>
> **LLM** `claude-haiku-4.5`: 25 classified in 28.0s · 24,511 tokens

The time is from the click to the last answer. The tokens are what the classifier sessions report from
`session.rpc.usage.getMetrics()`, the difference before and after each classification. Help Desk doesn't show a price
for either option, since it can't read what Foundry charges for the decision model. Classify is disabled during a simulation, and while another Classify is running;
starting a simulation clears the results. Running the same option again replaces its line.

Turn it on (local only, with `aspire run`):

1. In the [Foundry portal](https://ai.azure.com), deploy **Microsoft-Decision-1** in a Foundry resource. Note the
   resource's endpoint (`https://<resource>.services.ai.azure.com`) and the deployment's name.
2. Give yourself the **Cognitive Services User** role on that Foundry resource (Access control (IAM) in the Azure
   portal). It can take a few minutes to apply.
3. Sign in with `az login`. Help Desk gets a token for `https://cognitiveservices.azure.com` from the Azure CLI; no key
   is used.
4. In the repository root, tell the AppHost about the deployment, then run `aspire run`:

   ```powershell
   aspire secret set Parameters:help-desk-decision-endpoint https://<resource>.services.ai.azure.com
   aspire secret set Parameters:help-desk-decision-deployment <deployment>
   aspire secret set Parameters:help-desk-decision-subscription <subscription-id>   # when it isn't the Azure CLI's default
   ```

   None of these are secrets. The AppHost then adds the `help-desk-triage` environment and the endpoint, and generates
   the key the platform uses to call Help Desk's endpoint.

To turn it off, remove the settings with `aspire secret delete Parameters:help-desk-decision-endpoint` (and the
others). Without them, Help Desk works exactly as before, and the wall says classification isn't set up. If a
classification fails (no role yet, a missing deployment, throttling), the wall says why and the tickets carry on
unclassified; the customers' sessions don't depend on it. `aspire deploy` refuses these settings, because a deployed
Help Desk has no Azure identity to call Foundry with.

## Live players, from Downhill

[Downhill](../downhill/README.md) is the store's free mountain-biking browser game. Its in-game shop, the Downhill Shop,
sells rider outfits and bike paint on the store's own checkout code, and its launch banner's code, `trail15`, is turned
down at checkout. That's where a real person joins the wall:

1. **The game opens a ticket.** **Support** is always at hand in Downhill: on the title screen, in the pause menu, in
   the shop, under a rejected code, and on a receipt. Opening it has Downhill's server call Help Desk, server to server:

   ```text
   POST /api/player-tickets
   { "product": "downhill", "player": { "name": "Mona", "rider": "mona" }, "opener": "promo-error",
     "checkout": { "code": "trail15", "error": "Invalid code.", "offer": "Launch week: 15% off everything with code trail15",
                   "items": [{ "sku": "mona-neon", "name": "Neon Mona", "priceCents": 499 }], "subtotalCents": 499,
                   "order": { "id": "DH-1042", "totalCents": 499, "paidAt": "2026-11-12T17:30:00.000Z" } },
     "gameVersion": "1.0.0", "userAgent": "Mozilla/5.0 …", "at": "2026-11-12T17:30:00.000Z" }
   → 201 { "ticketId": "…", "chatPath": "/chat/…" }
   ```

   `opener` says what the player opened support from: `support-button`, `promo-error`, or `receipt`. `checkout` is
   there once they've tried a code or bought something: `order` only when they bought anyway, at full price, and `code`
   and `error` only when a code reached checkout. With `"ticketId"` of the player's ticket that's still open, Help Desk
   answers `200` with that ticket, and the checkout sent becomes its latest (one sent without a checkout keeps the one
   before); an unknown or ended ticket gets a new one, `201`. The same opening sent twice gets the same ticket. Help
   Desk checks every field (shapes, sizes, whole cents) and answers `400` in plain words when one is wrong, `503` when
   Managed Copilot isn't connected, and `429` while 25 player tickets are open.
2. **The player writes first.** Opening support asks no model anything. The chat greets the player itself (*Hi, I'm
   Contoso Outdoors support, an AI agent. What's going on?*), and their first message, in their own words (*My
   discount code isn't working*), starts the session. Its tools are bound to that one player: `get_checkout`,
   `request_refund` (a team member approves it, like the store's refunds), `report_bug` (the store's areas), and
   `resolve_conversation`. When the player mentions a code, the agent reads their checkout first, and when the game
   sent none, it asks what they tried. A valid code that checkout turned down is reported once, as `promo-codes`. A
   player who bought at full price is refunded what the code should have taken off, once you approve it; one who
   hasn't bought yet hears that typing the code in capitals may work.
3. **The chat, in the game.** The game shows Help Desk's page at `chatPath` in a frame (`HELP_DESK_PUBLIC_URL` +
   `/chat/<ticket>`). It's the conversation only, about 420 by 640, with what it's waiting for: connecting, the agent
   typing, a refund a team member is reviewing, the refund approved, resolved, ended, or Help Desk unreachable. Light
   and dark follow the player's system. Help Desk serves it and it calls only Help Desk, so it works framed by another
   origin while the API's cross-site check stays as it is.
4. **The wall.** The ticket's tile comes first as soon as support opens, marked **Live** and **Downhill**, with the
   player's name (*Mona · Downhill*) and, until they write, *Waiting for the player to write…*. Its page shows the chat
   as the player sees it, what they tried at checkout, where the session runs, and its tool calls. Once it has a
   session, the counters count it with the customers.

Player tickets don't belong to a simulation: starting, replacing, or ending one leaves them alone. A ticket with a
conversation stays until you click **End ticket** on its page, which deletes its session; the player's chat then says
it ended. A ticket the player never wrote in has no session yet: **End ticket** removes it the same way, and Help Desk
drops it by itself 30 minutes after the game last opened it, so stray opens don't clutter the wall. It lives only in
Help Desk's memory, so a restart forgets it too, and the game's next **Support** opens a new ticket.

## How it works

- **One shared environment.** [`apphost.mts`](apphost.mts) declares `help-desk`: `type: "shared"` with network off,
  because the agent's only hands are the store's tools in this app. Help Desk keeps one stock `CopilotClient` for it
  and creates every customer's session on that client.
- **Tools bound to one customer.** Each session gets its own `defineTool` tools, created for its customer
  ([`tools.ts`](src/server/tools.ts)), and `availableTools: ["custom:*", "builtin:store_memory"]`, so besides proposing
  team knowledge it has no other tools. A live player's session gets only `["custom:*"]`:

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
- **Memories are stored by the app.** Customers' sessions set the SDK's `memory.storeMemory` (experimental in SDK
  1.0.31) and allow `builtin:store_memory`. The runtime validates a proposed memory, filters secrets, and asks the
  permission handler (a `memory` request). Help Desk approves it at once and its `storeMemory` saves the fact as a
  proposal in [`knowledge.ts`](src/server/knowledge.ts); the operator adds or declines it later, outside the turn. The
  memory isn't held like a refund because on runtime 1.0.109 rejecting one permission request fails the others pending
  from the same step: declining a fact would also fail a cancellation the agent asked for alongside it, and the agent
  would reply to the customer about it. With `storeMemory` set, the runtime recalls no memories itself, so Help Desk
  puts the knowledge base in each customer session's system message. The gateway allows memory in a shared environment
  only on these terms: the app stores it, and no session's memory is kept in the shared runtime.
- **The wall is projected from the sessions' events.** Messages (streamed), tool calls, and approvals come from the
  stock session events; a call refused for an order of another customer is marked **Blocked**. The agent marks a
  conversation **Resolved** with a `resolve_conversation` tool, and a completed `report_bug` call is the ticket's
  report of a problem with the website.
- **Software issues go to Software Factory over its API.** [`factory.ts`](src/server/factory.ts) calls
  `POST /api/work-orders` server to server, with a 10-second timeout and plain-words errors. The work order's origin
  carries a key, `<simulation>:<area>` or `player-<ticket>:<area>` ([above](#software-issues-fixed-by-software-factory));
  while a work order is still running, Help Desk reads `GET /api/work-orders` every 5 seconds for its status, and after
  a restart it finds the work orders by that key. Before sending, it checks the factory for one already sent, so an
  issue is never sent twice.
- **Players' sessions carry their checkout.** A player ticket's session is `hd-player-<ticket>`
  ([`player.ts`](src/server/player.ts)), which no simulation's cleanup matches. The player's first message creates it,
  and carries the checkout the game sent in a hidden `<downhill_checkout>` block; a later message carries the block
  again only when the game sent a newer checkout (the player opened support again from a receipt, say). The chat page,
  the wall, and the transcripts sent to Software Factory show the player's words only (with *Checkout details* noted
  under the message), and a restarted Help Desk reads the latest block back from the session's history, so
  `get_checkout` answers as before. The chat page follows its ticket over `/api/events?player=<ticket>`, which carries
  that ticket and nothing else.
- **The platform holds the state.** Session IDs carry the simulation and the customer (`hd-<simulation>-<customer>`), or
  the player ticket (`hd-player-<ticket>`). After a restart, Help Desk lists the environment's sessions, picks up the
  latest simulation and every player ticket, rebuilds each conversation from `session.getEvents()`, replays the refunds
  and cancellations its history records (into the store, or onto the player's order), and deletes leftovers of older
  simulations. The platform asks again for any approval still pending when a session is resumed.
- **Open chats survive a restart.** Until Help Desk is connected and has listed the sessions, it can't tell a ticket it
  hasn't picked up yet from one that ended. So a chat page that reconnects in that window hears nothing about its ticket
  (rather than "ended"), and the ticket's requests, including the game reopening it, answer
  *Support is reconnecting. Try again in a moment.* (503). A listing that fails is tried again every few seconds.

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
| `HELP_DESK_TRIAGE_ENVIRONMENT` | none (the root AppHost sets it with classification on) | The shared environment that classifies tickets. Unset: classification is off |
| `HELP_DESK_TRIAGE_MODEL` | none | The classifier's model in that environment; required with `HELP_DESK_TRIAGE_ENVIRONMENT` |
| `HELP_DESK_DECISION_ENDPOINT`, `HELP_DESK_DECISION_DEPLOYMENT` | none | The Foundry resource and Microsoft-Decision-1 deployment Help Desk's endpoint calls. Unset, or without `HELP_DESK_TRIAGE_KEY`: the endpoint answers 503 |
| `HELP_DESK_DECISION_SUBSCRIPTION` | the Azure CLI's default | The subscription the Azure CLI gets its token for |
| `HELP_DESK_TRIAGE_KEY` | none | The key the platform presents to Help Desk's endpoint (a secret the AppHost generates) |

Help Desk needs no setting for players. Downhill's server is the one that needs Help Desk's address: its settings
([Downhill's README](../downhill/README.md)) name Help Desk's API for the server-to-server call, and
`HELP_DESK_PUBLIC_URL` for the chat it frames. Deployed, the server-to-server call uses Help Desk's name inside the
environment (`http://help-desk`), which `HELP_DESK_ALLOWED_HOSTS` already allows.

## Layout

| Path | Contents |
| --- | --- |
| `apphost.mts` | AppHost fragment: the `help-desk` shared environment, the optional `help-desk-triage` environment and its endpoint, and the app resource |
| `src/server` | Platform connection, the store and its tools, one ticket (session) per customer and per live player (`player.ts`: the Downhill contract and the player's tools), the event projection, the team knowledge base, software issues and the Software Factory client, REST and server-sent events |
| `src/scripts` | The happy-path script |
| `src/shared` | Types shared with the UI |
| `src/web` | The UI: the wall, and a player's chat page at `/chat/<ticket>` (React, Tailwind, and GitHub's Primer look from [`libraries/github-theme`](../../libraries/github-theme); light and dark follow the OS) |
| `storefront` | The Contoso Outdoors website's code (Node, no dependencies, `node --test`), with the bugs customers report: the project a software issue's work order asks Software Factory to fix. The Downhill Shop's checkout uses it too |
| `test` | Unit tests: the store, the tools, the projection, simulations, player tickets, approvals, and proposed memories against an in-memory platform, the knowledge base, software issues against an in-memory Software Factory, the factory client, the API and the chat page's route, the storefront, and the fragment |
| `Dockerfile` | The container `aspire deploy` publishes |
