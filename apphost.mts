// The Managed Copilot AppHost. `aspire run` starts the platform with the spec's example environments, then the demos.
import { createBuilder, type EndpointReference } from "./.aspire/modules/aspire.mjs";
import { addManagedCopilot, publishApp } from "@managed-copilot/aspire";
import { ASSISTANT_DEMO, ASSISTANT_PORT, assistantCopilotOptions } from "./demos/assistant/apphost.mjs";
import { DISPATCH_DEFAULT_PORT, dispatch } from "./demos/dispatch/apphost.mjs";
import { FRONT_DESK_APP, FRONT_DESK_PORT, frontDesk } from "./demos/front-desk/apphost.mjs";
import { PATTERN_RACE_DEFAULT_PORT, patternRace } from "./demos/pattern-race/apphost.mjs";
import { RESEARCH_SWARM_DEFAULT_PORT, researchSwarm } from "./demos/research-swarm/apphost.mjs";
import { softwareFactory } from "./demos/software-factory/apphost.mjs";
import { DATA_DESK_DEFAULT_PORT, dataDesk } from "./demos/data-desk/apphost.mjs";
import { DOWNHILL_PORT, downhill } from "./demos/downhill/apphost.mjs";
import { HELP_DESK_PORT, helpDesk } from "./demos/help-desk/apphost.mjs";
import { HACK_THE_HARNESS_PORT, hackTheHarness } from "./demos/hack-the-harness/apphost.mjs";
import { INCIDENT_DEFAULT_PORT, incidentCommander } from "./demos/incident-commander/apphost.mjs";
import { REPO_DOCTOR_PORT, repoDoctor } from "./demos/repo-doctor/apphost.mjs";

const builder = await createBuilder();
// `aspire deploy` publishes the same platform and demos to Azure Container Apps (docs/deployment.md).
const publishing = await builder.executionContext().isPublishMode();

// Fixed local ports. MANAGED_COPILOT_PORT_OFFSET (for example 300) runs a second copy beside this one; that copy leaves
// zero-config discovery to the first. Google and GitHub sign-in redirect to the demos' own URLs, so with an offset, add
// those callback URLs to your Google and GitHub OAuth apps too.
const offset = Number(process.env.MANAGED_COPILOT_PORT_OFFSET ?? 0);
if (!Number.isInteger(offset) || offset < 0 || offset > 50_000) {
  throw new Error(`MANAGED_COPILOT_PORT_OFFSET must be a whole number from 0 to 50000 (got "${process.env.MANAGED_COPILOT_PORT_OFFSET}").`);
}
const ports = {
  gateway: 7400 + offset,
  frontDesk: FRONT_DESK_PORT + offset,
  dispatch: DISPATCH_DEFAULT_PORT + offset,
  factory: 7480 + offset,
  snippetsWebhook: 7485 + offset,
  assistant: ASSISTANT_PORT + offset,
  researchSwarm: RESEARCH_SWARM_DEFAULT_PORT + offset,
  patternRace: PATTERN_RACE_DEFAULT_PORT + offset,
  dataDesk: DATA_DESK_DEFAULT_PORT + offset,
  helpDesk: HELP_DESK_PORT + offset,
  downhill: DOWNHILL_PORT + offset,
  hackTheHarness: HACK_THE_HARNESS_PORT + offset,
  incidentCommander: INCIDENT_DEFAULT_PORT + offset,
  repoDoctor: REPO_DOCTOR_PORT + offset,
};
const assistantUrl = `http://localhost:${ports.assistant}`;

// Generated once and kept in the AppHost's user secrets, so restarts keep the same values.
const generatedSecret = (name: string) => builder.addParameterWithGeneratedValue(name, { minLength: 48, special: false }, { secret: true, persist: true });

// Settings from the AppHost's configuration: user secrets with `aspire run`. `aspire deploy` runs as Production and
// doesn't load user secrets; `npx managed-copilot deploy` passes the `Parameters:*` ones on as environment variables.
const configuration = await builder.getConfiguration();
const setting = async (key: string) => ((await configuration.exists(key)) ? (await configuration.getConfigValue(key)).trim() || undefined : undefined);

// An Azure AI Foundry account pays for Front Desk's people without GitHub (spec section 15). Optional: name an existing
// account and its model deployments with `aspire secret set Parameters:foundry-account <name>`,
// `Parameters:foundry-resource-group <group>`, and `Parameters:foundry-deployments <deployment,...>` (and
// `Parameters:foundry-subscription <id>` when it isn't the deployment's).
const foundryAccount = await setting("Parameters:foundry-account");
const foundryResourceGroup = await setting("Parameters:foundry-resource-group");
const foundryDeployments = (await setting("Parameters:foundry-deployments"))?.split(",").map((name) => name.trim()).filter(Boolean) ?? [];
const foundrySubscription = await setting("Parameters:foundry-subscription");
if (foundryAccount && (!foundryResourceGroup || foundryDeployments.length === 0)) {
  throw new Error(
    `Parameters:foundry-account is "${foundryAccount}": also set Parameters:foundry-resource-group and Parameters:foundry-deployments (its model deployments, comma-separated).`,
  );
}
const foundry = foundryAccount
  ? { [foundryAccount]: { resourceGroup: foundryResourceGroup!, deployments: foundryDeployments, ...(foundrySubscription ? { subscription: foundrySubscription } : {}) } }
  : undefined;

// Optional: Help Desk classifies each customer message with Microsoft-Decision-1 on Microsoft Foundry
// (demos/help-desk/README.md "Ticket classification"). Name the deployment with `aspire secret set
// Parameters:help-desk-decision-endpoint <https://<resource>.services.ai.azure.com>` and
// `Parameters:help-desk-decision-deployment <name>` (and `Parameters:help-desk-decision-subscription <id>` when it isn't
// the Azure CLI's default). Help Desk calls it as your `az login` identity, so this works with `aspire run` only.
const helpDeskDecisionEndpoint = await setting("Parameters:help-desk-decision-endpoint");
const helpDeskDecisionDeployment = await setting("Parameters:help-desk-decision-deployment");
const helpDeskDecisionSubscription = await setting("Parameters:help-desk-decision-subscription");
if (Boolean(helpDeskDecisionEndpoint) !== Boolean(helpDeskDecisionDeployment)) {
  throw new Error("Help Desk's ticket classification needs both Parameters:help-desk-decision-endpoint and Parameters:help-desk-decision-deployment.");
}
if (publishing && helpDeskDecisionEndpoint) {
  throw new Error(
    "Help Desk's ticket classification (Parameters:help-desk-decision-*) works with `aspire run` only: a deployed Help Desk has no Azure identity to call Microsoft Foundry with. Remove those settings to deploy.",
  );
}
const helpDeskTriage = helpDeskDecisionEndpoint
  ? { endpoint: helpDeskDecisionEndpoint, deployment: helpDeskDecisionDeployment!, ...(helpDeskDecisionSubscription ? { subscription: helpDeskDecisionSubscription } : {}) }
  : undefined;
// The key the platform presents to Help Desk's OpenAI-compatible endpoint, generated once.
const helpDeskTriageKey = helpDeskTriage ? await generatedSecret("help-desk-triage-key") : undefined;

// The demos bring their own environments (and the assistant its webhook) as plain data.
const factory = softwareFactory({ port: ports.factory });
const dispatchDemo = dispatch({ port: ports.dispatch });
const frontDeskDemo = frontDesk({ port: ports.frontDesk, ...(foundryAccount ? { foundry: foundryAccount } : {}) });
const dataDeskDemo = dataDesk({ port: ports.dataDesk });
const assistant = assistantCopilotOptions({ webhookSecret: await generatedSecret("assistant-webhook-secret") });
const snippetsWebhook = { port: ports.snippetsWebhook, secret: await generatedSecret("snippets-webhook-secret") };
const swarm = researchSwarm({ port: ports.researchSwarm });
const helpDeskDemo = helpDesk({ port: ports.helpDesk, ...(helpDeskTriage ? { triage: helpDeskTriage } : {}) });
const downhillDemo = downhill({ port: ports.downhill });
const hackTheHarnessDemo = hackTheHarness({ port: ports.hackTheHarness });
const incidents = incidentCommander({ port: ports.incidentCommander, webhookSecret: await generatedSecret("incident-commander-webhook-secret") });
// Downhill's shop pages Incident Commander with its alert secret, and Incident Commander signs the deploys it sends the
// shop with this one.
const incidentAlertSecret = await generatedSecret("incident-commander-alert-secret");
const downhillDeploySecret = await generatedSecret("downhill-deploy-secret");
// Server-to-server addresses: localhost under `aspire run`, the app's name inside the Azure environment.
const internalUrl = (name: string, port: number) => (publishing ? `http://${name}` : `http://localhost:${port}`);
const downhillApi = internalUrl(downhillDemo.app.name, ports.downhill);
const incidentApi = internalUrl(incidents.app.name, ports.incidentCommander);
const repoDoctorDemo = repoDoctor({ port: ports.repoDoctor });
const chatEnvironment = {
  type: "shared" as const,
  customizations: "./environments/chat", // agents, skills, and instructions (section 10)
  models: ["claude-sonnet-5", "claude-haiku-5.5"],
  network: ["learn.microsoft.com"], // only this host
};

const copilot = await addManagedCopilot(builder, "copilot", {
  port: ports.gateway,
  discovery: offset === 0,
  // A deployed gateway is on the Internet: `aspire deploy` refuses to publish it until Parameters:copilot-github-users
  // (or Parameters:copilot-github-orgs) names who may use it, for example `aspire secret set Parameters:copilot-github-users <your-login>`.
  // The operator console (`npx managed-copilot console`, spec section 16) is open to every account on this machine; a
  // deployment turns it on for the accounts in Parameters:copilot-operator-users (or -operator-orgs).
  ...(foundry ? { foundry } : {}),
  // OpenAI-compatible endpoints the AppHost routes environments to (spec section 15): Help Desk's ticket classification.
  ...(helpDeskDemo.triage && helpDeskTriageKey ? { openai: { [helpDeskDemo.triage.endpoint]: { ...helpDeskDemo.triage.declaration, models: [...helpDeskDemo.triage.declaration.models], key: helpDeskTriageKey } } } : {}),
  // Apps that sign in their own users and vouch for them with a key the AppHost issues (spec section 2).
  apps: { ...frontDeskDemo.apps },
  environments: {
    chat: chatEnvironment,
    ...(publishing ? {} : { "webhook-examples": chatEnvironment }),
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
    ...frontDeskDemo.environments,
    ...swarm.environments,
    ...dataDeskDemo.environments,
    ...helpDeskDemo.environments,
    ...(publishing ? {} : hackTheHarnessDemo.environments),
    ...incidents.environments,
    ...repoDoctorDemo.environments,
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
            environments: ["webhook-examples"],
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
/**
 * How a demo is deployed by `aspire deploy`: its image and the settings that receive its Azure addresses. `public`
 * opens it to any address with no GitHub token, for a demo that signs in its own users; `githubToken: false` keeps it
 * behind the allowlist without a token, for a demo that never calls the platform; `app` gives it the key of an app
 * declared in `apps` (as MANAGED_COPILOT_APP_KEY, with `aspire run` too).
 */
type DemoDeployment = { dockerfile: string; publicUrlEnv?: string; allowedHostsEnv?: string; gatewayUrlEnv?: string[]; public?: boolean; githubToken?: boolean; app?: string };

/** A demo's built Node server on its fixed port, connected to the platform (a container app when publishing). */
function addDemo(demo: Demo, deployment: DemoDeployment) {
  return publishing ? publishApp(builder, copilot, { ...demo, ...deployment }) : runDemo(demo, deployment.app);
}

/** A demo's built Node server, run locally on its fixed port and connected to the platform. */
function runDemo(demo: Demo, appName?: string) {
  let app = builder
    .addNodeApp(demo.name, demo.workingDirectory, demo.script)
    .withPnpm({ install: false })
    .withHttpEndpoint({ port: demo.port, env: "PORT", isProxied: false })
    .withHttpHealthCheck({ path: demo.healthPath })
    .withEnvironment("MANAGED_COPILOT_URL", copilot.url)
    .waitFor(copilot.gateway);
  if (appName) app = app.withEnvironment("MANAGED_COPILOT_APP_KEY", copilot.appKey(appName));
  for (const [name, value] of Object.entries(demo.env ?? {})) app = app.withEnvironment(name, value);
  return app;
}

// An AI software factory: plans a work order, builds tasks in parallel sandboxes, reviews, and releases.
const factoryApp = await addDemo(factory.app, { dockerfile: "demos/software-factory/Dockerfile", allowedHostsEnv: "FACTORY_ALLOWED_HOSTS", gatewayUrlEnv: ["FACTORY_ATTACH_URL"] });

// Help Desk, Incident Commander, and Data Desk route work to the factory: a storefront bug, an incident's fix, a data
// insight. Their servers call its API at SOFTWARE_FACTORY_URL (in Azure, its name inside the environment, which stays
// there and so passes its ingress allowlist) and link people to SOFTWARE_FACTORY_PUBLIC_URL.
// (`publishApp` types its resource loosely, so the endpoint gets the AppHost's own type here.)
const factoryPublicUrl = (await factoryApp.getEndpoint("http")) as EndpointReference;
const factoryRouting: { readonly api: string | EndpointReference; readonly public: EndpointReference } = {
  api: publishing ? `http://${factory.app.name}` : factoryPublicUrl,
  public: factoryPublicUrl,
};

// Dispatch: one conversation with an orchestrator agent that, message by message, creates a sandbox for each part of
// the work or sends it to a sandbox it already has.
await addDemo(dispatchDemo.app, { dockerfile: "demos/dispatch/Dockerfile", allowedHostsEnv: "DISPATCH_ALLOWED_HOSTS", gatewayUrlEnv: ["DISPATCH_ATTACH_URL"] });

// Research Swarm: one question fans out to web researchers, each in its own sandbox, and comes back as a cited report.
await addDemo(swarm.app, { dockerfile: "demos/research-swarm/Dockerfile", allowedHostsEnv: "RESEARCH_SWARM_ALLOWED_HOSTS" });

// Pattern Race: one job in six lanes at once, one per pattern environment above; only the environment name differs.
await addDemo(patternRace({ port: ports.patternRace }).app, { dockerfile: "demos/pattern-race/Dockerfile", allowedHostsEnv: "PATTERN_RACE_ALLOWED_HOSTS" });

// Data Desk: chat with a spreadsheet. The session answers on the shared runtime, then moves once into a Python sandbox
// when a request needs code, and an attached Copilot CLI follows it. What it finds can go to the factory. With
// DOWNHILL_URL it also offers Downhill's shop sales, live.
await (await addDemo(dataDeskDemo.app, { dockerfile: "demos/data-desk/Dockerfile", allowedHostsEnv: "DATA_DESK_ALLOWED_HOSTS", gatewayUrlEnv: ["DATA_DESK_ATTACH_URL"] }))
  .withEnvironment("SOFTWARE_FACTORY_URL", factoryRouting.api)
  .withEnvironment("SOFTWARE_FACTORY_PUBLIC_URL", factoryRouting.public)
  .withEnvironment("DOWNHILL_URL", downhillApi);

// Repo Doctor: one sandbox per run clones a repository, reproduces its failing tests, fixes them, and returns a verified
// patch, while a strip shows the hosts its network rules allowed and blocked.
await addDemo(repoDoctorDemo.app, { dockerfile: "demos/repo-doctor/Dockerfile", allowedHostsEnv: "REPO_DOCTOR_ALLOWED_HOSTS" });

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
if (await configuration.exists("Parameters:google-client-id")) {
  await assistantApp
    .withEnvironment("GOOGLE_CLIENT_ID", await builder.addParameter("google-client-id"))
    .withEnvironment("GOOGLE_CLIENT_SECRET", await builder.addParameter("google-client-secret", { secret: true }));
}

// Front Desk: a chat assistant many people use. Each person signs in with GitHub (their own Copilot plan) or with an
// email and password (Foundry, which the app pays for), and gets private conversations and memory. Published as a
// public app with no GitHub token: its app key lets it act for each signed-in person, and never as you.
const frontDeskApp = await (
  await addDemo(frontDeskDemo.app, {
    dockerfile: "demos/front-desk/Dockerfile",
    publicUrlEnv: "FRONT_DESK_PUBLIC_URL",
    allowedHostsEnv: "FRONT_DESK_ALLOWED_HOSTS",
    public: true,
    app: FRONT_DESK_APP,
  })
).withEnvironment("FRONT_DESK_SEALING_KEY", await generatedSecret("front-desk-sealing-key"));
// "Continue with GitHub" needs a GitHub OAuth app whose callback URL is <Front Desk's URL>/auth/github/callback (see
// demos/front-desk/README.md). Without one, people sign in with email (and, on your own computer, as your GitHub CLI's
// account). Put the secret in the file `aspire secret path` names, never on a command line.
if (await configuration.exists("Parameters:front-desk-github-client-id")) {
  await frontDeskApp
    .withEnvironment("FRONT_DESK_GITHUB_CLIENT_ID", await builder.addParameter("front-desk-github-client-id"))
    .withEnvironment("FRONT_DESK_GITHUB_CLIENT_SECRET", await builder.addParameter("front-desk-github-client-secret", { secret: true }));
}
// Anyone who can reach a public Front Desk can create an email account, and your Foundry pays for their messages. To
// choose who can, set an invitation code (`Parameters:front-desk-invite-code`) and share it with them. Deploying with a
// Foundry account and no code is refused unless `Parameters:front-desk-open-signup` is "true".
if (await configuration.exists("Parameters:front-desk-invite-code")) {
  await frontDeskApp.withEnvironment("FRONT_DESK_INVITE_CODE", await builder.addParameter("front-desk-invite-code", { secret: true }));
} else if (publishing && foundryAccount && (await setting("Parameters:front-desk-open-signup"))?.toLowerCase() !== "true") {
  throw new Error(
    "Front Desk is public and Parameters:foundry-account pays for its email accounts, so anyone on the Internet could sign up and spend " +
      "your Foundry budget. Set Parameters:front-desk-invite-code (in the file `aspire secret path` names) and share it with the people " +
      'you want, or set Parameters:front-desk-open-signup to "true" to let anyone sign up (Parameters:front-desk-total-daily-limit still caps the spend).',
  );
}
// The most messages everyone Front Desk pays for may send in a day, together (default 1000).
const frontDeskTotalDailyLimit = await setting("Parameters:front-desk-total-daily-limit");
if (frontDeskTotalDailyLimit && !/^\d+$/.test(frontDeskTotalDailyLimit)) {
  throw new Error(`Parameters:front-desk-total-daily-limit must be a whole number (got "${frontDeskTotalDailyLimit}").`);
}
if (frontDeskTotalDailyLimit) await frontDeskApp.withEnvironment("FRONT_DESK_TOTAL_DAILY_LIMIT", frontDeskTotalDailyLimit);

// Help Desk: a support rush of simulated customers, each with a private session on the one shared runtime and the
// store's tools bound to that customer's orders, plus live tickets from Downhill's players. Storefront bugs its
// customers and players report go to the factory.
const helpDeskApp = await (await addDemo(helpDeskDemo.app, { dockerfile: "demos/help-desk/Dockerfile", allowedHostsEnv: "HELP_DESK_ALLOWED_HOSTS" }))
  .withEnvironment("SOFTWARE_FACTORY_URL", factoryRouting.api)
  .withEnvironment("SOFTWARE_FACTORY_PUBLIC_URL", factoryRouting.public);
if (helpDeskTriageKey) await helpDeskApp.withEnvironment("HELP_DESK_TRIAGE_KEY", helpDeskTriageKey);

// Downhill: Contoso Outdoors' browser game, with a shop whose checkout runs the store's own code (the version it was last
// deployed). Contact support opens a live Help Desk ticket: its server calls Help Desk's API at HELP_DESK_URL (in Azure,
// its name inside the environment) and shows the chat from HELP_DESK_PUBLIC_URL. Rejected launch codes page Incident
// Commander, which deploys the fix back to the shop. The game runs no agents of its own, so it's deployed without your
// GitHub token.
const helpDeskPublicUrl = (await helpDeskApp.getEndpoint("http")) as EndpointReference;
await (await addDemo(downhillDemo.app, { dockerfile: "demos/downhill/Dockerfile", allowedHostsEnv: "DOWNHILL_ALLOWED_HOSTS", githubToken: false }))
  .withEnvironment("HELP_DESK_URL", publishing ? `http://${helpDeskDemo.app.name}` : helpDeskPublicUrl)
  .withEnvironment("HELP_DESK_PUBLIC_URL", helpDeskPublicUrl)
  .withEnvironment("INCIDENT_URL", incidentApi)
  .withEnvironment("INCIDENT_ALERT_SECRET", incidentAlertSecret)
  .withEnvironment("DOWNHILL_DEPLOY_SECRET", downhillDeploySecret);

// Hack the Harness: a staff assistant, with a 3D office, that runs six agent deployment architectures side by side.
// Local only: it accepts any username and password.
if (!publishing) await runDemo(hackTheHarnessDemo.app);

// Incident Commander: an alert opens an incident; a mixed coordinator triages in its own sandbox, hands the repro and
// the fix to workers (or the fix to the factory), and waits on the platform for a person to approve the deploy. Alerts
// carry the generated bearer secret; the platform's webhook keeps the app informed while it isn't attached. Downhill's
// shop is one of its services: it loads the shop's code and logs from Downhill, and deploys approved fixes back there.
await (
  await addDemo(incidents.app, {
    dockerfile: "demos/incident-commander/Dockerfile",
    publicUrlEnv: "INCIDENT_PUBLIC_URL",
    allowedHostsEnv: "INCIDENT_ALLOWED_HOSTS",
  })
)
  .withEnvironment("INCIDENT_WEBHOOK_SECRET", incidents.webhooks["incident-commander"].secret)
  .withEnvironment("INCIDENT_ALERT_SECRET", incidentAlertSecret)
  .withEnvironment("INCIDENT_SERVICE_URLS", `downhill-shop=${downhillApi}/api/incident/service`)
  .withEnvironment("INCIDENT_DEPLOY_URL", `${downhillApi}/api/deploys`)
  .withEnvironment("INCIDENT_DEPLOY_SECRET", downhillDeploySecret)
  .withEnvironment("SOFTWARE_FACTORY_URL", factoryRouting.api)
  .withEnvironment("SOFTWARE_FACTORY_PUBLIC_URL", factoryRouting.public);

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
