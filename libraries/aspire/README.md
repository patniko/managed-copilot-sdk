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
    team: { type: "orchestrator", workers: ["coder"], maxWorkers: 3 }, // a coordinator; workers run in coder sandboxes
    operator: { type: "orchestrator", workers: ["coder"], execution: "direct" }, // acts in a coder sandbox itself
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
- **Deploy.** `aspire deploy` publishes the same platform to Azure Container Apps ([deploying to Azure](../../docs/deployment.md)).
  Publish the apps that use it with `publishApp` in publish mode. By default an app acts as the deployment's GitHub
  account (`Parameters:app-github-token`) and opens only from `Parameters:app-allowed-ips` (the deploying machine's
  address unless set). An app that signs in its own users can be public instead: open to any address, with no
  GitHub token.

  ```ts
  import { addManagedCopilot, publishApp } from "@managed-copilot/aspire";

  if (await builder.executionContext().isPublishMode()) {
    await publishApp(builder, copilot, {
      name: "front-desk",                     // https://front-desk.<environment-domain>
      dockerfile: "demos/front-desk/Dockerfile",
      port: 7450,
      healthPath: "/api/health",
      public: true,                           // anyone can open it; it gets no GitHub token
    });
  }
  ```

  `public: true` with `githubToken: true` is refused: a public app can't act as your account.

Run `pnpm build` before `aspire run`; the gateway starts from its built output.
