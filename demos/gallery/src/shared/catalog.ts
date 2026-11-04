/** Everything the gallery shows. Shared by the server (links, health checks) and the page (copy). */

export interface AppEntry {
  readonly id: string;
  readonly title: string;
  readonly tagline: string;
  readonly description: string;
  /** What to try first in a live demo. */
  readonly tryIt: string;
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
    app: "dispatch",
    port: 7470,
    healthPath: "/api/health",
    readme: "demos/dispatch/README.md",
  },
  {
    id: "software-factory",
    title: "Software Factory",
    tagline: "A work order in, a tested and reviewed release out",
    description:
      "A coordinator plans the work, builds tasks in parallel builder sandboxes, reuses them for review fixes, and assembles the release. The factory still checks every gate.",
    tryIt: "Start the CSV ⇄ JSON toolkit work order and watch the floor.",
    app: "software-factory",
    port: 7480,
    healthPath: "/api/health",
    readme: "demos/software-factory/README.md",
  },
  {
    id: "assistant",
    title: "Assistant",
    tagline: "A long-running assistant that keeps working when you leave",
    description:
      "Mail, calendar, reminders, and recurring jobs that run on the platform while no browser is open, plus sandboxes it starts for hands-on work once you approve them.",
    tryIt: "Triage my unread email, then chart my meeting load this week.",
    app: "assistant",
    port: 7490,
    healthPath: "/healthz",
    readme: "demos/assistant/README.md",
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

/** Screenshot file for an app or walkthrough, served at /shots/<file>. */
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
    demos: [{ app: "software-factory", where: "Classic mode" }],
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
    demos: [{ app: "software-factory", where: "its planner and reviewer" }],
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
    demos: [],
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
    demos: [{ app: "dispatch", where: "Work directly" }],
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
    demos: [{ app: "dispatch", where: "Mixed" }],
  },
];

export type Target = "local" | "cloud";

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
