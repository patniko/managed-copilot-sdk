import { AlertIcon, ContainerIcon, CopilotIcon, HistoryIcon, SyncIcon, TerminalIcon, TrashIcon } from "@primer/octicons-react";
import { useEffect, useState } from "react";
import type { ConversationView as View } from "../../shared/types.js";
import { confirmAction } from "../lib/confirm.js";
import { conversationStats } from "../lib/conversation.js";
import { cx } from "../lib/cx.js";
import { plural } from "../lib/format.js";
import { conversationHref, type ConversationTab } from "../lib/router.js";
import { deleteConversation, loadConversation, openInCli, useStore } from "../lib/store.js";
import { STYLE_META } from "../lib/styles.js";
import { Chat } from "./Chat.js";
import { Environments } from "./Environments.js";
import { Timeline } from "./Timeline.js";
import { Button } from "./ui/Button.js";
import { CopyButton } from "./ui/CopyButton.js";
import { EmptyState } from "./ui/Feedback.js";
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
        <div className="SkeletonBox mb-3 h-8 w-1/3" />
        <div className="SkeletonBox mb-6 h-4 w-1/2" />
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
  const [pane, setPane] = useState<"chat" | "environments">("chat");
  const [deleting, setDeleting] = useState(false);
  const stats = conversationStats(view);
  const selected = view.workers.find((candidate) => candidate.id === worker);
  const style = styles.find((candidate) => candidate.style === view.style);
  const meta = STYLE_META[view.style];
  const StyleGlyph = meta.icon;
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-tight" title={view.title}>
            {view.title}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
            <span className="Label Label--secondary" title="One coordinator session handles the whole conversation">
              <CopilotIcon size={12} />
              Coordinator · {view.environment}
              {style?.coordinator ? ` · ${style.coordinator.model}` : ""}
            </span>
            <span className="Label Label--accent" title={`${meta.summary} A conversation keeps its style.`}>
              <StyleGlyph size={12} />
              {meta.short}
            </span>
            <span>{plural(stats.messages, "message")}</span>
            {view.style !== "delegate" ? (
              <>
                <span aria-hidden>·</span>
                <span>
                  <strong className="font-semibold text-fg">{stats.commands}</strong> {stats.commands === 1 ? "command" : "commands"}
                  {stats.subagents > 0 ? `, ${plural(stats.subagents, "sub-agent")}` : ""}
                </span>
              </>
            ) : null}
            {view.style !== "direct" ? (
              <>
                <span aria-hidden>·</span>
                <span>
                  <strong className="font-semibold text-fg">{stats.created}</strong> {stats.created === 1 ? "sandbox" : "sandboxes"} created
                </span>
                <span aria-hidden>·</span>
                <span>
                  <strong className="font-semibold text-fg">{stats.reused}</strong> reused
                </span>
              </>
            ) : null}
            {stats.stopped > 0 ? (
              <>
                <span aria-hidden>·</span>
                <span>{stats.stopped} stopped</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {canLaunch ? (
            <Button icon={TerminalIcon} onClick={() => void openInCli(view.id)}>
              Open in Copilot CLI
            </Button>
          ) : (
            <CopyButton text={view.attachCommand} label={`Copy the command that opens this conversation in Copilot CLI: ${view.attachCommand}`} variant="default" size="md">
              Copy Copilot CLI command
            </CopyButton>
          )}
          <Button variant="danger" icon={TrashIcon} loading={deleting} onClick={() => void remove()}>
            End and delete sandboxes
          </Button>
        </div>
      </header>

      <div className="border-b border-line px-4 py-2 xl:hidden">
        <div className="SegmentedControl SegmentedControl--sm" role="group" aria-label="Show">
          <button type="button" className="SegmentedControl-item" aria-current={pane === "chat"} onClick={() => setPane("chat")}>
            Conversation
          </button>
          <button type="button" className="SegmentedControl-item" aria-current={pane === "environments"} onClick={() => setPane("environments")}>
            Sandboxes {stats.live > 0 ? <span className="Counter">{stats.live}</span> : null}
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className={cx("flex min-h-0 flex-col border-line xl:border-r", pane !== "chat" && "max-xl:hidden")}>
          <Chat view={view} blueprints={blueprints} />
        </div>
        <div className={cx("flex min-h-0 flex-col bg-canvas-muted", pane !== "environments" && "max-xl:hidden")}>
          <nav aria-label="Sandboxes" className="UnderlineNav shrink-0 bg-canvas px-3">
            <ul className="UnderlineNav-body">
              <li>
                <a href={conversationHref(view.id, { ...(worker ? { worker } : {}) })} className="UnderlineNav-item" aria-current={tab === "environments" ? "page" : undefined}>
                  <ContainerIcon size={16} />
                  Environments
                </a>
              </li>
              <li>
                <a href={conversationHref(view.id, { tab: "timeline", ...(worker ? { worker } : {}) })} className="UnderlineNav-item" aria-current={tab === "timeline" ? "page" : undefined}>
                  <HistoryIcon size={16} />
                  Timeline
                </a>
              </li>
            </ul>
            <div className="ml-auto flex items-center gap-2 text-xs text-fg-muted max-2xl:hidden">
              <span className="Label Label--success">#1</span> created by message 1
              <span className="Label Label--accent">#2</span> sent work by message 2
            </div>
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
            {tab === "timeline" ? <Timeline view={view} blueprints={blueprints} selected={worker} /> : <Environments view={view} blueprints={blueprints} selected={worker} />}
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
