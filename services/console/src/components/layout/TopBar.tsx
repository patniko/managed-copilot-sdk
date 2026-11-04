import type { OperatorIdentity } from "@managed-copilot/protocol/operator";
import { BeakerIcon, PauseIcon, PlayIcon, ServerIcon, ShieldCheckIcon, SignOutIcon, SyncIcon, ThreeBarsIcon, TriangleDownIcon, MarkGithubIcon } from "@primer/octicons-react";
import { useCallback, useRef, useState } from "react";
import { signOut } from "../../lib/auth.js";
import { cx } from "../../lib/cx.js";
import { formatDateTime, formatIso, formatRelative } from "../../lib/format.js";
import { useOverview } from "../../lib/resources.js";
import { hrefs } from "../../lib/routes.js";
import { isSampleData } from "../../lib/sample.js";
import { reconnectNow, setLiveUpdatesPaused, useStreamStatus, type StreamStatusSnapshot } from "../../lib/stream.js";
import { useNow } from "../../lib/time.js";
import { useDismiss } from "../../lib/useDismiss.js";
import { Avatar } from "../common/Identity.js";
import { Button } from "../ui/Button.js";
import { Dot } from "../ui/Chip.js";
import { Link } from "../ui/Link.js";
import { Spinner } from "../ui/Spinner.js";
import { Tooltip } from "../ui/Tooltip.js";

/** github.com's global header: menu button, GitHub mark, "Managed Copilot / Console", live status, and the account. */
export function TopBar({ identity, onOpenMenu }: { readonly identity: OperatorIdentity; readonly onOpenMenu: () => void }) {
  const overview = useOverview();
  const deployment = overview.data?.deployment;
  return (
    <header className="AppHeader relative z-30 shrink-0">
      <div className="AppHeader-globalBar gap-2 px-4 py-4 sm:gap-3">
        <button type="button" onClick={onOpenMenu} aria-label="Show navigation" className="AppHeader-button lg:hidden">
          <ThreeBarsIcon size={16} />
        </button>
        <Link href={hrefs.overview()} className="AppHeader-logo" aria-label="Operator console overview">
          <MarkGithubIcon size={32} />
        </Link>
        <nav aria-label="Breadcrumb" className="AppHeader-context min-w-0">
          <Link href={hrefs.overview()} className="AppHeader-context-item hidden sm:inline-flex">
            Managed Copilot
          </Link>
          <span className="AppHeader-context-divider hidden sm:inline" aria-hidden>
            /
          </span>
          <Link href={hrefs.overview()} className="AppHeader-context-item AppHeader-context-item--current">
            Console
          </Link>
        </nav>
        {deployment ? (
          <div className="hidden min-w-0 items-center gap-2 md:flex">
            <span
              className={cx("Label min-w-0", deployment.mode === "azure" ? "Label--accent" : "Label--secondary")}
              title={`Deployment ${deployment.name}, ${deployment.mode === "azure" ? "deployed to Azure" : "running locally"}`}
            >
              <ServerIcon size={12} />
              <span className="truncate">
                {deployment.name} · {deployment.mode}
              </span>
            </span>
            <span className="hidden font-mono text-xs text-fg-muted lg:inline" title="Gateway version">
              v{deployment.version.replace(/^v/, "")}
            </span>
          </div>
        ) : null}
        <div className="AppHeader-actions min-w-0">
          {import.meta.env.DEV && isSampleData() ? (
            <Tooltip content="Dev-only fixtures from ?fixtures. Nothing on screen comes from a gateway.">
              <span tabIndex={0} className="Label Label--attention">
                <BeakerIcon size={12} />
                <span className="hidden sm:inline">Sample data</span>
                <span className="sm:hidden">Sample</span>
              </span>
            </Tooltip>
          ) : null}
          <LiveIndicator />
          <span className="AppHeader-divider hidden sm:block" aria-hidden />
          <OperatorMenu identity={identity} />
        </div>
      </div>
    </header>
  );
}

const STATUS_COPY: Readonly<Record<StreamStatusSnapshot["status"], { readonly label: string; readonly title: string }>> = {
  off: { label: "Offline", title: "Live updates are off." },
  connecting: { label: "Connecting", title: "Connecting to the live stream…" },
  live: { label: "Live", title: "Live: events and logs stream in; views refresh every 5 seconds." },
  reconnecting: { label: "Reconnecting", title: "The live stream dropped; reconnecting." },
  paused: { label: "Paused", title: "Live updates are paused." },
};

function StreamIcon({ status }: { readonly status: StreamStatusSnapshot["status"] }) {
  if (status === "live") return <Dot tone="success" />;
  if (status === "connecting") return <Spinner className="text-fg-muted" />;
  if (status === "reconnecting") return <Spinner className="text-fg-attention" />;
  if (status === "paused") return <PauseIcon size={16} className="text-fg-muted" />;
  return <Dot tone="neutral" />;
}

function LiveIndicator() {
  const stream = useStreamStatus();
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(container, open, close);
  const status = stream.userPaused ? "paused" : stream.status;
  const copy = STATUS_COPY[status];
  const retryIn = stream.retryAt !== undefined ? Math.max(0, Math.ceil((stream.retryAt - now) / 1000)) : undefined;

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Live updates: ${copy.label}. Show options`}
        onClick={() => setOpen((value) => !value)}
        className="AppHeader-button inline-flex w-auto items-center gap-1.5 px-2"
      >
        <StreamIcon status={status} />
        <span className="text-fg">
          {copy.label}
          {status === "reconnecting" && retryIn !== undefined && retryIn > 0 ? <span className="hidden text-fg-muted sm:inline"> · {retryIn}s</span> : null}
        </span>
        <TriangleDownIcon size={16} />
      </button>
      {open ? (
        <div role="dialog" aria-label="Live updates" className="Overlay absolute top-full right-0 z-40 mt-2 w-80 origin-top-right animate-scale-in">
          <div className="Overlay-body">
            <p className="flex items-center gap-2 font-semibold">
              <StreamIcon status={status} />
              {copy.label}
            </p>
            <p className="mt-1 text-fg-muted">{copy.title}</p>
            {status === "live" && stream.connectedAt !== undefined ? (
              <p className="mt-2 text-xs text-fg-muted">
                Connected <time dateTime={formatIso(stream.connectedAt)}>{formatRelative(stream.connectedAt, now)}</time>
              </p>
            ) : null}
            {status === "reconnecting" && stream.error ? <p className="mt-2 text-fg-attention">{stream.error}</p> : null}
            {status === "reconnecting" && retryIn !== undefined ? <p className="mt-1 text-xs text-fg-muted">Next attempt in {retryIn}s.</p> : null}
            {status === "paused" ? <p className="mt-2 text-fg-muted">Data on screen stays as it is until you resume or refresh a view.</p> : null}
          </div>
          <div className="Overlay-footer justify-start">
            {status === "paused" ? (
              <Button
                size="sm"
                variant="primary"
                icon={PlayIcon}
                onClick={() => {
                  setLiveUpdatesPaused(false);
                  close();
                }}
              >
                Resume live updates
              </Button>
            ) : (
              <Button
                size="sm"
                icon={PauseIcon}
                onClick={() => {
                  setLiveUpdatesPaused(true);
                  close();
                }}
              >
                Pause live updates
              </Button>
            )}
            {status === "reconnecting" ? (
              <Button size="sm" variant="invisible" icon={SyncIcon} onClick={() => reconnectNow()}>
                Reconnect now
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const GRANTS = {
  configured: { label: "AppHost operator", description: "Named in the AppHost's operators." },
  local: { label: "Local operator", description: "This loopback gateway names no operators, so every account that can use it may operate it." },
} as const;

function OperatorMenu({ identity }: { readonly identity: OperatorIdentity }) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(container, open, close);
  const now = useNow(30_000);
  const account = identity.account;
  const grant = GRANTS[identity.grant] ?? { label: identity.grant, description: "" };
  const expires = identity.sessionExpiresAt;

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Signed in as ${account.login}. Account menu`}
        onClick={() => setOpen((value) => !value)}
        className="flex rounded-full"
      >
        <Avatar account={account} size="lg" />
      </button>
      {open ? (
        <div role="dialog" aria-label="Account" className="Overlay absolute top-full right-0 z-40 mt-2 w-80 origin-top-right animate-scale-in">
          <div className="flex items-center gap-3 px-4 py-3">
            <Avatar account={account} size="lg" />
            <div className="min-w-0">
              <p className="truncate font-semibold">{account.login}</p>
              {account.name ? <p className="truncate text-xs text-fg-muted">{account.name}</p> : null}
            </div>
          </div>
          <div className="border-t border-line-muted px-4 py-3">
            <p className="flex items-center gap-1.5 font-semibold">
              <ShieldCheckIcon size={16} className="text-fg-success" />
              {grant.label}
            </p>
            {grant.description ? <p className="mt-0.5 text-xs text-fg-muted">{grant.description}</p> : null}
            <dl className="mt-3 space-y-2 text-xs">
              {expires ? (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-fg-muted">Session ends</dt>
                  <dd className="text-right" title={formatIso(expires)}>
                    {formatRelative(expires, now)}
                    <span className="block text-fg-muted">{formatDateTime(expires)}</span>
                  </dd>
                </div>
              ) : null}
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-fg-muted">Signed in with</dt>
                <dd>{identity.via === "console" ? "Console sign-in link" : "GitHub token"}</dd>
              </div>
            </dl>
          </div>
          <ul className="ActionList border-t border-line-muted">
            <li>
              <button
                type="button"
                className="ActionList-item"
                disabled={signingOut}
                onClick={async () => {
                  setSigningOut(true);
                  await signOut();
                  setSigningOut(false);
                }}
              >
                {signingOut ? <Spinner className="text-fg-muted" /> : <SignOutIcon size={16} />}
                <span className="ActionList-item-label">Sign out</span>
              </button>
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}
