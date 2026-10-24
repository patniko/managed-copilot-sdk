import { ChevronDown, Factory, LoaderCircle, Menu } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { initials } from "../lib/format.js";
import { platformPill } from "../lib/platform.js";
import { useStore } from "../lib/store.js";
import { useDismiss } from "../lib/useDismiss.js";
import { PlatformPopover } from "./PlatformPopover.js";
import { IconButton } from "./ui/Button.js";
import { Dot } from "./ui/Chip.js";

export function TopBar({ onOpenMenu }: { readonly onOpenMenu: () => void }) {
  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/90 px-3 backdrop-blur sm:gap-3 sm:px-4">
      <IconButton icon={Menu} label="Show work orders" onClick={onOpenMenu} className="lg:hidden" />
      <a href="#/" className="flex min-w-0 items-center gap-2.5 rounded-lg pr-1" aria-label="Software Factory, new work order">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-linear-to-b from-amber-400/25 to-amber-500/10 text-amber-300 shadow-[0_0_18px_-6px_rgb(251_191_36/0.55)] ring-1 ring-inset ring-amber-400/30">
          <Factory className="size-[18px]" aria-hidden />
        </span>
        <span className="truncate text-[15px] font-semibold tracking-tight text-zinc-100">Software Factory</span>
        <span className="hidden truncate text-[13px] text-zinc-500 md:inline">on Managed Copilot</span>
      </a>
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <ConnectionIndicator />
        <PlatformStatusButton />
        <AccountBadge />
      </div>
    </header>
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
    <span
      role="status"
      className="inline-flex shrink-0 animate-fade-in items-center gap-1.5 rounded-full bg-zinc-900 px-2.5 py-1 text-xs text-zinc-400 ring-1 ring-inset ring-white/10"
    >
      <LoaderCircle className="size-3.5 animate-spin text-amber-300" aria-hidden />
      <span className="hidden sm:inline">Reconnecting…</span>
      <span className="sr-only sm:hidden">Reconnecting to the factory server</span>
    </span>
  );
}

function PlatformStatusButton() {
  const platform = useStore((state) => state.platform);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(container, open, close);
  if (!platform) return null;
  const pill = platformPill(platform);
  return (
    <div ref={container} className="relative min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Platform: ${pill.label}${pill.mode ? ` (${pill.mode})` : ""}. Show deployment details`}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-8 max-w-full min-w-0 items-center gap-2 rounded-full bg-zinc-900 pr-2 pl-3 text-xs font-medium ring-1 ring-inset ring-white/10 transition-colors hover:bg-zinc-800"
      >
        <Dot tone={pill.tone} pulse={pill.pulse} />
        <span className="max-w-[9rem] truncate text-zinc-200 sm:max-w-[16rem]">{pill.label}</span>
        {pill.mode ? (
          <span className="hidden rounded bg-zinc-800 px-1.5 py-px font-mono text-[10px] uppercase tracking-wide text-zinc-400 sm:inline">
            {pill.mode}
          </span>
        ) : null}
        <ChevronDown className={`size-3.5 shrink-0 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open ? <PlatformPopover platform={platform} /> : null}
    </div>
  );
}

function AccountBadge() {
  const account = useStore((state) => state.platform?.account);
  const [imageFailed, setImageFailed] = useState(false);
  if (!account) return null;
  const name = account.name ?? account.login;
  return (
    <div className="flex shrink-0 items-center gap-2" title={account.name ? `${account.name} (@${account.login})` : `@${account.login}`}>
      {account.avatarUrl && !imageFailed ? (
        <img
          src={account.avatarUrl}
          alt=""
          className="size-7 rounded-full bg-zinc-800 ring-1 ring-white/10"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span className="grid size-7 place-items-center rounded-full bg-zinc-800 text-[11px] font-semibold text-zinc-300 ring-1 ring-white/10" aria-hidden>
          {initials(name)}
        </span>
      )}
      <span className="hidden text-[13px] text-zinc-300 lg:inline">{account.login}</span>
      <span className="sr-only">Signed in as {account.login}</span>
    </div>
  );
}
