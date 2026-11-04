import { ContainerIcon, DotFillIcon, GlobeIcon, MarkGithubIcon, TriangleDownIcon } from "@primer/octicons-react";
import { useCallback, useRef, useState } from "react";
import type { PlatformStatus } from "../../shared/types.js";
import { initials } from "../lib/format.js";
import { homeHref } from "../lib/router.js";
import { useStore } from "../lib/store.js";
import { useDismiss } from "../lib/useDismiss.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

/** github.com's global header: the mark, `Managed Copilot / Repo Doctor`, then the platform pill and the account. */
export function Header() {
  return (
    <header className="AppHeader relative z-30 shrink-0">
      <div className="AppHeader-globalBar gap-2 sm:gap-3">
        <a href={homeHref()} className="AppHeader-logo" aria-label="Repo Doctor home">
          <MarkGithubIcon size={32} />
        </a>
        <nav className="AppHeader-context" aria-label="Breadcrumb">
          <a href={homeHref()} className="AppHeader-context-item max-sm:hidden">
            Managed Copilot
          </a>
          <span className="AppHeader-context-divider max-sm:hidden" aria-hidden>
            /
          </span>
          <a href={homeHref()} className="AppHeader-context-item AppHeader-context-item--current">
            <span className="truncate">Repo Doctor</span>
          </a>
        </nav>
        <div className="AppHeader-actions min-w-0">
          <Reconnecting />
          <PlatformPill />
          <Account />
        </div>
      </div>
    </header>
  );
}

/** The page lost Repo Doctor's event stream: it reconnects by itself, and says so meanwhile. */
function Reconnecting() {
  const connection = useStore((state) => state.connection);
  if (connection !== "reconnecting") return null;
  return (
    <span role="status" className="inline-flex shrink-0 animate-fade-in items-center gap-1.5 text-xs text-fg-muted">
      <Spinner size={16} className="text-fg-attention" />
      <span className="max-md:hidden">Reconnecting…</span>
    </span>
  );
}

function pillLabel(platform: PlatformStatus): string {
  if (platform.mode === "local") return "Local";
  if (platform.mode === "azure") return "Azure";
  return platform.deployment ?? "Platform";
}

function StatusDot({ platform }: { readonly platform: PlatformStatus }) {
  if (platform.state === "connecting" || platform.state === "reconnecting") return <Spinner size={12} className="text-fg-attention" />;
  return <DotFillIcon size={16} className={platform.state === "connected" ? "text-fg-success" : "text-fg-danger"} />;
}

function PlatformPill() {
  const platform = useStore((state) => state.platform);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(container, open, close);
  if (!platform) return null;
  const label = pillLabel(platform);
  return (
    <div ref={container} className="relative">
      <button
        type="button"
        className="btn btn-sm"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Platform: ${label}, ${platform.state}. Show details`}
        onClick={() => setOpen((value) => !value)}
      >
        <StatusDot platform={platform} />
        <span>{label}</span>
        <TriangleDownIcon size={16} />
      </button>
      {open ? <PlatformDetails platform={platform} /> : null}
    </div>
  );
}

function PlatformDetails({ platform }: { readonly platform: PlatformStatus }) {
  const environment = platform.environment;
  const account = platform.account;
  const label = pillLabel(platform);
  const status =
    platform.state === "connected" ? `Connected · ${label}` : platform.state === "unavailable" ? `Unavailable · ${label}` : platform.state === "reconnecting" ? "Reconnecting…" : "Connecting…";
  const hosts = environment?.network.access === "restricted" ? environment.network.hosts : [];
  return (
    <div role="dialog" aria-label="Platform details" className="Overlay absolute top-full right-0 z-40 mt-2 w-[22rem] animate-scale-in">
      <div className="flex flex-col gap-1 p-4 text-sm">
        <div className="flex items-center gap-2 font-semibold">
          <StatusDot platform={platform} />
          {status}
        </div>
        {platform.message ? <p className="text-fg-muted">{platform.message}</p> : null}
        {platform.deployment ? (
          <div>
            <span className="text-fg-muted">Deployment</span> <span className="font-semibold">{platform.deployment}</span>
          </div>
        ) : null}
        {platform.url ? (
          <div className="truncate font-mono text-xs text-fg-muted" title={platform.url}>
            {platform.url}
          </div>
        ) : null}
      </div>
      {account ? (
        <div className="flex items-center gap-2 border-t border-line-muted px-4 py-3 text-sm">
          {account.avatarUrl ? <img src={account.avatarUrl} alt="" className="avatar size-5" /> : null}
          <span className="truncate">
            {account.name ? <span className="font-semibold">{account.name} </span> : null}
            <span className="text-fg-muted">@{account.login}</span>
          </span>
        </div>
      ) : null}
      {environment ? (
        <div className="border-t border-line-muted px-4 py-3 text-sm">
          <div className="mb-2 text-xs font-semibold text-fg-muted">Environments</div>
          <div className="flex items-center gap-2">
            <ContainerIcon size={16} className="shrink-0 text-fg-muted" />
            <span className="font-mono text-xs">{environment.name}</span>
            <span className="ml-auto text-xs text-fg-muted">One sandbox per run</span>
          </div>
          <div className="mt-2 flex items-center gap-2" title={hosts.join(", ")}>
            <GlobeIcon size={16} className="shrink-0 text-fg-muted" />
            <span className="min-w-0 truncate text-xs text-fg-muted">
              {environment.network.access === "restricted" ? hosts.join(" · ") : environment.network.access === "disabled" ? "No network" : "Any host"}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Account() {
  const account = useStore((state) => state.platform?.account);
  const [imageFailed, setImageFailed] = useState(false);
  if (!account) return null;
  return (
    <>
      <span className="AppHeader-divider max-sm:hidden" aria-hidden />
      <Tooltip content={account.name ? `${account.name} (@${account.login})` : `@${account.login}`}>
        <span className="inline-flex shrink-0" tabIndex={0}>
          {account.avatarUrl && !imageFailed ? (
            <img src={account.avatarUrl} alt="" className="avatar size-8" onError={() => setImageFailed(true)} />
          ) : (
            <span className="avatar avatar-initials size-8 text-xs" aria-hidden>
              {initials(account.name ?? account.login)}
            </span>
          )}
          <span className="sr-only">Signed in as {account.login}</span>
        </span>
      </Tooltip>
    </>
  );
}
