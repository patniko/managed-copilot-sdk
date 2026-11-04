import { BeakerIcon, BellIcon, CalendarIcon, CopilotIcon, InboxIcon, IterationsIcon, LockIcon, PeopleIcon } from "@primer/octicons-react";
import type { BackgroundView } from "../../../shared/protocol";
import { firstName, greeting } from "../format";
import { schedulingBlockedReason } from "./Rail";
import { cx, Spinner, Tooltip } from "./ui";

export const SUGGESTIONS = [
  { icon: CalendarIcon, title: "What's on today?", text: "What's on my calendar today? Anything I should prepare for?" },
  { icon: InboxIcon, title: "Triage my inbox", text: "Triage my unread email: what needs a reply, what's FYI, and what can wait?" },
  { icon: BellIcon, title: "Remind me in 2 minutes", text: "Remind me in 2 minutes to stretch and grab some water.", scheduling: true },
  { icon: PeopleIcon, title: "Meet with Sam", text: "Sam asked for 30 minutes to go over the Q3 launch plan. Find a time in the next few days that works and send the invite." },
  { icon: IterationsIcon, title: "Daily briefing", text: "Every weekday at 8am, brief me on my calendar and the important unread mail.", scheduling: true },
];

/** Shown when the assistant can start sandboxes: hands-on work that runs in one (after you approve it). */
export const SANDBOX_SUGGESTION = {
  icon: BeakerIcon,
  title: "Chart my meeting load",
  text: "How did my meeting load change over the last four weeks? A chart would help.",
  scheduling: false,
};

/** A new conversation, like Copilot Chat's welcome: the Copilot mark, a greeting, one line, and prompts to start from. */
export function EmptyState({
  name,
  login,
  timeZone,
  demo,
  background,
  sandboxes = false,
  onPick,
  onNeedBackground,
}: {
  name?: string;
  login?: string;
  timeZone: string;
  demo: boolean;
  /** Scheduling suggestions wait until background work is confirmed on. */
  background?: BackgroundView;
  /** The assistant can start sandboxes, so a hands-on suggestion is offered too. */
  sandboxes?: boolean;
  onPick(text: string): void;
  onNeedBackground?(): void;
}) {
  const suggestions = sandboxes ? [...SUGGESTIONS.slice(0, 4), SANDBOX_SUGGESTION, ...SUGGESTIONS.slice(4)] : SUGGESTIONS;
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center px-4 py-10 text-center md:px-6">
      <CopilotIcon size={48} className="text-fg" />
      <h1 className="mt-4 text-xl font-semibold">
        {greeting(timeZone)}, {firstName(name, login)}
      </h1>
      <p className="mt-1 text-fg-muted">I handle your mail and calendar, and keep working while you're away.</p>
      {demo && (
        <Tooltip content="A sample inbox and calendar. Connect Google in the side panel to use yours.">
          <span className="Label Label--attention mt-3" tabIndex={0}>
            Demo data
          </span>
        </Tooltip>
      )}
      <div className="mt-8 grid w-full grid-cols-1 gap-2 min-[480px]:grid-cols-2 md:grid-cols-3">
        {suggestions.map(({ icon: Icon, title, text, scheduling }) => {
          const blockedReason = scheduling ? schedulingBlockedReason(background) : undefined;
          const blocked = blockedReason !== undefined;
          const checking = blocked && (background === undefined || background.state === "unknown");
          // While it's off, the suggestion leads to the consent card; in other states it simply waits.
          const leadsToConsent = blocked && background?.state === "off";
          // Inactive rather than disabled, so its tooltip still says why.
          const inactive = blocked && !leadsToConsent;
          return (
            <Tooltip key={title} content={blocked ? blockedReason : text}>
              <button
                type="button"
                onClick={() => {
                  if (inactive) return;
                  if (leadsToConsent) onNeedBackground?.();
                  else onPick(text);
                }}
                aria-disabled={inactive || undefined}
                data-testid="suggestion"
                data-blocked={blocked ? "true" : "false"}
                className={cx(
                  "flex min-h-12 items-center gap-2.5 rounded-lg border border-line bg-canvas px-3 py-2 text-left transition-colors duration-100",
                  inactive ? "cursor-not-allowed" : "hover:bg-canvas-muted",
                  blocked ? "text-fg-muted" : "text-fg",
                )}
              >
                <span
                  className={cx(
                    "grid size-7 shrink-0 place-items-center rounded-full",
                    !blocked ? "bg-accent-muted text-fg-accent" : leadsToConsent ? "bg-attention-muted text-fg-attention" : "bg-canvas-muted text-fg-muted",
                  )}
                  aria-hidden
                >
                  {checking ? <Spinner size={12} /> : blocked ? <LockIcon size={14} /> : <Icon size={14} />}
                </span>
                <span className="min-w-0 flex-1 font-semibold">{title}</span>
              </button>
            </Tooltip>
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
