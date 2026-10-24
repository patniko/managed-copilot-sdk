import { ArrowDown } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TimelineItem, ToolItem } from "../../../shared/protocol";
import { dayKey, dayLabel } from "../format";
import type { PendingMessage } from "../useAssistant";
import { ApprovalCard } from "./ApprovalCard";
import { AssistantMessage, NoticeLine, ToolRow, TriggerPill, TypingIndicator, UserBubble } from "./Items";

type Block =
  | { type: "day"; key: string; label: string }
  | { type: "unread"; key: string }
  | { type: "item"; key: string; item: TimelineItem; scheduleLabel?: string; outcome?: ToolItem }
  | { type: "tools"; key: string; items: ToolItem[] };

export interface TimelineProps {
  items: readonly TimelineItem[];
  pending: readonly PendingMessage[];
  timeZone: string;
  busy: boolean;
  unreadAnchor: string | undefined;
  empty: ReactNode;
  onDecide(id: string, decision: "approve" | "deny", feedback?: string): Promise<unknown>;
  onRetry(message: PendingMessage): void;
  onDiscard(localId: string): void;
  onOpenSchedule(id: string): void;
  onAtBottomChange(atBottom: boolean): void;
}

function buildBlocks(items: readonly TimelineItem[], timeZone: string, unreadAnchor: string | undefined): Block[] {
  const blocks: Block[] = [];
  // A consequential tool call's progress is shown inside its approval card instead of as a separate row.
  const approvalIds = new Set(items.filter((item) => item.kind === "approval").map((item) => item.id));
  const outcomes = new Map<string, ToolItem>();
  for (const item of items) {
    if (item.kind === "tool" && approvalIds.has(`approval:${item.id}`)) outcomes.set(`approval:${item.id}`, item);
  }
  let lastDay: string | undefined;
  let tools: ToolItem[] | undefined;
  let scheduleLabel: string | undefined;
  const flush = () => {
    if (tools?.length) blocks.push({ type: "tools", key: `tools:${tools[0]!.id}`, items: tools });
    tools = undefined;
  };
  for (const item of items) {
    if (item.kind === "tool" && outcomes.has(`approval:${item.id}`)) continue;
    const day = dayKey(item.at, timeZone);
    if (day !== lastDay) {
      flush();
      blocks.push({ type: "day", key: `day:${day}`, label: dayLabel(item.at, timeZone) });
      lastDay = day;
    }
    if (item.id === unreadAnchor) {
      flush();
      blocks.push({ type: "unread", key: "unread" });
    }
    if (item.kind === "tool") {
      (tools ??= []).push(item);
      continue;
    }
    flush();
    if (item.kind === "trigger") scheduleLabel = item.scheduleName;
    if (item.kind === "user") scheduleLabel = undefined;
    blocks.push({
      type: "item",
      key: item.id,
      item,
      scheduleLabel: item.kind === "assistant" && item.proactive ? scheduleLabel : undefined,
      outcome: item.kind === "approval" ? outcomes.get(item.id) : undefined,
    });
  }
  flush();
  return blocks;
}

export function Timeline(props: TimelineProps) {
  const { items, pending, timeZone, busy, unreadAnchor } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const unreadRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);
  const initialScrollDone = useRef(false);
  const blocks = useMemo(() => buildBlocks(items, timeZone, unreadAnchor), [items, timeZone, unreadAnchor]);
  const lastItem = items[items.length - 1];
  const streamingText = lastItem?.kind === "assistant" ? lastItem.text.length : 0;
  const showTyping = busy && !(lastItem?.kind === "assistant" && lastItem.streaming) && !(lastItem?.kind === "approval" && lastItem.status === "pending");
  const isEmpty = items.length === 0 && pending.length === 0;

  const measure = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = bottom;
    setAtBottom(bottom);
    props.onAtBottomChange(bottom);
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || items.length === 0) return;
    if (!initialScrollDone.current) {
      initialScrollDone.current = true;
      if (unreadRef.current) {
        unreadRef.current.scrollIntoView({ block: "start" });
        el.scrollTop -= 16;
      } else {
        el.scrollTop = el.scrollHeight;
      }
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    // Short content never fires a scroll event, so always report the position after layout.
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, pending.length, streamingText, showTyping]);

  useEffect(() => {
    if (items.length === 0) initialScrollDone.current = false;
  }, [items.length]);

  // Report the position on mount too: the timeline remounts after loading states.
  useEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stick.current = true;
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={measure} className="h-full overflow-y-auto scrollbar-thin" role="log" aria-live="polite" aria-relevant="additions">
        {isEmpty ? (
          props.empty
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pt-6 pb-8 sm:px-6">
            {blocks.map((block) => {
              switch (block.type) {
                case "day":
                  return (
                    <div key={block.key} className="flex items-center gap-3 text-[11px] font-medium tracking-wide text-zinc-400 uppercase">
                      <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                      {block.label}
                      <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                    </div>
                  );
                case "unread":
                  return (
                    <div key={block.key} ref={unreadRef} className="flex items-center gap-3 text-[11px] font-semibold tracking-wide text-violet-600 uppercase dark:text-violet-400">
                      <div className="h-px flex-1 bg-violet-300 dark:bg-violet-700" />
                      New since you were away
                      <div className="h-px flex-1 bg-violet-300 dark:bg-violet-700" />
                    </div>
                  );
                case "tools":
                  return (
                    <ul key={block.key} className="ml-11 rounded-xl border border-dashed border-zinc-200 bg-white/60 px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/40">
                      {block.items.map((tool) => (
                        <ToolRow key={tool.id} item={tool} onOpenSchedule={props.onOpenSchedule} />
                      ))}
                    </ul>
                  );
                case "item": {
                  const item = block.item;
                  return (
                    <Fragment key={block.key}>
                      {item.kind === "user" && <UserBubble text={item.text} at={item.at} timeZone={timeZone} />}
                      {item.kind === "assistant" && <AssistantMessage item={item} timeZone={timeZone} scheduleLabel={block.scheduleLabel} />}
                      {item.kind === "trigger" && <TriggerPill item={item} timeZone={timeZone} />}
                      {item.kind === "notice" && <NoticeLine item={item} />}
                      {item.kind === "approval" && (
                        <ApprovalCard item={item} outcome={block.outcome} timeZone={timeZone} onDecide={(decision, feedback) => props.onDecide(item.id, decision, feedback)} />
                      )}
                    </Fragment>
                  );
                }
              }
            })}
            {pending.map((message) => (
              <UserBubble
                key={message.localId}
                text={message.text}
                at={message.at}
                timeZone={timeZone}
                pending={{ ...message, onRetry: () => props.onRetry(message), onDiscard: () => props.onDiscard(message.localId) }}
              />
            ))}
            {showTyping && <TypingIndicator />}
          </div>
        )}
      </div>
      {!atBottom && !isEmpty && (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-md ring-1 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-zinc-700"
        >
          <ArrowDown className="size-3.5" aria-hidden />
          Jump to latest
        </button>
      )}
    </div>
  );
}
