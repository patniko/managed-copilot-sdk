import {
  AlertIcon,
  BookIcon,
  CheckIcon,
  CloudIcon,
  CopyIcon,
  DeviceDesktopIcon,
  LinkExternalIcon,
  MarkGithubIcon,
  SyncIcon,
  TerminalIcon,
} from "@primer/octicons-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { APPS, shotFile, WALKTHROUGHS, type AppEntry, type GalleryState, type Health, type Link, type Target, type TargetState, type Walkthrough } from "../shared/catalog.js";

const POLL_MS = 15_000;
const TARGET_NAME: Record<Target, string> = { local: "Local", cloud: "Azure" };
const HEALTH_TEXT: Record<Health, string> = { online: "Online", restricted: "IP-restricted", offline: "Offline" };

function useGallery() {
  const [state, setState] = useState<GalleryState>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async (refresh = false) => {
    setRefreshing(refresh);
    try {
      const response = await fetch(`/api/gallery${refresh ? "?refresh" : ""}`);
      if (!response.ok) throw new Error(`The gallery server answered ${response.status}.`);
      setState((await response.json()) as GalleryState);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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

function Dot({ health }: { readonly health?: Health }) {
  return <span className={`dot ${health ? `dot-${health}` : ""}`} aria-hidden />;
}

function healthTitle(target: Target, link: Link | undefined, state: TargetState | undefined): string {
  if (!link) return target === "cloud" ? (state?.searching ? "Looking for your Azure deployment…" : (state?.note ?? "No Azure deployment")) : "Not available";
  if (link.health === "restricted") return `${link.url} refused this network: its ingress only allows the addresses in Parameters:app-allowed-ips.`;
  if (link.health === "offline") return target === "local" ? `${link.url} isn't answering. Start the platform with aspire run.` : `${link.url} isn't answering.`;
  return link.url;
}

function TargetButton({ target, link, state, primary }: { readonly target: Target; readonly link?: Link; readonly state?: TargetState; readonly primary?: boolean }) {
  const Icon = target === "local" ? DeviceDesktopIcon : CloudIcon;
  const label = (
    <>
      <Icon size={16} />
      <span>{TARGET_NAME[target]}</span>
      <Dot health={link?.health} />
    </>
  );
  const title = healthTitle(target, link, state);
  if (!link) {
    return (
      <button type="button" className="btn btn-sm inline-flex items-center gap-2" disabled title={title}>
        {label}
      </button>
    );
  }
  return (
    <a
      className={`btn btn-sm inline-flex items-center gap-2 ${primary && link.health === "online" ? "btn-primary" : ""}`}
      href={link.url}
      target="_blank"
      rel="noreferrer"
      title={title}
    >
      {label}
    </a>
  );
}

function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm inline-flex items-center gap-2"
      title={text}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        });
      }}
    >
      {copied ? <CheckIcon size={16} className="text-fg-success" /> : <CopyIcon size={16} />}
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}

function Shot({ id, alt, href }: { readonly id: string; readonly alt: string; readonly href?: string }) {
  const [missing, setMissing] = useState(false);
  const image = missing ? (
    <div className="h-full w-full grid place-items-center text-fg-muted text-sm">No screenshot yet · pnpm --filter @managed-copilot/demo-gallery capture</div>
  ) : (
    <img src={`/shots/${shotFile(id)}`} alt={alt} loading="lazy" onError={() => setMissing(true)} />
  );
  return href ? (
    <a className="shot block" href={href} target="_blank" rel="noreferrer" tabIndex={-1} aria-hidden>
      {image}
    </a>
  ) : (
    <div className="shot">{image}</div>
  );
}

function AppCard({ app, state }: { readonly app: AppEntry; readonly state?: GalleryState }) {
  const local = state?.local.links[app.id];
  const cloud = state?.cloud.links[app.id];
  const best = [local, cloud].find((link) => link?.health === "online");
  return (
    <article className="card Box overflow-hidden flex flex-col">
      <Shot id={app.id} alt={`${app.title}: ${app.tagline}`} href={best?.url} />
      <div className="p-4 flex flex-col gap-2 grow">
        <div>
          <h3 className="text-lg font-semibold leading-tight">{app.title}</h3>
          <p className="text-fg-muted">{app.tagline}</p>
        </div>
        <p className="text-sm">{app.description}</p>
        <p className="text-sm text-fg-muted">
          <span className="font-semibold text-fg">Try it: </span>
          {app.tryIt}
        </p>
      </div>
      <div className="px-4 pb-4 flex flex-wrap items-center gap-2">
        <TargetButton target="local" link={local} state={state?.local} primary />
        <TargetButton target="cloud" link={cloud} state={state?.cloud} primary={local?.health !== "online"} />
        <a className="btn btn-sm btn-invisible inline-flex items-center gap-2 ml-auto" href={`${state?.repoUrl ?? ""}${app.readme}`} target="_blank" rel="noreferrer">
          <BookIcon size={16} />
          <span>README</span>
        </a>
      </div>
    </article>
  );
}

function WalkthroughCard({ walkthrough, state }: { readonly walkthrough: Walkthrough; readonly state?: GalleryState }) {
  const command = `pnpm sample ${walkthrough.id}`;
  // Both copies name their gateway: MANAGED_COPILOT_URL outlives the command in that terminal, and an AppHost with a
  // port offset writes no discovery record.
  const withUrl = (url: string) => `$env:MANAGED_COPILOT_URL = "${url}"; ${command}`;
  const localUrl = state?.local.gatewayUrl;
  const cloudUrl = state?.cloud.gatewayUrl;
  const readme = `${state?.repoUrl ?? ""}samples/${walkthrough.folder}/README.md`;
  return (
    <article className="card Box overflow-hidden flex flex-col">
      <Shot id={`sample-${walkthrough.id}`} alt={`Walkthrough ${walkthrough.id}: ${walkthrough.title}`} href={readme} />
      <div className="p-4 flex flex-col gap-1 grow">
        <div className="flex items-center gap-2 text-fg-muted text-xs">
          <span className="Label">{walkthrough.id}</span>
          <span>
            {walkthrough.minutes} min{walkthrough.runnable ? "" : " · guide"}
          </span>
          {walkthrough.runnable ? <code className="inline-code ml-auto">{command}</code> : null}
        </div>
        <h3 className="text-base font-semibold leading-snug">{walkthrough.title}</h3>
        <p className="text-sm text-fg-muted">{walkthrough.youSee}</p>
      </div>
      <div className="px-4 pb-4 flex flex-wrap items-center gap-2">
        {walkthrough.runnable ? (
          <>
            {localUrl ? <CopyButton text={withUrl(localUrl)} label="Local" /> : null}
            {cloudUrl ? <CopyButton text={withUrl(cloudUrl)} label="Azure" /> : null}
          </>
        ) : null}
        <a className="btn btn-sm btn-invisible inline-flex items-center gap-2 ml-auto" href={readme} target="_blank" rel="noreferrer">
          <BookIcon size={16} />
          <span>README</span>
        </a>
      </div>
    </article>
  );
}

function TargetStatus({ target, state }: { readonly target: Target; readonly state?: TargetState }) {
  const Icon = target === "local" ? DeviceDesktopIcon : CloudIcon;
  const text = !state ? "Checking…" : state.searching ? "Looking…" : !state.gatewayUrl ? "Not found" : HEALTH_TEXT[state.gateway ?? "offline"];
  return (
    <span className="inline-flex items-center gap-2 text-sm" title={state?.gatewayUrl ? `${state.gatewayUrl}${state.note ? ` · ${state.note}` : ""}` : state?.note}>
      <Icon size={16} className="text-fg-muted" />
      <span className="text-fg-muted">{TARGET_NAME[target]}</span>
      <Dot health={state?.gatewayUrl ? state.gateway : undefined} />
      <span>{text}</span>
    </span>
  );
}

function Notice({ tone, children }: { readonly tone: "warn" | "neutral"; readonly children: ReactNode }) {
  return (
    <div className={`flash ${tone === "warn" ? "flash-warn" : ""} flex items-start gap-2`}>
      <AlertIcon size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const renderCode = (text: string) => text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i} className="inline-code">{part}</code> : part));

export function App() {
  const { state, error, refreshing, refresh } = useGallery();
  const localDown = state && state.local.gateway !== "online";
  const cloudMissing = state && !state.cloud.searching && !state.cloud.gatewayUrl;
  return (
    <div className="min-h-screen bg-canvas text-fg">
      <header className="AppHeader">
        <div className="AppHeader-globalBar gap-3">
          <span className="AppHeader-logo" aria-hidden>
            <MarkGithubIcon size={32} />
          </span>
          <nav className="AppHeader-context" aria-label="Breadcrumb">
            <span className="AppHeader-context-item max-sm:hidden">Managed Copilot</span>
            <span className="AppHeader-context-divider max-sm:hidden" aria-hidden>
              /
            </span>
            <span className="AppHeader-context-item AppHeader-context-item--current">Demo gallery</span>
          </nav>
          <div className="AppHeader-actions gap-4">
            <TargetStatus target="local" state={state?.local} />
            <TargetStatus target="cloud" state={state?.cloud} />
            <button type="button" className="AppHeader-button" aria-label="Check again" title="Check again" onClick={refresh} disabled={refreshing}>
              <SyncIcon size={16} className={refreshing ? "animate-spin" : ""} />
            </button>
          </div>
        </div>
      </header>

      <section className="hero border-b border-line">
        <div className="mx-auto max-w-[1280px] px-6 py-10">
          <h1 className="text-2xl font-semibold">Demo gallery</h1>
          <p className="mt-2 max-w-3xl text-base text-fg-muted">
            Every demo and walkthrough in one place, on this machine and in your Azure deployment. Each one runs stock Copilot SDK clients and sessions on Managed Copilot; the screens are from
            real runs.
          </p>
        </div>
      </section>

      <main className="mx-auto max-w-[1280px] px-6 py-8 flex flex-col gap-10">
        {error || localDown || cloudMissing ? (
          <div className="flex flex-col gap-3">
            {error ? <Notice tone="warn">{error}</Notice> : null}
            {localDown ? (
              <Notice tone="warn">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span>The local platform isn't running at {state.local.gatewayUrl}. Start it from the repository root, then the Local buttons light up.</span>
                  <CopyButton text="aspire run" label="aspire run" />
                </div>
              </Notice>
            ) : null}
            {cloudMissing ? (
              <Notice tone="neutral">
                {renderCode(state.cloud.note ?? "No Azure deployment.")} Or name one: {renderCode("`pnpm gallery --cloud https://copilot.<environment-domain>`")}.
              </Notice>
            ) : null}
          </div>
        ) : null}

        <section aria-labelledby="apps">
          <div className="Subhead">
            <h2 id="apps" className="Subhead-heading">
              Apps
            </h2>
            <div className="Subhead-description">{renderCode("Web apps for live demos. Local runs with `aspire run`; Azure is what `aspire deploy` published.")}</div>
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            {APPS.map((app) => (
              <AppCard key={app.id} app={app} state={state} />
            ))}
          </div>
        </section>

        <section aria-labelledby="walkthroughs">
          <div className="Subhead">
            <h2 id="walkthroughs" className="Subhead-heading inline-flex items-center gap-2">
              <TerminalIcon size={20} /> Walkthroughs
            </h2>
            <div className="Subhead-description">Short scripts from {renderCode("`samples/`")}. Copy the Local or Azure command and run it from the repository root; each sets {renderCode("`MANAGED_COPILOT_URL`")} to that gateway first.</div>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {WALKTHROUGHS.map((walkthrough) => (
              <WalkthroughCard key={walkthrough.id} walkthrough={walkthrough} state={state} />
            ))}
          </div>
        </section>

        <footer className="border-t border-line pt-4 pb-8 text-sm text-fg-muted flex flex-wrap gap-x-4 gap-y-1">
          <span>Status checked {state ? new Date(state.checkedAt).toLocaleTimeString() : "…"} · every {POLL_MS / 1000}s</span>
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
