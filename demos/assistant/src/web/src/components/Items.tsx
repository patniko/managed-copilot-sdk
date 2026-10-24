import {
  AlarmClock,
  Bell,
  Calendar,
  CalendarClock,
  CalendarPlus,
  CalendarX,
  Check,
  CircleAlert,
  Clock,
  FilePen,
  Info,
  LoaderCircle,
  Mail,
  Repeat,
  RotateCcw,
  Satellite,
  Send,
  Sparkles,
  TriangleAlert,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type { AssistantItem, NoticeItem, ToolIcon, ToolItem, TriggerItem } from "../../../shared/protocol";
import { timeOf } from "../format";
import type { PendingMessage } from "../useAssistant";
import { Markdown } from "./Markdown";

const TOOL_ICONS: Record<ToolIcon, LucideIcon> = {
  mail: Mail,
  send: Send,
  draft: FilePen,
  calendar: Calendar,
  "calendar-plus": CalendarPlus,
  "calendar-edit": CalendarClock,
  "calendar-x": CalendarX,
  clock: Clock,
  repeat: Repeat,
  bell: Bell,
  tool: Wrench,
};

export function AssistantAvatar({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const dims = size === "lg" ? "size-14 rounded-2xl" : size === "sm" ? "size-6 rounded-lg" : "size-8 rounded-xl";
  const icon = size === "lg" ? "size-7" : size === "sm" ? "size-3.5" : "size-4";
  return (
    <div className={`${dims} grid shrink-0 place-items-center bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-sm shadow-violet-500/30`}>
      <Sparkles className={icon} strokeWidth={2.2} aria-hidden />
    </div>
  );
}

export function UserBubble({ text, at, timeZone, pending }: { text: string; at: string; timeZone: string; pending?: PendingMessage & { onRetry(): void; onDiscard(): void } }) {
  return (
    <div className="flex animate-rise flex-col items-end gap-1">
      <div
        className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-4 py-2.5 text-[15px] leading-relaxed shadow-sm sm:max-w-[75%] ${
          pending?.failed ? "bg-red-50 text-red-900 ring-1 ring-red-200 dark:bg-red-950/50 dark:text-red-100 dark:ring-red-900" : "bg-violet-600 text-white dark:bg-violet-500"
        } ${pending && !pending.failed ? "opacity-80" : ""}`}
      >
        {text}
      </div>
      <div className="flex items-center gap-2 pr-1 text-[11px] text-zinc-400">
        {pending?.failed ? (
          <>
            <span className="text-red-600 dark:text-red-400">{pending.failed}</span>
            <button type="button" className="font-medium text-zinc-600 hover:underline dark:text-zinc-300" onClick={pending.onRetry}>
              Retry
            </button>
            <button type="button" className="hover:underline" onClick={pending.onDiscard}>
              Discard
            </button>
          </>
        ) : pending ? (
          <span>Sending…</span>
        ) : (
          <time dateTime={at}>{timeOf(at, timeZone)}</time>
        )}
      </div>
    </div>
  );
}

export function AssistantMessage({ item, timeZone, scheduleLabel }: { item: AssistantItem; timeZone: string; scheduleLabel?: string }) {
  return (
    <div className="flex animate-rise gap-3" data-testid="assistant-message" data-streaming={item.streaming ? "true" : "false"} data-proactive={item.proactive ? "true" : "false"}>
      <AssistantAvatar />
      <div className="min-w-0 flex-1 pt-0.5">
        {item.proactive && (
          <div className="mb-1.5">
            <span className="chip bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
              <AlarmClock className="size-3" aria-hidden />
              {scheduleLabel ? `From “${scheduleLabel}”` : "Proactive update"}
            </span>
          </div>
        )}
        <Markdown text={item.text} streaming={item.streaming} />
        {!item.streaming && (
          <div className="mt-1.5 text-[11px] text-zinc-400">
            <time dateTime={item.at}>{timeOf(item.at, timeZone)}</time>
          </div>
        )}
      </div>
    </div>
  );
}

export function TriggerPill({ item, timeZone }: { item: TriggerItem; timeZone: string }) {
  return (
    <div className="flex animate-rise justify-center" data-testid="trigger">
      <div className="flex max-w-[90%] items-start gap-2 rounded-2xl bg-amber-50 px-3.5 py-2 text-sm text-amber-900 ring-1 ring-amber-200/80 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/20">
        <AlarmClock className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <div className="min-w-0">
          <div className="font-medium">
            {item.scheduleName ? `“${item.scheduleName}” ran` : "A scheduled task ran"} · <time dateTime={item.at}>{timeOf(item.at, timeZone)}</time>
          </div>
          <div className="line-clamp-2 text-amber-800/80 dark:text-amber-200/70">{item.text}</div>
        </div>
      </div>
    </div>
  );
}

export function ToolRow({ item, onOpenSchedule }: { item: ToolItem; onOpenSchedule?: (id: string) => void }) {
  const Icon = TOOL_ICONS[item.icon] ?? Wrench;
  return (
    <li className="flex animate-fade items-start gap-2.5 py-1" data-testid="tool" data-tool={item.name} data-status={item.status} data-offline={item.handledOffline ? "true" : "false"}>
      <span
        className={`mt-px grid size-6 shrink-0 place-items-center rounded-md ${
          item.status === "failed" ? "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
        }`}
      >
        <Icon className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className={item.status === "failed" ? "text-red-700 dark:text-red-300" : "text-zinc-700 dark:text-zinc-300"}>{item.title}</span>
          {item.status === "running" && <LoaderCircle className="size-3.5 animate-spin text-violet-500" aria-label="Running" />}
          {item.status === "succeeded" && <Check className="size-3.5 text-emerald-500" aria-label="Done" />}
          {item.status === "failed" && <X className="size-3.5 text-red-500" aria-label="Failed" />}
          {item.handledOffline && (
            <span className="chip bg-sky-50 text-sky-700 ring-1 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/20" title="Answered by this app's webhook while no browser was open">
              <Satellite className="size-3" aria-hidden />
              Handled while you were away
            </span>
          )}
          {item.scheduleId && onOpenSchedule && (
            <button type="button" className="text-xs font-medium text-violet-600 hover:underline dark:text-violet-400" onClick={() => onOpenSchedule(item.scheduleId!)}>
              Manage
            </button>
          )}
        </div>
        {item.detail && <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">{item.detail}</div>}
        {item.error && <div className="mt-0.5 text-xs text-red-600 dark:text-red-400">{item.error}</div>}
      </div>
    </li>
  );
}

export function NoticeLine({ item }: { item: NoticeItem }) {
  const styles =
    item.level === "error"
      ? "bg-red-50 text-red-800 ring-red-200 dark:bg-red-500/10 dark:text-red-200 dark:ring-red-500/20"
      : item.level === "warning"
        ? "bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/20"
        : "bg-zinc-100 text-zinc-600 ring-zinc-200 dark:bg-zinc-800/70 dark:text-zinc-300 dark:ring-zinc-700";
  const Icon = item.level === "error" ? CircleAlert : item.level === "warning" ? TriangleAlert : Info;
  return (
    <div className="flex justify-center">
      <div className={`flex max-w-[90%] items-start gap-2 rounded-xl px-3 py-1.5 text-xs ring-1 ${styles}`}>
        <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>{item.text}</span>
      </div>
    </div>
  );
}

export function TypingIndicator({ label }: { label?: string }) {
  return (
    <div className="flex animate-fade items-center gap-3" aria-live="polite">
      <AssistantAvatar />
      <div className="flex items-center gap-2 rounded-2xl bg-white px-3.5 py-2.5 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
        <span className="flex gap-1" aria-hidden>
          <span className="typing-dot size-1.5 rounded-full bg-violet-500" />
          <span className="typing-dot size-1.5 rounded-full bg-violet-500" />
          <span className="typing-dot size-1.5 rounded-full bg-violet-500" />
        </span>
        {label && <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>}
      </div>
    </div>
  );
}

export function RetryIcon() {
  return <RotateCcw className="size-3.5" aria-hidden />;
}
