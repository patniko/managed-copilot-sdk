/**
 * The canonical QA checks: everything a change or a release is held to, by tier. `pnpm qa` runs them (main.ts), and
 * docs/qa.md maps every user-facing flow to them. test/catalog.test.ts keeps the catalog, the doc, and the repository's
 * snippets, walkthroughs, demo scripts, and opt-in tests in step.
 */

export const TIERS = ["ci", "e2e", "local", "azure"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_INFO: Record<Tier, { readonly summary: string; readonly needs: string }> = {
  ci: { summary: "What CI runs on every pull request: build, type checks, and every package's tests", needs: "`pnpm install`" },
  e2e: { summary: "Opt-in end-to-end tests; each starts its own gateway, with real models and Docker sandboxes", needs: "Docker, a GitHub account with Copilot" },
  local: { summary: "Spec snippets, walkthroughs, and demo scripts against the running local platform", needs: "`aspire run`, a GitHub account with Copilot" },
  azure: { summary: "Spec snippets, demo scripts, and qualification against a deployment in Azure", needs: "`--url <gateway>`, a GitHub account with Copilot" },
};

/** Environment variables CI does not have: the `ci` tier runs without them, so it runs exactly what CI runs. */
export const CI_UNSET = ["MANAGED_COPILOT_GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "MANAGED_COPILOT_E2E"] as const;

/** Demo apps with a live check: their package and their local port (before `MANAGED_COPILOT_PORT_OFFSET`). */
export const DEMOS = {
  "pattern-race": { pkg: "@managed-copilot/demo-pattern-race", port: 7420 },
  "research-swarm": { pkg: "@managed-copilot/demo-research-swarm", port: 7425 },
  "data-desk": { pkg: "@managed-copilot/demo-data-desk", port: 7430 },
  "repo-doctor": { pkg: "@managed-copilot/demo-repo-doctor", port: 7435 },
  "help-desk": { pkg: "@managed-copilot/demo-help-desk", port: 7440 },
  "incident-commander": { pkg: "@managed-copilot/demo-incident-commander", port: 7445 },
  "front-desk": { pkg: "@managed-copilot/demo-front-desk", port: 7450 },
  "software-factory": { pkg: "@managed-copilot/demo-software-factory", port: 7480 },
  assistant: { pkg: "@managed-copilot/demo-assistant", port: 7490 },
} as const;
export type DemoName = keyof typeof DEMOS;

/**
 * What a check needs before it runs; a check whose needs aren't met is skipped with the reason.
 * - `built`: `pnpm build` has run.
 * - `docker`: a reachable Docker engine.
 * - `github`: a GitHub sign-in (`gh auth login`, or a token in the environment).
 * - `platform`: the run's gateway answers `/v1/info` for this account.
 * - `background`: background sign-in is on (`npx managed-copilot login`).
 * - `edge`: Microsoft Edge, for checks that drive a browser.
 * - `apps-domain`, `isolated-environment`: the `--apps-domain` and `--isolated-env` options.
 * - `environment:<name>`: the gateway offers that environment.
 * - `app:<demo>`: the demo app answers at its URL.
 */
export type Requirement =
  | "built"
  | "docker"
  | "github"
  | "platform"
  | "background"
  | "edge"
  | "apps-domain"
  | "isolated-environment"
  | `environment:${string}`
  | `app:${DemoName}`;

export interface RunContext {
  readonly tier: Tier;
  /** The gateway the check runs against; empty for tiers whose checks start their own. */
  readonly url: string;
  /** Azure: the environment domain the demo apps answer under (`https://<demo>.<domain>`). */
  readonly appsDomain: string | undefined;
  /** Azure: the isolated environment for the idle-replacement qualification. */
  readonly isolatedEnvironment: string | undefined;
  /** Local: `MANAGED_COPILOT_PORT_OFFSET`. */
  readonly portOffset: number;
  /** A file this check may write a JSON report to. */
  readonly reportFile: string;
}

export interface Command {
  /** pnpm arguments, run from the repository root. Never a credential. */
  readonly pnpm: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Passes the caller's GitHub token as `GH_TOKEN`, for tests that read it only from the environment. */
  readonly githubToken?: boolean;
  /** Variables removed from the environment. */
  readonly unset?: readonly string[];
}

export type Outcome = "pass" | "fail" | "skipped";

interface BaseCheck {
  /** `<tier>.<name>`: stable; used by `--only` and `--skip`, and in docs/qa.md. */
  readonly id: string;
  readonly tier: Tier;
  readonly title: string;
}

export interface AutomatedCheck extends BaseCheck {
  readonly kind: "automated";
  readonly requires: readonly Requirement[];
  readonly timeoutMinutes: number;
  /** Model cost of one run, when it calls models. */
  readonly cost?: string;
  readonly command: (ctx: RunContext) => Command;
  /** Reads a finer outcome than the exit code from the check's report file, when it writes one. */
  readonly interpret?: (report: string) => { readonly outcome: Outcome; readonly detail?: string } | undefined;
}

export interface ManualCheck extends BaseCheck {
  readonly kind: "manual";
  /** Where the steps are, and what to run. */
  readonly steps: string;
}

export type Check = AutomatedCheck | ManualCheck;

/** A demo's address: its fixed local port, or `https://<demo>.<domain>` in Azure. */
export function appUrl(ctx: Pick<RunContext, "tier" | "appsDomain" | "portOffset">, demo: DemoName): string {
  if (ctx.tier === "azure") return `https://${demo}.${ctx.appsDomain ?? "<apps-domain>"}`;
  return `http://localhost:${DEMOS[demo].port + ctx.portOffset}`;
}

const gatewayEnv = (ctx: RunContext): Record<string, string> => (ctx.url ? { MANAGED_COPILOT_URL: ctx.url } : {});

// ci ---------------------------------------------------------------------------------------------------------------

function ciCheck(id: string, title: string, args: readonly string[], timeoutMinutes: number): AutomatedCheck {
  return { id, tier: "ci", kind: "automated", title, requires: [], timeoutMinutes, command: () => ({ pnpm: args, unset: CI_UNSET }) };
}

// The same commands as .github/workflows/ci.yml.
const ci: AutomatedCheck[] = [
  ciCheck("ci.build", "Build every package", ["build"], 20),
  ciCheck("ci.typecheck", "Type-check every package", ["-r", "run", "typecheck"], 20),
  ciCheck("ci.test", "Every package's tests, with fakes (opt-in end-to-end tests stay skipped)", ["test"], 30),
];

// e2e --------------------------------------------------------------------------------------------------------------

function vitestE2e(id: string, title: string, pkg: string, file: string, requires: readonly Requirement[], cost?: string): AutomatedCheck {
  return {
    id,
    tier: "e2e",
    kind: "automated",
    title,
    requires: ["built", ...requires],
    timeoutMinutes: 45,
    ...(cost ? { cost } : {}),
    command: () => ({ pnpm: ["--filter", pkg, "exec", "vitest", "run", file], env: { MANAGED_COPILOT_E2E: "1" }, githubToken: true }),
  };
}

function liveScript(id: string, title: string, file: string, cost: string): AutomatedCheck {
  return { id, tier: "e2e", kind: "automated", title, requires: ["built", "github"], timeoutMinutes: 40, cost, command: () => ({ pnpm: ["exec", "tsx", file] }) };
}

const e2e: AutomatedCheck[] = [
  vitestE2e("e2e.model", "G1: the stock SDK and runtime with a real model: shared sessions, resume, ownership", "@managed-copilot/gateway", "test/model.e2e.test.ts", ["github"], "a few premium requests"),
  vitestE2e("e2e.isolated", "G1: isolated sessions: a custom agent, your tools, two sandboxes, resume, delete", "@managed-copilot/gateway", "test/isolated.e2e.test.ts", ["github", "docker"], "a few premium requests"),
  vitestE2e("e2e.promotion", "G5: promotion from shared into a sandbox, with an artifact and session.promoted", "@managed-copilot/gateway", "test/promotion.e2e.test.ts", ["github", "docker"], "a few premium requests"),
  vitestE2e("e2e.rollover", "A gateway replaced mid-turn: the turn ends visibly and the session continues", "@managed-copilot/gateway", "test/rollover.e2e.test.ts", ["github", "docker"], "a few premium requests"),
  vitestE2e("e2e.hands", "Hands tools (view, glob, grep, bash) in the real sandbox image", "@managed-copilot/gateway", "test/hands.docker.test.ts", ["docker"]),
  vitestE2e("e2e.sandbox", "Isolated placement: setup, persistence, network denial, idle stop and resume", "@managed-copilot/sandbox", "test/e2e.test.ts", ["github", "docker"], "a few premium requests"),
  vitestE2e("e2e.sandbox-exec", "managed.exec and managed.sandboxes in real sandboxes (no model)", "@managed-copilot/sandbox", "test/exec.e2e.test.ts", ["github", "docker"]),
  {
    id: "e2e.egress",
    tier: "e2e",
    kind: "automated",
    title: "The egress proxy with real containers: allowlists, vault substitution, redaction, CA trust",
    requires: ["built", "docker"],
    timeoutMinutes: 60,
    command: () => ({ pnpm: ["--filter", "@managed-copilot/egress", "test:docker"] }),
  },
  liveScript("e2e.durable", "G2: durable actions, webhooks, polling, schedules, and a detached agent", "libraries/sdk/test/acceptance/durable.live.ts", "about ten premium requests"),
  liveScript("e2e.platform-tools", "Platform tools: sub-agent attribution and cancellation", "services/gateway/test/acceptance/platform-tools.live.ts", "a few premium requests"),
];

// Spec snippets (local and azure) ----------------------------------------------------------------------------------

const SNIPPETS: ReadonlyArray<readonly [string, string]> = [
  ["01", "The idea in one snippet"],
  ["02", "Shared: a chat agent with your own tools (§3)"],
  ["03", "Isolated: a coding agent in its own sandbox (§4)"],
  ["04", "Set up the sandbox (§5)"],
  ["05", "Get results out (§6)"],
  ["06", "Control network access (§7)"],
  ["07", "Keep secrets out of the sandbox (§8)"],
  ["08", "Promotable: start cheap, move when needed (§9)"],
  ["09", "Come back later (§11)"],
  ["10", "Keep working while your app is offline: webhook (§12)"],
  ["11", "Keep working while your app is offline: polling (§12)"],
  ["12", "Run on a schedule (§13)"],
  ["13", "Open a session in Copilot CLI: the attach socket (§14)"],
  ["14", "Orchestrator: a coordinator with workers (§17)"],
  ["15", "Execution styles: a direct coordinator's hands (§17)"],
];
/** Snippets 10 and 12 need the local webhook receiver, which a deployed AppHost doesn't publish. */
const LOCAL_ONLY_SNIPPETS = new Set(["10", "12"]);

interface SnippetReport {
  readonly results: ReadonlyArray<{ readonly outcome: "pass" | "fail" | "unavailable" | "skipped"; readonly detail?: string; readonly checks: number }>;
}

function snippet(tier: "local" | "azure", number: string, title: string): AutomatedCheck {
  return {
    id: `${tier}.snippet-${number}`,
    tier,
    kind: "automated",
    title: `Snippet ${number}: ${title}`,
    requires: ["built", "platform"],
    // Above the longest snippet's own limit (30 minutes), so a slow snippet's cleanup runs before QA stops it.
    timeoutMinutes: 40,
    cost: "a few premium requests",
    command: (ctx) => ({
      pnpm: ["--silent", "--filter", "@managed-copilot/snippets", "acceptance", number, "--strict", "--report", ctx.reportFile],
      env: { ...gatewayEnv(ctx), ...(tier === "local" ? { SNIPPETS_WEBHOOK_PORT: String(7485 + ctx.portOffset) } : {}) },
    }),
    interpret: (report) => {
      const result = (JSON.parse(report) as SnippetReport).results[0];
      if (!result) return undefined;
      if (result.outcome === "pass") return { outcome: "pass", detail: `${result.checks} checks` };
      if (result.outcome === "skipped") return { outcome: "skipped", ...(result.detail ? { detail: result.detail } : {}) };
      return { outcome: "fail", detail: `${result.outcome === "unavailable" ? "not available yet: " : ""}${result.detail ?? ""}` };
    },
  };
}

// Walkthroughs (local) ---------------------------------------------------------------------------------------------

const WALKTHROUGHS: ReadonlyArray<readonly [string, string, readonly Requirement[]]> = [
  ["01", "Your first agent (leaves its session running, to open in Copilot CLI)", []],
  ["02", "Give it your own tools", []],
  ["03", "A coding agent in a sandbox", []],
  ["04", "Start cheap, move when needed", []],
  ["05", "Choose an environment from code", []],
  ["06", "Bring your own harness", []],
  ["07", "Network rules and secrets", []],
  ["08", "Keep working while your app is offline", ["background"]],
  ["09", "Run on a schedule", ["background"]],
  ["11", "Split a job across workers", []],
  ["12", "Direct execution", []],
  ["13", "Your own harness", []],
];

function walkthrough(number: string, title: string, extra: readonly Requirement[]): AutomatedCheck {
  return {
    id: `local.walkthrough-${number}`,
    tier: "local",
    kind: "automated",
    title: `Walkthrough ${number}: ${title}`,
    requires: ["built", "platform", ...extra],
    // Above the walkthroughs' longest single turn (20 minutes).
    timeoutMinutes: 30,
    cost: "a few premium requests",
    command: (ctx) => ({ pnpm: ["--silent", "--filter", "@managed-copilot/walkthroughs", "walkthrough", number], env: gatewayEnv(ctx) }),
  };
}

// Demo scripts (local and azure) -----------------------------------------------------------------------------------

interface DemoScript {
  readonly name: string;
  readonly demo: DemoName;
  readonly title: string;
  readonly script: string;
  readonly cost: string;
  readonly timeoutMinutes: number;
  readonly requires?: readonly Requirement[];
  /** Arguments after the script; the app's URL goes in `--url` unless `urlEnv` names the variable for it. */
  readonly args?: readonly string[];
  readonly urlEnv?: string;
  /** Talks to the platform rather than to the app. */
  readonly platformOnly?: boolean;
  readonly localOnly?: boolean;
}

const DEMO_SCRIPTS: readonly DemoScript[] = [
  { name: "pattern-race", demo: "pattern-race", title: "Pattern Race: one job in all six patterns", script: "happy-path", cost: "one premium request per lane", timeoutMinutes: 30 },
  { name: "help-desk", demo: "help-desk", title: "Help Desk: five customers on one shared runtime, with approvals", script: "happy-path", cost: "a couple of premium requests", timeoutMinutes: 25 },
  { name: "repo-doctor", demo: "repo-doctor", title: "Repo Doctor: fix a failing repository in a sandbox with network rules", script: "happy-path", cost: "two turns", timeoutMinutes: 30 },
  { name: "data-desk", demo: "data-desk", title: "Data Desk: answers on the shared runtime, then a move into a Python sandbox", script: "happy-path", cost: "about two premium requests", timeoutMinutes: 25 },
  { name: "research-swarm", demo: "research-swarm", title: "Research Swarm: parallel researchers and a cited report", script: "happy-path", cost: "a handful of premium requests", timeoutMinutes: 30 },
  { name: "incident-commander", demo: "incident-commander", title: "Incident Commander: a mixed coordinator and an approval that waits", script: "happy-path", cost: "a handful of premium requests", timeoutMinutes: 35 },
  {
    name: "incident-commander-factory",
    demo: "incident-commander",
    title: "Incident Commander and Software Factory: an incident's fix built by the factory, verified, and deployed",
    script: "happy-path",
    args: ["--factory"],
    requires: ["app:software-factory"],
    cost: "a dozen or so premium requests",
    timeoutMinutes: 50,
  },
  { name: "software-factory", demo: "software-factory", title: "Software Factory: plan, parallel builders, review, release", script: "happy-path", urlEnv: "FACTORY_URL", cost: "dozens of premium requests", timeoutMinutes: 60 },
  { name: "software-factory-office", demo: "software-factory", title: "Software Factory: its planner and reviewer agents in shared environments", script: "smoke:office", platformOnly: true, cost: "a few premium requests", timeoutMinutes: 20 },
  { name: "assistant", demo: "assistant", title: "Assistant: inbox triage and an approval in the real UI (Microsoft Edge)", script: "happy-path", requires: ["edge"], cost: "a few premium requests", timeoutMinutes: 25 },
  {
    name: "assistant-away",
    demo: "assistant",
    title: "Assistant: a reminder, a check-in while the tab is closed, and Python and web sandboxes",
    script: "happy-path",
    args: ["--skip-basics", "--reminder", "--offline", "--sandbox"],
    requires: ["edge", "background"],
    cost: "several premium requests",
    timeoutMinutes: 45,
  },
  {
    name: "front-desk",
    demo: "front-desk",
    title: "Front Desk: a GitHub user (this computer's sign-in) with private conversations and memory",
    script: "e2e",
    args: ["--email-users", "0", "--github", "local"],
    localOnly: true,
    cost: "a few premium requests",
    timeoutMinutes: 20,
  },
  {
    name: "front-desk-foundry",
    demo: "front-desk",
    title: "Front Desk: two email users on Azure AI Foundry, isolated from each other",
    script: "e2e",
    args: ["--email-users", "2", "--github", "skip"],
    requires: ["environment:front-desk-foundry"],
    cost: "a few Foundry calls",
    timeoutMinutes: 20,
  },
];

function demoCheck(tier: "local" | "azure", demo: DemoScript): AutomatedCheck {
  const reach: Requirement[] = demo.platformOnly ? [] : [...(tier === "azure" ? (["apps-domain"] as const) : []), `app:${demo.demo}`];
  return {
    id: `${tier}.demo-${demo.name}`,
    tier,
    kind: "automated",
    title: demo.title,
    requires: ["built", "platform", ...reach, ...(demo.requires ?? [])],
    timeoutMinutes: demo.timeoutMinutes,
    cost: demo.cost,
    command: (ctx) => {
      const url = appUrl(ctx, demo.demo);
      const args = [...(demo.platformOnly || demo.urlEnv ? [] : ["--url", url]), ...(demo.args ?? [])];
      return { pnpm: ["--silent", "--filter", DEMOS[demo.demo].pkg, demo.script, ...args], env: { ...gatewayEnv(ctx), ...(demo.urlEnv ? { [demo.urlEnv]: url } : {}) } };
    },
  };
}

// Manual checks ----------------------------------------------------------------------------------------------------

const manual = (id: string, tier: Tier, title: string, steps: string): ManualCheck => ({ id, tier, kind: "manual", title, steps });

const localManual: ManualCheck[] = [
  manual("local.cli-attach", "local", "The real Copilot CLI on live sessions: new, attach, a turn, an approval, Esc, a promotion", "docs/qa.md, \"Copilot CLI in a terminal\""),
  manual("local.dispatch", "local", "Dispatch: direct, delegate, and mixed work in one chat, then a follow-up from Copilot CLI", "docs/walkthrough.md 1.8, at http://localhost:7470"),
  manual("local.console", "local", "The operator console and `npx managed-copilot operator`: health, sessions, live feed", "docs/walkthrough.md 1.14; `npx managed-copilot console`, `npx managed-copilot operator overview`"),
  manual("local.gallery", "local", "The demo gallery: every card opens its demo or walkthrough", "docs/walkthrough.md 1.3; `pnpm gallery`"),
  manual(
    "local.factory-routing",
    "local",
    "Help Desk and Data Desk send work to Software Factory, and its floor shows where each work order came from",
    "docs/qa.md, \"Work routed to the software factory\"",
  ),
  manual(
    "local.help-desk-triage",
    "local",
    "Help Desk classifies each ticket with Microsoft-Decision-1 through an OpenAI-compatible endpoint, and groups the wall",
    "docs/qa.md, \"Help Desk's ticket classification\"",
  ),
];

const azureManual: ManualCheck[] = [
  manual("azure.deploy", "azure", "Deploy the root AppHost with `npx managed-copilot deploy`", "docs/walkthrough.md 2"),
  manual("azure.revision", "azure", "A new gateway revision keeps shared and isolated sessions", "`node deployments/azure/qualify/revision.live.mjs prepare <gateway-url> <record.json>` before a deploy, `verify <record.json>` after"),
  manual("azure.public-apps", "azure", "Public apps beside allowlisted apps", "deployments/azure/qualify/public-apps/README.md: its own deployment and `check.mjs`"),
  manual("azure.cli-attach", "azure", "The real Copilot CLI on an Azure sandbox", "docs/walkthrough.md 3.3: `npx managed-copilot new coder` with MANAGED_COPILOT_URL set"),
  manual("azure.demos-ui", "azure", "The demos and the console in Azure, from the gallery", "docs/walkthrough.md 3.2 and 3.3"),
];

const azureIsolated: AutomatedCheck = {
  id: "azure.isolated",
  tier: "azure",
  kind: "automated",
  title: "G3: an idle isolated session's compute is stopped and replaced, keeping its disks",
  requires: ["built", "platform", "isolated-environment"],
  timeoutMinutes: 30,
  cost: "two premium requests",
  command: (ctx) => ({ pnpm: ["exec", "tsx", "deployments/azure/qualify/isolated.live.ts", ctx.url, ctx.isolatedEnvironment ?? ""] }),
};

export const CHECKS: readonly Check[] = [
  ...ci,
  ...e2e,
  ...SNIPPETS.map(([number, title]) => snippet("local", number, title)),
  ...WALKTHROUGHS.map(([number, title, extra]) => walkthrough(number, title, extra)),
  ...DEMO_SCRIPTS.map((demo) => demoCheck("local", demo)),
  ...localManual,
  ...SNIPPETS.filter(([number]) => !LOCAL_ONLY_SNIPPETS.has(number)).map(([number, title]) => snippet("azure", number, title)),
  ...DEMO_SCRIPTS.filter((demo) => !demo.localOnly).map((demo) => demoCheck("azure", demo)),
  azureIsolated,
  ...azureManual,
];
