import { CloudIcon, CopilotIcon, LightBulbIcon, MarkGithubIcon, MailIcon, SignOutIcon, ThreeBarsIcon } from "@primer/octicons-react";
import { useEffect, useRef, useState } from "react";
import type { BillingInfo, UserView } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { navigate } from "../lib/router.js";
import { setMemoryOpen, setSidebarOpen, signOut, useStore } from "../lib/store.js";
import { Avatar, Spinner } from "./ui/index.js";

/** Where this person's model use goes, in one chip: their Copilot plan, or the app's Azure AI Foundry. */
export function BillingChip({ billing, compact = false }: { readonly billing: BillingInfo; readonly compact?: boolean }) {
  const Glyph = billing.route === "copilot" ? CopilotIcon : CloudIcon;
  const left = billing.remainingToday !== undefined && billing.dailyLimit !== undefined ? `${billing.remainingToday} of ${billing.dailyLimit} messages left today` : undefined;
  return (
    <span className={cx("Label", billing.route === "copilot" ? "Label--done" : "Label--accent", "gap-1")} title={`${billing.detail}${left ? ` ${left}.` : ""}`}>
      <Glyph size={12} />
      {compact ? (billing.route === "copilot" ? "Your Copilot" : "Front Desk pays") : billing.label}
    </span>
  );
}

export function Header({ user }: { readonly user: UserView }) {
  const memoryOpen = useStore((state) => state.memoryOpen);
  const memories = useStore((state) => state.memories.length);
  const stream = useStore((state) => state.stream);
  return (
    <header className="AppHeader relative z-30 shrink-0">
      <div className="AppHeader-globalBar gap-2 sm:gap-3">
        <button type="button" className="AppHeader-button lg:hidden" aria-label="Show your conversations" onClick={() => setSidebarOpen(true)}>
          <ThreeBarsIcon size={16} />
        </button>
        <a
          href="/"
          className="AppHeader-logo"
          aria-label="Front Desk home"
          onClick={(event) => {
            event.preventDefault();
            navigate("/");
          }}
        >
          <MarkGithubIcon size={32} />
        </a>
        <nav className="AppHeader-context" aria-label="Breadcrumb">
          <span className="AppHeader-context-item max-sm:hidden">Managed Copilot</span>
          <span className="AppHeader-context-divider max-sm:hidden" aria-hidden>
            /
          </span>
          <a
            href="/"
            className="AppHeader-context-item AppHeader-context-item--current"
            onClick={(event) => {
              event.preventDefault();
              navigate("/");
            }}
          >
            Front Desk
          </a>
        </nav>
        <div className="AppHeader-actions min-w-0">
          {stream === "reconnecting" ? (
            <span role="status" className="inline-flex shrink-0 items-center gap-1.5 text-xs text-fg-muted">
              <Spinner size={14} className="text-fg-attention" />
              <span className="max-md:hidden">Reconnecting…</span>
            </span>
          ) : null}
          <span className="max-md:hidden">
            <BillingChip billing={user.billing} />
          </span>
          <button
            type="button"
            className={cx("btn btn-sm", memoryOpen && "btn-primary")}
            aria-pressed={memoryOpen}
            aria-label={`What Front Desk remembers about you (${memories})`}
            onClick={() => setMemoryOpen(!memoryOpen)}
          >
            <LightBulbIcon size={16} />
            <span className="max-sm:hidden">Memory</span>
            <span className="Counter">{memories}</span>
          </button>
          <span className="AppHeader-divider max-sm:hidden" aria-hidden />
          <AccountMenu user={user} />
        </div>
      </div>
    </header>
  );
}

function AccountMenu({ user }: { readonly user: UserView }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={container} className="relative">
      <button type="button" className="inline-flex rounded-full" aria-haspopup="menu" aria-expanded={open} aria-label={`Account: ${user.name}`} onClick={() => setOpen((value) => !value)}>
        <Avatar name={user.name} {...(user.avatarUrl ? { src: user.avatarUrl } : {})} size={32} />
      </button>
      {open ? (
        <div role="menu" className="Overlay absolute top-full right-0 z-40 mt-2 w-[19rem] max-w-[calc(100vw-2rem)] animate-scale-in">
          <div className="flex items-center gap-3 border-b border-line-muted p-4">
            <Avatar name={user.name} {...(user.avatarUrl ? { src: user.avatarUrl } : {})} size={40} />
            <div className="min-w-0">
              <div className="truncate font-semibold">{user.name}</div>
              <div className="flex items-center gap-1 truncate text-xs text-fg-muted">
                {user.kind === "github" ? <MarkGithubIcon size={12} /> : <MailIcon size={12} />}
                {user.kind === "github" ? `@${user.login}` : user.email}
              </div>
            </div>
          </div>
          <div className="border-b border-line-muted p-4 text-xs text-fg-muted">
            <div className="mb-1.5">
              <BillingChip billing={user.billing} />
            </div>
            {user.billing.detail}
            {user.billing.remainingToday !== undefined ? ` ${user.billing.remainingToday} of ${user.billing.dailyLimit} messages left today.` : null}
          </div>
          <ul className="ActionList">
            <li>
              <button type="button" role="menuitem" className="ActionList-item w-full" onClick={() => void signOut()}>
                <SignOutIcon size={16} />
                <span className="ActionList-item-label">Sign out</span>
              </button>
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}
