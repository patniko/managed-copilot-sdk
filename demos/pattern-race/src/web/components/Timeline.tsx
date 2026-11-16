import { CheckCircleFillIcon, CpuIcon, SquareFillIcon, TrophyIcon, XCircleFillIcon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import { LANES } from "../../shared/lanes.js";
import { cpuMs, elapsedMs, formatBytes, formatClock, formatSeconds, ordinal, peakMemoryBytes, runtimeBrains } from "../../shared/score.js";
import { axisFor, cpuSeries, memorySeries, segments, usageStart, type Point } from "../../shared/timeline.js";
import type { LaneRun, PhaseKind, RaceSnapshot, SandboxToken } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { openLane, useStore } from "../lib/store.js";
import { useNow } from "../lib/useNow.js";

const PHASES: Readonly<Record<PhaseKind, { readonly name: string; readonly tone: string }>> = {
  starting: { name: "Starting", tone: "bg-attention-emphasis" },
  thinking: { name: "Thinking", tone: "bg-accent-emphasis" },
  command: { name: "Commands and files", tone: "bg-success-emphasis" },
  sandbox: { name: "Moving into a sandbox", tone: "bg-severe-emphasis" },
  workers: { name: "Workers", tone: "bg-done-emphasis" },
  subagents: { name: "Sub-agents", tone: "bg-sponsors-emphasis" },
  tool: { name: "Other tools", tone: "bg-neutral-emphasis" },
};

const SANDBOXES: Readonly<Record<SandboxToken["kind"], { readonly name: string; readonly tone: string }>> = {
  own: { name: "Its own sandbox", tone: "bg-accent-emphasis" },
  hands: { name: "Hands sandbox", tone: "bg-success-emphasis" },
  worker: { name: "Worker sandbox", tone: "bg-done-emphasis" },
};

const MIN_MEMORY_SCALE = 256 * 1024 ** 2;

/** The race over time: what each lane did, the sandboxes it held, and the CPU and memory they used, on one clock. */
export function Timeline() {
  const race = useStore((current) => current.app?.race);
  const skew = useStore((current) => current.skew);
  const running = race?.state === "running";
  const now = useNow(running, 250) + skew;
  if (!race) return null;
  const end = running ? now : (race.finishedAt ?? now);
  const axis = axisFor(end - race.startedAt);
  const x = (at: number) => Math.min(100, Math.max(0, ((at - race.startedAt) / axis.span) * 100));
  const lanes = LANES.map((lane) => race.lanes.find((run) => run.lane === lane.id)).filter((run): run is LaneRun => run !== undefined);
  const series = new Map(lanes.map((run) => [run.lane, laneSeries(run, race.startedAt)] as const));
  // Every lane on the same scale, so a taller chart really is more.
  const cpuMax = Math.max(1, ...[...series.values()].flatMap((entry) => entry.cpu.map((point) => point.value)));
  const memoryMax = Math.max(MIN_MEMORY_SCALE, ...[...series.values()].flatMap((entry) => entry.memory.map((point) => point.value)));
  return (
    <section aria-label="Race timeline" className="Box overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line-muted px-4 py-3">
        <h2 className="text-base font-semibold">Race timeline</h2>
        <Legend />
      </div>
      <div className="px-4 pt-2 pb-1">
        <Row label={<span className="text-xs text-fg-muted">Lane</span>} readout={<span className="text-xs text-fg-muted">Sandboxes used</span>}>
          <div className="relative h-5 text-xs text-fg-muted tabular-nums">
            {ticks(axis).map((at) => (
              <span key={at} className="absolute -translate-x-1/2 first:translate-x-0" style={{ left: `${(at / axis.span) * 100}%` }}>
                {formatClock(at).replace(/\.0$/, "")}
              </span>
            ))}
          </div>
        </Row>
      </div>
      <ol>
        <RuntimeLane race={race} x={x} axis={axis} />
        {lanes.map((run) => (
          <Lane key={run.lane} race={race} run={run} now={now} axis={axis} x={x} series={series.get(run.lane)!} cpuMax={cpuMax} memoryMax={memoryMax} />
        ))}
      </ol>
      <p className="border-t border-line-muted px-4 py-2 text-xs text-fg-muted">
        Charts: vCPUs its sandboxes kept busy (up to {formatCores(cpuMax)}) and the memory they held (up to {formatBytes(memoryMax)}), read from each sandbox&apos;s own counters every
        few seconds, on one scale for every lane. A lane with no sandbox has no chart of its own: its brain ran on the shared runtime, charted at the top on its own scale together with every other shared session on the gateway.
      </p>
    </section>
  );
}

interface LaneSeries {
  readonly from: number;
  readonly cpu: Point[];
  readonly memory: Point[];
}

function laneSeries(run: LaneRun, startedAt: number): LaneSeries {
  const from = usageStart(run) ?? startedAt;
  const samples = run.samples ?? [];
  return { from, cpu: cpuSeries(samples, from), memory: memorySeries(samples) };
}

function ticks(axis: { readonly span: number; readonly step: number }): number[] {
  const marks: number[] = [];
  for (let at = 0; at <= axis.span; at += axis.step) marks.push(at);
  return marks;
}

function formatCores(value: number): string {
  return `${Math.round(value * 10) / 10} vCPU`;
}

function Row({ label, readout, children, className }: { readonly label: ReactNode; readonly readout: ReactNode; readonly children: ReactNode; readonly className?: string }) {
  return (
    <div className={cx("grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-3 sm:grid-cols-[8rem_minmax(0,1fr)_7rem]", className)}>
      <div className="min-w-0">{label}</div>
      <div className="min-w-0">{children}</div>
      <div className="hidden min-w-0 text-right sm:block">{readout}</div>
    </div>
  );
}

interface LaneProps {
  readonly race: RaceSnapshot;
  readonly run: LaneRun;
  readonly now: number;
  readonly axis: { readonly span: number; readonly step: number };
  readonly x: (at: number) => number;
  readonly series: LaneSeries;
  readonly cpuMax: number;
  readonly memoryMax: number;
}

function Lane({ race, run, now, axis, x, series, cpuMax, memoryMax }: LaneProps) {
  const lane = LANES.find((candidate) => candidate.id === run.lane)!;
  const live = run.status === "starting" || run.status === "thinking" || run.status === "working";
  const end = run.finishedAt ?? (live ? now : (race.finishedAt ?? now));
  const skipped = run.status === "skipped" || run.status === "ready";
  return (
    <li className={cx("border-t border-line-muted px-4 py-2.5", skipped && "opacity-60")}>
      <Row
        label={
          <button type="button" disabled={skipped} onClick={() => openLane(run.lane)} className="block w-full min-w-0 text-left hover:underline disabled:hover:no-underline">
            <span className="block truncate text-sm font-semibold">{lane.pattern}</span>
            <span className="flex items-center gap-1 text-xs text-fg-muted tabular-nums">
              <Outcome run={run} />
              {skipped ? "Not available" : formatClock(elapsedMs(race, run, now))}
            </span>
          </button>
        }
        readout={<Readout run={run} live={live} series={series} />}
      >
        <div className="relative">
          <Grid axis={axis} />
          <div className="relative flex flex-col gap-1">
            <PhaseBar run={run} end={end} live={live} x={x} />
            <SandboxBars run={run} end={end} live={live} x={x} />
            {run.sandboxes.length || run.samples?.length ? (
              <>
                <Spark points={series.cpu} from={series.from} max={cpuMax} x={x} stepped tone="cpu" label="CPU" />
                <Spark points={series.memory} from={series.from} max={memoryMax} x={x} tone="memory" label="memory" />
              </>
            ) : (
              <div className="flex h-[3.75rem] items-center text-xs text-fg-muted">{skipped ? "" : "No sandbox: its brain ran on the shared runtime (top)"}</div>
            )}
          </div>
          {run.finishedAt !== undefined ? <Finish run={run} left={x(run.finishedAt)} /> : null}
        </div>
      </Row>
    </li>
  );
}

/**
 * The shared runtime's swimlane: one process for every shared session on the gateway, so the brains of the lanes
 * without a sandbox show up here together, on their own scale.
 */
function RuntimeLane({ race, x, axis }: { readonly race: RaceSnapshot; readonly x: (at: number) => number; readonly axis: { readonly span: number; readonly step: number } }) {
  const runtime = race.runtime;
  const shared = runtimeBrains(race);
  const cpu = runtime ? cpuSeries(runtime.samples, race.startedAt) : [];
  const memory = runtime ? memorySeries(runtime.samples) : [];
  const cpuMax = Math.max(1, ...cpu.map((point) => point.value));
  const memoryMax = Math.max(MIN_MEMORY_SCALE, ...memory.map((point) => point.value));
  return (
    <li className="border-t border-line-muted bg-canvas-muted px-4 py-2.5">
      <Row
        label={
          <div className="min-w-0" title="One process for every shared session on this gateway">
            <span className="flex items-center gap-1 text-sm font-semibold">
              <CpuIcon size={14} className="shrink-0 text-fg-muted" />
              Shared runtime
            </span>
            <span className="line-clamp-3 text-xs text-fg-muted" title={shared.join(", ")}>{shared.length ? `Thinking here: ${shared.join(", ")}` : "No lane thought here"}</span>
          </div>
        }
        readout={
          runtime ? (
            <dl className="flex flex-col gap-1 text-xs tabular-nums">
              <dd className="font-semibold text-fg-accent">{formatSeconds(runtime.cpuMs)} CPU</dd>
              <dd className="font-semibold text-fg-done">{formatBytes(runtime.peakMemoryBytes)} peak</dd>
            </dl>
          ) : null
        }
      >
        <div className="relative">
          <Grid axis={axis} />
          {runtime ? (
            <div className="relative flex flex-col gap-1">
              <Spark points={cpu} from={race.startedAt} max={cpuMax} x={x} stepped tone="cpu" label={`CPU (up to ${formatCores(cpuMax)})`} />
              <Spark points={memory} from={race.startedAt} max={memoryMax} x={x} tone="memory" label={`memory (up to ${formatBytes(memoryMax)})`} />
            </div>
          ) : (
            <div className="relative flex h-[3.75rem] items-center text-xs text-fg-muted">{race.runtimeNote ?? (race.state === "running" ? "Reading the shared runtime…" : "Not read during this race.")}</div>
          )}
        </div>
      </Row>
    </li>
  );
}

function Outcome({ run }: { readonly run: LaneRun }) {
  if (run.place === 1) return <TrophyIcon size={12} className="text-fg-success" />;
  if (run.verdict === "correct") return <CheckCircleFillIcon size={12} className="text-fg-success" />;
  if (run.status === "stopped") return <SquareFillIcon size={12} className="text-fg-muted" />;
  if (run.status === "done" || run.status === "failed") return <XCircleFillIcon size={12} className="text-fg-danger" />;
  return null;
}

function Grid({ axis }: { readonly axis: { readonly span: number; readonly step: number } }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {ticks(axis).map((at) => (
        <span key={at} className="absolute inset-y-0 border-l border-dashed border-line-muted" style={{ left: `${(at / axis.span) * 100}%` }} />
      ))}
    </div>
  );
}

function PhaseBar({ run, end, live, x }: { readonly run: LaneRun; readonly end: number; readonly live: boolean; readonly x: (at: number) => number }) {
  const parts = segments(run.timeline ?? [], end);
  return (
    <div className="relative h-5 overflow-hidden rounded-sm bg-neutral-muted">
      {parts.map((part, index) => {
        const phase = PHASES[part.phase.kind];
        return (
          <span
            key={`${part.from}-${index}`}
            title={`${phase.name}: ${part.phase.label} · ${formatSeconds(part.to - part.from)}`}
            className={cx("absolute inset-y-0 border-r border-canvas", phase.tone, live && index === parts.length - 1 && "bar-live")}
            style={{ left: `${x(part.from)}%`, width: `${Math.max(0.3, x(part.to) - x(part.from))}%` }}
          />
        );
      })}
    </div>
  );
}

function SandboxBars({ run, end, live, x }: { readonly run: LaneRun; readonly end: number; readonly live: boolean; readonly x: (at: number) => number }) {
  const tokens = run.sandboxes.filter((token) => token.appearedAt !== undefined);
  if (tokens.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      {tokens.map((token) => {
        const appeared = token.appearedAt!;
        const ended = token.endedAt ?? (live ? end : Math.max(end, appeared));
        const ready = Math.min(token.readyAt ?? ended, ended);
        const kind = SANDBOXES[token.kind];
        const name = token.kind === "own" ? kind.name : `${token.name} (${kind.name.toLowerCase()})`;
        const facts = [token.readyAt !== undefined ? `ready in ${formatSeconds(token.readyAt - appeared)}` : "starting", token.usage ? `${formatSeconds(token.usage.cpuMs)} CPU, ${formatBytes(token.usage.peakMemoryBytes)} peak` : ""];
        return (
          <div key={token.id} className="relative h-1.5" title={`${name}: ${facts.filter(Boolean).join(" · ")}`}>
            <span className={cx("absolute inset-y-0 rounded-l-sm bg-attention-emphasis opacity-70", token.readyAt === undefined && live && "bar-live")} style={{ left: `${x(appeared)}%`, width: `${Math.max(0.3, x(ready) - x(appeared))}%` }} />
            {ready < ended ? <span className={cx("absolute inset-y-0 rounded-r-sm", kind.tone)} style={{ left: `${x(ready)}%`, width: `${Math.max(0.3, x(ended) - x(ready))}%` }} /> : null}
          </div>
        );
      })}
    </div>
  );
}

/** A small area chart on the race's time axis. */
function Spark({ points, from, max, x, stepped, tone, label }: { readonly points: readonly Point[]; readonly from: number; readonly max: number; readonly x: (at: number) => number; readonly stepped?: boolean; readonly tone: "cpu" | "memory"; readonly label: string }) {
  const X = (at: number) => x(at) * 10;
  const Y = (value: number) => 100 - Math.min(1, value / max) * 94;
  let line = "";
  if (points.length) {
    line = `M ${X(from)} 100`;
    let previous = from;
    for (const point of points) {
      line += stepped ? ` L ${X(previous)} ${Y(point.value)} L ${X(point.at)} ${Y(point.value)}` : ` L ${X(point.at)} ${Y(point.value)}`;
      previous = point.at;
    }
  }
  const area = line ? `${line} L ${X(points.at(-1)!.at)} 100 Z` : "";
  const colors = tone === "cpu" ? "fill-[var(--bgColor-accent-muted)] stroke-[var(--fgColor-accent)]" : "fill-[var(--bgColor-done-muted)] stroke-[var(--fgColor-done)]";
  return (
    <div className="relative h-7 border-b border-line-muted">
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
        {area ? <path d={area} className={cx(colors, "stroke-0")} /> : null}
        {line ? <path d={line} className={cx(colors, "fill-none")} strokeWidth={1.5} vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      <span className="pointer-events-none absolute top-0 left-1 text-[10px] leading-3 text-fg-muted">{label}</span>
    </div>
  );
}

function Finish({ run, left }: { readonly run: LaneRun; readonly left: number }) {
  const tone = run.verdict === "correct" ? "border-success-emphasis text-fg-success" : run.status === "stopped" ? "border-neutral-emphasis text-fg-muted" : "border-danger-emphasis text-fg-danger";
  return (
    <div aria-hidden className={cx("pointer-events-none absolute -inset-y-1 border-l-2", tone)} style={{ left: `${left}%` }}>
      {run.place ? <span className="absolute -top-0.5 left-1 rounded-sm bg-canvas px-0.5 text-[10px] leading-3 font-semibold">{ordinal(run.place)}</span> : null}
    </div>
  );
}

function Readout({ run, live, series }: { readonly run: LaneRun; readonly live: boolean; readonly series: LaneSeries }) {
  if (run.status === "skipped" || run.status === "ready") return null;
  if (run.sandboxes.length === 0) return <span className="text-xs text-fg-muted">No sandbox</span>;
  const cpu = cpuMs(run);
  const memory = live ? series.memory.at(-1)?.value : peakMemoryBytes(run);
  return (
    <dl className="flex flex-col gap-1 pt-7 text-xs tabular-nums">
      <div>
        <dt className="sr-only">CPU</dt>
        <dd className="font-semibold text-fg-accent">{cpu === undefined ? "–" : `${formatSeconds(cpu)} CPU${live ? " so far" : ""}`}</dd>
      </div>
      <div>
        <dt className="sr-only">Memory</dt>
        <dd className="font-semibold text-fg-done">{memory === undefined ? "–" : live ? `${formatBytes(memory)} now` : `${formatBytes(memory)} peak`}</dd>
      </div>
    </dl>
  );
}

function Legend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
      {(Object.keys(PHASES) as PhaseKind[]).map((kind) => (
        <li key={kind} className="inline-flex items-center gap-1">
          <span className={cx("inline-block size-2.5 rounded-sm", PHASES[kind].tone)} />
          {PHASES[kind].name}
        </li>
      ))}
      <li className="inline-flex items-center gap-1">
        <span className="inline-block h-1.5 w-4 rounded-sm bg-attention-emphasis opacity-70" />
        Sandbox starting
      </li>
      {(Object.keys(SANDBOXES) as SandboxToken["kind"][]).map((kind) => (
        <li key={kind} className="inline-flex items-center gap-1">
          <span className={cx("inline-block h-1.5 w-4 rounded-sm", SANDBOXES[kind].tone)} />
          {SANDBOXES[kind].name}
        </li>
      ))}
    </ul>
  );
}
