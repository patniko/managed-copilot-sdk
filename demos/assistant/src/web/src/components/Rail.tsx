import {
  AlertIcon,
  BellIcon,
  BroadcastIcon,
  CheckCircleFillIcon,
  CheckIcon,
  CloudOfflineIcon,
  CopyIcon,
  InfoIcon,
  IterationsIcon,
  KebabHorizontalIcon,
  LocationIcon,
  MailIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  ShieldCheckIcon,
  ShieldIcon,
  TerminalIcon,
  TrashIcon,
  UndoIcon,
  XCircleFillIcon,
  ZapIcon,
} from "@primer/octicons-react";
import { useId, useState, type ReactNode } from "react";
import type { AccountView, AgendaView, BackgroundView, ConnectionsView, OfflineView, PlatformStatus, ScheduleView } from "../../../shared/protocol";
import { dayLabel, fullDate, relativeTime, timeOf, timeRange, whenLabel } from "../format";
import type { AssistantActions } from "../useAssistant";
import { cx, Menu, Spinner } from "./ui";

/** Shown on scheduling controls that need background work. */
export const NEEDS_BACKGROUND = "Turn on background work first, so this can run while you're away";
export const LOGIN_COMMAND = "npx managed-copilot login";

/** Why actions that make scheduled work run are disabled, or undefined once background work is confirmed on. */
export function schedulingBlockedReason(background?: BackgroundView): string | undefined {
  switch (background?.state) {
    case "on":
      return undefined;
    case "off":
      return NEEDS_BACKGROUND;
    case "unavailable":
      return "This deployment can't run work while you're away";
    case "error":
      return "Couldn't check whether background work is on";
    default:
      return "Checking background work…";
  }
}

/** A sidebar section: a small muted heading (like NavList group headings), an optional counter, and its content. */
function Section({ title, counter, trailing, children }: { title: string; counter?: number; trailing?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <div className="mb-2 flex min-h-5 items-center gap-2 px-1">
        <h2 id={id} className="text-xs font-semibold text-fg-muted">
          {title}
        </h2>
        {counter !== undefined && <span className="Counter">{counter}</span>}
        {trailing && <div className="ml-auto flex items-center gap-1">{trailing}</div>}
      </div>
      {children}
    </section>
  );
}

function DemoLabel() {
  return <span className="Label Label--attention">Demo data</span>;
}

function InlineCode({ children }: { children: ReactNode }) {
  return <code className="rounded-md bg-neutral-muted px-1 py-0.5 font-mono text-xs">{children}</code>;
}

export function TodayCard({ agenda, timeZone, demo }: { agenda?: AgendaView; timeZone: string; demo: boolean }) {
  const now = Date.now();
  const events = agenda?.events ?? [];
  const upcoming = events.filter((event) => Date.parse(event.end) > now).slice(0, 7);
  const nextId = upcoming.find((event) => !event.allDay && Date.parse(event.start) > now)?.id;
  const groups: { label: string; events: typeof upcoming }[] = [];
  for (const event of upcoming) {
    const label = dayLabel(event.start, timeZone);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.events.push(event);
    else groups.push({ label, events: [event] });
  }
  return (
    <Section title="Up next" trailing={demo ? <DemoLabel /> : undefined}>
      {!agenda ? (
        <div className="Box p-3" aria-busy="true" aria-label="Loading your calendar">
          <span className="SkeletonText w-3/4" />
          <span className="SkeletonText w-1/2" />
        </div>
      ) : agenda.error ? (
        <div className="flash flash-sm flash-error">
          <XCircleFillIcon />
          <div className="flash-content">{agenda.error}</div>
        </div>
      ) : upcoming.length === 0 ? (
        <div className="Box p-3 text-fg-muted">Nothing on your calendar this week.</div>
      ) : (
        <div className="Box overflow-hidden">
          {groups.map((group, index) => (
            <div key={group.label}>
              <div className={cx("bg-canvas-muted px-3 py-1.5 text-xs font-semibold text-fg-muted", index > 0 && "border-t border-line-muted")}>
                {group.label === "Today" ? `Today · ${fullDate(new Date(), timeZone)}` : group.label}
              </div>
              <ol>
                {group.events.map((event) => {
                  const live = !event.allDay && Date.parse(event.start) <= now;
                  return (
                    <li key={event.id} className="flex gap-3 border-t border-line-muted px-3 py-2">
                      <div className="w-16 shrink-0 text-xs leading-5 text-fg-muted tabular-nums">{event.allDay ? "All day" : timeOf(event.start, timeZone)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-semibold" title={event.title}>
                            {event.title}
                          </span>
                          {live && <span className="Label Label--success shrink-0">Now</span>}
                          {event.id === nextId && <span className="Label Label--accent shrink-0">Next</span>}
                        </div>
                        {(!event.allDay || event.location) && (
                          <div className="flex min-w-0 items-center gap-1 text-xs text-fg-muted">
                            {!event.allDay && <span className="shrink-0 tabular-nums">{timeRange(event.start, event.end, timeZone)}</span>}
                            {event.location && (
                              <>
                                <LocationIcon size={12} className={cx("shrink-0", !event.allDay && "ml-1")} />
                                <span className="truncate">{event.location}</span>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function ScheduleMenu({ schedule, actions, blockedReason }: { schedule: ScheduleView; actions: AssistantActions; blockedReason?: string }) {
  return (
    <Menu
      label={`Actions for ${schedule.name}`}
      width="w-48"
      items={[
        {
          key: "run",
          label: "Run now",
          icon: ZapIcon,
          disabled: blockedReason !== undefined,
          title: blockedReason,
          onSelect: () => void actions.runSchedule(schedule.id),
        },
        "divider",
        { key: "delete", label: "Delete", icon: TrashIcon, danger: true, onSelect: () => void actions.deleteSchedule(schedule.id) },
      ]}
      renderTrigger={(trigger) => (
        <button type="button" className="btn-octicon" aria-label={`More actions for ${schedule.name}`} {...trigger}>
          <KebabHorizontalIcon />
        </button>
      )}
    />
  );
}

/**
 * Background work is off: explain what turning it on means (the consent), then offer one click, or the terminal.
 * This is the only place the app turns it on.
 */
export function BackgroundOffNotice({ background, account, ready, highlight, actions }: { background: BackgroundView; account?: AccountView; ready: boolean; highlight?: boolean; actions: AssistantActions }) {
  const [busy, setBusy] = useState<"enable" | "check" | undefined>();
  const [copied, setCopied] = useState(false);
  const stopped = background.reason !== undefined;
  const login = background.login ?? account?.login;
  const act = async (key: "enable" | "check", fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <section
      id="background-work"
      data-testid="background"
      data-state="off"
      aria-label="Background work"
      className={cx("flash flash-warn flex-col items-stretch gap-3 p-4 transition-shadow duration-200", highlight && "ring-2 ring-line-accent")}
    >
      <div className="flex items-start gap-2">
        <ShieldIcon className="mt-0.5 text-fg-attention" />
        <div className="min-w-0">
          <div className="flash-title">{stopped ? "Background work stopped" : "Background work is off"}</div>
          <p className="mt-0.5">
            {stopped ? `${background.reason} ` : ""}
            Reminders and automations can't run while this tab is closed until you turn it on.
          </p>
        </div>
      </div>
      <p className="text-xs text-fg-muted" id="background-consent">
        Turning it on lets Managed Copilot keep a sealed copy of your GitHub sign-in{login ? ` (@${login})` : ""} on this deployment, so your scheduled work runs
        as you while you're away. It covers all your scheduled work on this deployment, and you can turn it off anytime in Settings.
      </p>
      <button
        type="button"
        className="btn btn-primary btn-block"
        aria-describedby="background-consent"
        disabled={!ready || busy !== undefined}
        title={ready ? undefined : "Managed Copilot isn't connected"}
        onClick={() => void act("enable", () => actions.enableBackground())}
      >
        {busy === "enable" ? <Spinner /> : <ShieldCheckIcon />}
        {stopped ? "Turn background work back on" : "Turn on background work"}
      </button>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-fg-muted">
        <TerminalIcon size={12} />
        <span>Prefer a terminal? Run</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-line bg-canvas px-1.5 py-0.5 font-mono text-xs text-fg hover:bg-canvas-muted"
          title="Copy the command"
          onClick={() => {
            void navigator.clipboard?.writeText(LOGIN_COMMAND).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {LOGIN_COMMAND}
          {copied ? <CheckIcon size={12} className="text-fg-success" aria-label="Copied" /> : <CopyIcon size={12} className="text-fg-muted" />}
        </button>
        <span>then</span>
        <button type="button" className="Link font-semibold disabled:opacity-50" disabled={!ready || busy !== undefined} onClick={() => void act("check", () => actions.checkBackground())}>
          {busy === "check" ? "checking…" : "check again"}
        </button>
      </div>
    </section>
  );
}

function BackgroundStatusLine({ background, ready, actions }: { background?: BackgroundView; ready: boolean; actions: AssistantActions }) {
  const [checking, setChecking] = useState(false);
  if (!ready) return null;
  const footer = "Box-footer flex items-center gap-1.5 px-3 py-2 text-xs text-fg-muted";
  if (background?.state === "on") {
    return (
      <div data-testid="background" data-state="on" className={footer}>
        <ShieldCheckIcon size={12} className="shrink-0 text-fg-success" />
        <span>
          Background work is on{background.login ? ` · runs as @${background.login}` : ""} while you're away
        </span>
      </div>
    );
  }
  if (background?.state === "unavailable") {
    return (
      <div data-testid="background" data-state="unavailable" className={footer}>
        <InfoIcon size={12} className="shrink-0" />
        <span>This deployment can't run work while you're away, so reminders and automations aren't available.</span>
      </div>
    );
  }
  if (background === undefined || background.state === "unknown") {
    return (
      <div data-testid="background" data-state="unknown" className={footer}>
        <Spinner size={12} />
        <span>Checking background work…</span>
      </div>
    );
  }
  if (background?.state === "error") {
    return (
      <div data-testid="background" data-state="error" className={footer}>
        <AlertIcon size={12} className="shrink-0 text-fg-attention" />
        <span className="min-w-0 flex-1 truncate" title={background.error}>
          Couldn't check background work
        </span>
        <button
          type="button"
          className="Link font-semibold disabled:opacity-50"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            try {
              await actions.checkBackground();
            } finally {
              setChecking(false);
            }
          }}
        >
          {checking ? "Checking…" : "Retry"}
        </button>
      </div>
    );
  }
  return null;
}

function ScheduleMeta({ schedule, timeZone }: { schedule: ScheduleView; timeZone: string }) {
  const paused = schedule.state === "paused";
  const failed = schedule.lastRun?.status === "failed" && !(paused && schedule.pausedReason);
  const status = paused ? (schedule.pausedReason ?? "") : schedule.nextRunAt ? `Next: ${whenLabel(schedule.nextRunAt, timeZone)}` : schedule.lastRun ? "Finished" : "Waiting to run";
  const notes: string[] = [];
  if (!failed && schedule.lastRun?.completedAt) notes.push(`Last ran ${relativeTime(schedule.lastRun.completedAt)}`);
  if (schedule.createdBy === "agent") notes.push("Set by your assistant");
  return (
    <>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
        {paused ? <span className="Label Label--attention shrink-0">Paused</span> : <span className="Label Label--success shrink-0">Active</span>}
        {status && (
          <span className="truncate" title={status}>
            {status}
          </span>
        )}
      </div>
      {failed && (
        <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-fg-danger">
          <XCircleFillIcon size={12} className="shrink-0" />
          <span className="truncate" title={schedule.lastRun?.reason}>
            Last run failed{schedule.lastRun?.reason ? `: ${schedule.lastRun.reason}` : ""}
          </span>
        </div>
      )}
      {notes.length > 0 && <div className="mt-0.5 truncate text-xs text-fg-muted">{notes.join(" · ")}</div>}
    </>
  );
}

export function AutomationsCard(props: {
  schedules: readonly ScheduleView[];
  error?: string;
  timeZone: string;
  highlight?: string;
  ready: boolean;
  background?: BackgroundView;
  actions: AssistantActions;
}) {
  const { schedules, actions } = props;
  const [busy, setBusy] = useState<string | undefined>();
  const backgroundOff = props.background?.state === "off";
  const scheduleBlocked = schedulingBlockedReason(props.background);
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
    } finally {
      setBusy(undefined);
    }
  };
  const briefingBlocked = props.error ?? (props.ready ? scheduleBlocked : "Managed Copilot isn't connected");
  return (
    <Section title="Reminders & automations" counter={schedules.length > 0 ? schedules.length : undefined}>
      {props.error && (
        <div className="flash flash-sm flash-warn mb-2">
          <AlertIcon />
          <div className="flash-content">{props.error}</div>
        </div>
      )}
      <div className="Box">
        {schedules.length === 0 ? (
          <div className="p-3 text-fg-muted">
            <p>
              {backgroundOff
                ? "Once background work is on, ask me to remind you about something or to do a task on a schedule."
                : "Ask me to remind you about something, or to do a task on a schedule. They run on Managed Copilot even when this tab is closed."}
            </p>
            <button
              type="button"
              className="btn btn-sm btn-block mt-3"
              disabled={briefingBlocked !== undefined || busy === "briefing"}
              title={briefingBlocked}
              onClick={() => void act("briefing", () => actions.addBriefing())}
            >
              {busy === "briefing" ? <Spinner /> : <PlusIcon />}
              Weekday morning briefing
            </button>
          </div>
        ) : (
          <ul>
            {schedules.map((schedule) => {
              const ScheduleIcon = schedule.oneShot ? BellIcon : IterationsIcon;
              const paused = schedule.state === "paused";
              const resumeBlocked = paused ? scheduleBlocked : undefined;
              return (
                <li
                  key={schedule.id}
                  id={`schedule-${schedule.id}`}
                  className={cx("Box-row flex items-start gap-3 px-3 py-2.5 transition-colors duration-200", props.highlight === schedule.id && "Box-row--selected")}
                >
                  <ScheduleIcon className={cx("mt-0.5", paused ? "text-fg-disabled" : "text-fg-muted")} />
                  <div className="min-w-0 flex-1">
                    <div className={cx("truncate font-semibold", paused && "text-fg-muted")} title={schedule.prompt}>
                      {schedule.name}
                    </div>
                    <div className="truncate text-xs text-fg-muted">{schedule.cadence}</div>
                    <ScheduleMeta schedule={schedule} timeZone={props.timeZone} />
                  </div>
                  <div className="-mr-1 flex shrink-0 items-center">
                    {busy === schedule.id ? (
                      <span className="grid size-7 place-items-center text-fg-muted">
                        <Spinner />
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn-octicon"
                        disabled={!props.ready || resumeBlocked !== undefined}
                        onClick={() => void act(schedule.id, () => (paused ? actions.resumeSchedule(schedule.id) : actions.pauseSchedule(schedule.id)))}
                        aria-label={paused ? `Resume ${schedule.name}` : `Pause ${schedule.name}`}
                        title={resumeBlocked ?? (paused ? "Resume" : "Pause")}
                      >
                        {paused ? <PlayIcon /> : <PauseIcon />}
                      </button>
                    )}
                    <ScheduleMenu schedule={schedule} actions={actions} blockedReason={scheduleBlocked} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <BackgroundStatusLine background={props.background} ready={props.ready} actions={actions} />
      </div>
    </Section>
  );
}

function StatusItem({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 flex shrink-0">{icon}</span>
      <span>{children}</span>
    </li>
  );
}

export function AwayCard({ offline, platform, background }: { offline?: OfflineView; platform?: PlatformStatus; background?: BackgroundView }) {
  const ready = platform?.state === "ready";
  return (
    <Section title="Works while you're away">
      <div className="Box p-3">
        <p className="text-fg-muted">
          Close this tab and reminders and briefings keep running on Managed Copilot. When they need your mail or calendar, the platform calls this app's signed
          webhook, so your Google credentials never leave it.
        </p>
        <ul className="mt-3 space-y-1.5 text-xs">
          {background && (background.state === "on" || background.state === "off") && (
            <StatusItem icon={background.state === "on" ? <CheckCircleFillIcon size={12} className="text-fg-success" /> : <AlertIcon size={12} className="text-fg-attention" />}>
              {background.state === "on" ? "Background work on" : "Background work off (reminders can't run while you're away)"}
            </StatusItem>
          )}
          <StatusItem icon={offline?.webhookConfigured ? <CheckCircleFillIcon size={12} className="text-fg-success" /> : <AlertIcon size={12} className="text-fg-attention" />}>
            {offline?.webhookConfigured ? "Webhook configured" : "Webhook secret not set (falls back to polling)"}
          </StatusItem>
          <StatusItem icon={ready ? <CheckCircleFillIcon size={12} className="text-fg-success" /> : <CloudOfflineIcon size={12} className="text-fg-muted" />}>
            {ready ? "Platform connected" : "Platform not connected"}
          </StatusItem>
          {offline && offline.handledOffline > 0 && (
            <StatusItem icon={<BroadcastIcon size={12} className="text-fg-accent" />}>
              {offline.handledOffline} tool call{offline.handledOffline === 1 ? "" : "s"} answered while no tab was open
              {offline.lastWebhookAt ? ` · last ${relativeTime(offline.lastWebhookAt)}` : ""}
            </StatusItem>
          )}
          {offline && offline.waitingApprovals > 0 && (
            <StatusItem icon={<ShieldIcon size={12} className="text-fg-attention" />}>
              {offline.waitingApprovals} approval{offline.waitingApprovals === 1 ? "" : "s"} waiting for you
            </StatusItem>
          )}
        </ul>
      </div>
    </Section>
  );
}

export function ConnectionsCard({ connections, ready, actions }: { connections?: ConnectionsView; ready: boolean; actions: AssistantActions }) {
  const [busy, setBusy] = useState<string | undefined>();
  const google = connections?.google;
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Section title="Mail & calendar">
      {google?.connected ? (
        <div className="Box">
          <div className="flex items-center gap-3 p-3">
            <GoogleMark />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{google.email ?? "Google account"}</div>
              {google.status === "needs_reconnect" ? (
                <div className="flex items-center gap-1 text-xs text-fg-attention">
                  <AlertIcon size={12} />
                  Access expired · reconnect
                </div>
              ) : (
                <div className="flex items-center gap-1 text-xs text-fg-muted">
                  <CheckCircleFillIcon size={12} className="text-fg-success" />
                  Gmail and Google Calendar connected
                </div>
              )}
            </div>
          </div>
          <div className="Box-footer flex gap-2 px-3 py-2">
            {google.status === "needs_reconnect" && (
              <button type="button" className="btn btn-sm btn-primary flex-1" onClick={() => void act("connect", () => actions.connectGoogle())}>
                Reconnect
              </button>
            )}
            <button type="button" className="btn btn-sm btn-danger flex-1" disabled={busy === "disconnect"} onClick={() => void act("disconnect", () => actions.disconnectGoogle())}>
              {busy === "disconnect" && <Spinner />}
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="Box">
          <div className="flex items-start gap-3 p-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-attention-muted text-fg-attention">
              <MailIcon />
            </span>
            <div className="min-w-0">
              <div className="font-semibold">Using the demo workspace</div>
              <div className="text-xs text-fg-muted">A sample inbox and calendar for {connections?.demo.address ?? "you"}. Nothing is sent outside this app.</div>
            </div>
          </div>
          <div className="Box-footer flex flex-col gap-1 px-3 py-2">
            {google?.configured ? (
              <button type="button" className="btn btn-sm btn-block" disabled={!ready || busy === "connect"} onClick={() => void act("connect", () => actions.connectGoogle())}>
                {busy === "connect" ? <Spinner /> : <GoogleMark small />}
                Connect Google
              </button>
            ) : (
              <p className="text-xs text-fg-muted">
                To use your own Gmail and Calendar, set <InlineCode>google-client-id</InlineCode> and <InlineCode>google-client-secret</InlineCode> (see the README).
              </p>
            )}
            <button type="button" className="btn btn-sm btn-invisible btn-block" disabled={!ready || busy === "reset"} onClick={() => void act("reset", () => actions.resetDemo())}>
              {busy === "reset" ? <Spinner /> : <UndoIcon />}
              Reset demo inbox and calendar
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

/** Google's "G" in its brand colors (an SVG data URI, so the colors stay inside the image). */
const GOOGLE_G =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Cpath fill='%23EA4335' d='M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z'/%3E%3Cpath fill='%234285F4' d='M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.2z'/%3E%3Cpath fill='%23FBBC05' d='M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.4 0 20.1 0 24s1 7.6 2.6 10.8l7.9-6.2z'/%3E%3Cpath fill='%2334A853' d='M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.2C6.6 42.6 14.6 48 24 48z'/%3E%3C/svg%3E";

function GoogleMark({ small }: { small?: boolean }) {
  if (small) return <img src={GOOGLE_G} alt="" className="size-4 shrink-0" />;
  return (
    <span className="avatar grid size-8 shrink-0 place-items-center bg-canvas">
      <img src={GOOGLE_G} alt="" className="size-4" />
    </span>
  );
}

/** The side panel before the first snapshot arrives. */
export function RailSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading your day">
      {[3, 2, 1].map((rows, index) => (
        <div key={index}>
          <span className="SkeletonText mb-2 ml-1 w-24" />
          <div className="Box space-y-3 p-3">
            {Array.from({ length: rows }, (_, row) => (
              <div key={row}>
                <span className="SkeletonText w-3/4" />
                <span className="SkeletonText w-1/2" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Rail(props: {
  agenda?: AgendaView;
  schedules: readonly ScheduleView[];
  schedulesError?: string;
  offline?: OfflineView;
  background?: BackgroundView;
  account?: AccountView;
  platform?: PlatformStatus;
  connections?: ConnectionsView;
  timeZone: string;
  highlightSchedule?: string;
  actions: AssistantActions;
}) {
  const ready = props.platform?.state === "ready";
  const demo = props.connections?.provider !== "google";
  return (
    <div className="flex flex-col gap-6">
      {/* While it's off, background work is the one thing here that needs the person, so it comes first. */}
      {props.background?.state === "off" && (
        <BackgroundOffNotice background={props.background} account={props.account} ready={ready} highlight={props.highlightSchedule === "background"} actions={props.actions} />
      )}
      <TodayCard agenda={props.agenda} timeZone={props.timeZone} demo={demo} />
      <AutomationsCard
        schedules={props.schedules}
        error={props.schedulesError}
        timeZone={props.timeZone}
        highlight={props.highlightSchedule}
        ready={ready}
        background={props.background}
        actions={props.actions}
      />
      <ConnectionsCard connections={props.connections} ready={ready} actions={props.actions} />
      <AwayCard offline={props.offline} platform={props.platform} background={props.background} />
    </div>
  );
}
