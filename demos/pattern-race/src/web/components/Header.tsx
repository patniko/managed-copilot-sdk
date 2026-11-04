import { CopilotIcon, DotFillIcon, MarkGithubIcon, TriangleDownIcon } from "@primer/octicons-react";
import { useCallback, useRef, useState } from "react";
import { LANES } from "../../shared/lanes.js";
import type { AppState, PlatformStatus } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { useStore } from "../lib/store.js";
import { useDismiss } from "../lib/useDismiss.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

/** github.com's global header: the GitHub mark, `Managed Copilot / Pattern Race`, the platform pill, and the account. */
export function Header() {
  return (
    <header className="AppHeader relative z-30 shrink-0">
      <div className="AppHeader-globalBar gap-2 sm:gap-3">
        <a href="/" className="AppHeader-logo" aria-label="Pattern Race home">
          <MarkGithubIcon size={32} />
        </a>
        <nav className="AppHeader-context" aria-label="Breadcrumb">
          <a href="/" className="AppHeader-context-item max-sm:hidden">
            Managed Copilot
          </a>
          <span className="AppHeader-context-divider max-sm:hidden" aria-hidden>
            /
          </span>
          <a href="/" className="AppHeader-context-item AppHeader-context-item--current">
            <span className="truncate">Pattern Race</span>
          </a>
        </nav>
        <div className="AppHeader-actions min-w-0">
          <ConnectionIndicator />
          <PlatformPill />
          <Account />
        </div>
      </div>
    </header>
  );
}

/** The page lost its live connection to this app's server; the browser reconnects by itself. */
function ConnectionIndicator() {
  const connection = useStore((current) => current.connection);
  if (connection !== "reconnecting") return null;
  return (
    <span role="status" className="inline-flex shrink-0 animate-fade-in items-center gap-1.5 text-xs text-fg-muted">
      <Spinner size={16} className="text-fg-attention" />
      <span className="max-md:hidden">Reconnecting…</span>
    </span>
  );
}

function pillLabel(platform: PlatformStatus): string {
  if (platform.mode === "azure") return "Azure";
  if (platform.mode === "local") return "Local";
  return platform.deployment ?? "Managed Copilot";
}

function PlatformDot({ platform }: { readonly platform: PlatformStatus }) {
  if (platform.state === "connecting" || platform.state === "reconnecting") return <Spinner size={12} className="text-fg-attention" />;
  return <DotFillIcon size={16} className={platform.state === "connected" ? "text-fg-success" : "text-fg-danger"} />;
}

function PlatformPill() {
  const app = useStore((current) => current.app);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(container, open, close);
  if (!app) return null;
  const { platform } = app;
  const label = pillLabel(platform);
  return (
    <div ref={container} className="relative min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Platform: ${label}, ${platform.state}. Show details`}
        onClick={() => setOpen((value) => !value)}
        className="btn btn-sm max-w-full min-w-0"
      >
        <PlatformDot platform={platform} />
        <span className="truncate">{label}</span>
        <TriangleDownIcon size={16} />
      </button>
      {open ? <PlatformPopover app={app} /> : null}
    </div>
  );
}

const STATE_TITLE: Record<PlatformStatus["state"], string> = {
  connected: "Connected",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  unavailable: "Unavailable",
};

function PlatformPopover({ app }: { readonly app: AppState }) {
  const { platform } = app;
  const account = platform.account;
  return (
    <div role="dialog" aria-label="Deployment details" className="Overlay absolute top-full right-0 z-40 mt-2 w-[21rem] max-w-[calc(100vw-2rem)] animate-scale-in text-sm">
      <div className="flex flex-col gap-1 px-4 py-3">
        <div className="flex items-center gap-2 font-semibold">
          <PlatformDot platform={platform} />
          <span>
            {STATE_TITLE[platform.state]}
            {platform.state === "connected" && platform.mode ? ` · ${pillLabel(platform)}` : ""}
          </span>
        </div>
        {platform.deployment ? (
          <div>
            <span className="text-fg-muted">Deployment</span> <span className="font-semibold">{platform.deployment}</span>
          </div>
        ) : null}
        {platform.url ? <div className="truncate font-mono text-xs text-fg-muted">{platform.url}</div> : null}
        {platform.message ? <p className="text-fg-muted">{platform.message}</p> : null}
      </div>
      {account ? (
        <div className="flex items-center gap-2 border-t border-line-muted px-4 py-3">
          {account.avatarUrl ? <img src={account.avatarUrl} alt="" className="avatar size-5" /> : null}
          <span className="truncate font-semibold">{account.name ?? account.login}</span>
          {account.name ? <span className="truncate text-fg-muted">@{account.login}</span> : null}
        </div>
      ) : null}
      <div className="border-t border-line-muted px-4 py-3">
        <div className="mb-2 text-xs font-semibold text-fg-muted">Environments</div>
        <ul className="flex flex-col gap-2">
          {LANES.map((lane) => {
            const availability = app.lanes.find((candidate) => candidate.lane === lane.id);
            const ready = availability?.available ?? false;
            return (
              <li key={lane.id} className="flex items-center gap-2" title={ready ? lane.summary : availability?.reason}>
                <CopilotIcon size={16} className="shrink-0 text-fg-muted" />
                <span className="truncate font-mono text-xs">{lane.environment}</span>
                <span className={cx("ml-auto shrink-0 text-xs", ready ? "text-fg-muted" : "text-fg-danger")}>{ready ? lane.pattern : "Not available"}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function Account() {
  const account = useStore((current) => current.app?.platform.account);
  const [imageFailed, setImageFailed] = useState(false);
  if (!account) return null;
  const name = account.name ?? account.login;
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <>
      <span className="AppHeader-divider max-sm:hidden" aria-hidden />
      <Tooltip content={account.name ? `${account.name} (@${account.login})` : `@${account.login}`}>
        <span className="inline-flex shrink-0">
          {account.avatarUrl && !imageFailed ? (
            <img src={account.avatarUrl} alt="" className="avatar size-8" onError={() => setImageFailed(true)} />
          ) : (
            <span className="avatar avatar-initials size-8 text-xs" aria-hidden>
              {initials}
            </span>
          )}
          <span className="sr-only">Signed in as {account.login}</span>
        </span>
      </Tooltip>
    </>
  );
}
