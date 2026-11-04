import { AlertIcon, CommentIcon, ContainerIcon, CopyIcon, HistoryIcon, SyncIcon, TerminalIcon, TrashIcon, TriangleDownIcon } from "@primer/octicons-react";
import { useEffect, useState } from "react";
import type { Blueprint, ConversationView as View, StyleInfo } from "../../shared/types.js";
import { copyText } from "../lib/clipboard.js";
import { confirmAction } from "../lib/confirm.js";
import { conversationStats, type ConversationStats } from "../lib/conversation.js";
import { cx } from "../lib/cx.js";
import { plural } from "../lib/format.js";
import { conversationHref, homeHref, type ConversationTab } from "../lib/router.js";
import { deleteConversation, loadConversation, openInCli, useStore } from "../lib/store.js";
import { STYLE_META } from "../lib/styles.js";
import { toast } from "../lib/toast.js";
import { usePopover } from "../lib/usePopover.js";
import { Chat } from "./Chat.js";
import { Sandboxes } from "./Sandboxes.js";
import { SharedRuntime, StyleDiagram } from "./Styles.js";
import { Timeline } from "./Timeline.js";
import { Button } from "./ui/Button.js";
import { EmptyState } from "./ui/Feedback.js";
import { OverflowMenu } from "./ui/Menu.js";
import { Tooltip } from "./ui/Tooltip.js";
import { WorkerDetail } from "./WorkerDetail.js";

export function ConversationPage({ id, tab, worker }: { readonly id: string; readonly tab: ConversationTab; readonly worker?: string }) {
  const view = useStore((state) => state.views[id]);
  const error = useStore((state) => state.viewErrors[id]);

  useEffect(() => {
    void loadConversation(id);
  }, [id]);

  if (!view) {
    if (error) {
      return (
        <div className="mx-auto mt-16 max-w-2xl px-4">
          <EmptyState
            icon={AlertIcon}
            title="This conversation can't be opened"
            action={
              <Button icon={SyncIcon} onClick={() => void loadConversation(id)}>
                Try again
              </Button>
            }
          >
            {error}
          </EmptyState>
        </div>
      );
    }
    return (
      <div className="p-6" aria-busy="true">
        <div className="SkeletonBox mb-6 h-7 w-1/3" />
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="SkeletonBox h-80" />
          <div className="SkeletonBox h-80" />
        </div>
      </div>
    );
  }
  return <Conversation view={view} tab={tab} worker={worker} />;
}

function Conversation({ view, tab, worker }: { readonly view: View; readonly tab: ConversationTab; readonly worker?: string }) {
  const allBlueprints = useStore((state) => state.blueprints);
  const styles = useStore((state) => state.styles);
  const canLaunch = useStore((state) => state.canLaunchTerminal);
  const [pane, setPane] = useState<"chat" | "sandboxes">("chat");
  const [deleting, setDeleting] = useState(false);
  const stats = conversationStats(view);
  const selected = view.workers.find((candidate) => candidate.id === worker);
  const style = styles.find((candidate) => candidate.style === view.style);
  // The blueprints this conversation's coordinator can use: its own sandbox's, and (delegate, mixed) its workers'.
  const usable = style?.available ? new Set([...(style.handsEnvironment ? [style.handsEnvironment] : []), ...style.workers]) : undefined;
  const blueprints = usable ? allBlueprints.filter((blueprint) => usable.has(blueprint.name)) : allBlueprints;

  const remove = async (): Promise<void> => {
    const confirmed = await confirmAction({
      title: "End this conversation?",
      message: `The coordinator session${stats.live > 0 ? ` and its ${plural(stats.live, "sandbox", "sandboxes")}` : ""} are deleted, with their files. This can't be undone.`,
      confirmLabel: "End and delete",
      tone: "danger",
    });
    if (!confirmed) return;
    setDeleting(true);
    await deleteConversation(view.id);
    setDeleting(false);
  };

  const copyAttach = async (): Promise<void> => {
    if (await copyText(view.attachCommand)) toast.success("Copied the Copilot CLI command", view.attachCommand);
    else toast.error("Couldn't copy to the clipboard", view.attachCommand);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight" title={view.title}>
            {view.title}
          </h1>
          <StyleBadge view={view} info={style} blueprints={allBlueprints} />
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Counters view={view} stats={stats} />
          <Button size="sm" icon={TerminalIcon} onClick={() => (canLaunch ? void openInCli(view.id) : void copyAttach())} aria-label={canLaunch ? "Open in Copilot CLI" : "Copy the command that opens this conversation in Copilot CLI"}>
            <span className="max-sm:sr-only">{canLaunch ? "Open in Copilot CLI" : "Copy CLI command"}</span>
          </Button>
          <OverflowMenu
            label="Conversation actions"
            items={[
              ...(canLaunch ? [{ label: "Copy Copilot CLI command", icon: CopyIcon, onSelect: () => void copyAttach() }] : []),
              { label: deleting ? "Deleting…" : "End and delete sandboxes", icon: TrashIcon, danger: true, disabled: deleting, onSelect: () => void remove() },
            ]}
          />
        </div>
      </header>

      <div className="border-b border-line px-4 py-2 xl:hidden">
        <div className="SegmentedControl SegmentedControl--sm" role="group" aria-label="Show">
          <button type="button" className="SegmentedControl-item" aria-current={pane === "chat"} onClick={() => setPane("chat")}>
            Conversation
          </button>
          <button type="button" className="SegmentedControl-item" aria-current={pane === "sandboxes"} onClick={() => setPane("sandboxes")}>
            Sandboxes {stats.live > 0 ? <span className="Counter">{stats.live}</span> : null}
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className={cx("flex min-h-0 flex-col border-line xl:border-r", pane !== "chat" && "max-xl:hidden")}>
          <Chat view={view} blueprints={blueprints} />
        </div>
        <div className={cx("flex min-h-0 flex-col bg-canvas-inset", pane !== "sandboxes" && "max-xl:hidden")}>
          <nav aria-label="Sandboxes and timeline" className="UnderlineNav shrink-0 bg-canvas px-3">
            <ul className="UnderlineNav-body">
              <li>
                <a href={conversationHref(view.id, { ...(worker ? { worker } : {}) })} className="UnderlineNav-item" aria-current={tab === "sandboxes" ? "page" : undefined}>
                  <ContainerIcon size={16} />
                  Sandboxes
                  {stats.live > 0 ? <span className="Counter">{stats.live}</span> : null}
                </a>
              </li>
              <li>
                <a href={conversationHref(view.id, { tab: "timeline", ...(worker ? { worker } : {}) })} className="UnderlineNav-item" aria-current={tab === "timeline" ? "page" : undefined}>
                  <HistoryIcon size={16} />
                  Timeline
                </a>
              </li>
            </ul>
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
            {tab === "timeline" ? <Timeline view={view} blueprints={blueprints} selected={worker} /> : <Sandboxes view={view} blueprints={blueprints} info={style} selected={worker} />}
            {selected ? (
              <div className="mt-3">
                <WorkerDetail key={selected.id} view={view} worker={selected} blueprints={blueprints} tab={tab} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The conversation's style, read-only: its popover says who coordinates, on what, with which model. */
function StyleBadge({ view, info, blueprints }: { readonly view: View; readonly info: StyleInfo | undefined; readonly blueprints: readonly Blueprint[] }) {
  const { open, toggle, container } = usePopover();
  const meta = STYLE_META[view.style];
  const Glyph = meta.icon;
  const hands = info?.handsEnvironment ? blueprints.find((blueprint) => blueprint.name === info.handsEnvironment) : undefined;
  return (
    <div ref={container} className="relative shrink-0">
      <button type="button" className="Label Label--accent cursor-pointer hover:bg-accent-muted" aria-expanded={open} aria-haspopup="dialog" onClick={toggle} title="How this conversation's agent works">
        <Glyph size={12} />
        {meta.short}
        <TriangleDownIcon size={12} />
      </button>
      {open ? (
        <div role="dialog" aria-label={meta.label} className="Overlay absolute top-full left-0 z-40 mt-2 w-80 animate-scale-in max-sm:-left-24">
          <div className="border-b border-line-muted px-4 py-3">
            <div className="flex items-center gap-1.5 font-semibold">
              <Glyph size={16} className="text-fg-muted" />
              {meta.label}
            </div>
            <StyleDiagram style={view.style} className="mt-2.5" stacked />
          </div>
          <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-4 py-3 text-sm">
            <dt className="text-fg-muted">Coordinator</dt>
            <dd className="truncate font-mono text-xs leading-5">{view.environment}</dd>
            <dt className="text-fg-muted">Runs on</dt>
            <dd>
              <SharedRuntime />
            </dd>
            {info?.coordinator ? (
              <>
                <dt className="text-fg-muted">Model</dt>
                <dd className="truncate">{info.coordinator.model}</dd>
              </>
            ) : null}
            {hands ? (
              <>
                <dt className="text-fg-muted">Its sandbox</dt>
                <dd className="truncate">{hands.label}</dd>
              </>
            ) : null}
          </dl>
          <p className="border-t border-line-muted px-4 py-2 text-xs text-fg-muted">
            A conversation keeps its style.{" "}
            <a href={homeHref()} className="Link">
              Start a new one
            </a>{" "}
            to try another.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Counter({ icon: Glyph, count, label }: { readonly icon: typeof ContainerIcon; readonly count: number; readonly label: string }) {
  return (
    <Tooltip content={label}>
      <span className="inline-flex items-center gap-1 text-sm text-fg-muted tabular-nums" aria-label={label}>
        <Glyph size={16} />
        {count}
      </span>
    </Tooltip>
  );
}

function Counters({ view, stats }: { readonly view: View; readonly stats: ConversationStats }) {
  const sandboxes = [plural(stats.created, "sandbox", "sandboxes"), stats.reused ? `${stats.reused} reused` : "", stats.stopped ? `${stats.stopped} deleted` : ""].filter(Boolean).join(" · ");
  return (
    <span className="flex items-center gap-3 max-md:hidden">
      <Counter icon={ContainerIcon} count={stats.created} label={sandboxes} />
      {view.style !== "delegate" ? (
        <Counter icon={TerminalIcon} count={stats.commands} label={[plural(stats.commands, "command"), stats.subagents ? plural(stats.subagents, "sub-agent") : ""].filter(Boolean).join(" · ")} />
      ) : null}
      <Counter icon={CommentIcon} count={stats.messages} label={plural(stats.messages, "message")} />
    </span>
  );
}
