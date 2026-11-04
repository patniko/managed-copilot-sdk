# Spec snippets, runnable

Every snippet from the [developer experience spec](../../docs/spec/developer-experience.md) as a TypeScript script
that runs against your platform with real models. Each file keeps the spec's code as written, then adds acceptance
checks after it.

| Script | Spec |
| --- | --- |
| `01-the-idea.ts` | The idea in one snippet |
| `02-shared-chat-with-a-tool.ts` | §3 Shared: a chat agent with your own tools |
| `03-isolated-coder.ts` | §4 Isolated: a coding agent in its own sandbox |
| `04-setup.ts` | §5 Set up the sandbox |
| `05-artifacts.ts` | §6 Get results out |
| `06-network.ts` | §7 Control network access |
| `07-vaults.ts` | §8 Keep secrets out of the sandbox |
| `08-promotable.ts` | §9 Promotable: start cheap, move when needed |
| `09-come-back-later.ts` | §11 Come back later |
| `10-offline-webhook.ts` | §12 Keep working while your app is offline (webhook) |
| `11-polling.ts` | §12 Keep working while your app is offline (polling) |
| `12-schedules.ts` | §13 Run on a schedule |
| `13-attach.ts` | §14 Open a session in Copilot CLI |
| `14-orchestrator.ts` | §17 Orchestrator: a coordinator with workers |
| `15-direct-execution.ts` | §17 Execution styles: a direct coordinator's hands in a sandbox |

## Run

Start the platform with `aspire run` from the repository root, then either start **snippets** in the Aspire
dashboard or run from a terminal:

```powershell
pnpm --filter @managed-copilot/snippets acceptance            # every snippet
pnpm --filter @managed-copilot/snippets acceptance 02 13      # a selection
pnpm --filter @managed-copilot/snippets acceptance --strict   # treat "not available yet" as failure
pnpm --filter @managed-copilot/snippets snippet 13            # one snippet; attach opens Copilot CLI here
```

Each snippet reports one outcome:

- **pass**: the spec's code ran and every check held.
- **fail**: something that should work did not (the run exits 1).
- **not available yet**: the deployment does not advertise a capability the snippet needs in `/v1/info`, or answered
  `capability_unavailable`. Nothing is faked.
- **skipped**: a local prerequisite is missing, such as background sign-in (`npx managed-copilot login`) for
  schedules, or the webhook secret that the AppHost passes to the dashboard's snippets resource.

Snippets clean up the sessions, vaults, and schedules they create. Downloads land in `tests/snippets/.output`.
