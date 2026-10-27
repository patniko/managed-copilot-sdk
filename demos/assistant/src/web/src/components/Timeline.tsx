import { ArrowDownIcon } from "@primer/octicons-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SandboxesView, TimelineItem } from "../../../shared/protocol";
import { replyImages, sandboxCardStates } from "../sandboxCards";
import { buildBlocks } from "../timelineBlocks";
import type { PendingMessage } from "../useAssistant";
import { ApprovalCard } from "./ApprovalCard";
import { AssistantMessage, NoticeLine, ToolRow, TriggerRow, TypingIndicator, UserBubble } from "./Items";
import { SandboxCard, SandboxImages } from "./Sandbox";

export interface TimelineProps {
  items: readonly TimelineItem[];
  pending: readonly PendingMessage[];
  timeZone: string;
  busy: boolean;
  unreadAnchor: string | undefined;
  empty: ReactNode;
  /** The conversation's sandboxes: live state, timing, and outputs for the sandbox cards. */
  sandboxes?: SandboxesView;
  /** A sandbox card to draw attention to (opened from the side panel). */
  highlightCard?: string;
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
  const stateOf = useMemo(() => sandboxCardStates(items, props.sandboxes), [items, props.sandboxes]);
  const images = useMemo(() => replyImages(items, stateOf), [items, stateOf]);
  const lastItem = items[items.length - 1];
  const streamingText = lastItem?.kind === "assistant" ? lastItem.text.length : 0;
  // While a sandbox works, its card shows the progress: the assistant is only waiting for it. Right after a new message
  // (for example a question asked meanwhile), the assistant is answering, so the dots show.
  const sandboxWorking = useMemo(() => {
    if (lastItem?.kind === "user" || lastItem?.kind === "trigger") return false;
    return items.some((item) => item.kind === "worker" && ["calling", "starting", "working"].includes(stateOf(item).phase ?? ""));
  }, [items, lastItem, stateOf]);
  const showTyping = busy && !(lastItem?.kind === "assistant" && lastItem.streaming) && !(lastItem?.kind === "approval" && lastItem.status === "pending") && !sandboxWorking;
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

  // Images (a sandbox's charts) load after layout; keep following the conversation if it was at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onLoad = (event: Event) => {
      if (event.target instanceof HTMLImageElement && stick.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener("load", onLoad, true);
    return () => el.removeEventListener("load", onLoad, true);
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
                      return (
                        <AssistantMessage key={block.key} item={item} timeZone={timeZone} scheduleLabel={block.scheduleLabel}>
                          <SandboxImages images={images.get(item.id) ?? []} />
                        </AssistantMessage>
                      );
                    case "notice":
                      return <NoticeLine key={block.key} item={item} />;
                    case "worker":
                      return <SandboxCard key={block.key} item={item} state={stateOf(item)} approval={block.approval} timeZone={timeZone} highlight={props.highlightCard === item.id} />;
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
