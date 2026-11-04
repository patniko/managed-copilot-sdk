import { MarkGithubIcon, ThreeBarsIcon, TriangleDownIcon } from "@primer/octicons-react";
import { useEffect, useState, type ReactNode } from "react";
import { initials } from "../lib/format.js";
import { platformPill } from "../lib/platform.js";
import { useStore } from "../lib/store.js";
import { PlatformPopover } from "./PlatformPopover.js";
import { Dot } from "./ui/Chip.js";
import { Popover } from "./ui/Popover.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

/** github.com's global header: logo, `Managed Copilot / Software Factory` breadcrumb, and actions on the right. */
export function AppHeaderBar({ onOpenMenu, actions }: { readonly onOpenMenu?: () => void; readonly actions?: ReactNode }) {
  return (
    <header className="AppHeader relative z-30 shrink-0">
      <div className="AppHeader-globalBar gap-2 sm:gap-3">
        {onOpenMenu ? (
          <button type="button" className="AppHeader-button lg:hidden" aria-label="Show work orders" onClick={onOpenMenu}>
            <ThreeBarsIcon size={16} />
          </button>
        ) : null}
        <a href="#/" className="AppHeader-logo" aria-label="Software Factory home">
          <MarkGithubIcon size={32} />
        </a>
        <nav className="AppHeader-context" aria-label="Breadcrumb">
          <a href="#/" className="AppHeader-context-item max-sm:hidden">
            Managed Copilot
          </a>
          <span className="AppHeader-context-divider max-sm:hidden" aria-hidden>
            /
          </span>
          <a href="#/" className="AppHeader-context-item AppHeader-context-item--current">
            <span className="truncate">Software Factory</span>
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
          <PlatformStatusButton />
          <AccountAvatar />
        </>
      }
    />
  );
}

function ConnectionIndicator() {
  const connection = useStore((state) => state.connection);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (connection !== "reconnecting") {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 1200);
    return () => clearTimeout(timer);
  }, [connection]);
  if (!visible) return null;
  return (
    <span role="status" className="inline-flex shrink-0 animate-fade-in items-center gap-1.5 text-xs text-fg-muted">
      <Spinner size={16} className="text-fg-attention" />
      <span className="max-md:hidden">Reconnecting…</span>
      <span className="sr-only md:hidden">Reconnecting to the factory server</span>
    </span>
  );
}

function PlatformStatusButton() {
  const platform = useStore((state) => state.platform);
  if (!platform) return null;
  const pill = platformPill(platform);
  return (
    <Popover
      label="Platform details"
      overlayClassName="max-h-[calc(100dvh-5rem)] overflow-y-auto max-sm:fixed max-sm:inset-x-3 max-sm:top-16 max-sm:mt-0 sm:w-[24rem]"
      trigger={(props) => (
        <button {...props} type="button" aria-label={`Platform: ${pill.label}, ${pill.status.toLowerCase()}. Show details`} className="btn btn-sm max-w-full min-w-0">
          <Dot tone={pill.tone} pulse={pill.pulse} />
          <span className="max-w-[10rem] min-w-0 truncate">{pill.label}</span>
          <TriangleDownIcon size={16} />
        </button>
      )}
    >
      <PlatformPopover platform={platform} />
    </Popover>
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
            <span className="avatar avatar-initials size-8 text-xs" aria-hidden>
              {initials(name)}
            </span>
          )}
          <span className="sr-only">Signed in as {account.login}</span>
        </span>
      </Tooltip>
    </>
  );
}
