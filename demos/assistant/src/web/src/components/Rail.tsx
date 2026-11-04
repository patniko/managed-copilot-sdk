import {
  AlertIcon,
  BellIcon,
  BroadcastIcon,
  CheckCircleFillIcon,
  ContainerIcon,
  DotFillIcon,
  InfoIcon,
  IterationsIcon,
  KebabHorizontalIcon,
  MailIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  ShieldCheckIcon,
  ShieldIcon,
  SignOutIcon,
  StopIcon,
  TerminalIcon,
  TrashIcon,
  UndoIcon,
  XCircleFillIcon,
  ZapIcon,
} from "@primer/octicons-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import type {
  AccountView,
  AgendaView,
  BackgroundView,
  ConnectionsView,
  OfflineView,
  PlatformStatus,
  SandboxEnvironmentView,
  SandboxesView,
  SandboxWorkerView,
  ScheduleView,
} from "../../../shared/protocol";
import { dayLabel, relativeTime, timeOf, timeRange, whenLabel } from "../format";
import type { AssistantActions } from "../useAssistant";
import { capitalize, networkLabel, SANDBOX_ICONS } from "./Sandbox";
import { CopyButton, cx, Menu, Spinner, Tooltip } from "./ui";

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
  return (
    <Tooltip content="A sample calendar. Connect Google under Mail & calendar to use yours.">
      <span className="Label Label--attention" tabIndex={0}>
        Demo data
      </span>
    </Tooltip>
  );
}

/** How many events "Up next" shows before "Show more". */
const UP_NEXT = 5;

/** Today's remaining events and the next few after them, one line each; details in a tooltip. */
export function TodayCard({ agenda, timeZone, demo }: { agenda?: AgendaView; timeZone: string; demo: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const now = Date.now();
  const upcoming = (agenda?.events ?? []).filter((event) => Date.parse(event.end) > now);
  const nextId = upcoming.find((event) => !event.allDay && Date.parse(event.start) > now)?.id;
  const shown = expanded ? upcoming : upcoming.slice(0, UP_NEXT);
  const more = upcoming.length - Math.min(upcoming.length, UP_NEXT);
  const groups: { label: string; events: typeof shown }[] = [];
  for (const event of shown) {
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
        <div className="Box px-3 py-2.5 text-fg-muted">Nothing on your calendar this week.</div>
      ) : (
        <div className="Box overflow-hidden">
          {groups.map((group, index) => (
            <div key={group.label} className={cx("py-1", index > 0 && "border-t border-line-muted")}>
              <h3 className="px-3 pt-1 pb-0.5 text-xs font-semibold text-fg-muted">{group.label}</h3>
              <ol>
                {group.events.map((event) => {
                  const live = !event.allDay && Date.parse(event.start) <= now;
                  const when = event.allDay ? "All day" : timeRange(event.start, event.end, timeZone);
                  const details = [when, event.location].filter(Boolean).join(" · ");
                  return (
                    <Tooltip key={event.id} content={details} describe={false}>
                      <li className="flex min-h-8 items-center gap-3 px-3">
                        <span className="w-16 shrink-0 text-xs text-fg-muted tabular-nums" aria-hidden>
                          {event.allDay ? "All day" : timeOf(event.start, timeZone)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {event.title}
                          <span className="sr-only">, {details}</span>
                        </span>
                        {live ? (
                          <span className="Label Label--success shrink-0">Now</span>
                        ) : event.id === nextId ? (
                          <span className="Label Label--accent shrink-0">Next</span>
                        ) : null}
                      </li>
                    </Tooltip>
                  );
                })}
              </ol>
            </div>
          ))}
          {more > 0 && (
            <button
              type="button"
              className="block w-full border-t border-line-muted px-3 py-1.5 text-center text-xs font-semibold text-fg-accent hover:bg-canvas-muted"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show less" : `Show ${more} more`}
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

/**
 * Background work is off: one line and the button that turns it on, with what that means one click away. This is the
 * only place the app turns it on.
 */
export function BackgroundOffNotice({ background, account, ready, highlight, actions }: { background: BackgroundView; account?: AccountView; ready: boolean; highlight?: boolean; actions: AssistantActions }) {
  const [busy, setBusy] = useState<"enable" | "check" | undefined>();
  const [open, setOpen] = useState(false);
  const consentId = useId();
  const stopped = background.reason !== undefined;
  const login = background.login ?? account?.login;
  // Brought here from a blocked suggestion or the chat: show what turning it on means.
  useEffect(() => {
    if (highlight) setOpen(true);
  }, [highlight]);
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
      className={cx("flash flash-warn flex-col items-stretch gap-0 p-3 transition-shadow duration-200", highlight && "ring-2 ring-line-accent")}
    >
      <div className="flex items-center gap-2">
        <ShieldIcon className="shrink-0 text-fg-attention" />
        <Tooltip content={background.reason} describe={false}>
          <span className="min-w-0 flex-1 font-semibold">{stopped ? "Background work stopped" : "Background work is off"}</span>
        </Tooltip>
        <button
          type="button"
          className="btn btn-sm shrink-0"
          aria-label={stopped ? "Turn background work back on" : "Turn on background work"}
          aria-describedby={consentId}
          disabled={!ready || busy !== undefined}
          title={ready ? undefined : "Managed Copilot isn't connected"}
          onClick={() => void act("enable", () => actions.enableBackground())}
        >
          {busy === "enable" && <Spinner />}
          Turn on
        </button>
      </div>
      <details className="mt-1 pl-6 text-xs" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="w-fit cursor-pointer text-fg-muted select-none hover:text-fg">What this means</summary>
        <div className="mt-1.5 space-y-2 text-fg-muted">
          {stopped && <p className="text-fg">{background.reason}</p>}
          <p id={consentId}>
            Reminders and automations run as you while this tab is closed. Turning it on keeps a sealed copy of your GitHub sign-in{login ? ` (@${login})` : ""} on
            this deployment for all your scheduled work. Turn it off anytime in Settings.
          </p>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <TerminalIcon size={12} />
            <span>Or run</span>
            <span className="inline-flex items-center rounded-md border border-line bg-canvas pl-1.5 font-mono text-fg">
              {LOGIN_COMMAND}
              <CopyButton text={LOGIN_COMMAND} label="Copy the command" />
            </span>
            <span>then</span>
            <button type="button" className="Link font-semibold disabled:opacity-50" disabled={!ready || busy !== undefined} onClick={() => void act("check", () => actions.checkBackground())}>
              {busy === "check" ? "checking…" : "check again"}
            </button>
          </div>
        </div>
      </details>
    </section>
  );
}

/** The automations' footer: whether scheduled work runs while you're away, and what it handled meanwhile. */
function BackgroundStatusLine({ background, offline, ready, actions }: { background?: BackgroundView; offline?: OfflineView; ready: boolean; actions: AssistantActions }) {
  const [checking, setChecking] = useState(false);
  if (!ready) return null;
  const footer = "Box-footer flex min-w-0 items-center gap-1.5 px-3 py-2 text-xs text-fg-muted";
  if (background?.state === "on") {
    const handled = offline?.handledOffline ?? 0;
    return (
      <div data-testid="background" data-state="on" className={footer}>
        <ShieldCheckIcon size={12} className="shrink-0 text-fg-success" />
        <Tooltip content={`Reminders and automations run${background.login ? ` as @${background.login}` : ""} while this tab is closed. Turn it off in Settings.`}>
          <span className="min-w-0 flex-1 truncate" tabIndex={0}>
            Background work on{background.login ? ` · @${background.login}` : ""}
          </span>
        </Tooltip>
        {handled > 0 && (
          <Tooltip content={`${handled} tool call${handled === 1 ? "" : "s"} answered while no tab was open${offline?.lastWebhookAt ? `, the last ${relativeTime(offline.lastWebhookAt)}` : ""}`}>
            <span className="inline-flex shrink-0 items-center gap-1 text-fg-accent" tabIndex={0}>
              <BroadcastIcon size={12} />
              {handled}
              <span className="sr-only">handled while you were away</span>
            </span>
          </Tooltip>
        )}
      </div>
    );
  }
  if (background?.state === "unavailable") {
    return (
      <div data-testid="background" data-state="unavailable" className={footer}>
        <InfoIcon size={12} className="shrink-0" />
        <span className="min-w-0 truncate" title="This deployment can't run work while you're away, so reminders and automations aren't available.">
          Not available on this deployment
        </span>
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
  if (background.state === "error") {
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

/** A schedule's line under its name: its cadence, or why it needs you (paused, or its last run failed). */
function ScheduleMeta({ schedule }: { schedule: ScheduleView }) {
  const paused = schedule.state === "paused";
  const failed = !paused && schedule.lastRun?.status === "failed";
  if (paused) {
    return (
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
        <span className="Label Label--attention shrink-0">Paused</span>
        <span className="truncate">{schedule.pausedReason ?? schedule.cadence}</span>
      </div>
    );
  }
  if (failed) {
    const failure = `Last run failed${schedule.lastRun?.reason ? `: ${schedule.lastRun.reason}` : ""}`;
    return (
      <div className="flex min-w-0 items-center gap-1 text-xs text-fg-danger">
        <XCircleFillIcon size={12} className="shrink-0" />
        <span className="truncate" title={failure}>
          {failure}
        </span>
      </div>
    );
  }
  return <div className="truncate text-xs text-fg-muted">{schedule.cadence}</div>;
}

/** What a schedule's row doesn't show: when it runs next, when it last ran, and who set it. */
function scheduleNotes(schedule: ScheduleView, timeZone: string): string[] {
  return [
    schedule.state === "active" && schedule.nextRunAt ? `Next ${whenLabel(schedule.nextRunAt, timeZone)}` : undefined,
    schedule.lastRun?.completedAt ? `Last ran ${relativeTime(schedule.lastRun.completedAt)}` : undefined,
    schedule.createdBy === "agent" ? "Set by your assistant" : undefined,
  ].filter((note): note is string => note !== undefined);
}

/** Everything about a schedule that its row doesn't show: what it asks, when it runs, and how it went. */
function ScheduleDetails({ schedule, timeZone }: { schedule: ScheduleView; timeZone: string }) {
  const notes = [schedule.cadence, ...scheduleNotes(schedule, timeZone)];
  return (
    <span className="block text-left">
      <span className="block">“{schedule.prompt}”</span>
      <span className="mt-1 block opacity-80">{notes.join(" · ")}</span>
    </span>
  );
}

/** The empty reminders list in one line: what reminders do, or what they wait for. */
function emptyLine(background?: BackgroundView): string {
  if (background?.state === "off") return "Reminders need background work.";
  if (background?.state === "unavailable") return "Reminders aren't available on this deployment.";
  return "Reminders keep running when this tab is closed.";
}

export function AutomationsCard(props: {
  schedules: readonly ScheduleView[];
  error?: string;
  timeZone: string;
  highlight?: string;
  ready: boolean;
  background?: BackgroundView;
  offline?: OfflineView;
  actions: AssistantActions;
}) {
  const { schedules, actions } = props;
  const [busy, setBusy] = useState<string | undefined>();
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
        <div className="mb-2 flex min-w-0 items-center gap-1.5 px-1 text-xs text-fg-attention">
          <AlertIcon size={12} className="shrink-0" />
          <span className="min-w-0 truncate" title={props.error}>
            {props.error}
          </span>
        </div>
      )}
      <div className="Box">
        {schedules.length === 0 ? (
          <div className="flex flex-col gap-2 p-3">
            {!props.error && <p className="text-fg-muted">{emptyLine(props.background)}</p>}
            <Tooltip content={briefingBlocked ?? "Every weekday at 8:00 AM: your calendar and important unread mail"}>
              <button
                type="button"
                className="btn btn-sm btn-block"
                aria-disabled={briefingBlocked !== undefined || busy === "briefing" || undefined}
                onClick={() => {
                  if (briefingBlocked !== undefined || busy === "briefing") return;
                  void act("briefing", () => actions.addBriefing());
                }}
              >
                {busy === "briefing" ? <Spinner /> : <PlusIcon />}
                Weekday morning briefing
              </button>
            </Tooltip>
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
                  className={cx("Box-row flex items-center gap-3 px-3 py-2 transition-colors duration-200", props.highlight === schedule.id && "Box-row--selected")}
                >
                  <ScheduleIcon className={cx("shrink-0", paused ? "text-fg-disabled" : "text-fg-muted")} />
                  <Tooltip content={<ScheduleDetails schedule={schedule} timeZone={props.timeZone} />} describe={false}>
                    <div className="min-w-0 flex-1">
                      <div className={cx("truncate font-semibold", paused && "text-fg-muted")}>{schedule.name}</div>
                      <ScheduleMeta schedule={schedule} />
                      <span className="sr-only">
                        {[`Asks: ${schedule.prompt.replace(/[.!?\s]+$/, "")}`, paused || schedule.lastRun?.status === "failed" ? schedule.cadence : undefined, ...scheduleNotes(schedule, props.timeZone)].filter(Boolean).join(". ")}
                      </span>
                    </div>
                  </Tooltip>
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
        <BackgroundStatusLine background={props.background} offline={props.offline} ready={props.ready} actions={actions} />
      </div>
    </Section>
  );
}

/** A sandbox's state as an icon and a word. */
function SandboxState({ worker }: { worker: SandboxWorkerView }) {
  switch (worker.state) {
    case "starting":
    case "working":
      return (
        <span className="inline-flex items-center gap-1 text-fg-attention">
          <Spinner size={12} />
          {worker.state === "starting" ? "Starting" : "Working"}
        </span>
      );
    case "idle":
      return (
        <span className="inline-flex items-center gap-0.5">
          <DotFillIcon size={12} className="text-fg-success" />
          Idle
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 text-fg-danger">
          <XCircleFillIcon size={12} />
          Failed
        </span>
      );
    case "stopped":
      return (
        <span className="inline-flex items-center gap-1">
          <StopIcon size={12} />
          Stopped
        </span>
      );
  }
}

/** What happened to a sandbox's sandbox, in a few words. */
function sandboxNote(worker: SandboxWorkerView): string {
  switch (worker.state) {
    case "starting":
      return "Starting its sandbox";
    case "working":
      return "Working on a task";
    case "idle":
      return worker.sandboxState === "stopped" ? "Sandbox paused, files kept" : "Sandbox kept for follow-ups";
    case "failed":
      return "Its last task failed; sandbox kept";
    case "stopped":
      return "Stopped; its sandbox is deleted";
  }
}

/** One sandbox: its name, state, and number of tasks. The rest (where and how it runs) is in the tooltip. */
function SandboxTile({ worker, environment, onOpen }: { worker: SandboxWorkerView; environment?: SandboxEnvironmentView; onOpen(): void }) {
  const KindIcon = SANDBOX_ICONS[environment?.kind ?? "general"];
  const stopped = worker.state === "stopped";
  const lines = [
    environment ? capitalize(environment.label) : "Sandbox",
    [worker.environment, environment?.size, networkLabel(environment?.network)].filter(Boolean).join(" · "),
    sandboxNote(worker),
    worker.error,
  ].filter(Boolean);
  // One text with line breaks, so the description screen readers get keeps a pause between lines.
  const details = <span className="block whitespace-pre-line text-left">{lines.join(".\n")}</span>;
  return (
    <li className="min-w-0" data-testid="sandbox-row" data-worker={worker.name} data-state={worker.state}>
      <Tooltip content={details}>
        <button
          type="button"
          className="Box flex h-full w-full flex-col gap-1 p-2.5 text-left transition-colors duration-100 hover:bg-canvas-muted"
          onClick={onOpen}
          aria-label={`${worker.name}: ${worker.state}, ${worker.messages} task${worker.messages === 1 ? "" : "s"}. Show in the chat`}
        >
          <span className="flex w-full min-w-0 items-center gap-1.5">
            <KindIcon size={14} className={cx("shrink-0", stopped ? "text-fg-disabled" : "text-fg-accent")} />
            <span className={cx("min-w-0 flex-1 truncate font-semibold", stopped && "text-fg-muted")}>{worker.name}</span>
            <span className="shrink-0 text-xs text-fg-muted tabular-nums">
              {worker.messages} task{worker.messages === 1 ? "" : "s"}
            </span>
          </span>
          <span className="flex w-full min-w-0 items-center pl-5 text-xs text-fg-muted">
            <SandboxState worker={worker} />
          </span>
        </button>
      </Tooltip>
    </li>
  );
}

const MAX_SANDBOX_TILES = 6;

/**
 * The conversation's sandboxes as tiles, newest first with stopped ones last. Starting one always asks first; this
 * panel only shows them (the assistant stops them, or Start over deletes them).
 */
export function SandboxesCard({ sandboxes, onOpen, onOpenSettings }: { sandboxes?: SandboxesView; onOpen(workerId: string): void; onOpenSettings(): void }) {
  if (!sandboxes || (sandboxes.environments.length === 0 && !sandboxes.unavailable)) return null;
  const kinds = new Map(sandboxes.environments.map((environment) => [environment.name, environment]));
  const byRecent = (a: SandboxWorkerView, b: SandboxWorkerView) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  const workers = [...sandboxes.workers.filter((worker) => worker.state !== "stopped").sort(byRecent), ...sandboxes.workers.filter((worker) => worker.state === "stopped").sort(byRecent)];
  const shown = workers.slice(0, MAX_SANDBOX_TILES);
  return (
    <Section title="Sandboxes" counter={workers.length > 0 ? workers.length : undefined}>
      {sandboxes.unavailable ? (
        <div className="flash flash-sm flash-warn" data-testid="sandboxes-unavailable">
          <AlertIcon />
          <div className="flash-content">
            <span className="line-clamp-2" title={sandboxes.unavailable.reason}>
              {sandboxes.unavailable.reason}
            </span>
            {sandboxes.unavailable.startOver && (
              <button type="button" className="btn btn-sm mt-2 block" onClick={onOpenSettings}>
                Open settings
              </button>
            )}
          </div>
        </div>
      ) : (
        <div data-testid="sandboxes">
          {sandboxes.error && (
            <div className="mb-2 flex min-w-0 items-center gap-1.5 px-1 text-xs text-fg-attention">
              <AlertIcon size={12} className="shrink-0" />
              <span className="min-w-0 truncate" title={sandboxes.error}>
                {sandboxes.error}
              </span>
            </div>
          )}
          {workers.length === 0 ? (
            <Tooltip content={sandboxes.environments.map((environment) => capitalize(environment.label)).join(", ")} describe={false}>
              <div className="Box flex items-center gap-2 px-3 py-2.5 text-fg-muted">
                <ContainerIcon className="shrink-0" />
                <span className="min-w-0 truncate">None yet · each one asks you first</span>
                <span className="sr-only">. It can start: {sandboxes.environments.map((environment) => environment.label).join(", ")}</span>
              </div>
            </Tooltip>
          ) : (
            <ul className="flex flex-col gap-2">
              {shown.map((worker) => (
                <SandboxTile key={worker.id} worker={worker} environment={kinds.get(worker.environment)} onOpen={() => onOpen(worker.id)} />
              ))}
            </ul>
          )}
          {workers.length > shown.length && <div className="mt-1.5 px-1 text-xs text-fg-muted">and {workers.length - shown.length} older</div>}
        </div>
      )}
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
  const overflow = (label: string, items: Parameters<typeof Menu>[0]["items"]) =>
    busy === "disconnect" || busy === "reset" ? (
      <span className="grid size-7 shrink-0 place-items-center text-fg-muted">
        <Spinner />
      </span>
    ) : (
      <Menu
        label={label}
        width="w-60"
        items={items}
        renderTrigger={(trigger) => (
          <button type="button" className="btn-octicon -mr-1 shrink-0" aria-label={label} disabled={!ready} {...trigger}>
            <KebabHorizontalIcon />
          </button>
        )}
      />
    );
  return (
    <Section title="Mail & calendar">
      {google?.connected ? (
        <div className="Box">
          <div className="flex items-center gap-2.5 px-3 py-2.5">
            <GoogleMark />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold" title={google.email}>
                {google.email ?? "Google account"}
              </div>
              {google.status === "needs_reconnect" ? (
                <div className="flex items-center gap-1 text-xs text-fg-attention">
                  <AlertIcon size={12} />
                  Access expired
                </div>
              ) : (
                <div className="flex items-center gap-1 text-xs text-fg-muted">
                  <CheckCircleFillIcon size={12} className="text-fg-success" />
                  Connected
                </div>
              )}
            </div>
            {overflow("More actions for Google", [
              { key: "disconnect", label: "Disconnect Google", icon: SignOutIcon, danger: true, onSelect: () => void act("disconnect", () => actions.disconnectGoogle()) },
            ])}
          </div>
          {google.status === "needs_reconnect" && (
            <div className="Box-footer px-3 py-2">
              <button type="button" className="btn btn-sm btn-block" disabled={busy === "connect"} onClick={() => void act("connect", () => actions.connectGoogle())}>
                {busy === "connect" ? <Spinner /> : <GoogleMark small />}
                Reconnect Google
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="Box">
          <div className="flex items-center gap-2.5 px-3 py-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-attention-muted text-fg-attention" aria-hidden>
              <MailIcon />
            </span>
            <Tooltip content={`A sample inbox and calendar for ${connections?.demo.address ?? "you"}. Nothing is sent outside this app.`}>
              <span className="min-w-0 flex-1 truncate font-semibold" tabIndex={0}>
                Demo inbox & calendar
              </span>
            </Tooltip>
            {overflow("More actions for the demo workspace", [
              { key: "reset", label: "Reset demo inbox and calendar", icon: UndoIcon, onSelect: () => void act("reset", () => actions.resetDemo()) },
            ])}
          </div>
          <div className="Box-footer px-3 py-2">
            {google?.configured ? (
              <button type="button" className="btn btn-sm btn-block" disabled={!ready || busy === "connect"} onClick={() => void act("connect", () => actions.connectGoogle())}>
                {busy === "connect" ? <Spinner /> : <GoogleMark small />}
                Connect Google
              </button>
            ) : (
              <Tooltip content="Set google-client-id and google-client-secret (see the README) to use your own Gmail and Calendar.">
                <p className="w-fit text-xs text-fg-muted" tabIndex={0}>
                  Add Google credentials to use yours
                </p>
              </Tooltip>
            )}
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
  sandboxes?: SandboxesView;
  timeZone: string;
  highlightSchedule?: string;
  actions: AssistantActions;
  onOpenSandbox(workerId: string): void;
  onOpenSettings(): void;
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
      <SandboxesCard sandboxes={props.sandboxes} onOpen={props.onOpenSandbox} onOpenSettings={props.onOpenSettings} />
      <AutomationsCard
        schedules={props.schedules}
        error={props.schedulesError}
        timeZone={props.timeZone}
        highlight={props.highlightSchedule}
        ready={ready}
        background={props.background}
        offline={props.offline}
        actions={props.actions}
      />
      <ConnectionsCard connections={props.connections} ready={ready} actions={props.actions} />
    </div>
  );
}
