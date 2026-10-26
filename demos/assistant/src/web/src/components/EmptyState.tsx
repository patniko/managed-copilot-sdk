import { BellIcon, CalendarIcon, CopilotIcon, InboxIcon, IterationsIcon, LockIcon, PeopleIcon } from "@primer/octicons-react";
import type { BackgroundView } from "../../../shared/protocol";
import { firstName, greeting } from "../format";
import { schedulingBlockedReason } from "./Rail";
import { cx, Spinner } from "./ui";

export const SUGGESTIONS = [
  { icon: CalendarIcon, title: "What's on today?", text: "What's on my calendar today? Anything I should prepare for?" },
  { icon: InboxIcon, title: "Triage my inbox", text: "Triage my unread email: what needs a reply, what's FYI, and what can wait?" },
  { icon: BellIcon, title: "Remind me in 2 minutes", text: "Remind me in 2 minutes to stretch and grab some water.", scheduling: true },
  { icon: PeopleIcon, title: "Meet with Sam", text: "Sam asked for 30 minutes to go over the Q3 launch plan. Find a time in the next few days that works and send the invite." },
  { icon: IterationsIcon, title: "Daily briefing", text: "Every weekday at 8am, brief me on my calendar and the important unread mail.", scheduling: true },
];

/** The short note on a scheduling suggestion that waits for background work, or undefined once it's confirmed on. */
function schedulingNote(background: BackgroundView | undefined): string | undefined {
  switch (background?.state) {
    case "on":
      return undefined;
    case "off":
      return "Needs background work · turn it on in the side panel";
    case "unavailable":
      return "Not available on this deployment";
    case "error":
      return "Couldn't check background work";
    default:
      return "Checking background work…";
  }
}

/** A new conversation, like Copilot Chat's welcome: the Copilot mark, a greeting, and prompts to start from. */
export function EmptyState({
  name,
  login,
  timeZone,
  demo,
  background,
  onPick,
  onNeedBackground,
}: {
  name?: string;
  login?: string;
  timeZone: string;
  demo: boolean;
  /** Scheduling suggestions wait until background work is confirmed on. */
  background?: BackgroundView;
  onPick(text: string): void;
  onNeedBackground?(): void;
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center px-4 py-10 text-center md:px-6">
      <CopilotIcon size={48} className="text-fg" />
      <h1 className="mt-4 text-xl font-semibold">
        {greeting(timeZone)}, {firstName(name, login)}
      </h1>
      <p className="mt-2 max-w-lg text-fg-muted">
        I keep an eye on your inbox and calendar, and I keep working on a schedule even when this tab is closed. Ask me anything, or start with one of these.
      </p>
      {demo && (
        <p className="mt-3 max-w-2xl text-xs text-fg-muted">
          <span className="Label Label--attention mr-1.5 align-middle">Demo data</span>
          Using the demo inbox and calendar. Connect Google from the side panel to use your own.
        </p>
      )}
      <div className="mt-8 grid w-full gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map(({ icon: Icon, title, text, scheduling }, index) => {
          const note = scheduling ? schedulingNote(background) : undefined;
          const blocked = note !== undefined;
          // While it's off, the suggestion leads to the consent card; in other states it simply waits.
          const leadsToConsent = blocked && background?.state === "off";
          return (
            <button
              key={title}
              type="button"
              onClick={() => (leadsToConsent ? onNeedBackground?.() : onPick(text))}
              disabled={blocked && !leadsToConsent}
              data-testid="suggestion"
              data-blocked={blocked ? "true" : "false"}
              title={blocked ? schedulingBlockedReason(background) : undefined}
              className={cx(
                "flex items-start gap-3 rounded-md border border-line bg-canvas p-3 text-left transition-colors duration-100 enabled:hover:bg-canvas-muted disabled:cursor-not-allowed",
                index === SUGGESTIONS.length - 1 && "sm:col-span-2",
              )}
            >
              <Icon className={cx("mt-0.5", blocked ? "text-fg-disabled" : "text-fg-muted")} />
              <span className="min-w-0">
                <span className={cx("block font-semibold", blocked ? "text-fg-muted" : "text-fg")}>{title}</span>
                {blocked ? (
                  <span className={cx("mt-0.5 inline-flex items-center gap-1 text-xs", leadsToConsent ? "text-fg-attention" : "text-fg-muted")}>
                    <LockIcon size={12} /> {note}
                  </span>
                ) : (
                  <span className="line-clamp-2 text-xs text-fg-muted">{text}</span>
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
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-10 md:px-6" aria-busy="true" aria-label="Loading your conversation">
      {[0.9, 0.6, 0.75].map((width, index) =>
        index === 1 ? (
          <div key={index} className="flex justify-end">
            <span className="SkeletonBox h-10 w-1/2 rounded-lg" />
          </div>
        ) : (
          <div key={index} className="flex gap-3">
            <span className="SkeletonBox size-8 shrink-0 rounded-full" />
            <div className="flex-1" style={{ maxWidth: `${width * 100}%` }}>
              <span className="SkeletonText w-1/3" />
              <span className="SkeletonText" />
              <span className="SkeletonText w-4/5" />
            </div>
          </div>
        ),
      )}
      <p className="flex items-center justify-center gap-2 text-fg-muted">
        <Spinner size={16} />
        Connecting to your assistant…
      </p>
    </div>
  );
}
