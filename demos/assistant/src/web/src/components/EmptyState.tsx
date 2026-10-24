import { BellRing, CalendarDays, Inbox, Lock, Repeat, Users } from "lucide-react";
import { firstName, greeting } from "../format";
import { AssistantAvatar } from "./Items";

export const SUGGESTIONS = [
  { icon: CalendarDays, title: "What's on today?", text: "What's on my calendar today? Anything I should prepare for?" },
  { icon: Inbox, title: "Triage my inbox", text: "Triage my unread email: what needs a reply, what's FYI, and what can wait?" },
  { icon: BellRing, title: "Remind me in 2 minutes", text: "Remind me in 2 minutes to stretch and grab some water.", scheduling: true },
  { icon: Users, title: "Meet with Sam", text: "Sam asked for 30 minutes to go over the Q3 launch plan. Find a time in the next few days that works and send the invite." },
  { icon: Repeat, title: "Daily briefing", text: "Every weekday at 8am, brief me on my calendar and the important unread mail.", scheduling: true },
];

export function EmptyState({
  name,
  login,
  timeZone,
  demo,
  backgroundOff,
  onPick,
  onNeedBackground,
}: {
  name?: string;
  login?: string;
  timeZone: string;
  demo: boolean;
  /** Scheduling suggestions wait until background work is on. */
  backgroundOff?: boolean;
  onPick(text: string): void;
  onNeedBackground?(): void;
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center px-6 py-10 text-center">
      <AssistantAvatar size="lg" />
      <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-zinc-900 sm:text-3xl dark:text-zinc-50">
        {greeting(timeZone)}, {firstName(name, login)}
      </h1>
      <p className="mt-2 max-w-lg text-[15px] text-zinc-500 dark:text-zinc-400">
        I keep an eye on your inbox and calendar, and I keep working on a schedule even when this tab is closed. Ask me anything, or start with one of these.
      </p>
      {demo && (
        <p className="mt-3 rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/20">
          Using the demo inbox and calendar. Connect Google from the side panel to use your own.
        </p>
      )}
      <div className="mt-8 grid w-full gap-2.5 sm:grid-cols-2">
        {SUGGESTIONS.map(({ icon: Icon, title, text, scheduling }, index) => {
          const blocked = Boolean(scheduling && backgroundOff);
          return (
            <button
              key={title}
              type="button"
              onClick={() => (blocked ? onNeedBackground?.() : onPick(text))}
              data-testid="suggestion"
              data-blocked={blocked ? "true" : "false"}
              title={blocked ? "Turn on background work first, so this can run while you're away" : undefined}
              className={`card group flex items-start gap-3 p-3.5 text-left transition hover:-translate-y-0.5 hover:shadow-md ${
                blocked ? "hover:ring-amber-300 dark:hover:ring-amber-500/50" : "hover:ring-violet-300 dark:hover:ring-violet-500/50"
              } ${index === SUGGESTIONS.length - 1 ? "sm:col-span-2" : ""}`}
            >
              <span
                className={`grid size-9 shrink-0 place-items-center rounded-xl ${
                  blocked
                    ? "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500"
                    : "bg-violet-50 text-violet-600 group-hover:bg-violet-100 dark:bg-violet-500/10 dark:text-violet-300"
                }`}
              >
                <Icon className="size-4.5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className={`block text-sm font-semibold ${blocked ? "text-zinc-500 dark:text-zinc-400" : "text-zinc-900 dark:text-zinc-100"}`}>{title}</span>
                {blocked ? (
                  <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                    <Lock className="size-3" aria-hidden /> Needs background work · turn it on in the side panel
                  </span>
                ) : (
                  <span className="line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">{text}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function LoadingState() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pt-10" aria-busy="true" aria-label="Loading your conversation">
      {[0.9, 0.6, 0.75].map((width, index) => (
        <div key={index} className={`flex gap-3 ${index === 1 ? "flex-row-reverse" : ""}`}>
          {index !== 1 && <div className="size-8 animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-800" />}
          <div className="flex-1 space-y-2" style={{ maxWidth: `${width * 100}%` }}>
            <div className="h-3.5 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-3.5 w-4/5 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
          </div>
        </div>
      ))}
      <p className="text-center text-sm text-zinc-400">Connecting to your assistant…</p>
    </div>
  );
}
