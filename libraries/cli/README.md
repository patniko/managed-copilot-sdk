# managed-copilot

The command line for your Managed Copilot deployment: the local `aspire run` platform or your Azure deployment.

```powershell
npx managed-copilot status                          # deployment, account, environments, background sign-in
npx managed-copilot login                           # let scheduled and unattended work run as you
npx managed-copilot logout                          # turn that off; dependent schedules pause
npx managed-copilot sessions [--environment chat]   # your sessions
npx managed-copilot new chat [--model <id>]         # a new session in that environment, opened in Copilot CLI
npx managed-copilot attach 7f3a2c1                  # Copilot CLI on a live session
npx managed-copilot promote 7f3a2c1                 # move a promotable session into its own sandbox
npx managed-copilot workers 7f3a2c1                 # an orchestrator session's workers and their latest reports
npx managed-copilot artifacts 7f3a2c1 --download .\out
npx managed-copilot exec 7f3a2c1 -- ls -la          # run a command in a session's sandbox; exits with its code
npx managed-copilot schedules [list|runs|pause|resume|delete|run] [schedule]
npx managed-copilot console                         # the operator console in your browser (operators only)
npx managed-copilot operator [sessions|sandboxes|...] # the operator overview and views in the terminal
npx managed-copilot deploy                          # deploy the AppHost in this directory to Azure
npx managed-copilot access [users|orgs|operators|operator-orgs|ips] [add|remove|set] [entries...]
```

- **Deployment.** `--url`, then `MANAGED_COPILOT_URL`, then the discovery record a local gateway writes.
- **Identity.** You are your GitHub sign-in: `MANAGED_COPILOT_GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
  `GITHUB_TOKEN`, or `gh auth login`. There is no token flag, so tokens never appear on a command line.
- **IDs.** Sessions resolve from any unique prefix of four or more characters; schedules by ID, name, or prefix.
- **Output.** Tables with relative times; `--json` for scripts; colors and symbols degrade on non-interactive or
  legacy consoles (`--no-color` or `NO_COLOR`). Errors show the stable error code and a hint. Exit codes: 0 success,
  1 failure, 2 usage error; `exec` exits with the command's own code (124 when it timed out, 130 when stopped).

## Attach

`attach` runs the stock Copilot CLI (`copilot --ahp`) in your terminal on the live session; your app and the CLI see
the same conversation. No credential goes on the CLI's command line: a loopback relay in this process admits the CLI
only when its own GitHub sign-in is the session's owner, and connects to the deployment with a single-use ticket.
Copilot CLI asks once to trust its empty working folder (`~/.managed-copilot/attach`). Exiting the CLI leaves the
session running.

`new <environment>` starts a session and attaches to it in one step. The session goes through the platform's normal
admission, exactly like `managed.createSession({ environment })` from code (an attached Copilot CLI cannot create
sessions itself), then this process leaves it and Copilot CLI attaches, so the CLI is the one that asks you to approve
tool calls. `--model` picks one of the environment's allowed models (the default is its first, as for any session;
Copilot CLI's model picker is empty in attached sessions). Isolated environments set up the session's sandbox first.
It checks that Copilot CLI is installed and the deployment offers attach before creating anything; the session keeps
running after you exit, so `attach` brings you back to it.

## Operate

`console` and `operator` are for the deployment's operators (spec section 16): the GitHub accounts and organizations
the AppHost names in `operators`, or every account on a local gateway that names none. `console` mints a one-time
sign-in ticket with your GitHub sign-in and opens the console with it (`--no-open` prints the link instead; it works
once, within 60 seconds). `operator` prints the same views in the terminal: `overview` (the default), `infra`,
`environments`, `sessions` (every owner's; `--owner`, `--environment`, `--state`), `sandboxes`, `schedules`, and
`webhooks`. Operators see configuration with secrets redacted, never conversation content.

## Deploy and share

`deploy` and `access` work on the AppHost in the current directory (or `--apphost <path>`; `--name` if
`addManagedCopilot` isn't named `copilot`), not on a running deployment. They read and write its user secrets with the
Aspire CLI and never print secret values.

```powershell
npx managed-copilot deploy                                    # the Azure CLI's subscription, managed-copilot-dev, westus2
npx managed-copilot deploy --resource-group demo --location eastus
```

`deploy` checks that the Aspire CLI, the Azure CLI (signed in), and Docker (running) are ready, then fills in what's
missing: the subscription, region, and resource group, and, on a first deployment, you as a platform user and an
operator. It shows the plan, asks before deploying (`--yes` skips the question), and runs `aspire deploy`. The published
apps act as your GitHub sign-in (except public apps, which get no token): the token goes to `aspire deploy` in an
environment variable, never on a command line. `aspire deploy` doesn't load the AppHost's user secrets, so `deploy`
passes the AppHost's own parameters from them the same way (for example an OAuth client's ID and secret, set with
`aspire secret set Parameters:<name> ...`), and names them, never their values. It never passes a parameter the AppHost
generates (`addParameterWithGeneratedValue`, such as the platform's and apps' keys and webhook secrets): each deployment
makes its own. It learns which ones those are from the manifest `aspire do publish-manifest` writes for the AppHost, and
if that fails it says so and passes none. It also leaves out every parameter the deployment's Aspire record already
keeps (Aspire's saved value wins on later deploys; see
[changing a saved parameter](../../docs/deployment.md#changing-a-saved-parameter)), and a value you've set in the
environment yourself (any spelling Aspire reads the same) wins over the user secret.
It won't deploy over a resource group that holds a deployment this AppHost didn't make: that deployment's generated
keys are in Aspire's deployment record (`~/.aspire/deployments/<hash of the AppHost path>/`) for the checkout that made
it. If that record is on this machine, it offers, in a terminal, to copy it to this AppHost so the deployment keeps its
keys. When it's done, it prints the gateway URL and the URLs of any public apps.

```powershell
npx managed-copilot access                           # the lists, and each running app's allowlist
npx managed-copilot access users add me alice bob    # who may use the platform ("me" is your GitHub sign-in)
npx managed-copilot access orgs add contoso          # or whole organizations
npx managed-copilot access operators add alice       # who may open the operator console
npx managed-copilot access ips add me                # let this machine open the deployed apps
npx managed-copilot access ips set 203.0.113.0/24    # replace the apps' allowlist
npx managed-copilot access users remove bob
```

Each list is one setting (`Parameters:<name>-github-users`, `-github-orgs`, `-operator-users`, `-operator-orgs`, and
`Parameters:app-allowed-ips`). User and operator changes take effect on the next `deploy`. Allowlist changes also apply
to the running apps at once through the Azure CLI. An unset allowlist means the deploying machine's address, so the
first `ips add` keeps that address. `ips set "*"` opens the apps to any address as your account; it asks first, and
takes effect on the next deploy.

Public apps, which the AppHost publishes with `publishApp({ public: true })` because they sign in their own users,
are open to any address and get no GitHub token. `access` lists them under **Public apps**; the allowlist never
applies to them, and `ips` never changes their ingress.
