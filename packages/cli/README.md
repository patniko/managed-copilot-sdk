# managed-copilot

The command line for your Managed Copilot deployment: the local `aspire run` platform or your Azure deployment.

```powershell
npx managed-copilot status                          # deployment, account, environments, background sign-in
npx managed-copilot login                           # let scheduled and unattended work run as you
npx managed-copilot logout                          # turn that off; dependent schedules pause
npx managed-copilot sessions [--environment chat]   # your sessions
npx managed-copilot attach 7f3a2c1                  # Copilot CLI on a live session
npx managed-copilot promote 7f3a2c1                 # move a promotable session into its own sandbox
npx managed-copilot artifacts 7f3a2c1 --download .\out
npx managed-copilot schedules [list|runs|pause|resume|delete|run] [schedule]
npx managed-copilot console                         # the operator console in your browser (operators only)
npx managed-copilot operator [sessions|sandboxes|...] # the operator overview and views in the terminal
```

- **Deployment.** `--url`, then `MANAGED_COPILOT_URL`, then the discovery record a local gateway writes.
- **Identity.** You are your GitHub sign-in: `MANAGED_COPILOT_GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
  `GITHUB_TOKEN`, or `gh auth login`. There is no token flag, so tokens never appear on a command line.
- **IDs.** Sessions resolve from any unique prefix of four or more characters; schedules by ID, name, or prefix.
- **Output.** Tables with relative times; `--json` for scripts; colors and symbols degrade on non-interactive or
  legacy consoles (`--no-color` or `NO_COLOR`). Errors show the stable error code and a hint. Exit codes: 0 success,
  1 failure, 2 usage error.

## Attach

`attach` runs the stock Copilot CLI (`copilot --ahp`) in your terminal on the live session; your app and the CLI see
the same conversation. No credential goes on the CLI's command line: a loopback relay in this process admits the CLI
only when its own GitHub sign-in is the session's owner, and connects to the deployment with a single-use ticket.
Copilot CLI asks once to trust its empty working folder (`~/.managed-copilot/attach`). Exiting the CLI leaves the
session running.

## Operate

`console` and `operator` are for the deployment's operators (spec section 16): the GitHub accounts and organizations
the AppHost names in `operators`, or every account on a local gateway that names none. `console` mints a one-time
sign-in ticket with your GitHub sign-in and opens the console with it (`--no-open` prints the link instead; it works
once, within 60 seconds). `operator` prints the same views in the terminal: `overview` (the default), `infra`,
`environments`, `sessions` (every owner's; `--owner`, `--environment`, `--state`), `sandboxes`, `schedules`, and
`webhooks`. Operators see configuration with secrets redacted, never conversation content.
