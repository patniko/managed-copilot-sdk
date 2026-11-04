import { ContainerIcon, CpuIcon } from "@primer/octicons-react";
import { jobById } from "../../shared/jobs.js";
import { LANES } from "../../shared/lanes.js";
import { formatClock } from "../../shared/score.js";
import type { RaceSnapshot } from "../../shared/types.js";
import { useStore } from "../lib/store.js";
import { useNow } from "../lib/useNow.js";
import { LaneCard } from "./LaneCard.js";
import { Spinner } from "./ui/Spinner.js";

/** Six lanes side by side, one per pattern: the race. */
export function Board() {
  const app = useStore((current) => current.app);
  const picked = useStore((current) => current.job);
  const skew = useStore((current) => current.skew);
  const race = app?.race;
  const now = useNow(true, race?.state === "running" ? 100 : 30_000) + skew;
  const job = jobById(race?.job ?? picked);
  return (
    <section aria-label="Race board" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <CodeLine />
        {race ? <RaceSummary race={race} now={now} /> : null}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 race:grid-cols-[6.5rem_repeat(6,minmax(0,1fr))]">
        <RowHeaders />
        {LANES.map((lane) => (
          <LaneCard
            key={lane.id}
            lane={lane}
            availability={app?.lanes.find((candidate) => candidate.lane === lane.id)}
            race={race}
            job={job}
            run={race?.lanes.find((run) => run.lane === lane.id)}
            now={now}
          />
        ))}
      </div>
    </section>
  );
}

/** On a single row of lanes, the two places a lane's agents can be, named once beside the first lane. */
function RowHeaders() {
  return (
    <div aria-hidden className="hidden flex-col gap-1.5 pt-[3.5625rem] text-xs font-semibold text-fg-muted race:flex">
      <span className="flex h-12 items-center justify-end gap-1.5 text-right">
        Shared runtime
        <CpuIcon size={16} className="shrink-0" />
      </span>
      <span className="flex h-12 items-center justify-end gap-1.5 text-right">
        Sandboxes
        <ContainerIcon size={16} className="shrink-0" />
      </span>
    </div>
  );
}

/** The code every lane runs, with the one argument that differs between them. */
function CodeLine() {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <code className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-sm">
        <span className="text-fg-muted">const client = await</span>
        <span>managed.client(</span>
        {LANES.map((lane, index) => (
          <span key={lane.id} className="inline-flex items-center gap-1">
            <span className="rounded-sm bg-accent-muted px-1 text-xs text-fg-accent">"{lane.environment}"</span>
            {index < LANES.length - 1 ? <span className="text-fg-muted">|</span> : null}
          </span>
        ))}
        <span>);</span>
      </code>
      <span className="text-xs text-fg-muted">The only line that differs</span>
    </div>
  );
}

function RaceSummary({ race, now }: { readonly race: RaceSnapshot; readonly now: number }) {
  if (race.state === "running") {
    const done = race.lanes.filter((lane) => lane.finishedAt !== undefined || lane.status === "skipped").length;
    return (
      <span className="inline-flex items-center gap-2 text-sm text-fg-muted" role="status">
        <Spinner size={16} className="text-fg-accent" />
        <span className="font-mono tabular-nums">{formatClock(now - race.startedAt)}</span>
        <span>
          {done} of {race.lanes.length} done
        </span>
      </span>
    );
  }
  const took = race.finishedAt !== undefined ? formatClock(race.finishedAt - race.startedAt) : undefined;
  return (
    <span className="text-sm text-fg-muted" title={new Date(race.startedAt).toLocaleString()}>
      {race.state === "stopped" ? "Stopped" : "Finished"}
      {took ? ` in ${took}` : ""} · {jobById(race.job).title} · {timeAgo(race.finishedAt ?? race.startedAt, now)}
    </span>
  );
}

function timeAgo(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}
