import { CloudOfflineIcon, ContainerIcon, CopilotIcon, CpuIcon, GlobeIcon, ShieldLockIcon, SyncIcon, type Icon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import type { EnvironmentView, Station, WorkOrder } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { formatClock, formatDuration, pluralize, type NetworkSummary } from "../lib/format.js";
import { isReusedWorker, isStationActive, latestReview, stationElapsed, stationShortLabel, stationStatusMeta } from "../lib/stations.js";
import { useStore } from "../lib/store.js";
import { useNow } from "../lib/time.js";
import { TONE_TEXT, type Tone } from "../lib/tone.js";
import { Chip, StatusIcon } from "./ui/Chip.js";
import { Tooltip } from "./ui/Tooltip.js";

export function useEnvironment(name: string | undefined): EnvironmentView | undefined {
  const environments = useStore((state) => state.platform?.environments);
  return name ? environments?.find((environment) => environment.name === name) : undefined;
}

export function networkIcon(network: NetworkSummary): Icon {
  return network.kind === "off" ? CloudOfflineIcon : network.kind === "restricted" ? ShieldLockIcon : GlobeIcon;
}

/** Network policy as a Label, with the allowed hosts in a tooltip. */
export function NetworkChip({ network }: { readonly network: NetworkSummary }) {
  return (
    <Tooltip
      content={
        network.hosts.length > 0 ? (
          <div className="text-left">
            <p className="mb-1">{network.description}</p>
            <ul className="font-mono">
              {network.hosts.map((host) => (
                <li key={host}>{host}</li>
              ))}
            </ul>
          </div>
        ) : (
          network.description
        )
      }
    >
      <Chip icon={networkIcon(network)}>{network.label}</Chip>
    </Tooltip>
  );
}

export interface Placement {
  readonly icon: Icon;
  readonly label: string;
  readonly className: string;
}

/** Where a station's agent runs: the coordinator, the shared runtime (the "brain"), or its own sandbox (the "hands"). */
export function stationPlacement(station: Pick<Station, "kind" | "placement">): Placement {
  if (station.kind === "coordinate") return { icon: CopilotIcon, label: "Coordinator agent on the shared runtime", className: "text-fg-done" };
  if (station.placement === "sandbox") return { icon: ContainerIcon, label: "Runs in its own sandbox", className: "text-fg-muted" };
  return { icon: CpuIcon, label: "Runs on the shared runtime", className: "text-fg-muted" };
}

/** Card chrome shared by the floor's nodes, like a job in the GitHub Actions workflow graph. */
export function stationCardClass(selected: boolean, dashed = false): string {
  return cx(
    "flex w-full min-w-0 flex-col rounded-md border bg-canvas px-3 py-2 text-left shadow-[var(--shadow-resting-small)] transition-colors duration-100",
    selected ? "border-line-accent ring-1 ring-line-accent" : "border-line hover:bg-canvas-muted",
    dashed && !selected && "border-dashed shadow-none",
  );
}

export interface StationMetric {
  readonly text: string;
  readonly tone?: Tone;
  readonly label: string;
}

/** The one number a card shows: elapsed time while it runs, then tasks, sandboxes, tests, or findings. */
export function stationMetric(station: Station, workOrder: WorkOrder, now: number): StationMetric | undefined {
  if (station.kind === "coordinate" && (workOrder.workersStarted ?? 0) > 0) {
    const workers = workOrder.workersStarted ?? 0;
    return { text: pluralize(workers, "sandbox", "sandboxes"), label: "Sandboxes the coordinator created" };
  }
  const elapsed = stationElapsed(station, now);
  if (isStationActive(station.status)) return elapsed === undefined ? undefined : { text: formatClock(elapsed), label: "Elapsed" };
  if (station.status === "waiting" || station.status === "skipped") return undefined;
  if (station.kind === "plan" && workOrder.plan) return { text: pluralize(workOrder.plan.tasks.length, "task"), label: "Tasks in the plan" };
  if ((station.kind === "build" || station.kind === "release") && station.tests) {
    if (station.tests.failed > 0) return { text: `${station.tests.failed} failed`, tone: "danger", label: "Failing tests" };
    if (station.tests.passed > 0) return { text: pluralize(station.tests.passed, "test"), label: "Tests passed" };
  }
  if (station.kind === "review") {
    const findings = latestReview(station)?.findings.length ?? 0;
    if (findings > 0) {
      const open = station.status === "changes_requested" || station.acceptedWithFindings;
      return { text: pluralize(findings, "finding"), tone: open ? "warning" : undefined, label: "Findings in the latest review" };
    }
  }
  return elapsed === undefined ? undefined : { text: formatDuration(elapsed), label: "Duration" };
}

/** Build and review rounds as dots: ●●○ is round 2 of 3. */
export function RoundDots({
  round,
  max,
  active = false,
  className,
}: {
  readonly round: number;
  readonly max: number;
  readonly active?: boolean;
  readonly className?: string;
}) {
  const count = Math.max(1, max, round);
  const filled = Math.min(Math.max(round, 0), count);
  const label = `Round ${Math.max(filled, 1)} of ${count}`;
  return (
    <span role="img" aria-label={label} title={label} className={cx("inline-flex shrink-0 items-center gap-[3px]", className)}>
      {Array.from({ length: count }, (_, index) => {
        const done = index < filled;
        const current = done && index === filled - 1 && active;
        return (
          <span
            key={index}
            className={cx(
              "size-2 rounded-full",
              current ? "bg-attention-emphasis" : done ? "bg-fg-muted" : "border border-line-emphasis",
            )}
          />
        );
      })}
    </span>
  );
}

/** Technical details for a card's hover: the worker, sandbox, environment, agent, and model. */
function StationDetails({ station, model }: { readonly station: Station; readonly model?: string }) {
  const rows: (readonly [string, string])[] = [];
  if (station.worker) rows.push(["Worker", station.worker.name]);
  if (station.sandbox) rows.push(["Sandbox", station.sandbox.id]);
  rows.push(["Environment", station.environment]);
  rows.push(["Agent", `@${station.agent}`]);
  if (model) rows.push(["Model", model]);
  return (
    <div>
      <p className="font-semibold">{station.title}</p>
      {station.detail ? <p className="mb-1">{station.detail}</p> : null}
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        {rows.map(([label, value]) => (
          <Row key={label} label={label}>
            {value}
          </Row>
        ))}
      </dl>
    </div>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="opacity-70">{label}</dt>
      <dd className="break-all">{children}</dd>
    </>
  );
}

export interface StationCardProps {
  readonly station: Station;
  readonly workOrder: WorkOrder;
  readonly selected: boolean;
  readonly onSelect: () => void;
  /** Overrides the station title (e.g. "Build" inside a lane that already names the task). */
  readonly heading?: string;
  /** Placeholder for a station the server hasn't created yet. */
  readonly ghost?: boolean;
}

/** A station at rest: where it runs, its name, rounds, status, and one metric. Hover for the technical details. */
export function StationCard({ station, workOrder, selected, onSelect, heading, ghost = false }: StationCardProps) {
  const meta = stationStatusMeta(station);
  const active = isStationActive(station.status);
  const now = useNow(1000, active);
  const environment = useEnvironment(station.environment);
  const placement = stationPlacement(station);
  const muted = station.status === "waiting" || station.status === "skipped" || station.status === "cancelled";
  const metric = ghost ? undefined : stationMetric(station, workOrder, now);
  const reused = isReusedWorker(station);
  const rounds = station.kind === "build" || station.kind === "review";
  const model = station.model ?? environment?.model;

  return (
    <Tooltip content={<StationDetails station={station} model={model} />} delay={600} align="start" disabled={ghost} className="flex w-full">
      <button type="button" onClick={onSelect} aria-pressed={selected} className={stationCardClass(selected, ghost || muted)}>
        <span className="flex w-full min-w-0 items-center gap-2">
          <placement.icon size={16} className={cx("shrink-0", placement.className)} aria-label={placement.label} />
          <span className={cx("min-w-0 truncate font-semibold", muted && "text-fg-muted")}>{heading ?? station.title}</span>
          {reused ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-semibold text-fg-accent" title={`Same sandbox, reused for round ${station.round}`}>
              <SyncIcon size={12} />
              Reused
            </span>
          ) : null}
          {rounds ? <RoundDots round={station.round} max={workOrder.maxReviewRounds} active={active} className="ml-auto pl-1" /> : null}
        </span>
        <span className="mt-1.5 flex w-full min-w-0 items-center gap-1.5 text-xs">
          <StatusIcon meta={meta} />
          <span className={cx("min-w-0 truncate", muted ? "text-fg-muted" : "text-fg")}>{stationShortLabel(station)}</span>
          {metric ? (
            <span className={cx("ml-auto shrink-0 pl-1 tabular-nums", metric.tone ? TONE_TEXT[metric.tone] : "text-fg-muted")} title={metric.label}>
              {metric.text}
            </span>
          ) : null}
        </span>
      </button>
    </Tooltip>
  );
}
