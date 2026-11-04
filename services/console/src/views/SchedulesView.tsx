import type { OperatorSchedule } from "@managed-copilot/protocol/operator";
import type { ScheduleRun } from "@managed-copilot/protocol";
import { CalendarIcon, HistoryIcon, PauseIcon, PlayIcon } from "@primer/octicons-react";
import { getScheduleRuns, listSchedules } from "../lib/api.js";
import { formatNumber, shortId } from "../lib/format.js";
import { confirmPauseSchedule, confirmResumeSchedule } from "../lib/operatorActions.js";
import { usePoll } from "../lib/poll.js";
import { useQueryUpdater } from "../lib/router.js";
import type { Query } from "../lib/routes.js";
import { runStatusMeta, scheduleStateMeta } from "../lib/status.js";
import { AccountLabel, EnvironmentLink, IdText, RelativeTime, SessionLink } from "../components/common/Identity.js";
import { Page, PollContent } from "../components/layout/Page.js";
import { Button, IconButton } from "../components/ui/Button.js";
import { Card, Field, FieldGrid } from "../components/ui/Card.js";
import { Chip, StatusBadge } from "../components/ui/Chip.js";
import { CodeBlock } from "../components/ui/CodeBlock.js";
import { Segmented } from "../components/ui/Controls.js";
import { DataTable, TableSkeleton, type Column } from "../components/ui/DataTable.js";
import { Drawer } from "../components/ui/Drawer.js";
import { Callout, EmptyState, ErrorState, None, SectionLabel, SkeletonLines } from "../components/ui/Feedback.js";

type StateFilter = "all" | "active" | "paused";

const CREATED_BY: Readonly<Record<OperatorSchedule["createdBy"], string>> = { user: "Person", agent: "Agent", apphost: "AppHost" };

function When({ schedule }: { readonly schedule: OperatorSchedule }) {
  return (
    <span className="inline-flex flex-col">
      {schedule.cron ? (
        <code className="font-mono text-xs">{schedule.cron}</code>
      ) : schedule.runAt ? (
        <span>
          Once, <RelativeTime value={schedule.runAt} />
        </span>
      ) : (
        <None />
      )}
      <span className="text-xs text-fg-muted">{schedule.timeZone}</span>
    </span>
  );
}

export function SchedulesView({ query }: { readonly query: Query }) {
  const poll = usePoll("schedules", listSchedules);
  const setQuery = useQueryUpdater();
  const filter: StateFilter = query["state"] === "active" || query["state"] === "paused" ? query["state"] : "all";
  const selectedId = query["schedule"];
  const openRuns = (id: string): void => setQuery({ schedule: id }, { replace: false });

  const columns: readonly Column<OperatorSchedule>[] = [
    {
      id: "name",
      header: "Schedule",
      cell: (schedule) => (
        <span className="inline-flex min-w-0 flex-col">
          <button type="button" onClick={() => openRuns(schedule.id)} className="Link--primary truncate text-left font-semibold hover:underline" title={`Show runs of ${schedule.name}`}>
            {schedule.name}
          </button>
          <span className="font-mono text-xs text-fg-muted" title={schedule.id}>
            {shortId(schedule.id)}
          </span>
        </span>
      ),
    },
    { id: "owner", header: "Owner", cell: (schedule) => <AccountLabel account={schedule.owner} /> },
    { id: "createdBy", header: "Created by", cell: (schedule) => <Chip>{CREATED_BY[schedule.createdBy] ?? schedule.createdBy}</Chip>, hideBelow: "2xl" },
    { id: "when", header: "When", cell: (schedule) => <When schedule={schedule} /> },
    { id: "environment", header: "Environment", cell: (schedule) => <EnvironmentLink name={schedule.environment} />, hideBelow: "2xl" },
    {
      id: "state",
      header: "State",
      cell: (schedule) => (
        <span className="inline-flex flex-col items-start gap-1">
          <StatusBadge meta={scheduleStateMeta(schedule.state)} />
          {schedule.pausedReason ? (
            <span className="line-clamp-2 max-w-40 text-xs text-fg-muted" title={schedule.pausedReason}>
              {schedule.pausedReason}
            </span>
          ) : null}
        </span>
      ),
    },
    { id: "next", header: "Next run", cell: (schedule) => (schedule.state === "active" && schedule.nextRunAt ? <RelativeTime value={schedule.nextRunAt} /> : <None />), hideBelow: "2xl" },
    {
      id: "last",
      header: "Last run",
      cell: (schedule) =>
        schedule.lastRun ? (
          <span className="inline-flex flex-col items-start gap-1">
            <StatusBadge meta={runStatusMeta(schedule.lastRun.status)} title={schedule.lastRun.reason} />
            <RelativeTime value={schedule.lastRun.completedAt ?? schedule.lastRun.startedAt ?? schedule.lastRun.scheduledFor} className="text-xs text-fg-muted" />
          </span>
        ) : (
          <span className="text-fg-muted">Never</span>
        ),
      hideBelow: "xl",
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (schedule) => (
        <span className="inline-flex justify-end gap-2">
          <IconButton size="sm" icon={HistoryIcon} label={`Show runs of ${schedule.name}`} onClick={() => openRuns(schedule.id)} />
          {schedule.state === "active" ? (
            <Button size="sm" icon={PauseIcon} onClick={() => confirmPauseSchedule(schedule)}>
              Pause
            </Button>
          ) : (
            <Button size="sm" icon={PlayIcon} onClick={() => confirmResumeSchedule(schedule)}>
              Resume
            </Button>
          )}
        </span>
      ),
    },
  ];

  const schedules = poll.data ?? [];
  const active = schedules.filter((schedule) => schedule.state === "active").length;
  const paused = schedules.length - active;

  return (
    <Page wide title="Schedules" documentTitle="Schedules" description="Recurring and one-time runs of every owner, and the AppHost's schedules." poll={poll}>
      <div className="mb-4">
        <Segmented<StateFilter>
          label="Filter by state"
          value={filter}
          onChange={(value) => setQuery({ state: value === "all" ? undefined : value })}
          options={[
            { value: "all", label: "All", count: poll.data ? schedules.length : undefined },
            { value: "active", label: "Active", icon: PlayIcon, count: poll.data ? active : undefined },
            { value: "paused", label: "Paused", icon: PauseIcon, count: poll.data ? paused : undefined },
          ]}
        />
      </div>
      <Card padded={false}>
        <PollContent poll={poll} skeleton={<TableSkeleton columns={8} />} errorTitle="Couldn't load schedules">
          {(data) => (
            <DataTable
              label="Schedules"
              rows={filter === "all" ? data : data.filter((schedule) => schedule.state === filter)}
              columns={columns}
              rowKey={(schedule) => schedule.id}
              empty={
                <EmptyState icon={CalendarIcon} title={filter === "all" ? "No schedules" : `No ${filter} schedules`} spacious={filter === "all"} compact={filter !== "all"}>
                  {filter === "all" ? "Schedules appear here when the AppHost declares them or people and agents create them." : "Choose another filter to see more."}
                </EmptyState>
              }
            />
          )}
        </PollContent>
      </Card>
      <Drawer open={Boolean(selectedId)} onClose={() => setQuery({ schedule: undefined }, { replace: false })} title="Schedule runs">
        {selectedId ? <RunsPanel id={selectedId} /> : null}
      </Drawer>
    </Page>
  );
}

const RUN_COLUMNS: readonly Column<ScheduleRun>[] = [
  { id: "scheduled", header: "Scheduled for", cell: (run) => <RelativeTime value={run.scheduledFor} /> },
  { id: "trigger", header: "Trigger", cell: (run) => (run.trigger ? <Chip>{run.trigger}</Chip> : <None />) },
  { id: "status", header: "Status", cell: (run) => <StatusBadge meta={runStatusMeta(run.status)} /> },
  { id: "session", header: "Session", cell: (run) => <SessionLink id={run.sessionId} /> },
  { id: "started", header: "Started", cell: (run) => (run.startedAt ? <RelativeTime value={run.startedAt} className="text-fg-muted" /> : <None />) },
  { id: "completed", header: "Completed", cell: (run) => (run.completedAt ? <RelativeTime value={run.completedAt} className="text-fg-muted" /> : <None />) },
  {
    id: "reason",
    header: "Reason",
    cell: (run) =>
      run.reason ? (
        <span className="line-clamp-2 text-xs text-fg-muted" title={run.reason}>
          {run.reason}
        </span>
      ) : (
        <None />
      ),
  },
];

function RunsPanel({ id }: { readonly id: string }) {
  const poll = usePoll(`schedule-runs:${id}`, (signal) => getScheduleRuns(id, signal));
  if (poll.data === undefined) {
    if (poll.error) {
      return poll.error.status === 404 ? (
        <EmptyState icon={CalendarIcon} title="Schedule not found" compact>
          It may have been deleted.
        </EmptyState>
      ) : (
        <ErrorState title="Couldn't load the runs" message={poll.error.message} onRetry={() => void poll.refresh()} retrying={poll.loading} boxed />
      );
    }
    return (
      <div className="space-y-4" role="status" aria-label="Loading runs">
        <div className="Box p-4">
          <SkeletonLines lines={3} />
        </div>
        <div className="Box p-4">
          <SkeletonLines lines={5} />
        </div>
      </div>
    );
  }
  const { schedule, runs } = poll.data;
  return (
    <div className="space-y-5">
      {poll.error ? (
        <Callout tone="attention" role="status">
          Couldn&apos;t refresh: {poll.error.message}
        </Callout>
      ) : null}
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <CalendarIcon size={16} className="text-fg-muted" />
          <h3 className="text-base font-semibold">{schedule.name}</h3>
          <StatusBadge meta={scheduleStateMeta(schedule.state)} />
          <span className="ml-auto">
            {schedule.state === "active" ? (
              <Button size="sm" icon={PauseIcon} onClick={() => confirmPauseSchedule(schedule)}>
                Pause
              </Button>
            ) : (
              <Button size="sm" icon={PlayIcon} onClick={() => confirmResumeSchedule(schedule)}>
                Resume
              </Button>
            )}
          </span>
        </div>
        {schedule.pausedReason ? (
          <Callout tone="attention" className="mt-3" title="Paused" icon={PauseIcon}>
            {schedule.pausedReason}
          </Callout>
        ) : null}
      </div>
      <div className="Box p-4">
        <FieldGrid columns={2}>
          <Field label="Schedule ID">
            <IdText id={schedule.id} label="schedule ID" length={12} />
          </Field>
          <Field label="Owner">
            <AccountLabel account={schedule.owner} />
          </Field>
          <Field label="When">
            <When schedule={schedule} />
          </Field>
          <Field label="Environment">
            <EnvironmentLink name={schedule.environment} />
          </Field>
          <Field label="Created by">{CREATED_BY[schedule.createdBy] ?? schedule.createdBy}</Field>
          <Field label="Created">
            <RelativeTime value={schedule.createdAt} />
          </Field>
          <Field label="Next run">{schedule.state === "active" && schedule.nextRunAt ? <RelativeTime value={schedule.nextRunAt} /> : undefined}</Field>
          <Field label="Target session">{schedule.target ? <SessionLink id={schedule.target.sessionId} copy /> : <span className="text-fg-muted">A new session per run</span>}</Field>
          <Field label="Session settings" wide>
            {schedule.session ? (
              <span className="flex flex-wrap gap-1.5">
                {schedule.session.agent ? <Chip>agent: {schedule.session.agent}</Chip> : null}
                {schedule.session.model ? <Chip mono>model: {schedule.session.model}</Chip> : null}
                {(schedule.session.tools ?? []).map((tool) => (
                  <Chip key={tool.name} mono title={tool.description}>
                    tool: {tool.name}
                  </Chip>
                ))}
              </span>
            ) : undefined}
          </Field>
          <Field label="Webhook" mono>
            {schedule.webhook}
          </Field>
        </FieldGrid>
      </div>
      {schedule.prompt ? <CodeBlock text={schedule.prompt} label="Prompt (AppHost configuration)" copyLabel="Copy prompt" maxHeight="sm" /> : null}
      <section>
        <SectionLabel className="mb-2">
          Runs <span className="Counter ml-1">{formatNumber(runs.length)}</span>
        </SectionLabel>
        <div className="Box overflow-hidden">
          <DataTable
            label={`Runs of ${schedule.name}`}
            rows={runs}
            columns={RUN_COLUMNS}
            rowKey={(run) => run.id}
            empty={
              <EmptyState icon={HistoryIcon} title="No runs yet" compact>
                {schedule.state === "active" && schedule.nextRunAt ? "Its first run is scheduled; see Next run above." : "Runs appear here once it starts one."}
              </EmptyState>
            }
          />
        </div>
      </section>
    </div>
  );
}
