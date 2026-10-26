import { ArrowDownIcon } from "@primer/octicons-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TimelineItem } from "../../../shared/protocol";
import { buildBlocks } from "../timelineBlocks";
import type { PendingMessage } from "../useAssistant";
import { ApprovalCard } from "./ApprovalCard";
import { AssistantMessage, NoticeLine, ToolRow, TriggerRow, TypingIndicator, UserBubble } from "./Items";

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
  /** Set while background work is off: tool rows blocked by it offer to turn it on. */
  onOpenBackground?: () => void;
  onAtBottomChange(atBottom: boolean): void;
}

function Divider({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "accent" }) {
  const line = tone === "accent" ? "bg-line-accent" : "bg-line-muted";
  return (
    <div className={`flex items-center gap-3 text-xs font-semibold ${tone === "accent" ? "text-fg-accent" : "text-fg-muted"}`}>
      <span className={`h-px flex-1 ${line}`} aria-hidden />
      {children}
      <span className={`h-px flex-1 ${line}`} aria-hidden />
    </div>
  );
}

export function Timeline(props: TimelineProps) {
  const { items, pending, timeZone, busy, unreadAnchor } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const unreadRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);
  const initialScrollDone = useRef(false);
  /** The unread divider already scrolled to (it can arrive after the first render, once the live history loads). */
  const anchoredTo = useRef<string | undefined>(undefined);
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
    if (unreadAnchor && anchoredTo.current !== unreadAnchor && unreadRef.current) {
      anchoredTo.current = unreadAnchor;
      initialScrollDone.current = true;
      unreadRef.current.scrollIntoView({ block: "start" });
      el.scrollTop -= 16;
    } else if (!initialScrollDone.current) {
      initialScrollDone.current = true;
      el.scrollTop = el.scrollHeight;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    // Short content never fires a scroll event, so always report the position after layout.
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, pending.length, streamingText, showTyping, unreadAnchor]);

  useEffect(() => {
    if (items.length > 0) return;
    initialScrollDone.current = false;
    anchoredTo.current = undefined;
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
      <div ref={scroller} onScroll={measure} className="h-full overflow-y-auto" role="log" aria-live="polite" aria-relevant="additions">
        {isEmpty ? (
          props.empty
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pt-6 pb-8 md:px-6">
            {blocks.map((block) => {
              switch (block.type) {
                case "day":
                  return <Divider key={block.key}>{block.label}</Divider>;
                case "unread":
                  return (
                    <div key={block.key} ref={unreadRef}>
                      <Divider tone="accent">New since you were away</Divider>
                    </div>
                  );
                case "run":
                  return (
                    <div key={block.key} className="timeline-run">
                      {block.items.map((entry) =>
                        entry.kind === "tool" ? (
                          <ToolRow key={entry.id} item={entry} onOpenSchedule={props.onOpenSchedule} onOpenBackground={props.onOpenBackground} />
                        ) : entry.kind === "trigger" ? (
                          <TriggerRow key={entry.id} item={entry} timeZone={timeZone} />
                        ) : (
                          <NoticeLine key={entry.id} item={entry} />
                        ),
                      )}
                    </div>
                  );
                case "item": {
                  const item = block.item;
                  switch (item.kind) {
                    case "user":
                      return <UserBubble key={block.key} text={item.text} at={item.at} timeZone={timeZone} />;
                    case "assistant":
                      return <AssistantMessage key={block.key} item={item} timeZone={timeZone} scheduleLabel={block.scheduleLabel} />;
                    case "notice":
                      return <NoticeLine key={block.key} item={item} />;
                    case "approval":
                      return (
                        <ApprovalCard
                          key={block.key}
                          item={item}
                          outcome={block.outcome}
                          timeZone={timeZone}
                          onDecide={(decision, feedback) => props.onDecide(item.id, decision, feedback)}
                        />
                      );
                  }
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
        <button type="button" onClick={jump} className="btn btn-sm absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-lg">
          <ArrowDownIcon />
          Jump to latest
        </button>
      )}
    </div>
  );
}
