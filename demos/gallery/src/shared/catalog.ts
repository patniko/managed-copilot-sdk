/** Everything the gallery shows. Shared by the server (links, health checks) and the page (copy). */

/**
 * Which gallery tab lists an app:
 * - `connected`: the Software Factory and the apps that send it work, and Downhill, whose support tickets go to Help Desk.
 * - `staff`: the staff assistant whose stages step through the architectures (Hack the Harness).
 * - `more`: everything else, the operator console included.
 */
export type AppGroup = "connected" | "staff" | "more";

export interface AppEntry {
  readonly id: string;
  readonly title: string;
  readonly tagline: string;
  readonly description: string;
  /** What to try first in a live demo. */
  readonly tryIt: string;
  readonly group: AppGroup;
  /** Aspire resource and Azure container app name; the deployed URL is https://<app>.<environment-domain>. */
  readonly app: string;
  /** Local port before MANAGED_COPILOT_PORT_OFFSET. */
  readonly port: number;
  readonly healthPath: string;
  /** Repository path of its README. */
  readonly readme: string;
  /**
   * Published with `publishApp({ public: true })` in the root AppHost: any address can open the deployed app, which
   * signs in its own users. The others open only from `Parameters:app-allowed-ips`.
   */
  readonly public?: boolean;
  /** Run by `aspire run` only, never published: no Azure link, and a deployed gallery leaves it out. */
  readonly localOnly?: boolean;
}

export interface Walkthrough {
  /** Two digits, as `pnpm walkthrough <id>` takes it. */
  readonly id: string;
  readonly folder: string;
  readonly title: string;
  readonly youSee: string;
  readonly minutes: number;
  /** Runs with `pnpm walkthrough <id>`; walkthrough 10 is a guide without a script. */
  readonly runnable: boolean;
}

export const GATEWAY_APP = "copilot";
export const GATEWAY_PORT = 7400;
export const GALLERY_PORT = 7460;

/** The operator console, served by the gateway at /console and opened with a one-time sign-in ticket. */
export const CONSOLE: AppEntry = {
  id: "console",
  title: "Operator console",
  tagline: "The platform as operators see it",
  description: "Infrastructure health, environments, every owner's sessions and sandboxes, and harness configuration. Metadata only, never conversation content.",
  tryIt: "Open Sessions while a demo runs and watch sandboxes appear.",
  group: "more",
  app: GATEWAY_APP,
  port: GATEWAY_PORT,
  healthPath: "/healthz",
  readme: "services/console/README.md",
};

export const APPS: readonly AppEntry[] = [
  {
    id: "dispatch",
    title: "Dispatch",
    tagline: "One conversation, as many sandboxes as the work needs",
    description:
      "Chat with an orchestrator agent, and pick how it works: delegate each part to a worker in its own sandbox, work directly in a sandbox with its sub-agents, or mix the two. Every decision and every command shows live.",
    tryIt: "Estimate π three ways in parallel, then try the same job with Work directly.",
    group: "more",
    app: "dispatch",
    port: 7470,
    healthPath: "/api/health",
    readme: "demos/dispatch/README.md",
  },
  {
    id: "assistant",
    title: "Assistant",
    tagline: "A long-running assistant that keeps working when you leave",
    description:
      "Mail, calendar, reminders, and recurring jobs that run on the platform while no browser is open, plus sandboxes it starts for hands-on work once you approve them.",
    tryIt: "Triage my unread email, then chart my meeting load this week.",
    group: "more",
    app: "assistant",
    port: 7490,
    healthPath: "/healthz",
    readme: "demos/assistant/README.md",
  },
  {
    id: "front-desk",
    title: "Front Desk",
    tagline: "One app for many people, each with their own private conversations",
    description:
      "Anyone signs in: with GitHub, to chat on their own Copilot plan, or with an email, so the app pays through its Azure AI Foundry. Each person gets conversations and a memory that nobody else can see.",
    tryIt: "Ask it to remember your favorite color, then sign in as someone else and ask for it.",
    group: "more",
    app: "front-desk",
    port: 7450,
    healthPath: "/api/health",
    readme: "demos/front-desk/README.md",
    public: true,
  },
  {
    id: "research-swarm",
    title: "Research Swarm",
    tagline: "One question, many researchers, one cited report",
    description:
      "A lead on the shared runtime splits your question across web researchers, each in its own sandbox, and writes a report where every claim cites a page they read.",
    tryIt: "Ask how WebAssembly garbage collection works.",
    group: "more",
    app: "research-swarm",
    port: 7425,
    healthPath: "/api/health",
    readme: "demos/research-swarm/README.md",
  },
  {
    id: "pattern-race",
    title: "Pattern Race",
    tagline: "One job raced through all six patterns at once",
    description:
      "Sends the same prompt to six real sessions, one per pattern environment, and compares where each agent thinks and acts, its time, sandboxes, and premium requests.",
    tryIt: "Race Run code, then Split the work, and compare Delegate with Mixed.",
    group: "more",
    app: "pattern-race",
    port: 7420,
    healthPath: "/api/health",
    readme: "demos/pattern-race/README.md",
  },
  {
    id: "downhill",
    title: "Downhill",
    tagline: "Ride, shop, and the launch code fails at checkout",
    description:
      "Contoso Outdoors' painterly mountain-biking game. Ride a run, then buy a new look in its shop: checkout runs the store's own code, which rejects the launch offer's code. Support opens a live Help Desk chat with the checkout attached, Data Desk charts the shop's live sales, and the failure alerts Incident Commander, which sends the fix to the factory.",
    tryIt: "Ride a run, open the Shop, press Apply code on the launch offer, then open Support and say what happened.",
    group: "connected",
    app: "downhill",
    port: 7455,
    healthPath: "/api/health",
    readme: "demos/downhill/README.md",
  },
  {
    id: "help-desk",
    title: "Help Desk",
    tagline: "25 customers, 25 private sessions, one shared runtime",
    description:
      "A support rush where every customer chats with their own agent, bound to their own orders, all on one runtime; refunds wait for you, and storefront bugs customers report go to the Software Factory.",
    tryIt: "Simulate 25 customers, then approve a refund.",
    group: "connected",
    app: "help-desk",
    port: 7440,
    healthPath: "/api/health",
    readme: "demos/help-desk/README.md",
  },
  {
    id: "data-desk",
    title: "Data Desk",
    tagline: "Chat with a spreadsheet; it moves to a sandbox for code",
    description:
      "Questions the app's own tools can answer run on the shared runtime; a chart request moves the same session into a Python sandbox, and Copilot CLI follows it. Send what you find to the Software Factory.",
    tryIt: "Pick Coffee shop sales, ask which store sold most, then chart it.",
    group: "connected",
    app: "data-desk",
    port: 7430,
    healthPath: "/api/health",
    readme: "demos/data-desk/README.md",
  },
  {
    id: "hack-the-harness",
    title: "Hack the Harness",
    tagline: "One staff assistant, six agent deployment architectures",
    description:
      "A chat app, with a 3D office of colleagues to talk to. Every architecture runs side by side, from shared and isolated through promotable, direct, and workers to mixed, and the header switches between them.",
    tryIt: "Open a stage below, attach the leads spreadsheet, and ask for a cleaned-up copy.",
    group: "staff",
    app: "hack-the-harness",
    port: 7415,
    healthPath: "/api/health",
    readme: "demos/hack-the-harness/README.md",
    localOnly: true,
  },
  {
    id: "incident-commander",
    title: "Incident Commander",
    tagline: "On call: triage, fix, and deploy when you say so",
    description:
      "An alert opens an incident: Copilot triages in its own sandbox, hands the repro to a worker and the fix to a worker or the Software Factory, and waits for your OK to deploy, even with the tab closed.",
    tryIt: "Simulate an incident, close the tab, then reopen it and deploy.",
    group: "connected",
    app: "incident-commander",
    port: 7445,
    healthPath: "/api/health",
    readme: "demos/incident-commander/README.md",
  },
  {
    id: "software-factory",
    title: "Software Factory",
    tagline: "A work order in, a tested and reviewed release out",
    description:
      "A coordinator plans the work, builds tasks in parallel builder sandboxes, reuses them for review fixes, and assembles the release. The factory still checks every gate, and shows which work orders Help Desk, Incident Commander, and Data Desk sent.",
    tryIt: "Start the CSV ⇄ JSON toolkit work order and watch the floor.",
    group: "connected",
    app: "software-factory",
    port: 7480,
    healthPath: "/api/health",
    readme: "demos/software-factory/README.md",
  },
  {
    id: "repo-doctor",
    title: "Repo Doctor",
    tagline: "A failing test in, a verified patch out",
    description:
      "Paste a public GitHub repository: one sandbox clones it, Copilot fixes the failing tests, and Repo Doctor verifies the patch, while a strip shows which hosts the sandbox reached and which were blocked.",
    tryIt: "Run the sample and watch two failing tests turn green.",
    group: "more",
    app: "repo-doctor",
    port: 7435,
    healthPath: "/api/health",
    readme: "demos/repo-doctor/README.md",
  },
  CONSOLE,
];

export const WALKTHROUGHS: readonly Walkthrough[] = [
  { id: "01", folder: "01-first-agent", title: "Your first agent", youSee: "Connect, chat, then open the same conversation in Copilot CLI", minutes: 1, runnable: true },
  { id: "02", folder: "02-your-own-tools", title: "Give it your own tools", youSee: "Tools that run in your process, and an approval prompt", minutes: 1, runnable: true },
  { id: "03", folder: "03-sandbox", title: "A coding agent in a sandbox", youSee: "A file in, a report artifact out, one sandbox per session", minutes: 1, runnable: true },
  { id: "04", folder: "04-promotion", title: "Start cheap, move when needed", youSee: "A chat that moves itself into a sandbox to run Python", minutes: 1, runnable: true },
  { id: "05", folder: "05-choose-environments", title: "Choose an environment from code", youSee: "A name, a name plus additions, an inline type, and a refusal", minutes: 1, runnable: true },
  { id: "06", folder: "06-harness", title: "Bring your own harness", youSee: "One harness in three environments, then in Copilot CLI", minutes: 1, runnable: true },
  { id: "07", folder: "07-network-and-secrets", title: "Network rules and secrets", youSee: "A placeholder in the sandbox, a real value at the edge, a blocked host", minutes: 1, runnable: true },
  { id: "08", folder: "08-offline", title: "Keep working while your app is offline", youSee: "A tool call that waits for you, answered by polling", minutes: 1, runnable: true },
  { id: "09", folder: "09-schedules", title: "Run on a schedule", youSee: "A weekday schedule, run now, with the agent's reply", minutes: 1, runnable: true },
  { id: "10", folder: "10-azure", title: "Your agent in Azure, from your laptop", youSee: "The same samples against Azure, and a sandbox in Copilot CLI", minutes: 5, runnable: false },
  { id: "11", folder: "11-orchestrator", title: "Split a job across workers", youSee: "A coordinator starts two workers in their own sandboxes and puts their reports together", minutes: 1, runnable: true },
  {
    id: "12",
    folder: "12-direct-execution",
    title: "Direct execution",
    youSee: "The same job delegated to workers and done directly by a coordinator and its sub-agents, then a coordinator that can do both",
    minutes: 2,
    runnable: true,
  },
  { id: "13", folder: "13-your-own-harness", title: "Your own harness", youSee: "Commands run directly in a sandbox, and a stock client whose sub-agents' hands are there", minutes: 1, runnable: true },
];

/** An app's screenshot file, served at /shots/<file>. */
export const shotFile = (id: string): string => `${id}.png`;

/** The three building blocks every pattern is made of. */
export type BuildingBlock = "container" | "multi-tenant" | "orchestration";

export interface BuildingBlockEntry {
  readonly title: string;
  readonly description: string;
}

export const BUILDING_BLOCKS: Readonly<Record<BuildingBlock, BuildingBlockEntry>> = {
  container: { title: "Single container", description: "A sandbox per session: a workspace, a shell, files, packages, and its own network rules." },
  "multi-tenant": { title: "Virtualized multi-tenant", description: "The shared runtime: one process hosting many sessions, each with its own state and identity." },
  orchestration: { title: "Container orchestration", description: "Sandboxes created, reused, and deleted on demand while a session runs." },
};

export interface PatternDemo {
  /** An entry of APPS. */
  readonly app: string;
  /** Where in that app the pattern shows. */
  readonly where: string;
}

export interface Pattern {
  readonly id: string;
  readonly title: string;
  /** Where the agent's brain, its model loop, runs. */
  readonly brain: string;
  /** Where its hands, the tools that act, run. */
  readonly hands: string;
  readonly blocks: readonly BuildingBlock[];
  /** The root AppHost's environment for this pattern: the only name that changes in code. */
  readonly environment: string;
  /** That environment's settings that make it this pattern, as `key: value` pairs from apphost.mts. */
  readonly settings: readonly string[];
  /** The walkthrough (an entry of WALKTHROUGHS) that runs it. */
  readonly walkthrough: string;
  readonly demos: readonly PatternDemo[];
}

/** The six patterns, in the order the docs present them (docs/concepts/patterns.md). */
export const PATTERNS: readonly Pattern[] = [
  {
    id: "isolated",
    title: "Isolated",
    brain: "In its own sandbox",
    hands: "In the same sandbox",
    blocks: ["container"],
    environment: "coder",
    settings: ['type: "isolated"'],
    walkthrough: "03",
    demos: [
      { app: "repo-doctor", where: "every run" },
      { app: "software-factory", where: "App-driven mode" },
      { app: "hack-the-harness", where: "its Isolated stage" },
    ],
  },
  {
    id: "shared",
    title: "Shared",
    brain: "On the shared runtime, beside other sessions",
    hands: "Your tools in your app; web fetches and remote MCP servers through the gateway",
    blocks: ["multi-tenant"],
    environment: "chat",
    settings: ['type: "shared"'],
    walkthrough: "02",
    demos: [
      { app: "software-factory", where: "its planner and reviewer" },
      { app: "help-desk", where: "25 customers, one runtime" },
      { app: "front-desk", where: "every person's conversations" },
      { app: "hack-the-harness", where: "its Shared stage" },
    ],
  },
  {
    id: "promotable",
    title: "Promotable",
    brain: "On the shared runtime, then once in its own sandbox",
    hands: "Your tools in your app throughout, plus a shell and files once it moves",
    blocks: ["multi-tenant", "container"],
    environment: "helper",
    settings: ['type: "promotable"', 'promoteTo: "coder"'],
    walkthrough: "04",
    demos: [
      { app: "data-desk", where: "every analysis" },
      { app: "hack-the-harness", where: "its Promotable stage" },
    ],
  },
  {
    id: "direct",
    title: "Direct",
    brain: "On the shared runtime, with the stock sub-agents it starts",
    hands: "In a sandbox with no agent in it",
    blocks: ["multi-tenant", "orchestration", "container"],
    environment: "operator",
    settings: ['type: "orchestrator"', 'execution: "direct"'],
    walkthrough: "12",
    demos: [
      { app: "dispatch", where: "Work directly" },
      { app: "hack-the-harness", where: "its Direct stage" },
    ],
  },
  {
    id: "delegate",
    title: "Delegate",
    brain: "On the shared runtime, as a coordinator",
    hands: "Through new agent sessions, each in its own sandbox",
    blocks: ["multi-tenant", "orchestration", "container"],
    environment: "team",
    settings: ['type: "orchestrator"'],
    walkthrough: "11",
    demos: [
      { app: "dispatch", where: "Delegate to workers" },
      { app: "software-factory", where: "Agent-led mode" },
      { app: "assistant", where: "its sandboxes" },
      { app: "research-swarm", where: "its researchers" },
      { app: "hack-the-harness", where: "its Workers stage" },
    ],
  },
  {
    id: "mixed",
    title: "Mixed",
    brain: "On the shared runtime, as a coordinator",
    hands: "In its own sandbox, and through new agent sessions; the model picks for each part",
    blocks: ["multi-tenant", "orchestration", "container"],
    environment: "lead",
    settings: ['type: "orchestrator"', 'execution: "mixed"'],
    walkthrough: "12",
    demos: [
      { app: "dispatch", where: "Mixed" },
      { app: "incident-commander", where: "every incident" },
      { app: "hack-the-harness", where: "its Mixed stage" },
    ],
  },
];

export type Target = "local" | "cloud";

/** One stage of Hack the Harness: the same staff assistant on a different architecture, side by side. */
export interface HarnessStage {
  /** Its `?stage=` in the app (demos/hack-the-harness/src/app/server/stages.ts). */
  readonly id: string;
  readonly title: string;
  /** What changes at this stage. */
  readonly summary: string;
  /** The pattern (an entry of PATTERNS) it shows. */
  readonly pattern: string;
}

/** The Hack the Harness app, whose stages the gallery links to one by one. */
export const HARNESS_APP_ID = "hack-the-harness";

/** Hack the Harness's stages, in talk order: from a container per chat to mixed direct and delegated work. */
export const HARNESS_STAGES: readonly HarnessStage[] = [
  { id: "shared", title: "Shared", summary: "Every chat on one shared runtime, no sandboxes and no shell.", pattern: "shared" },
  { id: "isolated", title: "Isolated", summary: "Every chat in its own sandbox, with its runtime, history, and files.", pattern: "isolated" },
  { id: "promotable", title: "Promotable", summary: "Chats start shared and move into a sandbox when they need to run code.", pattern: "promotable" },
  { id: "direct", title: "Direct", summary: "The agent stays shared; only its shell and file commands run in a sandbox.", pattern: "direct" },
  { id: "workers", title: "Workers", summary: "The agent stays shared and hands each job to a worker in its own sandbox.", pattern: "delegate" },
  { id: "mixed", title: "Mixed", summary: "The agent works directly in its own sandbox, and hands bigger jobs to workers.", pattern: "mixed" },
];

/** A stage's address in the app at `base`. */
export const harnessStageUrl = (base: string, stage: string): string => `${base.replace(/\/+$/, "")}/?stage=${encodeURIComponent(stage)}`;

/**
 * - `online`: answered its health check.
 * - `restricted`: reachable, but its ingress refused this machine (a deployment's app IP allowlist).
 * - `offline`: nothing answered.
 */
export type Health = "online" | "restricted" | "offline";

export interface Link {
  readonly url: string;
  readonly health: Health;
}

export interface TargetState {
  /** The gateway URL, when this target is known. */
  readonly gatewayUrl?: string;
  readonly gateway?: Health;
  readonly links: Readonly<Record<string, Link>>;
  /** Why the target is unknown, or how it was found. */
  readonly note?: string;
  /** True while the gallery is still looking for it. */
  readonly searching?: boolean;
}

export interface GalleryState {
  /** Absent on a hosted gallery, whose visitors' machines it can't see. */
  readonly local?: TargetState;
  readonly cloud: TargetState;
  /** Served from the deployment itself (`aspire deploy`): Azure only, and the console opens from each operator's terminal. */
  readonly hosted?: boolean;
  /** Base URL for repository files (README links). */
  readonly repoUrl: string;
  readonly checkedAt: string;
}
