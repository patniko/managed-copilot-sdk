import type { OperatorIdentity } from "@managed-copilot/protocol/operator";
import { ChevronDown, FlaskConical, Gauge, LoaderCircle, LogOut, Menu, Pause, Play, RefreshCw, ShieldCheck } from "lucide-react";
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
import { Button, IconButton } from "../ui/Button.js";
import { Chip, Dot } from "../ui/Chip.js";
import { Link } from "../ui/Link.js";
import { Tooltip } from "../ui/Tooltip.js";

export function TopBar({ identity, onOpenMenu }: { readonly identity: OperatorIdentity; readonly onOpenMenu: () => void }) {
  const overview = useOverview();
  const deployment = overview.data?.deployment;
  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/95 px-3 backdrop-blur sm:gap-3 sm:px-4">
      <IconButton icon={Menu} label="Show navigation" onClick={onOpenMenu} className="lg:hidden" />
      <Link href={hrefs.overview()} className="flex min-w-0 items-center gap-2.5 rounded-lg pr-1" aria-label="Operator console overview">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-linear-to-b from-amber-400/25 to-amber-500/10 text-amber-300 shadow-[0_0_18px_-6px_rgb(251_191_36/0.55)] ring-1 ring-inset ring-amber-400/30">
          <Gauge className="size-[18px]" aria-hidden />
        </span>
        <span className="hidden truncate text-[15px] font-semibold tracking-tight text-zinc-100 sm:inline">Operator console</span>
      </Link>
      {deployment ? (
        <div className="flex min-w-0 items-center gap-2 border-l border-zinc-800 pl-3">
          <span className="truncate text-[13px] font-medium text-zinc-200" title={`Deployment ${deployment.name}`}>
            {deployment.name}
          </span>
          <Chip mono tone={deployment.mode === "azure" ? "active" : "plain"} title={deployment.mode === "azure" ? "Deployed to Azure" : "Running locally"}>
            {deployment.mode}
          </Chip>
          <span className="hidden font-mono text-[11px] text-zinc-500 md:inline" title="Gateway version">
            v{deployment.version.replace(/^v/, "")}
          </span>
        </div>
      ) : null}
      <div className="ml-auto flex min-w-0 items-center gap-2">
        {import.meta.env.DEV && isSampleData() ? (
          <Tooltip content="Dev-only fixtures from ?fixtures. Nothing on screen comes from a gateway.">
            <span tabIndex={0} className="inline-flex items-center gap-1.5 rounded-full bg-amber-400/15 px-2.5 py-1 text-xs font-semibold text-amber-200 ring-1 ring-inset ring-amber-400/40">
              <FlaskConical className="size-3.5" aria-hidden />
              Sample data
            </span>
          </Tooltip>
        ) : null}
        <LiveIndicator />
        <OperatorMenu identity={identity} />
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
        className="inline-flex h-8 items-center gap-2 rounded-full bg-zinc-900 pr-2 pl-3 text-xs font-medium ring-1 ring-inset ring-white/10 transition-colors hover:bg-zinc-800"
      >
        {status === "live" ? <Dot tone="success" pulse /> : null}
        {status === "connecting" || status === "reconnecting" ? (
          <LoaderCircle className={cx("size-3.5 animate-spin", status === "reconnecting" ? "text-amber-300" : "text-zinc-400")} aria-hidden />
        ) : null}
        {status === "paused" ? <Pause className="size-3.5 text-zinc-400" aria-hidden /> : null}
        {status === "off" ? <Dot tone="neutral" /> : null}
        <span className={cx(status === "live" ? "text-emerald-200" : status === "reconnecting" ? "text-amber-200" : "text-zinc-300")}>
          {copy.label}
          {status === "reconnecting" && retryIn !== undefined && retryIn > 0 ? <span className="hidden text-zinc-500 sm:inline"> · {retryIn}s</span> : null}
        </span>
        <ChevronDown className={cx("size-3.5 text-zinc-500 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Live updates"
          className="absolute top-full right-0 z-40 mt-2 w-80 origin-top-right animate-rise-in rounded-2xl border border-zinc-700/70 bg-zinc-900/95 p-4 text-left shadow-2xl shadow-black/60 backdrop-blur"
        >
          <p className="text-sm font-semibold text-zinc-100">{copy.label}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-zinc-400">{copy.title}</p>
          {status === "live" && stream.connectedAt !== undefined ? (
            <p className="mt-2 text-[12px] text-zinc-500">
              Connected <time dateTime={formatIso(stream.connectedAt)}>{formatRelative(stream.connectedAt, now)}</time>
            </p>
          ) : null}
          {status === "reconnecting" && stream.error ? <p className="mt-2 text-[12.5px] leading-relaxed text-amber-200/90">{stream.error}</p> : null}
          {status === "reconnecting" && retryIn !== undefined ? <p className="mt-1 text-[12px] text-zinc-500">Next attempt in {retryIn}s.</p> : null}
          {status === "paused" ? (
            <p className="mt-2 text-[12.5px] leading-relaxed text-zinc-400">Data on screen stays as it is until you resume or refresh a view.</p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            {status === "paused" ? (
              <Button
                size="sm"
                variant="primary"
                icon={Play}
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
                icon={Pause}
                onClick={() => {
                  setLiveUpdatesPaused(true);
                  close();
                }}
              >
                Pause live updates
              </Button>
            )}
            {status === "reconnecting" ? (
              <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => reconnectNow()}>
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
        className="inline-flex h-8 items-center gap-2 rounded-full py-0.5 pr-2 pl-0.5 ring-1 ring-inset ring-white/10 transition-colors hover:bg-zinc-800"
      >
        <Avatar account={account} size="md" />
        <span className="hidden max-w-[10rem] truncate text-[13px] text-zinc-200 md:inline">{account.login}</span>
        <ChevronDown className={cx("size-3.5 text-zinc-500 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Account"
          className="absolute top-full right-0 z-40 mt-2 w-80 origin-top-right animate-rise-in rounded-2xl border border-zinc-700/70 bg-zinc-900/95 text-left shadow-2xl shadow-black/60 backdrop-blur"
        >
          <div className="flex items-center gap-3 border-b border-zinc-800 p-4">
            <Avatar account={account} size="lg" />
            <div className="min-w-0">
              {account.name ? <p className="truncate text-sm font-semibold text-zinc-100">{account.name}</p> : null}
              <p className={cx("truncate", account.name ? "text-[13px] text-zinc-400" : "text-sm font-semibold text-zinc-100")}>@{account.login}</p>
            </div>
          </div>
          <dl className="space-y-2.5 px-4 py-3 text-[13px]">
            <div>
              <dt className="sr-only">Access</dt>
              <dd className="flex items-center gap-1.5 font-medium text-zinc-200">
                <ShieldCheck className="size-3.5 text-emerald-300" aria-hidden />
                {grant.label}
              </dd>
              {grant.description ? <dd className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">{grant.description}</dd> : null}
            </div>
            {expires ? (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-zinc-500">Session ends</dt>
                <dd className="text-right text-zinc-300" title={formatIso(expires)}>
                  {formatRelative(expires, now)}
                  <span className="block text-[11.5px] text-zinc-500">{formatDateTime(expires)}</span>
                </dd>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-zinc-500">Signed in with</dt>
              <dd className="text-zinc-300">{identity.via === "console" ? "Console sign-in link" : "GitHub token"}</dd>
            </div>
          </dl>
          <div className="border-t border-zinc-800 p-2">
            <Button
              variant="ghost"
              className="w-full justify-start"
              icon={LogOut}
              loading={signingOut}
              onClick={async () => {
                setSigningOut(true);
                await signOut();
                setSigningOut(false);
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
