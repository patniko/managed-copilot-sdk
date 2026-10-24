import {
  Bell,
  CalendarDays,
  Check,
  CircleAlert,
  Ellipsis,
  LoaderCircle,
  Mail,
  MapPin,
  Pause,
  Play,
  Plus,
  Repeat,
  RotateCcw,
  Satellite,
  ShieldCheck,
  Trash,
  Unplug,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgendaView, ConnectionsView, OfflineView, PlatformStatus, ScheduleView } from "../../../shared/protocol";
import { dayLabel, fullDate, relativeTime, timeOf, timeRange, whenLabel } from "../format";
import type { AssistantActions } from "../useAssistant";

function Card({ title, icon, badge, children }: { title: string; icon: ReactNode; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-zinc-400">{icon}</span>
        <h2 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">{title}</h2>
        {badge && <div className="ml-auto">{badge}</div>}
      </div>
      {children}
    </section>
  );
}

function DemoBadge() {
  return <span className="chip bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">Demo data</span>;
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
    <Card title="Up next" icon={<CalendarDays className="size-4" />} badge={demo ? <DemoBadge /> : undefined}>
      {!agenda ? (
        <div className="space-y-2">
          <div className="h-3 w-3/4 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-3 w-1/2 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
        </div>
      ) : agenda.error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{agenda.error}</p>
      ) : upcoming.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Nothing on your calendar this week.</p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.label}>
              <div className="mb-1 px-2 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">{group.label === "Today" ? `Today · ${fullDate(new Date(), timeZone)}` : group.label}</div>
              <ol className="space-y-0.5">
                {group.events.map((event) => {
                  const live = Date.parse(event.start) <= now;
                  return (
                    <li key={event.id} className={`flex gap-3 rounded-lg px-2 py-1.5 ${event.id === nextId ? "bg-violet-50 dark:bg-violet-500/10" : ""}`}>
                      <div className="w-16 shrink-0 text-right text-xs leading-5 text-zinc-500 tabular-nums dark:text-zinc-400">{event.allDay ? "All day" : timeOf(event.start, timeZone)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {event.title}
                          {live && !event.allDay && <span className="ml-1.5 chip bg-emerald-100 align-middle text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">Now</span>}
                        </div>
                        <div className="flex items-center gap-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {!event.allDay && timeRange(event.start, event.end, timeZone)}
                          {event.location && (
                            <>
                              <MapPin className="ml-1 size-3 shrink-0" aria-hidden />
                              <span className="truncate">{event.location}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ScheduleMenu({ schedule, actions }: { schedule: ScheduleView; actions: AssistantActions }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" className="btn-ghost px-1.5 py-1" onClick={() => setOpen((value) => !value)} aria-label={`More actions for ${schedule.name}`}>
        <Ellipsis className="size-4" aria-hidden />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-xl bg-white py-1 text-sm shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800"
            onClick={() => {
              setOpen(false);
              void actions.runSchedule(schedule.id);
            }}
          >
            <Zap className="size-3.5" aria-hidden /> Run now
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
            onClick={() => {
              setOpen(false);
              void actions.deleteSchedule(schedule.id);
            }}
          >
            <Trash className="size-3.5" aria-hidden /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

export function AutomationsCard(props: {
  schedules: readonly ScheduleView[];
  error?: string;
  timeZone: string;
  highlight?: string;
  ready: boolean;
  actions: AssistantActions;
}) {
  const { schedules, actions } = props;
  const [busy, setBusy] = useState<string | undefined>();
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Card title="Reminders & automations" icon={<Bell className="size-4" />} badge={schedules.length ? <span className="text-xs text-zinc-400">{schedules.length}</span> : undefined}>
      {props.error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-zinc-50 px-2.5 py-2 text-xs text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300">
          <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          {props.error}
        </div>
      )}
      {schedules.length === 0 ? (
        <div className="text-sm text-zinc-500 dark:text-zinc-400">
          <p>Ask me to remind you about something, or to do a task on a schedule. They run on Managed Copilot even when this tab is closed.</p>
          <button type="button" className="btn-secondary mt-3 w-full" disabled={!props.ready || busy === "briefing"} onClick={() => void act("briefing", () => actions.addBriefing())}>
            {busy === "briefing" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
            Weekday morning briefing
          </button>
        </div>
      ) : (
        <ul className="-mx-1 space-y-1">
          {schedules.map((schedule) => {
            const Icon = schedule.oneShot ? Bell : Repeat;
            const paused = schedule.state === "paused";
            const failed = schedule.lastRun?.status === "failed";
            return (
              <li
                key={schedule.id}
                id={`schedule-${schedule.id}`}
                className={`group flex items-start gap-2.5 rounded-xl px-2 py-2 transition-colors ${props.highlight === schedule.id ? "bg-violet-50 ring-1 ring-violet-200 dark:bg-violet-500/10 dark:ring-violet-500/30" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"}`}
              >
                <span className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg ${paused ? "bg-zinc-100 text-zinc-400 dark:bg-zinc-800" : "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"}`}>
                  <Icon className="size-3.5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-sm font-medium ${paused ? "text-zinc-400 line-through decoration-zinc-300" : "text-zinc-900 dark:text-zinc-100"}`} title={schedule.prompt}>
                    {schedule.name}
                  </div>
                  <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">{schedule.cadence}</div>
                  <div className="truncate text-[11px] text-zinc-400">
                    {paused ? "Paused" : schedule.nextRunAt ? `Next: ${whenLabel(schedule.nextRunAt, props.timeZone)}` : schedule.lastRun ? "Finished" : "Waiting to run"}
                    {failed && <span className="ml-1 text-red-500">· Last run failed{schedule.lastRun?.reason ? `: ${schedule.lastRun.reason}` : ""}</span>}
                    {!failed && schedule.lastRun?.completedAt && <span> · Last ran {relativeTime(schedule.lastRun.completedAt)}</span>}
                    {schedule.createdBy === "agent" && <span> · Set by your assistant</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center">
                  {busy === schedule.id ? (
                    <LoaderCircle className="m-1.5 size-4 animate-spin text-zinc-400" aria-hidden />
                  ) : (
                    <button
                      type="button"
                      className="btn-ghost px-1.5 py-1"
                      disabled={!props.ready}
                      onClick={() => void act(schedule.id, () => (paused ? actions.resumeSchedule(schedule.id) : actions.pauseSchedule(schedule.id)))}
                      aria-label={paused ? `Resume ${schedule.name}` : `Pause ${schedule.name}`}
                      title={paused ? "Resume" : "Pause"}
                    >
                      {paused ? <Play className="size-4" aria-hidden /> : <Pause className="size-4" aria-hidden />}
                    </button>
                  )}
                  <ScheduleMenu schedule={schedule} actions={actions} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function AwayCard({ offline, platform }: { offline?: OfflineView; platform?: PlatformStatus }) {
  const ready = platform?.state === "ready";
  return (
    <Card title="Works while you're away" icon={<Satellite className="size-4" />}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Close this tab and reminders and briefings keep running on Managed Copilot. When they need your mail or calendar, the platform calls this app's
        signed webhook, so your Google credentials never leave it.
      </p>
      <ul className="mt-3 space-y-1.5 text-xs">
        <li className="flex items-center gap-2">
          {offline?.webhookConfigured ? <Check className="size-3.5 text-emerald-500" aria-hidden /> : <CircleAlert className="size-3.5 text-amber-500" aria-hidden />}
          <span className="text-zinc-600 dark:text-zinc-300">{offline?.webhookConfigured ? "Webhook configured" : "Webhook secret not set (falls back to polling)"}</span>
        </li>
        <li className="flex items-center gap-2">
          {ready ? <Check className="size-3.5 text-emerald-500" aria-hidden /> : <Unplug className="size-3.5 text-zinc-400" aria-hidden />}
          <span className="text-zinc-600 dark:text-zinc-300">{ready ? "Platform connected" : "Platform not connected"}</span>
        </li>
        {offline && offline.handledOffline > 0 && (
          <li className="flex items-center gap-2">
            <Satellite className="size-3.5 text-sky-500" aria-hidden />
            <span className="text-zinc-600 dark:text-zinc-300">
              {offline.handledOffline} tool call{offline.handledOffline === 1 ? "" : "s"} answered while no tab was open
              {offline.lastWebhookAt ? ` · last ${relativeTime(offline.lastWebhookAt)}` : ""}
            </span>
          </li>
        )}
        {offline && offline.waitingApprovals > 0 && (
          <li className="flex items-center gap-2">
            <ShieldCheck className="size-3.5 text-violet-500" aria-hidden />
            <span className="text-zinc-600 dark:text-zinc-300">{offline.waitingApprovals} approval{offline.waitingApprovals === 1 ? "" : "s"} waiting for you</span>
          </li>
        )}
      </ul>
    </Card>
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
    <Card title="Mail & calendar" icon={<Mail className="size-4" />}>
      {google?.connected ? (
        <div>
          <div className="flex items-center gap-2.5">
            <GoogleMark />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{google.email ?? "Google account"}</div>
              <div className={`text-xs ${google.status === "needs_reconnect" ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                {google.status === "needs_reconnect" ? "Access expired · reconnect" : "Gmail and Google Calendar connected"}
              </div>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            {google.status === "needs_reconnect" && (
              <button type="button" className="btn-primary flex-1" onClick={() => void act("connect", () => actions.connectGoogle())}>
                Reconnect
              </button>
            )}
            <button type="button" className="btn-secondary flex-1" disabled={busy === "disconnect"} onClick={() => void act("disconnect", () => actions.disconnectGoogle())}>
              {busy === "disconnect" && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div>
          <div className="flex items-start gap-2.5 rounded-xl bg-amber-50 px-3 py-2.5 ring-1 ring-amber-200/70 dark:bg-amber-500/10 dark:ring-amber-500/20">
            <span className="mt-0.5 text-amber-600 dark:text-amber-400">
              <Mail className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 text-xs text-amber-900 dark:text-amber-100">
              <div className="font-semibold">Using the demo workspace</div>
              <div className="opacity-80">A sample inbox and calendar for {connections?.demo.address ?? "you"}. Nothing is sent outside this app.</div>
            </div>
          </div>
          {google?.configured ? (
            <button type="button" className="btn-primary mt-3 w-full" disabled={!ready || busy === "connect"} onClick={() => void act("connect", () => actions.connectGoogle())}>
              {busy === "connect" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <GoogleMark small />}
              Connect Google
            </button>
          ) : (
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              To use your own Gmail and Calendar, set <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">google-client-id</code> and{" "}
              <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">google-client-secret</code> (see the README).
            </p>
          )}
          <button type="button" className="btn-ghost mt-1 w-full text-xs" disabled={!ready || busy === "reset"} onClick={() => void act("reset", () => actions.resetDemo())}>
            {busy === "reset" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <RotateCcw className="size-3.5" aria-hidden />}
            Reset demo inbox and calendar
          </button>
        </div>
      )}
    </Card>
  );
}

function GoogleMark({ small }: { small?: boolean }) {
  const size = small ? "size-4" : "size-8";
  return (
    <span className={`${size} grid shrink-0 place-items-center rounded-full bg-white ring-1 ring-zinc-200 dark:ring-zinc-700`}>
      <svg viewBox="0 0 48 48" className={small ? "size-3" : "size-4.5"} aria-hidden>
        <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.2z" />
        <path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.4 0 20.1 0 24s1 7.6 2.6 10.8l7.9-6.2z" />
        <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.2C6.6 42.6 14.6 48 24 48z" />
      </svg>
    </span>
  );
}

export function Rail(props: {
  agenda?: AgendaView;
  schedules: readonly ScheduleView[];
  schedulesError?: string;
  offline?: OfflineView;
  platform?: PlatformStatus;
  connections?: ConnectionsView;
  timeZone: string;
  highlightSchedule?: string;
  actions: AssistantActions;
}) {
  const ready = props.platform?.state === "ready";
  const demo = props.connections?.provider !== "google";
  return (
    <div className="flex flex-col gap-3">
      <TodayCard agenda={props.agenda} timeZone={props.timeZone} demo={demo} />
      <AutomationsCard schedules={props.schedules} error={props.schedulesError} timeZone={props.timeZone} highlight={props.highlightSchedule} ready={ready} actions={props.actions} />
      <ConnectionsCard connections={props.connections} ready={ready} actions={props.actions} />
      <AwayCard offline={props.offline} platform={props.platform} />
    </div>
  );
}
