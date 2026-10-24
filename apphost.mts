// The Managed Copilot AppHost. `aspire run` starts the platform with the spec's example environments, then the demos.
import { createBuilder } from "./.aspire/modules/aspire.mjs";
import { addManagedCopilot } from "@managed-copilot/aspire";
import { ASSISTANT_DEMO, assistantCopilotOptions } from "./demos/assistant/apphost.mjs";
import { softwareFactory } from "./demos/software-factory/apphost.mjs";

const builder = await createBuilder();

// Generated once and kept in the AppHost's user secrets, so restarts keep the same values.
const generatedSecret = (name: string) => builder.addParameterWithGeneratedValue(name, { minLength: 48, special: false }, { secret: true, persist: true });

// The demos bring their own environments (and the assistant its webhook) as plain data.
const factory = softwareFactory();
const assistant = assistantCopilotOptions({ webhookSecret: await generatedSecret("assistant-webhook-secret") });
const quickstartWebhook = { port: 7485, secret: await generatedSecret("quickstart-webhook-secret") };

const copilot = await addManagedCopilot(builder, "copilot", {
  environments: {
    chat: {
      type: "shared",
      customizations: "./copilot/chat", // agents, skills, and instructions (section 10)
      models: ["claude-sonnet-5", "claude-haiku-5.5"],
      network: ["learn.microsoft.com"], // only this host
    },
    coder: { type: "isolated", size: "medium" },
    helper: { type: "promotable", promoteTo: "coder" }, // placement target, not a policy override
    ...factory.environments,
    ...assistant.environments,
  },

  // Optional: lets code request { type, size } without a name, using the default sandbox image and settings.
  inline: { types: ["shared", "isolated"], sizes: ["small"] },

  webhooks: {
    // The quickstart's offline snippets answer tool calls here while their app is away (section 12).
    quickstart: {
      url: `http://localhost:${quickstartWebhook.port}/api/copilot-events`,
      environments: ["chat"],
      events: ["session.action_required", "session.idle", "session.failed", "schedule.run_started"],
      secret: quickstartWebhook.secret,
    },
    ...assistant.webhooks,
  },
});

/** A demo's built Node server on its fixed port, connected to the platform. */
function addDemo(demo: { name: string; workingDirectory: string; script: string; port: number; healthPath: string; env?: Readonly<Record<string, string>> }) {
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
await addDemo(factory.app);

// A long-running assistant you talk to like a bot: reminders, briefings, Gmail, and Google Calendar.
const assistantApp = await addDemo(ASSISTANT_DEMO)
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

// Every spec snippet as an acceptance check against this platform. Start it from the dashboard.
await builder
  .addJavaScriptApp("quickstart", "./demos/quickstart", { runScriptName: "acceptance" })
  .withPnpm({ install: false })
  .withEnvironment("MANAGED_COPILOT_URL", copilot.url)
  .withEnvironment("COPILOT_WEBHOOK_SECRET", quickstartWebhook.secret)
  .withEnvironment("QUICKSTART_WEBHOOK_PORT", String(quickstartWebhook.port))
  .waitFor(copilot.gateway)
  .withExplicitStart();

await builder.build().run();
