import { CommentDiscussionIcon, ContainerIcon, PlusIcon, ShieldIcon, XIcon } from "@primer/octicons-react";
import { useEffect, useId, useRef } from "react";
import type { ConversationSummary } from "../../shared/types.js";
import { buttonClass, IconButton } from "./ui/Button.js";
import { EmptyState } from "./ui/Feedback.js";
import { Spinner } from "./ui/Spinner.js";
import { formatRelative, plural } from "../lib/format.js";
import { conversationHref, homeHref } from "../lib/router.js";
import { useStore } from "../lib/store.js";
import { useNow } from "../lib/useNow.js";

export interface SidebarProps {
  readonly activeId?: string;
  readonly drawerOpen: boolean;
  readonly onCloseDrawer: () => void;
}

export function Sidebar({ activeId, drawerOpen, onCloseDrawer }: SidebarProps) {
  return (
    <>
      <aside className="hidden w-64 shrink-0 border-r border-line bg-canvas lg:block xl:w-72" aria-label="Conversations">
        <SidebarContent activeId={activeId} />
      </aside>
      {drawerOpen ? <Drawer activeId={activeId} onClose={onCloseDrawer} /> : null}
    </>
  );
}

/** The conversation list as a side sheet on small screens. */
function Drawer({ activeId, onClose }: { readonly activeId?: string; readonly onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="absolute inset-0 animate-fade-in bg-backdrop" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Conversations"
        tabIndex={-1}
        className="absolute inset-y-0 left-0 flex w-[min(20rem,88vw)] animate-fade-in flex-col rounded-r-lg bg-canvas-overlay shadow-xl outline-none"
      >
        <SidebarContent activeId={activeId} onNavigate={onClose} onClose={onClose} />
      </div>
    </div>
  );
}

function SidebarContent({ activeId, onNavigate, onClose }: { readonly activeId?: string; readonly onNavigate?: () => void; readonly onClose?: () => void }) {
  const conversations = useStore((state) => state.conversations);
  const now = useNow(true, 20_000);
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-12 items-center gap-2 px-4 pt-4">
        <h2 className="text-sm font-semibold">Conversations</h2>
        {conversations.length > 0 ? <span className="Counter">{conversations.length}</span> : null}
        {onClose ? (
          <div className="-my-2 ml-auto">
            <IconButton icon={XIcon} label="Close conversations" onClick={onClose} />
          </div>
        ) : null}
      </div>
      <div className="px-4 pt-2 pb-3">
        <a href={homeHref()} onClick={onNavigate} className={buttonClass("default", "md", "btn-block")}>
          <PlusIcon size={16} />
          New conversation
        </a>
      </div>
      <nav aria-label="Conversation list" className="min-h-0 flex-1 overflow-y-auto border-t border-line-muted px-2 pt-2 pb-4">
        {conversations.length === 0 ? (
          <EmptyState icon={CommentDiscussionIcon} title="No conversations yet" size="sm">
            Ask for something, and watch the agent create sandboxes for it.
          </EmptyState>
        ) : (
          <ul className="NavList">
            {conversations.map((summary) => (
              <li key={summary.id}>
                <ConversationItem summary={summary} active={summary.id === activeId} now={now} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        )}
      </nav>
    </div>
  );
}

function StatusGlyph({ summary }: { readonly summary: ConversationSummary }) {
  if (summary.status === "working") return <Spinner size={16} className="mt-0.5 text-fg-attention" label="Working" />;
  if (summary.status === "asking") return <ShieldIcon size={16} className="mt-0.5 text-fg-attention" aria-label="Waiting for your approval" />;
  return <CommentDiscussionIcon size={16} className="mt-0.5 text-fg-muted" />;
}

function ConversationItem({ summary, active, now, onNavigate }: { readonly summary: ConversationSummary; readonly active: boolean; readonly now: number; readonly onNavigate?: () => void }) {
  const id = useId();
  const state = summary.status === "asking" ? "Needs your approval" : summary.status === "working" ? "Working" : formatRelative(summary.updatedAt, now);
  return (
    <a href={conversationHref(summary.id)} onClick={onNavigate} aria-current={active ? "page" : undefined} aria-labelledby={`${id}-title ${id}-meta`} className="NavList-item items-start py-2">
      <StatusGlyph summary={summary} />
      <span className="min-w-0 flex-1">
        <span id={`${id}-title`} className="block truncate" title={summary.title}>
          {summary.title}
        </span>
        <span id={`${id}-meta`} className="mt-0.5 block truncate text-xs font-normal text-fg-muted">
          {plural(summary.messageCount, "message")} · <span className={summary.status === "asking" ? "font-semibold text-fg-attention" : undefined}>{state}</span>
        </span>
      </span>
      {summary.sandboxCount > 0 ? (
        <span
          className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs font-normal text-fg-muted tabular-nums"
          title={`${plural(summary.sandboxCount, "sandbox", "sandboxes")} created, ${summary.liveSandboxes} still running`}
        >
          <ContainerIcon size={14} />
          {summary.liveSandboxes}
          <span className="sr-only"> of {summary.sandboxCount} sandboxes running</span>
        </span>
      ) : null}
    </a>
  );
}
