// The Managed Copilot AppHost. `aspire run` starts the platform with the spec's example environments, then the demos.
import { createBuilder } from "./.aspire/modules/aspire.mjs";
import { addManagedCopilot, publishApp } from "@managed-copilot/aspire";
import { ASSISTANT_DEMO, ASSISTANT_PORT, assistantCopilotOptions } from "./demos/assistant/apphost.mjs";
import { DISPATCH_DEFAULT_PORT, dispatch } from "./demos/dispatch/apphost.mjs";
import { softwareFactory } from "./demos/software-factory/apphost.mjs";
import { INCIDENT_DEFAULT_PORT, incidentCommander } from "./demos/incident-commander/apphost.mjs";

const builder = await createBuilder();
// `aspire deploy` publishes the same platform and demos to Azure Container Apps (docs/deployment.md).
const publishing = await builder.executionContext().isPublishMode();

// Fixed local ports. MANAGED_COPILOT_PORT_OFFSET (for example 300) runs a second copy beside this one; that copy leaves
// zero-config discovery to the first. Google sign-in redirects to the assistant's own URL, so with an offset, add that
// callback URL to your Google OAuth client too.
const offset = Number(process.env.MANAGED_COPILOT_PORT_OFFSET ?? 0);
if (!Number.isInteger(offset) || offset < 0 || offset > 50_000) {
  throw new Error(`MANAGED_COPILOT_PORT_OFFSET must be a whole number from 0 to 50000 (got "${process.env.MANAGED_COPILOT_PORT_OFFSET}").`);
}
const ports = {
  gateway: 7400 + offset,
  dispatch: DISPATCH_DEFAULT_PORT + offset,
  factory: 7480 + offset,
  snippetsWebhook: 7485 + offset,
  assistant: ASSISTANT_PORT + offset,
  incidentCommander: INCIDENT_DEFAULT_PORT + offset,
};
const assistantUrl = `http://localhost:${ports.assistant}`;

// Generated once and kept in the AppHost's user secrets, so restarts keep the same values.
const generatedSecret = (name: string) => builder.addParameterWithGeneratedValue(name, { minLength: 48, special: false }, { secret: true, persist: true });

// The demos bring their own environments (and the assistant its webhook) as plain data.
const factory = softwareFactory({ port: ports.factory });
const dispatchDemo = dispatch({ port: ports.dispatch });
const assistant = assistantCopilotOptions({ webhookSecret: await generatedSecret("assistant-webhook-secret") });
const snippetsWebhook = { port: ports.snippetsWebhook, secret: await generatedSecret("snippets-webhook-secret") };
const incidents = incidentCommander({ port: ports.incidentCommander, webhookSecret: await generatedSecret("incident-commander-webhook-secret") });

const copilot = await addManagedCopilot(builder, "copilot", {
  port: ports.gateway,
  discovery: offset === 0,
  // A deployed gateway is on the Internet: `aspire deploy` refuses to publish it until Parameters:copilot-github-users
  // (or Parameters:copilot-github-orgs) names who may use it, for example `aspire secret set Parameters:copilot-github-users <your-login>`.
  // The operator console (`npx managed-copilot console`, spec section 16) is open to every account on this machine; a
  // deployment turns it on for the accounts in Parameters:copilot-operator-users (or -operator-orgs).
  environments: {
    chat: {
      type: "shared",
      customizations: "./environments/chat", // agents, skills, and instructions (section 10)
      models: ["claude-sonnet-5", "claude-haiku-5.5"],
      network: ["learn.microsoft.com"], // only this host
    },
    coder: { type: "isolated", size: "medium" },
    helper: { type: "promotable", promoteTo: "coder" }, // placement target, not a policy override
    // A coordinator on the shared runtime that starts workers, each a session of `coder` in its own sandbox (section 17).
    team: { type: "orchestrator", workers: ["coder"], maxWorkers: 3 },
    // The same brain acting directly: it and its sub-agents run commands and edit files in a `coder` sandbox, no agent in it.
    operator: { type: "orchestrator", workers: ["coder"], execution: "direct" },
    // Both: its own `coder` sandbox for quick work, and workers for big independent parts. The model chooses.
    lead: { type: "orchestrator", workers: ["coder"], execution: "mixed", maxWorkers: 3 },
    ...factory.environments,
    ...assistant.environments,
    ...dispatchDemo.environments,
    ...incidents.environments,
  },

  // Optional: lets code request { type, size } without a name, using the default sandbox image and settings.
  inline: { types: ["shared", "isolated"], sizes: ["small"] },

  webhooks: {
    // The spec snippets' offline checks answer tool calls here while their app is away (section 12). Local only.
    ...(publishing
      ? {}
      : {
          snippets: {
            url: `http://localhost:${snippetsWebhook.port}/api/copilot-events`,
            environments: ["chat"],
            events: ["session.action_required", "session.idle", "session.failed", "schedule.run_started"],
            secret: snippetsWebhook.secret,
          },
        }),
    ...assistant.webhooks,
    // The assistant receives its events on its own port.
    assistant: { ...assistant.webhooks.assistant, url: `${assistantUrl}/api/copilot-events` },
    ...incidents.webhooks,
  },
});

type Demo = { name: string; workingDirectory: string; script: string; port: number; healthPath: string; env?: Readonly<Record<string, string>> };
/** How a demo is deployed by `aspire deploy`: its image and the settings that receive its Azure addresses. */
type DemoDeployment = { dockerfile: string; publicUrlEnv?: string; allowedHostsEnv?: string; gatewayUrlEnv?: string[] };

/** A demo's built Node server on its fixed port, connected to the platform (a container app when publishing). */
function addDemo(demo: Demo, deployment: DemoDeployment) {
  if (publishing) return publishApp(builder, copilot, { ...demo, ...deployment });
  let app = builder
    .addNodeApp(demo.name, demo.workingDirectory, demo.script)
    .withPnpm({ install: false })
    .withHttpEndpoint({ port: demo.port, env: "PORT", isProxied: false })
    .withHttpHealthCheck({ path: demo.healthPath })
    .withEnvironment("MANAGED_COPILOT_URL", copilot.url)
    .waitFor(copilot.gateway);
  for (const [name, value] of Object.entries(demo.env ?? {})) app = app.withEnvironment(name, value);
  return app;
}

// An AI software factory: plans a work order, builds tasks in parallel sandboxes, reviews, and releases.
await addDemo(factory.app, { dockerfile: "demos/software-factory/Dockerfile", allowedHostsEnv: "FACTORY_ALLOWED_HOSTS", gatewayUrlEnv: ["FACTORY_ATTACH_URL"] });

// Dispatch: one conversation with an orchestrator agent that, message by message, creates a sandbox for each part of
// the work or sends it to a sandbox it already has.
await addDemo(dispatchDemo.app, { dockerfile: "demos/dispatch/Dockerfile", allowedHostsEnv: "DISPATCH_ALLOWED_HOSTS", gatewayUrlEnv: ["DISPATCH_ATTACH_URL"] });

// A long-running assistant you talk to like a bot: reminders, briefings, Gmail, Google Calendar, and sandboxes it starts
// for hands-on work.
const assistantApp = await (
  await addDemo(
    { ...ASSISTANT_DEMO, port: ports.assistant, env: { ...ASSISTANT_DEMO.env, ASSISTANT_PUBLIC_URL: assistantUrl } },
    { dockerfile: "demos/assistant/Dockerfile", publicUrlEnv: "ASSISTANT_PUBLIC_URL", allowedHostsEnv: "ASSISTANT_ALLOWED_HOSTS" },
  )
)
  .withEnvironment("ASSISTANT_WEBHOOK_SECRET", assistant.webhooks.assistant.secret)
  .withEnvironment("ASSISTANT_SEALING_KEY", await generatedSecret("assistant-sealing-key"));

// Google sign-in is optional: without it the assistant uses its labeled demo inbox and calendar. Set both with
// `aspire secret set Parameters:google-client-id <id>` and `aspire secret set Parameters:google-client-secret <secret>`.
const configuration = await builder.getConfiguration();
if (await configuration.exists("Parameters:google-client-id")) {
  await assistantApp
    .withEnvironment("GOOGLE_CLIENT_ID", await builder.addParameter("google-client-id"))
    .withEnvironment("GOOGLE_CLIENT_SECRET", await builder.addParameter("google-client-secret", { secret: true }));
}

// Incident Commander: an alert opens an incident; a mixed coordinator triages in its own sandbox, hands the repro and
// the fix to workers, and waits on the platform for a person to approve the deploy. Alerts carry the generated bearer
// secret; the platform's webhook keeps the app informed while it isn't attached.
await (
  await addDemo(incidents.app, {
    dockerfile: "demos/incident-commander/Dockerfile",
    publicUrlEnv: "INCIDENT_PUBLIC_URL",
    allowedHostsEnv: "INCIDENT_ALLOWED_HOSTS",
  })
)
  .withEnvironment("INCIDENT_WEBHOOK_SECRET", incidents.webhooks["incident-commander"].secret)
  .withEnvironment("INCIDENT_ALERT_SECRET", await generatedSecret("incident-commander-alert-secret"));

// The demo gallery: every demo and walkthrough of this deployment on one page, at https://gallery.<environment-domain>.
// Deployed only (locally, `pnpm gallery`). It holds no GitHub token, and opens from the same addresses as the demos.
if (publishing) {
  await publishApp(builder, copilot, {
    name: "gallery",
    dockerfile: "demos/gallery/Dockerfile",
    port: 7460,
    healthPath: "/api/health",
    allowedHostsEnv: "GALLERY_ALLOWED_HOSTS",
    githubToken: false,
  });
}

// Every spec snippet as an acceptance check against this platform. Start it from the dashboard. Local only: against
// Azure, run it from your machine with MANAGED_COPILOT_URL set to the deployed gateway.
if (!publishing) await builder
  .addJavaScriptApp("snippets", "./tests/snippets", { runScriptName: "acceptance" })
  .withPnpm({ install: false })
  .withEnvironment("MANAGED_COPILOT_URL", copilot.url)
  .withEnvironment("COPILOT_WEBHOOK_SECRET", snippetsWebhook.secret)
  .withEnvironment("SNIPPETS_WEBHOOK_PORT", String(snippetsWebhook.port))
  .waitFor(copilot.gateway)
  .withExplicitStart();

await builder.build().run();
