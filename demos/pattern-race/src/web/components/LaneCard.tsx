import {
  CheckCircleFillIcon,
  ChevronRightIcon,
  CircleIcon,
  SkipIcon,
  SquareFillIcon,
  TrophyIcon,
  XCircleFillIcon,
  type Icon,
} from "@primer/octicons-react";
import type { ReactNode } from "react";
import type { Job } from "../../shared/jobs.js";
import type { Lane } from "../../shared/lanes.js";
import { agentCount, elapsedMs, formatClock, formatCount, ordinal, premiumRequests, sandboxCount } from "../../shared/score.js";
import type { LaneAvailability, LaneRun, RaceSnapshot } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { openLane } from "../lib/store.js";
import { Placement } from "./Placement.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

export interface LaneCardProps {
  readonly lane: Lane;
  readonly availability: LaneAvailability | undefined;
  readonly race: RaceSnapshot | undefined;
  /** The race's job (or the picked one, before a race). */
  readonly job: Job;
  readonly run: LaneRun | undefined;
  readonly now: number;
}

/** One lane of the race board: the pattern, where its brain and hands are, its stopwatch, and what it used. */
export function LaneCard({ lane, availability, race, job, run, now }: LaneCardProps) {
  const unavailable = run ? run.status === "skipped" : availability ? !availability.available : false;
  const winner = run?.place === 1;
  const elapsed = race && run ? elapsedMs(race, run, now) : undefined;
  return (
    <article
      aria-label={`${lane.pattern} lane`}
      className={cx("flex min-w-0 flex-col rounded-lg border bg-canvas transition-shadow", winner ? "border-line-success shadow-md" : "border-line", unavailable && "opacity-60")}
    >
      <header className="flex h-14 items-center justify-between gap-2 px-3">
        <div className="min-w-0">
          <h2 className="truncate text-base leading-5 font-semibold" title={lane.summary}>
            {lane.pattern}
          </h2>
          <code className="mt-0.5 inline-block rounded-sm bg-accent-muted px-1 font-mono text-xs text-fg-accent">"{lane.environment}"</code>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {run?.place ? <Place place={run.place} /> : null}
          {run && run.status !== "skipped" && run.status !== "ready" ? (
            <Tooltip content="Details">
              <button type="button" className="btn-octicon" onClick={() => openLane(lane.id)} aria-label={`${lane.pattern} lane details`}>
                <ChevronRightIcon size={16} />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </header>
      <div className="px-3 pb-3">
        <Placement lane={lane} run={run} />
      </div>
      <div className="border-t border-line-muted px-3 py-2.5">
        <div className={cx("text-2xl leading-8 font-semibold tabular-nums", elapsed === undefined ? "text-fg-muted" : "text-fg")}>{formatClock(elapsed)}</div>
        <Status lane={lane} job={job} run={run} availability={availability} />
      </div>
      <div className="grid grid-cols-3 border-t border-line-muted">
        <Stat label="sandboxes" value={run ? String(sandboxCount(run)) : "–"} hint="Sandboxes it had: its own, its hands, and its workers'" />
        <Stat label="agents" value={run && agentCount(run) ? String(agentCount(run)) : "–"} hint="Agents it ran: itself, its sub-agents, and its workers" />
        <Stat
          label="requests"
          value={run && run.status !== "skipped" ? formatCount(premiumRequests(run)) : "–"}
          hint={run?.premium.workers ? `Premium requests: ${formatCount(run.premium.session)} by this session, ${formatCount(run.premium.workers)} by its workers` : "Premium requests this session used"}
        />
      </div>
    </article>
  );
}

function Place({ place }: { readonly place: number }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1 text-lg font-semibold tabular-nums", place === 1 ? "text-fg-success" : "text-fg-muted")}>
      {place === 1 ? <TrophyIcon size={16} /> : null}
      {ordinal(place)}
    </span>
  );
}

function Stat({ label, value, hint }: { readonly label: string; readonly value: string; readonly hint: string }) {
  return (
    <Tooltip content={hint} className="block">
      <span className="flex w-full flex-col items-center py-2" aria-label={`${value} ${label}`}>
        <span className="text-lg leading-6 font-semibold tabular-nums">{value}</span>
        <span className="text-xs text-fg-muted">{label}</span>
      </span>
    </Tooltip>
  );
}

interface StatusView {
  readonly icon: ReactNode;
  readonly word: string;
  readonly tone: string;
  readonly detail?: string;
  readonly mono?: boolean;
}

const icon = (Glyph: Icon, className: string): ReactNode => <Glyph size={16} className={cx("shrink-0", className)} />;

function statusView(lane: Lane, job: Job, run: LaneRun | undefined, availability: LaneAvailability | undefined): StatusView {
  if (!run) {
    if (availability && !availability.available) return { icon: icon(SkipIcon, "text-fg-muted"), word: "Not available", tone: "text-fg-muted", ...(availability.reason ? { detail: availability.reason } : {}) };
    return { icon: icon(CircleIcon, "text-fg-muted"), word: "Ready", tone: "text-fg-muted" };
  }
  const activity = run.activity && run.activity !== "Thinking" ? run.activity : undefined;
  switch (run.status) {
    case "ready":
      return { icon: icon(CircleIcon, "text-fg-muted"), word: "Ready", tone: "text-fg-muted" };
    case "starting":
      return { icon: <Spinner size={16} className="text-fg-attention" />, word: "Starting", tone: "text-fg-attention", ...(activity ? { detail: activity } : {}) };
    case "thinking":
      return { icon: <Spinner size={16} className="text-fg-accent" />, word: "Thinking", tone: "text-fg-accent", ...(activity ? { detail: activity } : {}) };
    case "working":
      return { icon: <Spinner size={16} className="text-fg-accent" />, word: "Working", tone: "text-fg-accent", ...(activity ? { detail: activity, mono: activity.startsWith("$ ") } : {}) };
    case "done": {
      const preview = run.answer?.replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim();
      const detail = preview ? { detail: preview } : {};
      if (run.verdict === "correct") return { icon: icon(CheckCircleFillIcon, "text-fg-success"), word: "Correct", tone: "text-fg-success", ...detail };
      if (run.verdict === "partial") return { icon: icon(CheckCircleFillIcon, "text-fg-attention"), word: `${run.checks?.filter(Boolean).length ?? 0} of ${job.checks.length} right`, tone: "text-fg-attention", ...detail };
      // A shared session has no shell: missing a job that needs one is the pattern's limit, not a slip.
      const word = lane.type === "shared" && job.needsShell ? "No shell" : run.answer ? "Wrong" : "No answer";
      return { icon: icon(XCircleFillIcon, "text-fg-danger"), word, tone: "text-fg-danger", ...detail };
    }
    case "failed":
      return { icon: icon(XCircleFillIcon, "text-fg-danger"), word: "Failed", tone: "text-fg-danger", ...(run.error ? { detail: run.error } : {}) };
    case "stopped":
      return { icon: icon(SquareFillIcon, "text-fg-muted"), word: "Stopped", tone: "text-fg-muted" };
    case "skipped":
      return { icon: icon(SkipIcon, "text-fg-muted"), word: "Not available", tone: "text-fg-muted", ...(run.error ? { detail: run.error } : {}) };
  }
}

function Status({ lane, job, run, availability }: { readonly lane: Lane; readonly job: Job; readonly run: LaneRun | undefined; readonly availability: LaneAvailability | undefined }) {
  const view = statusView(lane, job, run, availability);
  return (
    <div className="mt-1 min-w-0" aria-live="polite">
      <div className={cx("flex items-center gap-1.5 text-sm font-semibold", view.tone)}>
        {view.icon}
        <span className="truncate">{view.word}</span>
      </div>
      <p className={cx("mt-0.5 h-5 truncate text-xs leading-5 text-fg-muted", view.mono && "font-mono")} title={view.detail}>
        {view.detail ?? "\u00a0"}
      </p>
    </div>
  );
}
