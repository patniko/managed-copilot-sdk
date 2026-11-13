import {
  AlertIcon,
  AppsIcon,
  ArrowRightIcon,
  BookIcon,
  CloudIcon,
  ColumnsIcon,
  CommentDiscussionIcon,
  DeviceDesktopIcon,
  DotFillIcon,
  LinkExternalIcon,
  MarkGithubIcon,
  ShieldIcon,
  StackIcon,
  SyncIcon,
  TerminalIcon,
  TriangleDownIcon,
  WorkflowIcon,
} from "@primer/octicons-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  APPS,
  BUILDING_BLOCKS,
  CONSOLE,
  HARNESS_APP_ID,
  HARNESS_STAGES,
  harnessStageUrl,
  PATTERNS,
  SHOP_APP_ID,
  shotFile,
  WALKTHROUGHS,
  type AppEntry,
  type BuildingBlock,
  type GalleryState,
  type Health,
  type Link,
  type Pattern,
  type Target,
  type TargetState,
  type Walkthrough,
} from "../shared/catalog.js";
import { AGENT_SKETCHES, appHref, appsOnTab, COMPARE_APP_ID, compareApp, patternsOf, tabForHash, walkthroughCommand, type Shell, type Tab } from "./model.js";
import { ConnectedMap, type NodeLayout, type Send } from "./ConnectedMap.js";
import { AgentSketchView, PatternDiagram } from "./PatternDiagram.js";
import { ShopSwitch } from "./ShopSwitch.js";
import { CopyButton, cx, Spinner, Tooltip, useDismiss } from "./ui.js";

const POLL_MS = 15_000;
const TARGET_NAME: Record<Target, string> = { local: "Local", cloud: "Azure" };
const TARGET_ICON = { local: DeviceDesktopIcon, cloud: CloudIcon } as const;
const HEALTH_TEXT: Record<Health, string> = { online: "Online", restricted: "IP-restricted", offline: "Offline" };
/** Copied walkthrough commands use the visitor's shell: PowerShell on Windows, sh elsewhere. */
const SHELL: Shell = /^Win/i.test(navigator.platform) || /Windows/i.test(navigator.userAgent) ? "powershell" : "posix";

export interface GalleryData {
  readonly state?: GalleryState;
  readonly error?: string;
  readonly refreshing: boolean;
  readonly refresh: () => void;
}

function useGallery(): GalleryData {
  const [state, setState] = useState<GalleryState>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async (refresh = false) => {
    setRefreshing(refresh);
    try {
      const response = await fetch(`/api/gallery${refresh ? "?refresh" : ""}`);
      if (!response.ok) {
        setError(`The gallery server answered with an error (${response.status}).`);
        return;
      }
      setState((await response.json()) as GalleryState);
      setError(undefined);
    } catch {
      setError("Couldn't reach the gallery server.");
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  // Poll faster while the Azure lookup is still running.
  useEffect(() => {
    if (!state?.cloud.searching) return;
    const timer = setTimeout(() => void load(), 2_000);
    return () => clearTimeout(timer);
  }, [state, load]);
  return { state, error, refreshing, refresh: () => void load(true) };
}

/** Text with `code` spans; `nowrap` keeps each span on one line (narrow popovers). */
const renderCode = (text: string, nowrap = false): ReactNode[] =>
  text.split(/`([^`]+)`/).map((part, i) =>
    i % 2 ? (
      <code key={i} className={cx("inline-code", nowrap && "whitespace-nowrap")}>
        {part}
      </code>
    ) : (
      part
    ),
  );

const checkedAt = (state?: GalleryState): string => (state ? new Date(state.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "…");

// ------------------------------------------------------------------------------------------------ Status

type Tone = "success" | "attention" | "danger" | "muted";
const TONE_TEXT: Record<Tone, string> = { success: "text-fg-success", attention: "text-fg-attention", danger: "text-fg-danger", muted: "text-fg-muted" };

/** A gateway's status: a dot (a spinner while the gallery is still looking) and a word or two. */
function targetStatus(state: TargetState | undefined): { readonly tone: Tone; readonly busy: boolean; readonly text: string } {
  if (!state) return { tone: "muted", busy: true, text: "Checking" };
  if (state.searching) return { tone: "muted", busy: true, text: "Looking" };
  if (!state.gatewayUrl) return { tone: "muted", busy: false, text: "Not found" };
  const health = state.gateway ?? "offline";
  return { tone: health === "online" ? "success" : health === "restricted" ? "attention" : "danger", busy: false, text: HEALTH_TEXT[health] };
}

function StatusDot({ tone, busy }: { readonly tone: Tone; readonly busy?: boolean }) {
  return busy ? <Spinner size={12} className="mx-0.5 text-fg-muted" /> : <DotFillIcon size={16} className={TONE_TEXT[tone]} />;
}

const LINK_TONE: Record<Health, Tone> = { online: "success", restricted: "attention", offline: "muted" };

/** The header's control for one target: a status pill that opens the gateway's details. */
function TargetPill({ target, state, data }: { readonly target: Target; readonly state?: TargetState; readonly data: GalleryData }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(container, open, close);
  const status = targetStatus(state);
  const Glyph = TARGET_ICON[target];
  const title = target === "local" ? "Local platform" : "Azure deployment";
  const notFound = target === "cloud" && state && !state.searching && !state.gatewayUrl;
  const offline = state?.gatewayUrl && state.gateway === "offline";
  return (
    <div ref={container} className="relative">
      <button
        type="button"
        className="btn btn-sm"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${title}: ${status.text}. Show details`}
        onClick={() => setOpen((value) => !value)}
      >
        <StatusDot tone={status.tone} busy={status.busy} />
        <span>{TARGET_NAME[target]}</span>
        <TriangleDownIcon size={16} />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={`${title} details`}
          className="Overlay absolute top-full right-0 z-40 mt-2 w-[24rem] animate-scale-in max-sm:fixed max-sm:top-16 max-sm:right-4 max-sm:left-4 max-sm:w-auto"
        >
          <div className="Overlay-body flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2">
              <Glyph size={16} className="text-fg-muted" />
              <span className="font-semibold">{title}</span>
              <span className="ml-auto inline-flex items-center gap-1 text-fg-muted">
                <StatusDot tone={status.tone} busy={status.busy} />
                {status.text}
              </span>
            </div>
            {state?.gatewayUrl ? <div className="truncate font-mono text-xs text-fg-muted">{state.gatewayUrl}</div> : null}
            {state?.note ? <p className="text-fg-muted">{renderCode(state.note, true)}</p> : null}
            {target === "local" && offline ? (
              <div className="flex items-center gap-2">
                <span className="text-fg-muted">Start it from the repository root:</span>
                <CopyButton text="aspire run" label="Copy aspire run" className="ml-auto">
                  <span className="font-mono text-xs">aspire run</span>
                </CopyButton>
              </div>
            ) : null}
            {target === "cloud" && state?.gatewayUrl && state.gateway === "restricted" ? (
              <p className="text-fg-muted">{renderCode("It refuses this network: its ingress allows only `Parameters:app-allowed-ips`.", true)}</p>
            ) : null}
            {notFound ? (
              <div className="flex items-center gap-2">
                <span className="text-fg-muted">Or name one:</span>
                <CopyButton text="pnpm gallery --cloud https://copilot.<environment-domain>" label="Copy the command that names a deployment" className="ml-auto">
                  <span className="font-mono text-xs">pnpm gallery --cloud …</span>
                </CopyButton>
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2 border-t border-line px-4 py-2 text-xs text-fg-muted">
            <span>Checked {checkedAt(data.state)}</span>
            <button type="button" className="btn btn-sm btn-invisible ml-auto" onClick={data.refresh} disabled={data.refreshing}>
              <SyncIcon size={16} className={data.refreshing ? "animate-spin" : ""} />
              Check now
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ Patterns

const BLOCK_ORDER = Object.keys(BUILDING_BLOCKS) as BuildingBlock[];
const BLOCK_STYLE: Record<BuildingBlock, { readonly pip: string; readonly gloss: string }> = {
  container: { pip: "pip-container", gloss: "a sandbox per session" },
  "multi-tenant": { pip: "pip-multi-tenant", gloss: "one runtime, many sessions" },
  orchestration: { pip: "pip-orchestration", gloss: "sandboxes on demand" },
};

function BuildingBlocks() {
  return (
    <ul className="mb-4 flex flex-col gap-x-6 gap-y-1 text-sm sm:flex-row sm:flex-wrap" aria-label="Building blocks">
      {BLOCK_ORDER.map((block) => (
        <li key={block}>
          <Tooltip content={BUILDING_BLOCKS[block].description}>
            <span tabIndex={0}>
              <span className={cx("pip mr-2 align-[-1px]", BLOCK_STYLE[block].pip)} aria-hidden />
              <span className="font-semibold">{BUILDING_BLOCKS[block].title}</span> <span className="text-fg-muted">{BLOCK_STYLE[block].gloss}</span>
            </span>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

function Pips({ blocks }: { readonly blocks: readonly BuildingBlock[] }) {
  const ordered = BLOCK_ORDER.filter((block) => blocks.includes(block));
  const names = ordered.map((block) => BUILDING_BLOCKS[block].title).join(", ");
  return (
    <Tooltip content={`Built from: ${names}`}>
      <span className="inline-flex items-center gap-1 p-1" role="img" aria-label={`Built from: ${names}`}>
        {ordered.map((block) => (
          <span key={block} className={cx("pip", BLOCK_STYLE[block].pip)} />
        ))}
      </span>
    </Tooltip>
  );
}

function PatternCard({ pattern, apps, walkthroughs, state }: { readonly pattern: Pattern; readonly apps: readonly AppEntry[]; readonly walkthroughs: readonly Walkthrough[]; readonly state?: GalleryState }) {
  const walkthrough = walkthroughs.find((entry) => entry.id === pattern.walkthrough);
  const demos = pattern.demos.flatMap((demo) => {
    const app = apps.find((entry) => entry.id === demo.app);
    return app ? [{ demo, app, ...appHref(app, state) }] : [];
  });
  return (
    <article id={`pattern-${pattern.id}`} className="pattern-card Box flex scroll-mt-4 flex-col gap-4 p-4">
      <header className="flex items-center gap-2">
        <h3 className="text-base font-semibold">{pattern.title}</h3>
        <span className="ml-auto">
          <Pips blocks={pattern.blocks} />
        </span>
      </header>
      <PatternDiagram pattern={pattern} />
      <Tooltip className="self-start" content={`apphost.mts: ${pattern.environment}: { ${pattern.settings.join(", ")}, … }`}>
        <code className="inline-code truncate text-xs" tabIndex={0}>
          managed.client("{pattern.environment}")
        </code>
      </Tooltip>
      <footer className="mt-auto flex items-start gap-3 border-t border-line-muted pt-3 text-sm">
        <Tooltip className="shrink-0" content={`Walkthrough ${pattern.walkthrough}${walkthrough ? `: ${walkthrough.title}` : ""}`}>
          <a className="btn btn-sm" href={`#walkthrough-${pattern.walkthrough}`} aria-label={`Walkthrough ${pattern.walkthrough}${walkthrough ? `: ${walkthrough.title}` : ""}`}>
            <TerminalIcon size={16} />
            {pattern.walkthrough}
          </a>
        </Tooltip>
        {demos.length ? (
          <ul className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 pt-0.5" aria-label="Apps that show it">
            {demos.map(({ demo, app, href, online }) => (
              <li key={`${demo.app}-${demo.where}`}>
                <Tooltip content={online ? `${app.title}: ${demo.where}` : `${app.title}: ${demo.where}. It isn't answering, so this opens its README.`}>
                  <a className="Link whitespace-nowrap" href={href} target="_blank" rel="noreferrer" aria-label={`${app.title}: ${demo.where}`}>
                    {app.title}
                  </a>
                </Tooltip>
              </li>
            ))}
          </ul>
        ) : null}
      </footer>
    </article>
  );
}

// ------------------------------------------------------------------------------------------------ Apps

const PLACEHOLDER_TONES = [
  "bg-display-blue-muted text-display-blue",
  "bg-display-green-muted text-display-green",
  "bg-display-orange-muted text-display-orange",
  "bg-display-purple-muted text-display-purple",
  "bg-display-pink-muted text-display-pink",
  "bg-display-teal-muted text-display-teal",
  "bg-display-indigo-muted text-display-indigo",
  "bg-display-yellow-muted text-display-yellow",
] as const;

const initials = (title: string): string =>
  title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");

/** The app's screenshot; a tile with its initials until one is captured. */
function Shot({ app, href }: { readonly app: AppEntry; readonly href?: string }) {
  const [missing, setMissing] = useState(false);
  const tone = PLACEHOLDER_TONES[[...app.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % PLACEHOLDER_TONES.length];
  const image = missing ? (
    <div className="shot-placeholder">
      <span className={cx("shot-initials", tone)}>{initials(app.title)}</span>
    </div>
  ) : (
    <img src={`/shots/${shotFile(app.id)}`} alt="" loading="lazy" onError={() => setMissing(true)} />
  );
  return href ? (
    <a className="shot" href={href} target="_blank" rel="noreferrer" tabIndex={-1} aria-hidden>
      {image}
    </a>
  ) : (
    <div className="shot" aria-hidden>
      {image}
    </div>
  );
}

function linkTitle(target: Target, link: Link | undefined, state: TargetState | undefined, hosted: boolean, open = false): string {
  if (!link) return target === "cloud" ? (state?.searching ? "Looking for your Azure deployment…" : "No Azure deployment") : "Not available";
  if (link.health === "restricted") return "Refuses this network: its ingress allows only Parameters:app-allowed-ips";
  if (link.health === "offline") return target === "local" ? "Not answering. Start the platform with aspire run." : "Not answering";
  // The console's link is the gallery's own route, which signs you in and redirects.
  if (link.url.startsWith("/")) return "Signs you in with this machine's GitHub sign-in";
  if (!hosted) return link.url;
  // A public app (publishApp({ public: true })) opens from anywhere and signs in its own users.
  return open ? `${link.url} · open to anyone; it signs in its own users` : `${link.url} · opens from allowed networks only`;
}

/** Opens an app on one target, with that link's live status. */
function OpenButton({ app, target, link, state, hosted }: { readonly app: AppEntry; readonly target: Target; readonly link?: Link; readonly state?: TargetState; readonly hosted: boolean }) {
  const Glyph = TARGET_ICON[target];
  const status = link ? HEALTH_TEXT[link.health] : state?.searching || !state ? "checking" : "not available";
  const content = (
    <>
      <Glyph size={16} />
      {TARGET_NAME[target]}
      {state && !state.searching ? <StatusDot tone={link ? LINK_TONE[link.health] : "muted"} /> : <StatusDot tone="muted" busy />}
    </>
  );
  const label = `Open ${app.title} (${TARGET_NAME[target]}, ${status.toLowerCase()})`;
  return (
    <Tooltip content={linkTitle(target, link, state, hosted, app.public === true)}>
      {link ? (
        <a className="btn btn-sm" href={link.url} target="_blank" rel="noreferrer" aria-label={label}>
          {content}
        </a>
      ) : (
        <button type="button" className="btn btn-sm" aria-disabled="true" aria-label={label}>
          {content}
        </button>
      )}
    </Tooltip>
  );
}

function ReadmeLink({ href, name }: { readonly href: string; readonly name: string }) {
  return (
    <Tooltip content="README">
      <a className="btn btn-sm btn-invisible btn-icon" href={href} target="_blank" rel="noreferrer" aria-label={`${name} README`}>
        <BookIcon size={16} />
      </a>
    </Tooltip>
  );
}

function PatternMarkers({ app, patterns }: { readonly app: AppEntry; readonly patterns: readonly Pattern[] }) {
  if (app.id === COMPARE_APP_ID) {
    return (
      <div className="flex">
        <a className="pattern-marker" href="#patterns">
          All six patterns
        </a>
      </div>
    );
  }
  const shown = patternsOf(app.id, patterns);
  if (!shown.length) return null;
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Patterns it shows">
      {shown.map((pattern) => {
        const where = pattern.demos.find((demo) => demo.app === app.id)?.where;
        return (
          <li key={pattern.id}>
            <Tooltip content={where ? `${pattern.title}: ${where}` : pattern.title}>
              <a className="pattern-marker" href={`#pattern-${pattern.id}`}>
                {pattern.title}
              </a>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}

/** An app's Local and Azure buttons, with live status, and its README. */
function AppActions({ app, state }: { readonly app: AppEntry; readonly state?: GalleryState }) {
  const hosted = state?.hosted === true;
  const local = state?.local?.links[app.id];
  const cloud = state?.cloud.links[app.id];
  // Without a deployment, the header's Azure control says why; the cards leave Azure out.
  const noCloud = app.localOnly === true || (state !== undefined && !state.cloud.searching && !state.cloud.gatewayUrl);
  return (
    <div className="flex items-center gap-2">
      {hosted ? null : <OpenButton app={app} target="local" link={local} state={state?.local} hosted={hosted} />}
      {hosted && app.id === CONSOLE.id ? (
        // The console signs each operator in with their own GitHub account, from their terminal.
        state?.cloud.gatewayUrl ? (
          <CopyButton text={`npx managed-copilot console --url ${state.cloud.gatewayUrl}`} label="Copy the command that opens the console">
            Copy command
          </CopyButton>
        ) : null
      ) : noCloud ? null : (
        <OpenButton app={app} target="cloud" link={cloud} state={state?.cloud} hosted={hosted} />
      )}
      <span className="ml-auto">
        <ReadmeLink href={`${state?.repoUrl ?? ""}${app.readme}`} name={app.title} />
      </span>
    </div>
  );
}

function AppCard({ app, patterns, state }: { readonly app: AppEntry; readonly patterns: readonly Pattern[]; readonly state?: GalleryState }) {
  const best = [state?.local?.links[app.id], state?.cloud.links[app.id]].find((link) => link?.health === "online");
  return (
    <article className="app-card Box flex flex-col overflow-hidden">
      <Shot app={app} href={best?.url} />
      <div className="flex grow flex-col gap-2 px-4 pt-3 pb-2">
        <Tooltip block content={app.description}>
          <h3 className="flex min-w-0 items-center gap-2 text-base font-semibold leading-snug">
            <span className="truncate">{app.title}</span>
            {/* Published with public: true: its deployed address opens from anywhere, because it signs in its own users. */}
            {app.public ? <span className="Label Label--success shrink-0">Public</span> : null}
          </h3>
          <p className="truncate text-sm text-fg-muted">{app.tagline}</p>
        </Tooltip>
        <PatternMarkers app={app} patterns={patterns} />
        <p className="mt-auto truncate text-xs text-fg-muted" title={app.tryIt}>
          <span className="font-semibold text-fg">Try</span> {app.tryIt}
        </p>
      </div>
      <div className="px-4 pb-4">
        <AppActions app={app} state={state} />
      </div>
    </article>
  );
}

/**
 * One app on the Connected demos map. `tall` (the storefront and the factory, which span the map's height) stacks its
 * screenshot over its text; `wide` (the apps between them) puts its screenshot beside it. Downhill's has the shop switch.
 */
function FlowNode({ app, layout, sends, patterns, state }: { readonly app: AppEntry; readonly layout: NodeLayout; readonly sends: readonly Send[]; readonly patterns: readonly Pattern[]; readonly state?: GalleryState }) {
  const best = [state?.local?.links[app.id], state?.cloud.links[app.id]].find((link) => link?.health === "online");
  return (
    <article className={cx("flow-node app-card Box", `flow-node-${layout}`)} aria-label={app.title}>
      <Shot app={app} href={best?.url} />
      <div className="flow-node-body">
        <Tooltip block content={app.description}>
          <h4 className="flex min-w-0 items-center gap-2 text-base font-semibold leading-snug">
            <span className="truncate">{app.title}</span>
            {app.public ? <span className="Label Label--success shrink-0">Public</span> : null}
          </h4>
          <p className={cx("text-sm text-fg-muted", layout === "wide" && "truncate")}>{app.tagline}</p>
        </Tooltip>
        <AgentSketchView sketch={AGENT_SKETCHES[app.id]} />
        {/* The factory alone keeps its patterns and what to try: it shows several patterns, and the others say one in their sketch. */}
        {layout === "tall" && AGENT_SKETCHES[app.id] ? (
          <>
            <PatternMarkers app={app} patterns={patterns} />
            <p className="text-xs text-fg-muted">
              <span className="font-semibold text-fg">Try</span> {app.tryIt}
            </p>
          </>
        ) : null}
        {sends.length ? (
          <ul className="flow-sends" aria-label={`What ${app.title} sends`}>
            {sends.map(({ flow, to }) => (
              <li key={to.id}>
                <ArrowRightIcon size={12} className="mt-1 shrink-0 text-fg-muted" />
                <span>
                  <span className="font-semibold">{to.title}</span>
                  <span className="text-fg-muted">: {flow.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-auto flex flex-col gap-2 pt-1">
          {app.id === SHOP_APP_ID ? <ShopSwitch {...shopTarget(app, state)} /> : null}
          <AppActions app={app} state={state} />
        </div>
      </div>
    </article>
  );
}

/** Where the map's shop switch acts: the deployed Downhill on a hosted gallery, otherwise the first that answers (local first). */
function shopTarget(app: AppEntry, state?: GalleryState): { readonly target?: Target; readonly targetName?: string } {
  const targets: readonly Target[] = state?.hosted ? ["cloud"] : ["local", "cloud"];
  const target = targets.find((entry) => (entry === "local" ? state?.local : state?.cloud)?.links[app.id]?.health === "online");
  return target ? { target, targetName: TARGET_NAME[target] } : {};
}

// ------------------------------------------------------------------------------------------------ Walkthroughs

function WalkthroughList({ walkthroughs, state }: { readonly walkthroughs: readonly Walkthrough[]; readonly state?: GalleryState }) {
  const hosted = state?.hosted === true;
  const gateways: Partial<Record<Target, TargetState>> = {
    ...(!hosted && state?.local?.gatewayUrl ? { local: state.local } : {}),
    ...(state?.cloud.gatewayUrl ? { cloud: state.cloud } : {}),
  };
  const targets = Object.keys(gateways) as Target[];
  const [chosen, setChosen] = useState<Target>();
  const runOn = chosen && gateways[chosen] ? chosen : (targets.find((target) => gateways[target]?.gateway === "online") ?? targets[0]);
  const gatewayUrl = runOn ? gateways[runOn]?.gatewayUrl : undefined;
  return (
    <section aria-labelledby="walkthroughs-heading">
      <div className="Subhead">
        <h2 id="walkthroughs-heading" className="Subhead-heading inline-flex items-center gap-2">
          Walkthroughs <span className="Counter">{walkthroughs.length}</span>
        </h2>
        {targets.length > 1 ? (
          <div className="Subhead-actions">
            <Tooltip content="The platform the copied commands run against">
              <div className="SegmentedControl SegmentedControl--sm" role="group" aria-label="Run walkthroughs against">
                {targets.map((target) => {
                  const Glyph = TARGET_ICON[target];
                  return (
                    <button key={target} type="button" className="SegmentedControl-item" aria-pressed={target === runOn} onClick={() => setChosen(target)}>
                      <Glyph size={16} />
                      {TARGET_NAME[target]}
                    </button>
                  );
                })}
              </div>
            </Tooltip>
          </div>
        ) : null}
      </div>
      <ol className="Box">
        {walkthroughs.map((walkthrough) => {
          const command = gatewayUrl ? walkthroughCommand(walkthrough.id, gatewayUrl, SHELL) : `pnpm walkthrough ${walkthrough.id}`;
          const readme = `${state?.repoUrl ?? ""}walkthroughs/${walkthrough.folder}/README.md`;
          return (
            <li key={walkthrough.id} id={`walkthrough-${walkthrough.id}`} className="walkthrough Box-row flex scroll-mt-4 items-center gap-3">
              <span className="walkthrough-id" aria-hidden>
                {walkthrough.id}
              </span>
              <div className="min-w-0 flex-1 md:flex md:items-baseline md:gap-4">
                <p className="truncate font-semibold md:w-64 md:shrink-0" title={walkthrough.title}>
                  <span className="sr-only">Walkthrough {walkthrough.id}: </span>
                  {walkthrough.title}
                </p>
                <p className="truncate text-sm text-fg-muted" title={walkthrough.youSee}>
                  {walkthrough.youSee}
                </p>
              </div>
              <span className="w-12 shrink-0 text-right text-xs whitespace-nowrap text-fg-muted max-sm:hidden">{walkthrough.minutes} min</span>
              <span className="flex shrink-0 justify-end sm:w-[11.5rem]">
                {walkthrough.runnable ? (
                  <CopyButton
                    text={command}
                    label={`Copy the command for walkthrough ${walkthrough.id}`}
                    tooltip={
                      <span className="font-mono">
                        {command}
                        <span className="mt-1 block font-sans text-fg-on-emphasis/70">Run it from the repository root</span>
                      </span>
                    }
                  >
                    <span className="font-mono text-xs max-sm:hidden">pnpm walkthrough {walkthrough.id}</span>
                  </CopyButton>
                ) : (
                  <span className="text-xs text-fg-muted">Guide</span>
                )}
              </span>
              <ReadmeLink href={readme} name={`Walkthrough ${walkthrough.id}`} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ Hack the Harness

/**
 * Hack the Harness's stages, one row each, to flip between architectures during a talk. Each opens the local app at
 * that stage; every stage runs side by side, so switching needs no rebuild or restart.
 */
function HarnessStages({ apps, patterns, state }: { readonly apps: readonly AppEntry[]; readonly patterns: readonly Pattern[]; readonly state?: GalleryState }) {
  const app = apps.find((entry) => entry.id === HARNESS_APP_ID);
  // Local only: a hosted gallery can't reach it.
  if (!app || state?.hosted) return null;
  const link = state?.local?.links[app.id];
  const online = link?.health === "online";
  return (
    <section id="hack-the-harness" className="scroll-mt-4" aria-labelledby="harness-heading">
      <div className="Subhead">
        <h2 id="harness-heading" className="Subhead-heading inline-flex items-center gap-2">
          {app.title} stages <span className="Counter">{HARNESS_STAGES.length}</span>
        </h2>
        <div className="Subhead-actions flex items-center gap-2">
          {link && !online ? <span className="text-xs text-fg-muted">{state?.local?.gateway === "online" ? "Starting…" : "Needs aspire run"}</span> : null}
          <ReadmeLink href={`${state?.repoUrl ?? ""}${app.readme}`} name={app.title} />
        </div>
      </div>
      <p className="mb-3 text-sm text-fg-muted">
        The same staff assistant on six architectures, all running at once. Each stage has its own chats, so open one, start a new chat, and flip to the next.
      </p>
      <ol className="Box">
        {HARNESS_STAGES.map((stage, index) => {
          const pattern = patterns.find((entry) => entry.id === stage.pattern);
          const href = link ? harnessStageUrl(link.url, stage.id) : undefined;
          return (
            <li key={stage.id} id={`harness-${stage.id}`} className="walkthrough Box-row flex scroll-mt-4 items-center gap-3">
              <span className="walkthrough-id" aria-hidden>
                {index + 1}
              </span>
              <div className="min-w-0 flex-1 md:flex md:items-baseline md:gap-4">
                <p className="truncate font-semibold md:w-40 md:shrink-0">
                  <span className="sr-only">Stage {index + 1}: </span>
                  {stage.title}
                </p>
                <p className="truncate text-sm text-fg-muted" title={stage.summary}>
                  {stage.summary}
                </p>
              </div>
              {pattern ? (
                <a className="Label shrink-0 max-sm:hidden" href={`#pattern-${pattern.id}`} title={`The ${pattern.title} pattern`}>
                  {pattern.title}
                </a>
              ) : null}
              {href ? (
                <a className={cx("btn btn-sm shrink-0", online && "btn-primary")} href={href} target="_blank" rel="noreferrer" aria-label={`Open stage ${index + 1}, ${stage.title}`}>
                  <DeviceDesktopIcon size={16} />
                  Open
                </a>
              ) : (
                <button type="button" className="btn btn-sm shrink-0" disabled aria-label={`Stage ${index + 1}, ${stage.title}: the local platform isn't running`}>
                  <DeviceDesktopIcon size={16} />
                  Open
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ Tabs

/**
 * The open tab, from the URL hash, and a way to open another. A hash naming a section inside a tab (#pattern-mixed,
 * #walkthrough-03, #harness-shared) opens that tab and scrolls to the section.
 */
function useTab(): readonly [Tab, (tab: Tab) => void] {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const changed = () => setHash(window.location.hash);
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  const tab = tabForHash(hash);
  useEffect(() => {
    const id = hash.replace(/^#/, "");
    if (!id || id === tab) return;
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
  }, [hash, tab]);
  const select = useCallback((next: Tab) => {
    // Push the tab's hash without the browser's jump to an element, so the page stays where it is.
    window.history.pushState(null, "", `#${next}`);
    setHash(`#${next}`);
  }, []);
  return [tab, select];
}

function AppGrid({
  id,
  title,
  intro,
  apps,
  patterns,
  state,
}: {
  readonly id: string;
  readonly title: string;
  readonly intro: string;
  readonly apps: readonly AppEntry[];
  readonly patterns: readonly Pattern[];
  readonly state?: GalleryState;
}) {
  return (
    <section id={`${id}-apps`} aria-labelledby={`${id}-heading`}>
      <div className="Subhead">
        <h2 id={`${id}-heading`} className="Subhead-heading inline-flex items-center gap-2">
          {title} <span className="Counter">{apps.length}</span>
        </h2>
      </div>
      <p className="mb-4 text-sm text-fg-muted">{intro}</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {apps.map((app) => (
          <AppCard key={app.id} app={app} patterns={patterns} state={state} />
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ Page

function Notice({ tone, icon, children, actions }: { readonly tone: "warn" | "error"; readonly icon: ReactNode; readonly children: ReactNode; readonly actions?: ReactNode }) {
  return (
    <div className={cx("flash flash-sm items-center", tone === "warn" ? "flash-warn" : "flash-error")} role="status">
      {icon}
      <div className="flash-content">{children}</div>
      {actions ? <div className="flash-actions">{actions}</div> : null}
    </div>
  );
}

export interface GalleryProps extends GalleryData {
  readonly apps?: readonly AppEntry[];
  readonly patterns?: readonly Pattern[];
  readonly walkthroughs?: readonly Walkthrough[];
}

/** The page for a given state and catalog. */
export function Gallery(props: GalleryProps) {
  const { state, error, refreshing, refresh, apps = APPS, patterns = PATTERNS, walkthroughs = WALKTHROUGHS } = props;
  const hosted = state?.hosted === true;
  const localDown = !hosted && state?.local?.gatewayUrl !== undefined && state.local.gateway !== "online";
  const race = compareApp(apps);
  const raceLink = race ? appHref(race, state) : undefined;
  const connected = appsOnTab(apps, "connected", hosted);
  const more = appsOnTab(apps, "more", hosted);
  const staff = appsOnTab(apps, "staff", hosted).length > 0;
  const tabs: readonly { readonly id: Tab; readonly label: string; readonly icon: typeof StackIcon; readonly count: number }[] = [
    { id: "architectures", label: "Architectures", icon: StackIcon, count: patterns.length },
    { id: "connected", label: "Connected demos", icon: WorkflowIcon, count: connected.length },
    ...(staff ? [{ id: "staff-assistant" as const, label: "Staff assistant", icon: CommentDiscussionIcon, count: HARNESS_STAGES.length }] : []),
    { id: "demos", label: "More demos", icon: AppsIcon, count: more.length },
    { id: "walkthroughs", label: "Walkthroughs", icon: TerminalIcon, count: walkthroughs.length },
  ];
  const [chosen, selectTab] = useTab();
  const tab: Tab = tabs.some((entry) => entry.id === chosen) ? chosen : "architectures";
  return (
    <div className="min-h-screen bg-canvas text-fg">
      <header className="AppHeader">
        <div className="AppHeader-globalBar gap-2 sm:gap-3">
          <a href="/" className="AppHeader-logo" aria-label="Demo gallery home">
            <MarkGithubIcon size={32} />
          </a>
          <nav className="AppHeader-context min-w-0" aria-label="Breadcrumb">
            <a href="/" className="AppHeader-context-item max-sm:hidden">
              Managed Copilot
            </a>
            <span className="AppHeader-context-divider max-sm:hidden" aria-hidden>
              /
            </span>
            <a href="/" className="AppHeader-context-item AppHeader-context-item--current" aria-current="page">
              <span className="truncate">Demo gallery</span>
            </a>
          </nav>
          <div className="AppHeader-actions">
            {hosted ? null : <TargetPill target="local" state={state?.local} data={props} />}
            <TargetPill target="cloud" state={state?.cloud} data={props} />
          </div>
        </div>
      </header>

      <section className="hero border-b border-line">
        <div className="mx-auto max-w-[1280px] px-4 pt-8 sm:px-6">
          <h1 className="text-2xl font-semibold">Demo gallery</h1>
          <p className="mt-1 text-base text-fg-muted">
            {hosted ? "Six ways to run an agent, and the apps in this deployment that show them." : "Six ways to run an agent, and the apps and walkthroughs that show them."}
          </p>
          <nav className="UnderlineNav mt-6 border-b-0" aria-label="Gallery sections">
            <div className="UnderlineNav-body" role="tablist">
              {tabs.map(({ id, label, icon: Glyph, count }) => (
                <a
                  key={id}
                  id={`tab-${id}`}
                  href={`#${id}`}
                  role="tab"
                  aria-selected={tab === id}
                  aria-controls={`panel-${id}`}
                  className="UnderlineNav-item"
                  onClick={(event) => {
                    event.preventDefault();
                    selectTab(id);
                  }}
                >
                  <Glyph size={16} className="UnderlineNav-octicon" />
                  <span>{label}</span>
                  <span className="Counter">{count}</span>
                </a>
              ))}
            </div>
          </nav>
        </div>
      </section>

      <main className="mx-auto flex max-w-[1280px] flex-col gap-10 px-4 py-8 sm:px-6">
        {error || localDown || hosted ? (
          <div className="flex flex-col gap-2">
            {error ? (
              <Notice
                tone="error"
                icon={<AlertIcon size={16} />}
                actions={
                  <button type="button" className="btn btn-sm" onClick={refresh} disabled={refreshing}>
                    Try again
                  </button>
                }
              >
                {error}
              </Notice>
            ) : null}
            {localDown ? (
              <Notice
                tone="warn"
                icon={<AlertIcon size={16} />}
                actions={
                  <>
                    <CopyButton text="aspire run" label="Copy aspire run" tooltip="Copy aspire run, then run it from the repository root">
                      <span className="font-mono text-xs">aspire run</span>
                    </CopyButton>
                    <Tooltip content="Check again">
                      <button type="button" className="btn btn-sm btn-icon" aria-label="Check again" onClick={refresh} disabled={refreshing}>
                        <SyncIcon size={16} className={refreshing ? "animate-spin" : ""} />
                      </button>
                    </Tooltip>
                  </>
                }
              >
                The local platform isn't running.
              </Notice>
            ) : null}
            {hosted ? (
              <div className="flash flash-neutral flash-sm items-start">
                <ShieldIcon size={16} />
                <details className="flash-content">
                  <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                    {apps.some((app) => app.public) ? "Apps marked Public open from anywhere; the others, from allowed networks only." : "Apps open from allowed networks only."}{" "}
                    <span className="Link">How to get access</span>
                  </summary>
                  <p className="mt-2 text-fg-muted">
                    {renderCode(
                      `${apps.some((app) => app.public) ? "A Public app signs in its own users. " : ""}If an app answers \`403 RBAC: access denied\`, ask the deployment's owner to add your address with \`npx managed-copilot access ips add <your address>\`. Walkthroughs run from a clone of the repository and need your GitHub account on the deployment's access list.`,
                    )}
                  </p>
                </details>
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === "architectures" ? (
          <div role="tabpanel" id="panel-architectures" aria-labelledby="tab-architectures">
            <section id="patterns" className="scroll-mt-4" aria-labelledby="patterns-heading">
              <div className="Subhead">
                <h2 id="patterns-heading" className="Subhead-heading inline-flex items-center gap-2">
                  Patterns <span className="Counter">{patterns.length}</span>
                </h2>
                {race && raceLink ? (
                  <div className="Subhead-actions">
                    <Tooltip content={raceLink.online ? `${race.title}: one job through every pattern, side by side` : `${race.title} isn't answering, so this opens its README`}>
                      <a className="btn btn-sm" href={raceLink.href} target="_blank" rel="noreferrer">
                        <ColumnsIcon size={16} />
                        Compare all six
                      </a>
                    </Tooltip>
                  </div>
                ) : null}
              </div>
              <BuildingBlocks />
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {patterns.map((pattern) => (
                  <PatternCard key={pattern.id} pattern={pattern} apps={apps} walkthroughs={walkthroughs} state={state} />
                ))}
              </div>
            </section>
          </div>
        ) : null}

        {tab === "connected" ? (
          <div role="tabpanel" id="panel-connected" aria-labelledby="tab-connected">
            <section id="connected-apps" aria-labelledby="connected-heading">
              <div className="Subhead">
                <h2 id="connected-heading" className="Subhead-heading inline-flex items-center gap-2">
                  Connected demos <span className="Counter">{connected.length}</span>
                </h2>
              </div>
              <p className="mb-6 text-sm text-fg-muted">
                Contoso Outdoors' launch day, end to end. A Downhill player's launch code fails at checkout: support opens a Help Desk ticket, Data Desk sees the sales drop, and
                Incident Commander gets the alert. Each sends its work order to the Software Factory, and once you approve the fix, Incident Commander deploys it back to the shop.
                Hover an app to follow its connections.
              </p>
              <ConnectedMap apps={connected} renderNode={(app, layout, sends) => <FlowNode app={app} layout={layout} sends={sends} patterns={patterns} state={state} />} />
            </section>
          </div>
        ) : null}

        {tab === "staff-assistant" ? (
          <div role="tabpanel" id="panel-staff-assistant" aria-labelledby="tab-staff-assistant">
            <HarnessStages apps={apps} patterns={patterns} state={state} />
          </div>
        ) : null}

        {tab === "demos" ? (
          <div role="tabpanel" id="panel-demos" aria-labelledby="tab-demos">
            <AppGrid id="demos" title="More demos" intro="Each of these stands on its own: one app, one idea." apps={more} patterns={patterns} state={state} />
          </div>
        ) : null}

        {tab === "walkthroughs" ? (
          <div role="tabpanel" id="panel-walkthroughs" aria-labelledby="tab-walkthroughs">
            <WalkthroughList walkthroughs={walkthroughs} state={state} />
          </div>
        ) : null}

        <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-4 pb-8 text-xs text-fg-muted">
          <span>
            Checked {checkedAt(state)} · every {POLL_MS / 1000}s
          </span>
          <a className="Link--muted inline-flex items-center gap-1" href={`${state?.repoUrl ?? ""}docs/concepts/patterns.md`} target="_blank" rel="noreferrer">
            Patterns <LinkExternalIcon size={12} />
          </a>
          <a className="Link--muted inline-flex items-center gap-1" href={`${state?.repoUrl ?? ""}docs/README.md`} target="_blank" rel="noreferrer">
            Concepts <LinkExternalIcon size={12} />
          </a>
          <a className="Link--muted inline-flex items-center gap-1" href={`${state?.repoUrl ?? ""}docs/deployment.md`} target="_blank" rel="noreferrer">
            Deploying to Azure <LinkExternalIcon size={12} />
          </a>
        </footer>
      </main>
    </div>
  );
}

export function App() {
  return <Gallery {...useGallery()} />;
}
