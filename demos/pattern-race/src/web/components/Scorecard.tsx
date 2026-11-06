import { TrophyIcon } from "@primer/octicons-react";
import { jobById } from "../../shared/jobs.js";
import { laneById } from "../../shared/lanes.js";
import { agentCount, bests, elapsedMs, formatClock, formatCount, ordinal, plural, premiumRequests, sandboxCount } from "../../shared/score.js";
import type { LaneRun, RaceSnapshot } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { openLane, useStore } from "../lib/store.js";
import { useNow } from "../lib/useNow.js";

const ORDER: Readonly<Record<LaneRun["status"], number>> = { done: 0, thinking: 1, working: 1, starting: 1, ready: 1, failed: 2, stopped: 3, skipped: 4 };

/** Lanes in finishing order: correct answers first, then the rest by when they ended. */
function rankLanes(race: RaceSnapshot, now: number): LaneRun[] {
  return [...race.lanes].sort((a, b) => {
    if (a.place !== undefined || b.place !== undefined) return (a.place ?? Infinity) - (b.place ?? Infinity);
    if (ORDER[a.status] !== ORDER[b.status]) return ORDER[a.status] - ORDER[b.status];
    return (elapsedMs(race, a, now) ?? Infinity) - (elapsedMs(race, b, now) ?? Infinity);
  });
}

const BAR_TONE: Readonly<Record<string, string>> = {
  correct: "bg-success-emphasis",
  partial: "bg-attention-emphasis",
  missed: "bg-danger-emphasis",
  failed: "bg-danger-emphasis",
};

const RESULT: Readonly<Record<string, { readonly text: string; readonly tone: string }>> = {
  correct: { text: "Correct", tone: "text-fg-success" },
  partial: { text: "Partly right", tone: "text-fg-attention" },
  missed: { text: "Missed", tone: "text-fg-danger" },
  failed: { text: "Failed", tone: "text-fg-danger" },
};

/** The race's outcome side by side: time, sandboxes, agents, and premium requests per lane. */
export function Scorecard() {
  const race = useStore((current) => current.app?.race);
  const modelName = useStore((current) => current.app?.model.name);
  const skew = useStore((current) => current.skew);
  const now = useNow(race?.state === "running") + skew;
  if (!race) return null;
  const ranked = rankLanes(race, now);
  const longest = Math.max(1, ...ranked.map((lane) => elapsedMs(race, lane, now) ?? 0));
  const best = race.state === "running" ? {} : bests(race);
  return (
    <section aria-label="Scorecard" className="Box overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line-muted px-4 py-3">
        <h2 className="text-base font-semibold">Scorecard</h2>
        <span className="text-xs text-fg-muted">
          {jobById(race.job).title} · {modelName ?? race.model}
        </span>
      </div>
      <div className="hidden grid-cols-[2.5rem_8rem_minmax(0,1fr)_5rem_4rem_5rem_7rem] gap-x-3 border-b border-line-muted px-4 py-2 text-xs text-fg-muted sm:grid">
        <span />
        <span>Pattern</span>
        <span>Time</span>
        <span className="text-right">Sandboxes</span>
        <span className="text-right">Agents</span>
        <span className="text-right">Requests</span>
        <span>Result</span>
      </div>
      <ol>
        {ranked.map((run) => (
          <Row key={run.lane} race={race} run={run} now={now} longest={longest} best={best} />
        ))}
      </ol>
    </section>
  );
}

function Row({ race, run, now, longest, best }: { readonly race: RaceSnapshot; readonly run: LaneRun; readonly now: number; readonly longest: number; readonly best: ReturnType<typeof bests> }) {
  const lane = laneById(run.lane);
  const elapsed = elapsedMs(race, run, now);
  const live = run.status === "starting" || run.status === "thinking" || run.status === "working";
  const result = run.status === "skipped" ? { text: "Not available", tone: "text-fg-muted" } : run.status === "stopped" ? { text: "Stopped", tone: "text-fg-muted" } : live ? { text: "Racing", tone: "text-fg-accent" } : RESULT[run.verdict ?? "failed"]!;
  const correct = run.verdict === "correct";
  const highlight = (value: number, target: number | undefined) => (correct && value === target ? "font-semibold text-fg-success" : "");
  const sandboxes = sandboxCount(run);
  const requests = premiumRequests(run);
  return (
    <li className="border-b border-line-muted last:border-b-0">
      <button
        type="button"
        disabled={run.status === "skipped"}
        onClick={() => openLane(run.lane)}
        className="grid w-full grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-left text-sm hover:bg-canvas-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:hover:bg-transparent sm:grid-cols-[2.5rem_8rem_minmax(0,1fr)_5rem_4rem_5rem_7rem]"
      >
        <span className={cx("inline-flex items-center gap-1 font-semibold tabular-nums", run.place === 1 ? "text-fg-success" : "text-fg-muted")}>
          {run.place === 1 ? <TrophyIcon size={16} /> : null}
          {run.place ? ordinal(run.place) : "–"}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-semibold">{lane.pattern}</span>
          <code className="block truncate font-mono text-xs text-fg-muted">"{lane.environment}"</code>
        </span>
        <span className="col-span-3 row-start-2 flex min-w-0 items-center gap-2 sm:col-span-1 sm:row-start-auto">
          <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-muted">
            <span
              className={cx("block h-full rounded-full transition-[width] duration-300", live ? "bar-live bg-accent-emphasis" : (BAR_TONE[run.verdict ?? ""] ?? "bg-neutral-emphasis"))}
              style={{ width: `${elapsed === undefined ? 0 : Math.max(2, (elapsed / longest) * 100)}%` }}
            />
          </span>
          <span className={cx("w-14 shrink-0 text-right text-xs tabular-nums", highlight(elapsed ?? -1, best.time))}>{elapsed === undefined ? "–" : formatClock(elapsed)}</span>
        </span>
        <span className={cx("hidden text-right tabular-nums sm:block", highlight(sandboxes, best.sandboxes))}>{run.status === "skipped" ? "–" : sandboxes}</span>
        <span className="hidden text-right tabular-nums sm:block">{run.status === "skipped" ? "–" : agentCount(run)}</span>
        <span className={cx("hidden text-right tabular-nums sm:block", highlight(requests, best.requests))}>{run.status === "skipped" ? "–" : formatCount(requests)}</span>
        <span className={cx("col-start-3 row-start-1 text-right font-semibold sm:col-start-auto sm:row-start-auto sm:text-left", result.tone)}>{result.text}</span>
        <span className="col-span-3 text-xs text-fg-muted sm:hidden">
          {run.status === "skipped" ? "" : [plural(sandboxes, "sandbox", "sandboxes"), plural(agentCount(run), "agent", "agents"), plural(requests, "request", "requests")].join(" · ")}
        </span>
      </button>
    </li>
  );
}
