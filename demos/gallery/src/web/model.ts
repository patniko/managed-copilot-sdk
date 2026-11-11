// What the page derives from the catalog and the live state. No DOM here, so the tests can import it.
import type { AppEntry, AppGroup, GalleryState, Pattern } from "../shared/catalog.js";

/** The app that runs one job through all six patterns side by side. The Patterns section links it once it's listed. */
export const COMPARE_APP_ID = "pattern-race";

export const compareApp = (apps: readonly AppEntry[]): AppEntry | undefined => apps.find((app) => app.id === COMPARE_APP_ID);

/**
 * The patterns an app shows, in the catalog's order: every one for the side-by-side comparison (which no pattern lists,
 * so it doesn't repeat under all six), the ones that list it otherwise.
 */
export const patternsOf = (appId: string, patterns: readonly Pattern[]): readonly Pattern[] =>
  appId === COMPARE_APP_ID ? patterns : patterns.filter((pattern) => pattern.demos.some((demo) => demo.app === appId));

/** Where an app opens: its first target that answers (local first), or its README when none does. */
export function appHref(app: AppEntry, state: GalleryState | undefined): { readonly href: string; readonly online: boolean } {
  const online = [state?.local?.links[app.id], state?.cloud.links[app.id]].find((link) => link?.health === "online");
  return online ? { href: online.url, online: true } : { href: `${state?.repoUrl ?? ""}${app.readme}`, online: false };
}

export type Shell = "powershell" | "posix";

/** The gallery's tabs, in order. */
export const TABS = ["architectures", "connected", "staff-assistant", "demos", "walkthroughs"] as const;
export type Tab = (typeof TABS)[number];

/** Which tab a URL hash opens, so links into a section (#pattern-mixed, #walkthrough-03, #harness-shared) still land. */
export function tabForHash(hash: string): Tab {
  const id = hash.replace(/^#/, "");
  if ((TABS as readonly string[]).includes(id)) return id as Tab;
  if (id === "patterns" || id.startsWith("pattern-")) return "architectures";
  if (id.startsWith("walkthrough")) return "walkthroughs";
  if (id === "hack-the-harness" || id.startsWith("harness-")) return "staff-assistant";
  return "architectures";
}

/** The apps a tab lists: its group, minus those a hosted gallery can't open. */
export const appsOnTab = (apps: readonly AppEntry[], group: AppGroup, hosted: boolean): readonly AppEntry[] =>
  apps.filter((app) => app.group === group && !(hosted && app.localOnly));

/**
 * Runs a walkthrough against one gateway. It sets MANAGED_COPILOT_URL first: the variable outlives the command in that
 * terminal, and an AppHost with a port offset writes no discovery record.
 */
export function walkthroughCommand(id: string, gatewayUrl: string, shell: Shell): string {
  return shell === "powershell" ? `$env:MANAGED_COPILOT_URL = "${gatewayUrl}"; pnpm walkthrough ${id}` : `export MANAGED_COPILOT_URL="${gatewayUrl}"; pnpm walkthrough ${id}`;
}

/** Where part of an agent runs, as the pattern diagrams draw it. */
export type Place = "runtime" | "sandbox" | "app" | "worker";

export interface Hand {
  readonly place: Place;
  /** Only once the session has moved (promotable). */
  readonly later?: true;
}

/** A pattern's brain/hands diagram. */
export interface PatternShape {
  /** Where its brain runs. Two places: it starts in the first and moves once to the second. */
  readonly brain: readonly Place[];
  /** Where its hands act, left to right. */
  readonly hands: readonly Hand[];
  /** Brain and hands share one sandbox. */
  readonly together?: true;
  readonly brainCaption: string;
  readonly handsCaption: string;
}

/** Every pattern's diagram, keyed by pattern id. The catalog's `brain` and `hands` sentences say the same in words. */
export const SHAPES: Readonly<Record<string, PatternShape>> = {
  isolated: { brain: ["sandbox"], hands: [{ place: "sandbox" }], together: true, brainCaption: "Its own sandbox", handsCaption: "The same sandbox" },
  shared: { brain: ["runtime"], hands: [{ place: "app" }], brainCaption: "Shared runtime", handsCaption: "Your app" },
  promotable: {
    brain: ["runtime", "sandbox"],
    hands: [{ place: "app" }, { place: "sandbox", later: true }],
    brainCaption: "Runtime, then a sandbox",
    handsCaption: "Your app + the sandbox",
  },
  direct: { brain: ["runtime"], hands: [{ place: "sandbox" }], brainCaption: "Shared runtime", handsCaption: "A sandbox, no agent" },
  delegate: { brain: ["runtime"], hands: [{ place: "worker" }, { place: "worker" }, { place: "worker" }], brainCaption: "Shared runtime", handsCaption: "Worker sandboxes" },
  mixed: { brain: ["runtime"], hands: [{ place: "sandbox" }, { place: "worker" }, { place: "worker" }], brainCaption: "Shared runtime", handsCaption: "Sandbox + workers" },
};
