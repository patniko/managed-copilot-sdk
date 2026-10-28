import { DotFillIcon, MarkGithubIcon, ThreeBarsIcon, TriangleDownIcon } from "@primer/octicons-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import type { PlatformStatus } from "../../shared/types.js";
import { KIND_ICON, networkSummary, sizeSummary } from "../lib/blueprints.js";
import { cx } from "../lib/cx.js";
import { initials } from "../lib/format.js";
import { homeHref } from "../lib/router.js";
import { useStore } from "../lib/store.js";
import { TONE_TEXT, type Tone } from "../lib/tone.js";
import { useDismiss } from "../lib/useDismiss.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

/** github.com's global header: logo, `Managed Copilot / Dispatch` breadcrumb, and actions on the right. */
export function AppHeaderBar({ onOpenMenu, actions }: { readonly onOpenMenu?: () => void; readonly actions?: ReactNode }) {
  return (
    <header className="AppHeader relative z-30 shrink-0">
      <div className="AppHeader-globalBar gap-2 sm:gap-3">
        {onOpenMenu ? (
          <button type="button" className="AppHeader-button lg:hidden" aria-label="Show conversations" onClick={onOpenMenu}>
            <ThreeBarsIcon size={16} />
          </button>
        ) : null}
        <a href={homeHref()} className="AppHeader-logo" aria-label="Dispatch home">
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
            <span className="truncate">Dispatch</span>
          </a>
        </nav>
        {actions ? <div className="AppHeader-actions min-w-0">{actions}</div> : null}
      </div>
    </header>
  );
}

export function TopBar({ onOpenMenu }: { readonly onOpenMenu: () => void }) {
  return (
    <AppHeaderBar
      onOpenMenu={onOpenMenu}
      actions={
        <>
          <ConnectionIndicator />
          <PlatformButton />
          <AccountAvatar />
        </>
      }
    />
  );
}

function ConnectionIndicator() {
  const connection = useStore((state) => state.connection);
  if (connection !== "reconnecting") return null;
  return (
    <span role="status" className="inline-flex shrink-0 animate-fade-in items-center gap-1.5 text-xs text-fg-muted">
      <Spinner size={16} className="text-fg-attention" />
      <span className="max-md:hidden">Reconnecting…</span>
    </span>
  );
}

export function platformTone(platform: PlatformStatus): { tone: Tone; pulse: boolean; label: string } {
  switch (platform.state) {
    case "connected":
      return { tone: "success", pulse: false, label: platform.deployment ?? "Managed Copilot" };
    case "connecting":
      return { tone: "active", pulse: true, label: "Connecting" };
    case "reconnecting":
      return { tone: "active", pulse: true, label: "Reconnecting" };
    case "unavailable":
      return { tone: "danger", pulse: false, label: "Unavailable" };
  }
}

function Dot({ tone, pulse }: { readonly tone: Tone; readonly pulse: boolean }) {
  return pulse ? <Spinner size={12} className={TONE_TEXT[tone]} /> : <DotFillIcon size={16} className={TONE_TEXT[tone]} />;
}

function PlatformButton() {
  const platform = useStore((state) => state.platform);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(container, open, close);
  if (!platform) return null;
  const pill = platformTone(platform);
  return (
    <div ref={container} className="relative min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Platform: ${pill.label}${platform.mode ? ` (${platform.mode})` : ""}. Show deployment details`}
        onClick={() => setOpen((value) => !value)}
        className="btn btn-sm max-w-full min-w-0"
      >
        <Dot tone={pill.tone} pulse={pill.pulse} />
        <span className="max-w-[14rem] min-w-0 truncate max-sm:hidden">{pill.label}</span>
        {platform.mode ? <span className="font-normal text-fg-muted max-sm:hidden">{platform.mode}</span> : null}
        <TriangleDownIcon size={16} />
      </button>
      {open ? <PlatformPopover platform={platform} /> : null}
    </div>
  );
}

function PlatformPopover({ platform }: { readonly platform: PlatformStatus }) {
  const coordinator = useStore((state) => state.coordinator);
  const blueprints = useStore((state) => state.blueprints);
  return (
    <div role="dialog" aria-label="Deployment details" className="Overlay absolute top-full right-0 z-40 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] animate-scale-in">
      <div className="Overlay-body flex flex-col gap-3 p-4 text-sm">
        <div>
          <div className="font-semibold">{platform.state === "connected" ? `Connected to ${platform.deployment ?? "Managed Copilot"}` : platformTone(platform).label}</div>
          {platform.url ? <div className="mt-0.5 truncate font-mono text-xs text-fg-muted">{platform.url}</div> : null}
          {platform.message ? <p className="mt-2 text-fg-muted">{platform.message}</p> : null}
        </div>
        {coordinator ? (
          <div>
            <div className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Coordinator</div>
            <div className="mt-1">
              <span className="font-mono text-xs">{coordinator.environment}</span> · {coordinator.model} · up to {coordinator.maxWorkers} sandboxes at once
            </div>
          </div>
        ) : null}
        {blueprints.length ? (
          <div>
            <div className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Sandboxes it can create</div>
            <ul className="mt-1 flex flex-col gap-1">
              {blueprints.map((blueprint) => {
                const Glyph = KIND_ICON[blueprint.kind];
                return (
                  <li key={blueprint.name} className="flex items-center gap-2">
                    <Glyph size={14} className="shrink-0 text-fg-muted" />
                    <span className="font-mono text-xs">{blueprint.name}</span>
                    <span className="truncate text-xs text-fg-muted">
                      {sizeSummary(blueprint)} · {networkSummary(blueprint.network, blueprint.kind)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AccountAvatar() {
  const account = useStore((state) => state.platform?.account);
  const [imageFailed, setImageFailed] = useState(false);
  if (!account) return null;
  const name = account.name ?? account.login;
  return (
    <>
      <span className="AppHeader-divider max-sm:hidden" aria-hidden />
      <Tooltip content={account.name ? `${account.name} (@${account.login})` : `@${account.login}`}>
        <span className="inline-flex shrink-0">
          {account.avatarUrl && !imageFailed ? (
            <img src={account.avatarUrl} alt="" className="avatar size-8" onError={() => setImageFailed(true)} />
          ) : (
            <span className={cx("avatar avatar-initials size-8 text-xs")} aria-hidden>
              {initials(name)}
            </span>
          )}
          <span className="sr-only">Signed in as {account.login}</span>
        </span>
      </Tooltip>
    </>
  );
}
