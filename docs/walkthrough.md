# Demo walkthrough: local, deploy, Azure, share

One pass through everything you'd show the team: run the platform locally and check each demo from the gallery, deploy
the same AppHost to Azure, check the demos again there, and let other people in. Every step lists the command, what to
click, and what you should see. Tick each box as you go.

```mermaid
flowchart LR
  A["1 · Local<br/>aspire run · pnpm gallery"] --> B["2 · Deploy<br/>npx managed-copilot deploy"]
  B --> C["3 · Azure<br/>pnpm gallery --cloud"]
  C --> D["4 · Share<br/>npx managed-copilot access"]
```

Run every command from the repository root in PowerShell. Keep three terminals: **T1** for `aspire run`, **T2** for the
gallery, **T3** for the CLI.

## 0 · Before you start

- [ ] `node -v` prints 24.x, `pnpm -v` prints 10.x, `aspire --version` prints 13.6, and Docker Desktop is running.
- [ ] `gh auth status` shows the GitHub account with Copilot you'll demo as.
- [ ] `copilot --version` works ([Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli), for "Open in
      Copilot CLI").
- [ ] `az account show` shows the subscription you'll deploy to (only for part 2).

```powershell
pnpm install
pnpm build
```

## 1 · Local

### 1.1 Start the platform (T1)

```powershell
aspire run --non-interactive
```

`--non-interactive` skips the hidden "Trusting certificates…" prompt (or run `aspire certs trust` once). It prints the
Aspire dashboard URL. Wait until the dashboard shows `copilot`, `front-desk`, `dispatch`, `software-factory`, and
`assistant` as **Running / Healthy**. The first run builds the sandbox image, which takes a few minutes.

| Resource | Local URL |
| --- | --- |
| Gateway (`copilot`) | http://localhost:7400 |
| Front Desk | http://localhost:7450 |
| Dispatch | http://localhost:7470 |
| Software factory | http://localhost:7480 |
| Assistant | http://localhost:7490 |
| Gallery (next step) | http://localhost:7460 |

- [ ] Dashboard shows every resource healthy.

### 1.2 Check the platform from the terminal (T3)

```powershell
npx managed-copilot status       # deployment "local", you as "Signed in", environments, capabilities
```

- [ ] `Capabilities` includes `isolated`, `files`, and `promotion` (they appear once Docker and the sandbox backend are
      ready; run it again after a minute if they're missing).

### 1.3 Open the gallery (T2)

```powershell
pnpm gallery            # opens http://localhost:7460; add --no-azure to hide the Azure column for now
```

- [ ] Header shows the local gateway as up.
- [ ] The **Patterns** row shows the three building blocks and six pattern cards; each card's walkthrough link jumps
  to its walkthrough below.
- [ ] Front Desk, Dispatch, Software factory, Assistant, and Operator console cards each have a green **Local** dot.

Open each app from its **Local** button and run the checks below.

### 1.4 Dispatch (orchestrator, a sandbox per part of the request)

1. Keep **Delegate to workers** selected, pick the **Estimate π three ways** template, and send it.
2. **Approve** each "start a sandbox" request (or deny one with a reason and watch it retry your way).
3. Send a suggested follow-up, such as the chart.
4. Open the **Timeline** tab, then select a sandbox in the right pane.
5. Press **Open in Copilot CLI** on the conversation, type a message there, then `/exit`.
6. Switch the style to **Work directly**, send a template, and approve its commands.

- [ ] Message #1 created three Python sandboxes (**#1 created**) and answered, in about a minute.
- [ ] The follow-up reused at least one sandbox (**reused**) and the card says what the agent did.
- [ ] A sandbox shows its blueprint, network policy, files, and outputs.
- [ ] The message typed in Copilot CLI appears in Dispatch labeled **from Copilot CLI**.
- [ ] Work directly lists each command with who ran it and its exit code.

### 1.5 Software factory (coordinator, builders, review, release)

1. Pick the **CSV ⇄ JSON toolkit** template, keep **Agent-led**, and press **Start work order**.
2. Watch the floor and the decision log; select a station for its reports.
3. When it finishes, open the **Deliverable** and the **Artifacts** diff viewer.

- [ ] The coordinator creates a builder sandbox per task, sends review findings back to the **same** builder, then
      creates the release sandbox.
- [ ] The deliverable shows release ready with all tests passed (a run takes about 5 to 7 minutes).

Scripted check of the same path (exits 0 only when the release's tests pass and the bundle downloads):

```powershell
pnpm --filter @managed-copilot/demo-software-factory happy-path
```

### 1.6 Assistant (long-running, approvals, schedules, sandboxes)

1. If the side panel says **Background work is off**, press **Turn on background work** (or
   `npx managed-copilot login`).
2. Ask: "What's on my calendar tomorrow? Find a free 30 minutes and book a meeting with Sam."
3. Ask: "Remind me in 2 minutes to stretch." Close the tab, wait 3 minutes, reopen it.
4. Ask: "Chart my meeting load for this week."

- [ ] The header labels the inbox and calendar as the **demo workspace** (unless you configured Google).
- [ ] Booking the meeting shows an approval card; nothing changes until you approve.
- [ ] The reminder arrives as a proactive message while the tab is closed, waiting for you when you reopen it.
- [ ] The chart asks to start a Python sandbox, then shows the chart under the reply; a follow-up is marked **reused**.

Scripted check in Microsoft Edge (`--fresh` starts a new conversation and resets the demo workspace):

```powershell
pnpm --filter @managed-copilot/demo-assistant happy-path -- --fresh --reminder --offline --sandbox --enable-background
```

### 1.7 Front Desk (many people, each with private conversations)

1. Open http://localhost:7450 and press **Use this computer's GitHub sign-in**.
2. Ask: "Remember that my favorite color is teal." Open **Memory**.
3. In a private window, open Front Desk again and **Create an account** with any email and password.
4. As that person, ask: "What's my favorite color?"

- [ ] The GitHub user's chip says **Your Copilot plan**; the email account's says **Front Desk's Azure AI Foundry**,
      with a daily allowance.
- [ ] The memory panel lists the favorite color for the GitHub user only; the other person's list and memory are empty,
      and their assistant doesn't know it.

Scripted check (two email accounts and your GitHub CLI's account; each saves a secret, and every other person is checked
to see none of it):

```powershell
pnpm --filter @managed-copilot/demo-front-desk e2e -- --url http://localhost:7450
```

### 1.8 Operator console

Press the console card's **Local** button, or:

```powershell
npx managed-copilot console      # the console in your browser; locally every account is an operator
npx managed-copilot operator     # the same overview in the terminal
```

- [ ] Health shows every component up.
- [ ] Sessions lists the sessions the demos just created (Dispatch coordinators, factory builders, assistant workers),
      with placement and sandbox; conversation content is not shown.
- [ ] The live feed moves while a demo runs.

### 1.9 The CLI and the walkthroughs (T3)

```powershell
npx managed-copilot sessions              # your sessions
npx managed-copilot new chat              # a new chat session, opened in Copilot CLI; /exit to leave
npx managed-copilot new coder             # the same in its own sandbox; ask it to run `uname -a`
npx managed-copilot workers <id>          # an orchestrator session's workers (use a Dispatch conversation's ID)
npx managed-copilot exec <id> -- ls -la   # a command in a session's sandbox
pnpm walkthrough 01                            # walkthrough 01; the gallery lists all of them
pnpm --filter @managed-copilot/snippets acceptance   # every spec snippet against the local platform
```

- [ ] `new coder` opens Copilot CLI with the footer `remote /workspace`.

### 1.10 Stop

```powershell
aspire stop --apphost apphost.mts --non-interactive
```

Stopping the `aspire run` terminal alone leaves the gateway and demos holding their ports.

## 2 · Deploy to Azure

One command runs the whole flow from the repository root (full reference: [deploying to Azure](deployment.md)):

```powershell
npx managed-copilot deploy
```

It checks that the Aspire CLI, the Azure CLI (signed in with `az login`), and Docker are ready, then shows the plan and
asks before deploying:

```text
Deploying apphost.mts to Azure
  Subscription    <your subscription> (<id>)
  Resource group  managed-copilot-dev · westus2 · new deployment
  Platform users  @your-login
  Operators       @your-login
  Apps act as     @your-login (your GitHub sign-in)
  Apps open to    203.0.113.7/32 (this machine)
  Added you (@your-login) to platform users and operators. Change with `npx managed-copilot access`.

Deploy? [y/N]
```

- **Where it goes.** The Azure CLI's current subscription, `managed-copilot-dev`, and `westus2`, unless you've set them
  before or pass `--subscription`, `--resource-group`, or `--location`. They're saved for next time.
- **Who may use it.** A first deployment adds you as a platform user and an operator (the deployed console is off
  without operators). Add others in part 4.
- **The demo apps' account.** The deployed demos have no sign-in of their own: they act as your GitHub sign-in, passed
  to `aspire deploy` in an environment variable, never on a command line.
- **Who can open the apps.** Your machine's public address, unless you've set a list with
  `npx managed-copilot access ips`.

The first deploy builds and pushes the images (several minutes on ARM64). It ends with:

```text
✓ Deployed: https://copilot.<environment-domain>
  Demo gallery: https://gallery.<environment-domain>
```

- [ ] The deploy succeeds and prints the gateway URL.

Run it again after any change (code, users, operators); it updates the same deployment. The deployment's generated
keys live in Aspire's deployment record for the checkout that made it. From another checkout (a new clone or
worktree), `deploy` stops and, if that record is on this machine, offers to copy it so the deployment keeps its keys.
Say yes; deploying with new keys can leave the gateway unable to start.

<details>
<summary>The same steps by hand</summary>

```powershell
aspire secret set Azure:SubscriptionId <subscription-id>
aspire secret set Azure:Location westus2
aspire secret set Azure:ResourceGroup managed-copilot-dev
# aspire deploy doesn't load user secrets for the AppHost, so the lists go in the environment:
${env:Parameters__copilot-github-users} = "your-login"           # the whole list
${env:Parameters__copilot-operator-users} = "your-login"
${env:Parameters__app-github-token} = (gh auth token).Trim()
aspire deploy
Remove-Item Env:Parameters__app-github-token
```

</details>

Find the URL again later with:

```powershell
az containerapp list --query "[?name=='copilot'].properties.configuration.ingress.fqdn" -o tsv
```

## 3 · Azure

### 3.1 Check the platform (T3)

```powershell
$env:MANAGED_COPILOT_URL = "https://copilot.<environment-domain>"
npx managed-copilot status       # Deployment copilot · azure, you as Signed in
npx managed-copilot login        # once per deployment, so schedules and offline work run as you
```

- [ ] `Capabilities` includes `isolated` (if not, see [troubleshooting](deployment.md#troubleshooting): the role
      assignment can take a few minutes; the gateway re-checks every 30 seconds).

### 3.2 Open the gallery

The deployment has its own gallery, at the address `deploy` printed: **https://gallery.&lt;environment-domain&gt;**.
That's the link to share. It shows the Azure apps only, and its console card copies the command each operator runs
(`npx managed-copilot console --url …`).

- [ ] The deployed gallery opens and its header shows Azure as up.
- [ ] Each app card's **Azure** dot is green, and each app opens.

From your laptop, the local gallery shows both columns side by side (T2):

```powershell
pnpm gallery --cloud https://copilot.<environment-domain>
```

Without `--cloud`, it finds the `copilot` container app through `az login`. Here an **amber** dot means the app refused
your network address (see 3.4); the deployed gallery can't tell, because the apps always admit it.

### 3.3 The demos and console in Azure

Repeat 1.4 to 1.8 with each card's **Azure** button. Differences to expect:

- Sandboxes are Azure Container Apps microVMs (`Linux x86_64`), so the first one in a conversation takes a little
  longer to start.
- "Open in Copilot CLI" commands include `--url https://copilot.<environment-domain>`.
- The console button signs you in with a one-time link; it works only for operators (`npx managed-copilot access`
  lists them).

- [ ] Dispatch: π template with approvals, a reused follow-up, Copilot CLI follow-up.
- [ ] Software factory: CSV ⇄ JSON toolkit, Agent-led, release with all tests passed.
- [ ] Assistant: approval card, reminder while the tab is closed, a sandbox chart. (Its sandboxes haven't been
      verified on Azure before, so this is the one to watch.)
- [ ] Console: health, sessions with Azure sandboxes, live feed.

Platform checks from the terminal:

```powershell
pnpm walkthrough 03                   # an Azure sandbox: prints Linux x86_64
npx managed-copilot new coder    # Copilot CLI on an Azure sandbox
pnpm --filter @managed-copilot/snippets acceptance 01 02 03 04 05 06 07 08 09 11 13 14 --strict
```

Snippets 10 and 12 need a local webhook receiver, so they're left out against Azure.

### 3.4 If an Azure button is amber (403 "RBAC: access denied")

Corporate VPNs and Global Secure Access send Azure traffic from different addresses than `deploy` detected, often a
rotating pool. `npx managed-copilot access` shows each running app's allowlist. Either:

- Add your network's Azure egress ranges. This updates the running apps at once, no redeploy needed:

  ```powershell
  npx managed-copilot access ips add 203.0.113.0/24
  ```
- Run the demos on your machine against the Azure platform. The gateway needs no IP allowlist; it checks your GitHub
  sign-in. Stop any local `aspire run` first so the ports are free:

  ```powershell
  $env:MANAGED_COPILOT_URL = "https://copilot.<environment-domain>"
  pnpm --filter @managed-copilot/demo-dispatch start           # http://localhost:7470
  pnpm --filter @managed-copilot/demo-software-factory start   # http://localhost:7480
  pnpm --filter @managed-copilot/demo-assistant start          # http://localhost:7490
  ```

  Sessions and sandboxes still run in Azure. The assistant polls for offline tool calls, since Azure can't reach a
  webhook on your laptop.

## 4 · Share it

`npx managed-copilot access` shows and changes three lists. Run it from the repository root:

```text
> npx managed-copilot access
copilot · apphost.mts · managed-copilot-dev
Platform users  @your-login
Platform orgs   none
Operators       @your-login
Operator orgs   none
Apps act as     @your-login (your GitHub sign-in when you deploy)
Apps open to    203.0.113.7/32
                dispatch now: 203.0.113.7/32
                software-factory now: 203.0.113.7/32
                assistant now: 203.0.113.7/32
```

| List | Command | What it allows | Takes effect |
| --- | --- | --- | --- |
| Platform users | `access users add alice bob` (or `access orgs add contoso`) | Use the gateway with their own GitHub sign-in and Copilot plan: the CLI, samples, Copilot CLI, and demos they run themselves | Next `npx managed-copilot deploy` |
| Operators | `access operators add alice` | Open the operator console and operator API. Operators must also be platform users | Next `npx managed-copilot deploy` |
| Who can open the deployed apps | `access ips add 203.0.113.50` | Open the deployed gallery, Dispatch, factory, and assistant from those addresses, **acting as your account** (except the gallery, which holds no account) | At once |

`me` means you: `access users add me` adds your GitHub login, and `access ips add me` adds this machine's public
address. Each list also takes `remove` and `set` (which replaces the whole list).

```powershell
npx managed-copilot access users add alice bob
npx managed-copilot access operators add alice
npx managed-copilot deploy                          # applies user and operator changes
npx managed-copilot access ips add me               # applies at once, no deploy needed
```
**The deployed demos are not per-user.** There is no GitHub allow list for them: anyone who can reach them shares your
account, your Copilot usage, and the same conversations. Pick one:

- **Teammates use their own accounts (recommended).** Add them with `access users add`, then `deploy`. They clone the
  repository, run `pnpm install; pnpm build`, and use the commands in 3.4 and 3.1 with your gateway URL. Their
  sessions are theirs, on their Copilot plan.
- **Teammates open your deployed demos.** Add their addresses (or a shared network's range) with `access ips add`. Fine for a supervised demo, not for unsupervised use. `"*"` opens the apps to anyone
  on the Internet as you; don't.

What to send a teammate who uses their own account:

```powershell
git clone https://github.com/patniko/managed-copilot-sdk; cd managed-copilot-sdk
pnpm install; pnpm build
gh auth login                                            # their GitHub account with Copilot
$env:MANAGED_COPILOT_URL = "https://copilot.<environment-domain>"
npx managed-copilot status                               # should show them as Signed in
npx managed-copilot new chat                             # a chat in Copilot CLI
pnpm walkthrough 03                                           # an Azure sandbox
pnpm --filter @managed-copilot/demo-dispatch start       # Dispatch on http://localhost:7470, running in Azure
npx managed-copilot console                              # operators only
```

A teammate who isn't on the list gets an access error from `status`; add them with `access users add` and redeploy.

## 5 · Cost and teardown

The deployment costs roughly $0.11/hour idle and more while demos run, plus sandbox time
([cost](deployment.md#cost)). Delete sessions you're done with; an idle sandbox stops after 15 minutes and keeps only
its disks. To remove everything:

```powershell
az group delete --subscription <subscription-id> --name managed-copilot-dev --yes
```

Your settings (lists, region) stay on your machine for the next `npx managed-copilot deploy`.
