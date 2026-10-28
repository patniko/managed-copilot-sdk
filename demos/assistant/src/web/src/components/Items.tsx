import {
  AlertIcon,
  BellIcon,
  BroadcastIcon,
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  CopilotIcon,
  CopyIcon,
  FileIcon,
  InfoIcon,
  IterationsIcon,
  MailIcon,
  PaperAirplaneIcon,
  PencilIcon,
  ShieldCheckIcon,
  StopIcon,
  SyncIcon,
  ToolsIcon,
  TrashIcon,
  XIcon,
  type Icon,
} from "@primer/octicons-react";
import { useId, useState, type ReactNode } from "react";
import type { AssistantItem, NoticeItem, ToolIcon, ToolItem, ToolStatus, TriggerItem } from "../../../shared/protocol";
import { timeOf } from "../format";
import type { PendingMessage } from "../useAssistant";
import { Markdown } from "./Markdown";
import { cx, Spinner } from "./ui";

const TOOL_ICONS: Record<ToolIcon, Icon> = {
  mail: MailIcon,
  send: PaperAirplaneIcon,
  draft: PencilIcon,
  calendar: CalendarIcon,
  "calendar-plus": CalendarIcon,
  "calendar-edit": CalendarIcon,
  "calendar-x": CalendarIcon,
  clock: ClockIcon,
  repeat: IterationsIcon,
  bell: BellIcon,
  file: FileIcon,
  copy: CopyIcon,
  trash: TrashIcon,
  tool: ToolsIcon,
};

const AVATAR_SIZES = { 24: "size-6", 32: "size-8", 48: "size-12", 64: "size-16" } as const;

/** The assistant's avatar: the Copilot mark in a bordered circle, as Copilot appears on github.com. */
export function AssistantAvatar({ size = 32 }: { size?: keyof typeof AVATAR_SIZES }) {
  return (
    <span className={cx("grid shrink-0 place-items-center rounded-full border border-line bg-canvas text-fg", AVATAR_SIZES[size])} aria-hidden>
      <CopilotIcon size={size >= 48 ? 24 : size === 32 ? 16 : 12} />
    </span>
  );
}

export function UserBubble({ text, at, timeZone, pending }: { text: string; at: string; timeZone: string; pending?: PendingMessage & { onRetry(): void; onDiscard(): void } }) {
  const failed = pending?.failed;
  return (
    <div className="flex animate-slide-up flex-col items-end gap-1">
      <div
        className={cx(
          "max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-4 py-2.5 sm:max-w-[75%]",
          failed ? "border border-line-danger-muted bg-danger-muted" : "bg-canvas-muted",
          pending && !failed && "text-fg-muted",
        )}
      >
        {text}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs text-fg-muted">
        {failed ? (
          <>
            <span className="inline-flex items-center gap-1 text-fg-danger">
              <AlertIcon size={12} />
              {failed}
            </span>
            <button type="button" className="btn btn-sm" onClick={pending.onRetry}>
              <SyncIcon />
              Retry
            </button>
            <button type="button" className="btn btn-sm btn-invisible" onClick={pending.onDiscard}>
              Discard
            </button>
          </>
        ) : pending ? (
          <span className="inline-flex items-center gap-1.5">
            <Spinner size={12} />
            Sending…
          </span>
        ) : (
          <time dateTime={at}>{timeOf(at, timeZone)}</time>
        )}
      </div>
    </div>
  );
}

/** A reply; `children` (a turn's sandbox images) show under its text. */
export function AssistantMessage({ item, timeZone, scheduleLabel, children }: { item: AssistantItem; timeZone: string; scheduleLabel?: string; children?: ReactNode }) {
  return (
    <div className="flex animate-slide-up gap-3" data-testid="assistant-message" data-streaming={item.streaming ? "true" : "false"} data-proactive={item.proactive ? "true" : "false"}>
      <AssistantAvatar />
      <div className="min-w-0 flex-1">
        <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold text-fg">Assistant</span>
          {item.proactive && (
            <span className="Label Label--accent max-w-full truncate" title={scheduleLabel ? `Sent on its own, from “${scheduleLabel}”` : "Sent on its own, from a schedule"}>
              <ClockIcon />
              <span className="truncate">{scheduleLabel ? `From “${scheduleLabel}”` : "Proactive update"}</span>
            </span>
          )}
          <time className="text-xs text-fg-muted" dateTime={item.at}>
            {timeOf(item.at, timeZone)}
          </time>
        </div>
        <Markdown text={item.text} streaming={item.streaming} />
        {children}
      </div>
    </div>
  );
}

/** A schedule fired and delivered its prompt into the conversation. */
export function TriggerRow({ item, timeZone }: { item: TriggerItem; timeZone: string }) {
  return (
    <div className="TimelineItem TimelineItem--condensed animate-slide-up" data-testid="trigger">
      <div className="TimelineItem-badge">
        <BellIcon />
      </div>
      <div className="TimelineItem-body min-w-0">
        <div>
          <span className="font-semibold text-fg">{item.scheduleName ? `“${item.scheduleName}”` : "A scheduled task"}</span> ran ·{" "}
          <time className="text-xs" dateTime={item.at}>
            {timeOf(item.at, timeZone)}
          </time>
        </div>
        <div className="line-clamp-2 text-xs">{item.text}</div>
      </div>
    </div>
  );
}

function StatusIcon({ status, className }: { status: ToolStatus; className?: string }) {
  if (status === "running") return <Spinner size={12} className={cx("inline-block align-text-bottom text-fg-attention", className)} label="Running" />;
  if (status === "succeeded") return <CheckIcon size={12} className={cx("text-fg-success", className)} aria-label="Done" />;
  return <XIcon size={12} className={cx("text-fg-danger", className)} aria-label="Failed" />;
}

/** One tool call, as a quiet condensed timeline event. Its detail (counts, subject, schedule) is a disclosure. */
export function ToolRow({ item, onOpenSchedule, onOpenBackground }: { item: ToolItem; onOpenSchedule?: (id: string) => void; onOpenBackground?: () => void }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const ToolGlyph = TOOL_ICONS[item.icon] ?? ToolsIcon;
  const failed = item.status === "failed";
  // Inline, so the status icon and chevron follow the last word when the title wraps.
  const title = (
    <>
      <span className={failed ? "text-fg-danger" : undefined}>{item.title}</span>
      <StatusIcon status={item.status} className="ml-1.5" />
    </>
  );
  return (
    <div className="TimelineItem TimelineItem--condensed animate-fade-in" data-testid="tool" data-tool={item.name} data-status={item.status} data-offline={item.handledOffline ? "true" : "false"}>
      <div className={cx("TimelineItem-badge", failed && "text-fg-danger")}>
        <ToolGlyph />
      </div>
      <div className="TimelineItem-body min-w-0">
        <div className="break-words">
          {item.detail ? (
            <button type="button" className="rounded-md text-left hover:text-fg" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((value) => !value)}>
              {title}
              <ChevronRightIcon size={12} className={cx("ml-1 text-fg-muted transition-transform duration-150", open && "rotate-90")} />
            </button>
          ) : (
            title
          )}
          {item.handledOffline && (
            <span className="Label Label--accent ml-2 align-middle" title="Answered by this app's webhook while no browser was open">
              <BroadcastIcon />
              Handled while you were away
            </span>
          )}
          {item.scheduleId && onOpenSchedule && (
            <button type="button" className="Link ml-2 text-xs" onClick={() => onOpenSchedule(item.scheduleId!)}>
              Manage
            </button>
          )}
        </div>
        {item.detail && (
          <div id={detailId} hidden={!open} className="mt-0.5 break-words text-xs">
            {item.detail}
          </div>
        )}
        {item.error && <div className="mt-0.5 break-words text-xs text-fg-danger">{item.error}</div>}
        {item.needsBackgroundWork && onOpenBackground && (
          <button type="button" data-testid="turn-on-background" className="btn btn-sm mt-2" onClick={onOpenBackground}>
            <ShieldCheckIcon />
            Turn on background work
          </button>
        )}
      </div>
    </div>
  );
}

/** Info notices are quiet timeline events; warnings and errors are banners in the conversation. */
export function NoticeLine({ item }: { item: NoticeItem }) {
  if (item.level === "info") {
    return (
      <div className="TimelineItem TimelineItem--condensed animate-fade-in">
        <div className="TimelineItem-badge">
          <InfoIcon />
        </div>
        <div className="TimelineItem-body min-w-0 break-words">{item.text}</div>
      </div>
    );
  }
  const error = item.level === "error";
  return (
    <div className={cx("flash flash-sm ml-11 animate-fade-in", error ? "flash-error" : "flash-warn")}>
      {error ? <StopIcon /> : <AlertIcon />}
      <div className="flash-content break-words">{item.text}</div>
    </div>
  );
}

export function TypingIndicator() {
  return (
    <div className="flex animate-fade-in items-center gap-3" role="status" aria-label="Your assistant is working">
      <AssistantAvatar />
      <span className="flex items-center gap-1" aria-hidden>
        <span className="typing-dot size-1.5 rounded-full" />
        <span className="typing-dot size-1.5 rounded-full" />
        <span className="typing-dot size-1.5 rounded-full" />
      </span>
    </div>
  );
}
