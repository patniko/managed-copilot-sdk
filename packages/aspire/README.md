# @managed-copilot/aspire

Declare Managed Copilot environments in an Aspire TypeScript AppHost. The same declaration runs locally with
`aspire run`.

```ts
// apphost.mts
import { createBuilder } from "./.aspire/modules/aspire.mjs";
import { addManagedCopilot } from "@managed-copilot/aspire";

const builder = await createBuilder();
const stripeKey = await builder.addParameter("stripe-key", { secret: true });

const copilot = await addManagedCopilot(builder, "copilot", {
  environments: {
    chat: { type: "shared", models: ["claude-sonnet-5"], network: ["learn.microsoft.com"] },
    coder: { type: "isolated", size: "medium", vaults: ["payments"] },
    helper: { type: "promotable", promoteTo: "coder" },
  },
  vaults: { payments: [{ env: "STRIPE_API_KEY", value: stripeKey, hosts: ["api.stripe.com"] }] },
});

// Connect your own app: it finds the platform through MANAGED_COPILOT_URL.
await builder
  .addNodeApp("web", "./web", "dist/main.js")
  .withEnvironment("MANAGED_COPILOT_URL", copilot.url)
  .waitFor(copilot.gateway);

await builder.build().run();
```

- **Validation.** Options are checked against the platform's configuration schema before anything starts, and every
  problem is reported at once.
- **Secrets.** Vault values and webhook secrets must be Aspire secret parameters. The gateway receives them as
  environment variables; its configuration holds only `{ secretEnv }` references.
- **Schedules.** `session.tools` take stock SDK tools (`defineTool`); only their declarations are stored.
- **Operators.** `operators: { githubUsers: [...], githubOrgs: [...] }` names who may open the operator console
  (`npx managed-copilot console`) and operator API. A local gateway that names none lets every account that can use
  it operate it; a deployment that names none keeps its console off.
- **Hosting.** The gateway runs on a fixed port (7400 by default, `port` to change it) with a health check, a generated
  persistent platform key, and its data under `.managed-copilot/data` next to the AppHost. It builds sandbox images
  and runs the sandbox relay and egress proxy itself.
- **Deploy.** `aspire deploy` is not available yet (delivery gate G3) and fails with an explicit message.

Run `pnpm build` before `aspire run`; the gateway starts from its built output.
