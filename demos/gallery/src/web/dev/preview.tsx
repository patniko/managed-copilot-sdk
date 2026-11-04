// Sample states for UI work only: run `pnpm --filter @managed-copilot/demo-gallery dev` and open
// /?preview=<live|offline|looking|hosted|error|loading>, adding &more for the demos other branches add. main.tsx loads
// this behind import.meta.env.DEV, so production builds leave it out.
import { useState } from "react";
import { APPS, CONSOLE, PATTERNS, type AppEntry, type GalleryState, type Health, type Pattern, type PatternDemo, type TargetState } from "../../shared/catalog.js";
import { Gallery } from "../App.js";

/** Stand-ins for demos that are on their way, so the grid can be checked at its full size. Sample copy only. */
const SAMPLE_APPS: readonly AppEntry[] = [
  sample("pattern-race", "Pattern Race", "One job through all six patterns, side by side", "Start the race and watch where each brain and its hands run."),
  sample("research-swarm", "Research Swarm", "A question in, a cited brief out", "Ask how three databases compare for time series data."),
  sample("data-desk", "Data Desk", "Ask your data a question, get a chart back", "Upload a CSV and ask for the month with the most returns."),
  sample("repo-doctor", "Repo Doctor", "A repository in, a health report and fixes out", "Check a small repository and open its suggested fix."),
  sample("help-desk", "Help Desk", "Hundreds of support chats on one runtime", "Start fifty customer chats at once and watch the queue."),
  sample("incident-commander", "Incident Commander", "An alert in, a coordinated response out", "Fire the sample outage and approve the rollback."),
  sample("front-desk", "Front Desk", "One app for many people, each with private conversations", "Sign in as two people and compare what each one sees."),
];

const SAMPLE_DEMOS: Readonly<Record<string, readonly PatternDemo[]>> = {
  isolated: [{ app: "repo-doctor", where: "each checkup" }],
  shared: [
    { app: "help-desk", where: "every customer chat" },
    { app: "front-desk", where: "every person's conversations" },
  ],
  promotable: [{ app: "data-desk", where: "questions that need Python" }],
  direct: [{ app: "incident-commander", where: "its runbooks" }],
  delegate: [{ app: "research-swarm", where: "one researcher per source" }],
  mixed: [{ app: "incident-commander", where: "the response" }],
};

function sample(id: string, title: string, tagline: string, tryIt: string): AppEntry {
  return { id, title, tagline, description: `${tagline}. A sample entry for the gallery's preview.`, tryIt, app: id, port: 7400, healthPath: "/api/health", readme: `demos/${id}/README.md` };
}

const withSamples = (patterns: readonly Pattern[]): readonly Pattern[] =>
  patterns.map((pattern) => ({ ...pattern, demos: [...pattern.demos, ...(SAMPLE_DEMOS[pattern.id] ?? []), { app: "pattern-race", where: "its lane" }] }));

function target(apps: readonly AppEntry[], url: (app: AppEntry) => string | undefined, health: (app: AppEntry) => Health, gatewayUrl: string, note: string): TargetState {
  const links = Object.fromEntries(apps.flatMap((app) => (url(app) ? [[app.id, { url: url(app)!, health: health(app) }]] : [])));
  return { gatewayUrl, gateway: "online", links, note };
}

const REPO = "https://github.com/patniko/managed-copilot-sdk/blob/main/";
const AZURE = "https://copilot.bravedesert-123.westus2.azurecontainerapps.io";
const azureUrl = (app: AppEntry) => (app === CONSOLE ? "/open/console?target=cloud" : AZURE.replace("copilot.", `${app.app}.`));

function scenario(name: string, apps: readonly AppEntry[]): { readonly state?: GalleryState; readonly error?: string } {
  const now = new Date().toISOString();
  const local = target(apps, (app) => (app === CONSOLE ? "/open/console?target=local" : `http://localhost:${app.port}`), () => "online", "http://localhost:7400", "The platform `aspire run` starts on this machine.");
  const cloud = target(apps, azureUrl, (app) => (app.id === "assistant" ? "restricted" : "online"), AZURE, "Found with the Azure CLI in resource group rg-managed-copilot.");
  switch (name) {
    case "loading":
      return {};
    case "offline":
      return {
        state: {
          local: { ...local, gateway: "offline", links: Object.fromEntries(Object.entries(local.links).map(([id, link]) => [id, { ...link, health: "offline" as const }])) },
          cloud: { links: {}, note: "No deployment given. Start the gallery with `--cloud https://copilot.<environment-domain>`." },
          repoUrl: REPO,
          checkedAt: now,
        },
      };
    case "looking":
      return { state: { local, cloud: { links: {}, searching: true, note: "Looking for your Azure deployment…" }, repoUrl: REPO, checkedAt: now } };
    case "hosted": {
      const { console: _console, ...links } = cloud.links;
      return { state: { cloud: { ...cloud, links: Object.fromEntries(Object.entries(links).map(([id, link]) => [id, { ...link, health: "online" as const }])), note: "This deployment." }, hosted: true, repoUrl: REPO, checkedAt: now } };
    }
    case "error":
      return { state: { local, cloud, repoUrl: REPO, checkedAt: now }, error: "Couldn't reach the gallery server. Is pnpm gallery still running?" };
    default:
      return { state: { local, cloud, repoUrl: REPO, checkedAt: now } };
  }
}

export function Preview() {
  const params = new URLSearchParams(window.location.search);
  const more = params.has("more");
  const apps = more ? [...APPS.filter((app) => app !== CONSOLE), ...SAMPLE_APPS.filter((entry) => !APPS.some((app) => app.id === entry.id)), CONSOLE] : APPS;
  const patterns = more ? withSamples(PATTERNS) : PATTERNS;
  const { state, error } = scenario(params.get("preview") || "live", apps);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 800);
  };
  return <Gallery state={state} error={error} refreshing={refreshing} refresh={refresh} apps={apps} patterns={patterns} />;
}
