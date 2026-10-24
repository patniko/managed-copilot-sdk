import { ChevronRight, Inbox, Link2, PackageCheck, PackageOpen, PackageX } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { FACTORY_ENVIRONMENTS, ROLE_AGENTS } from "../../shared/environments.js";
import type { EnvironmentView, Station, WorkOrder } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { formatBytes, pluralize } from "../lib/format.js";
import { workOrderHref } from "../lib/router.js";
import {
  edgeState,
  isStationActive,
  KIND_LABELS,
  taskRows,
  taskTitle,
  type EdgeState,
  type TaskRow,
} from "../lib/stations.js";
import { useStore } from "../lib/store.js";
import { StationCard } from "./StationCard.js";

// Column widths for the horizontal layout; HORIZONTAL_MIN is the width they need.
const W_TERMINAL = 120;
const W_PLAN = 176;
const W_BUILD = 184;
const W_REVIEW = 176;
const W_RELEASE = 176;
const GAP = 28;
const ROW_GAP = 24;
const CANVAS_PADDING = 20;
const HORIZONTAL_MIN = W_TERMINAL * 2 + W_PLAN + W_BUILD + ROW_GAP + W_REVIEW + W_RELEASE + GAP * 4 + CANVAS_PADDING * 2;
/** Below this width, build and review cards stack inside each task row. */
const STACK_BELOW = 560;
/** Spine / vertical connector x offset from a card's left edge. */
const SPINE = 20;

type Mode = "horizontal" | "vertical";

function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Stand-in for a station the server hasn't created yet, described from the platform's environments. */
function placeholderStation(kind: "plan" | "release", environments: readonly EnvironmentView[] | undefined): Station {
  const role = kind === "plan" ? "planner" : "release";
  const environment = environments?.find((candidate) => candidate.role === role);
  return {
    id: kind,
    kind,
    title: KIND_LABELS[kind],
    status: "waiting",
    role,
    environment: environment?.name ?? FACTORY_ENVIRONMENTS[role],
    placement: environment ? (environment.type === "shared" ? "shared" : "sandbox") : kind === "plan" ? "shared" : "sandbox",
    agent: environment?.agents[0] ?? ROLE_AGENTS[role],
    model: environment?.model,
    round: 0,
  };
}

interface Lane {
  readonly id: string;
  readonly row?: TaskRow;
  readonly buildId: string;
  readonly reviewId: string;
}

interface EdgeSpec {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "h" | "v" | "branch" | "spine" | "spine-to-row" | "spine-from-row";
  readonly state: EdgeState;
}

interface DrawnEdge {
  readonly id: string;
  readonly d: string;
  readonly state: EdgeState;
  readonly end?: { readonly x: number; readonly y: number };
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly cy: number;
}

function curveH(x1: number, y1: number, x2: number, y2: number): string {
  if (Math.abs(y1 - y2) < 0.5) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const dx = Math.max(12, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function curveV(x1: number, y1: number, x2: number, y2: number): string {
  if (Math.abs(x1 - x2) < 0.5) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const dy = Math.max(10, (y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}

function drawEdge(spec: EdgeSpec, box: (id: string) => Box | undefined): DrawnEdge | undefined {
  const a = box(spec.from);
  const b = box(spec.to);
  if (!a || !b) return undefined;
  const radius = 10;
  switch (spec.kind) {
    case "h":
      return { id: spec.id, state: spec.state, d: curveH(a.right, a.cy, b.left, b.cy), end: { x: b.left, y: b.cy } };
    case "v": {
      const x1 = a.left + SPINE;
      const x2 = b.left + SPINE;
      return { id: spec.id, state: spec.state, d: curveV(x1, a.bottom, x2, b.top), end: { x: x2, y: b.top } };
    }
    case "branch": {
      const x = a.left + SPINE;
      if (b.left - x < 8) return undefined;
      const r = Math.min(radius, (b.left - x) / 2);
      return { id: spec.id, state: spec.state, d: `M ${x} ${b.cy - r} Q ${x} ${b.cy} ${x + r} ${b.cy} L ${b.left} ${b.cy}`, end: { x: b.left, y: b.cy } };
    }
    case "spine": {
      const x = a.left + SPINE;
      return { id: spec.id, state: spec.state, d: `M ${x} ${a.bottom} L ${x} ${b.top}` };
    }
    case "spine-to-row": {
      const x = a.left + SPINE;
      return { id: spec.id, state: spec.state, d: `M ${x} ${a.bottom} L ${x} ${b.cy - radius}` };
    }
    case "spine-from-row": {
      const x = b.left + SPINE;
      return { id: spec.id, state: spec.state, d: `M ${x} ${a.cy - radius} L ${x} ${b.top}` };
    }
  }
}

function buildEdges(
  mode: Mode,
  stacked: boolean,
  plan: Station,
  release: Station,
  lanes: readonly Lane[],
  deliverable: EdgeState,
): EdgeSpec[] {
  const edges: EdgeSpec[] = [];
  const planDone = plan.status === "done";
  const allReviewed = lanes.length > 0 && lanes.every((lane) => lane.row?.review?.status === "done");
  edges.push({ id: "intake", from: "intake", to: plan.id, kind: mode === "horizontal" ? "h" : "v", state: edgeState(true, plan.status) });

  if (mode === "horizontal") {
    for (const lane of lanes) {
      const build = lane.row?.build;
      const review = lane.row?.review;
      edges.push({ id: `plan>${lane.id}`, from: plan.id, to: lane.buildId, kind: "h", state: edgeState(planDone, build?.status) });
      edges.push({ id: `build>${lane.id}`, from: lane.buildId, to: lane.reviewId, kind: "h", state: edgeState(build?.status === "done", review?.status) });
      edges.push({ id: `review>${lane.id}`, from: lane.reviewId, to: release.id, kind: "h", state: edgeState(review?.status === "done", release.status) });
    }
    if (lanes.length === 0) edges.push({ id: "plan>release", from: plan.id, to: release.id, kind: "h", state: "idle" });
    edges.push({ id: "deliverable", from: release.id, to: "deliverable", kind: "h", state: deliverable });
    return edges;
  }

  const last = lanes[lanes.length - 1];
  if (last) {
    const builds = lanes.map((lane) => lane.row?.build?.status);
    const spineState: EdgeState = builds.some((status) => status !== undefined && isStationActive(status))
      ? "active"
      : builds.every((status) => status === "done")
        ? "done"
        : planDone
          ? "ready"
          : "idle";
    edges.push({ id: "spine>rows", from: plan.id, to: last.buildId, kind: "spine-to-row", state: spineState });
    edges.push({ id: "spine>release", from: last.buildId, to: release.id, kind: "spine-from-row", state: edgeState(allReviewed, release.status) });
  } else {
    edges.push({ id: "spine", from: plan.id, to: release.id, kind: "spine", state: edgeState(false, release.status) });
  }
  for (const lane of lanes) {
    const build = lane.row?.build;
    const review = lane.row?.review;
    edges.push({ id: `plan>${lane.id}`, from: plan.id, to: lane.buildId, kind: "branch", state: edgeState(planDone, build?.status) });
    edges.push({
      id: `build>${lane.id}`,
      from: lane.buildId,
      to: lane.reviewId,
      kind: stacked ? "v" : "h",
      state: edgeState(build?.status === "done", review?.status),
    });
  }
  edges.push({ id: "deliverable", from: release.id, to: "deliverable", kind: "v", state: deliverable });
  return edges;
}

export interface PipelineProps {
  readonly workOrder: WorkOrder;
  readonly selectedId: string;
  readonly onSelect: (stationId: string) => void;
}

export function Pipeline({ workOrder, selectedId, onSelect }: PipelineProps) {
  const environments = useStore((state) => state.platform?.environments);
  const frame = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  // Measure the frame, not the scroller: its scrollbars must not flip the layout back and forth.
  const width = useElementWidth(frame);
  const mode: Mode = width >= HORIZONTAL_MIN ? "horizontal" : "vertical";
  const stacked = mode === "vertical" && width > 0 && width < STACK_BELOW;

  const plan = workOrder.stations.find((station) => station.kind === "plan") ?? placeholderStation("plan", environments);
  const release = workOrder.stations.find((station) => station.kind === "release") ?? placeholderStation("release", environments);
  const rows = taskRows(workOrder);
  const lanes: Lane[] =
    rows.length > 0
      ? rows.map((row) => ({ id: row.id, row, buildId: row.build?.id ?? `ghost-build:${row.id}`, reviewId: row.review?.id ?? `ghost-review:${row.id}` }))
      : [0, 1].map((index) => ({ id: `ghost-${index}`, buildId: `ghost-build:${index}`, reviewId: `ghost-review:${index}` }));
  const hasPlan = rows.length > 0;
  const released = Boolean(workOrder.release) && release.status === "done";
  const deliverableState: EdgeState = released
    ? "done"
    : release.status === "failed"
      ? "failed"
      : release.status === "done"
        ? "ready"
        : "idle";

  const signature = JSON.stringify([
    mode,
    stacked,
    plan.id,
    plan.status,
    release.id,
    release.status,
    deliverableState,
    lanes.map((lane) => [lane.buildId, lane.reviewId, lane.row?.build?.status, lane.row?.review?.status]),
  ]);
  // The signature captures everything the edge specs depend on, so specs stay stable across unrelated updates.
  const specs = useMemo(() => buildEdges(mode, stacked, plan, release, lanes, deliverableState), [signature]);

  const nodes = useRef(new Map<string, HTMLElement>());
  const refs = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const refFor = useCallback((id: string) => {
    let callback = refs.current.get(id);
    if (!callback) {
      callback = (element: HTMLElement | null) => {
        if (element) nodes.current.set(id, element);
        else nodes.current.delete(id);
      };
      refs.current.set(id, callback);
    }
    return callback;
  }, []);

  const [edges, setEdges] = useState<readonly DrawnEdge[]>([]);
  useLayoutEffect(() => {
    const root = canvas.current;
    if (!root) return;
    let frame = 0;
    let last = "";
    const measure = (): void => {
      const base = root.getBoundingClientRect();
      const box = (id: string): Box | undefined => {
        const element = nodes.current.get(id);
        if (!element) return undefined;
        const rect = element.getBoundingClientRect();
        const top = rect.top - base.top;
        return { left: rect.left - base.left, top, right: rect.right - base.left, bottom: rect.bottom - base.top, cy: top + rect.height / 2 };
      };
      const drawn = specs.map((spec) => drawEdge(spec, box)).filter((edge): edge is DrawnEdge => edge !== undefined);
      const key = JSON.stringify(drawn);
      if (key !== last) {
        last = key;
        setEdges(drawn);
      }
    };
    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    for (const element of nodes.current.values()) observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [specs]);

  const card = (station: Station, heading?: string, ghost = false): ReactNode => (
    <StationCard
      station={station}
      heading={heading}
      ghost={ghost}
      selected={selectedId === station.id}
      onSelect={() => onSelect(station.id)}
    />
  );

  const waitingNote = hasPlan ? undefined : plan.status === "failed" || plan.status === "cancelled" ? "No plan was submitted." : "Tasks appear once the planner submits a plan.";

  const laneContent = (lane: Lane, layout: "columns" | "split" | "stacked"): ReactNode => {
    const row = lane.row;
    const build = row?.build;
    const review = row?.review;
    const ghostBuild = !build && row ? taskStation(row, "build", environments) : undefined;
    const ghostReview = !review && row ? taskStation(row, "review", environments) : undefined;
    return (
      <div key={lane.id} className="min-w-0">
        {row ? <LaneLabel row={row} workOrder={workOrder} /> : <div className="mb-2 h-4 w-28 rounded bg-zinc-800/50" aria-hidden />}
        <div
          className={cx(
            layout === "columns" && "grid",
            layout === "split" && "grid grid-cols-2 gap-6",
            layout === "stacked" && "flex flex-col gap-5",
          )}
          style={layout === "columns" ? { gridTemplateColumns: `${W_BUILD}px ${W_REVIEW}px`, columnGap: ROW_GAP } : undefined}
        >
          <div ref={refFor(lane.buildId)} className="relative z-10 min-w-0">
            {build ? card(build, "Build") : ghostBuild ? card(ghostBuild, "Build", true) : <GhostCard label="Build" />}
          </div>
          <div ref={refFor(lane.reviewId)} className="relative z-10 min-w-0">
            {review ? card(review, "Review") : ghostReview ? card(ghostReview, "Review", true) : <GhostCard label="Review" />}
          </div>
        </div>
      </div>
    );
  };

  const intake = <IntakeCard workOrder={workOrder} selected={selectedId === "intake"} onSelect={() => onSelect("intake")} />;
  const deliverable = <DeliverableCard workOrder={workOrder} release={release} />;

  return (
    <section
      ref={frame}
      aria-label="Factory floor"
      className="relative min-w-0 overflow-clip rounded-2xl border border-zinc-800/80 bg-zinc-950/60 xl:h-full"
    >
      <div ref={scroller} className="bg-floor-grid h-full overflow-auto">
        <div
          ref={canvas}
          className={cx("relative", mode === "horizontal" ? "flex min-w-max items-stretch" : "flex flex-col gap-6")}
          style={mode === "horizontal" ? { padding: CANVAS_PADDING, columnGap: GAP } : { padding: CANVAS_PADDING }}
        >
          <svg className="pointer-events-none absolute inset-0 z-0 h-full w-full overflow-visible" aria-hidden>
            {edges.map((edge) => (
              <path key={edge.id} d={edge.d} className={cx("edge", `edge-${edge.state}`)} />
            ))}
            {edges.map((edge) =>
              edge.end && (edge.state === "active" || edge.state === "done") ? (
                <circle
                  key={`${edge.id}:dot`}
                  cx={edge.end.x}
                  cy={edge.end.y}
                  r={2.5}
                  className={edge.state === "active" ? "edge-dot-active" : "edge-dot-done"}
                />
              ) : null,
            )}
          </svg>

          {mode === "horizontal" ? (
            <>
              <Column label="Intake" width={W_TERMINAL}>
                <div ref={refFor("intake")} className="relative z-10">
                  {intake}
                </div>
              </Column>
              <Column label="Plan" width={W_PLAN}>
                <div ref={refFor(plan.id)} className="relative z-10">
                  {card(plan)}
                </div>
              </Column>
              <div className="flex flex-col">
                <div className="mb-3 grid" style={{ gridTemplateColumns: `${W_BUILD}px ${W_REVIEW}px`, columnGap: ROW_GAP }}>
                  <ColumnLabel>Build</ColumnLabel>
                  <ColumnLabel>Review</ColumnLabel>
                </div>
                <div className="flex flex-1 flex-col justify-center gap-5">
                  {lanes.map((lane) => laneContent(lane, "columns"))}
                  {waitingNote ? <p className="text-center text-xs text-zinc-500">{waitingNote}</p> : null}
                </div>
              </div>
              <Column label="Release" width={W_RELEASE}>
                <div ref={refFor(release.id)} className="relative z-10">
                  {card(release)}
                </div>
              </Column>
              <Column label="Deliverable" width={W_TERMINAL}>
                <div ref={refFor("deliverable")} className="relative z-10">
                  {deliverable}
                </div>
              </Column>
            </>
          ) : (
            <>
              <div ref={refFor("intake")} className="relative z-10 w-full max-w-lg">
                {intake}
              </div>
              <div ref={refFor(plan.id)} className="relative z-10 w-full max-w-lg">
                {card(plan)}
              </div>
              <div className="flex max-w-3xl flex-col gap-5 pl-12">
                {lanes.map((lane) => laneContent(lane, stacked ? "stacked" : "split"))}
                {waitingNote ? <p className="text-xs text-zinc-500">{waitingNote}</p> : null}
              </div>
              <div ref={refFor(release.id)} className="relative z-10 w-full max-w-lg">
                {card(release)}
              </div>
              <div ref={refFor("deliverable")} className="relative z-10 w-full max-w-lg">
                {deliverable}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** A build/review station the plan implies but the server hasn't created yet. */
function taskStation(row: TaskRow, kind: "build" | "review", environments: readonly EnvironmentView[] | undefined): Station {
  const role = kind === "build" ? "builder" : "reviewer";
  const environment = environments?.find((candidate) => candidate.role === role);
  return {
    id: `${kind}:${row.id}`,
    kind,
    taskId: row.id,
    title: `${KIND_LABELS[kind]} · ${row.title}`,
    status: "waiting",
    role,
    environment: environment?.name ?? FACTORY_ENVIRONMENTS[role],
    placement: environment ? (environment.type === "shared" ? "shared" : "sandbox") : kind === "build" ? "sandbox" : "shared",
    agent: environment?.agents[0] ?? ROLE_AGENTS[role],
    model: environment?.model,
    round: 0,
  };
}

function ColumnLabel({ children }: { readonly children: ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">{children}</div>;
}

function Column({ label, width, children }: { readonly label: string; readonly width: number; readonly children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col" style={{ width }}>
      <div className="mb-3">
        <ColumnLabel>{label}</ColumnLabel>
      </div>
      <div className="flex flex-1 flex-col justify-center">{children}</div>
    </div>
  );
}

function LaneLabel({ row, workOrder }: { readonly row: TaskRow; readonly workOrder: WorkOrder }) {
  const waiting = row.build === undefined || row.build.status === "waiting";
  return (
    <div className="mb-2 flex min-w-0 items-center gap-2" title={row.task?.description}>
      <span className="truncate text-xs font-medium text-zinc-300">{row.title}</span>
      {row.dependsOn.length > 0 ? (
        <span
          className={cx(
            "inline-flex min-w-0 shrink items-center gap-1 truncate text-[11px]",
            waiting ? "text-amber-300/80" : "text-zinc-500",
          )}
        >
          <Link2 className="size-3 shrink-0" aria-hidden />
          <span className="truncate">
            {waiting ? "waits for" : "after"} {row.dependsOn.map((id) => taskTitle(workOrder, id)).join(", ")}
          </span>
        </span>
      ) : null}
    </div>
  );
}

function GhostCard({ label }: { readonly label: string }) {
  return (
    <div className="flex h-[92px] flex-col justify-between rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-3" aria-hidden>
      <div className="flex items-center gap-2.5">
        <span className="size-8 rounded-lg bg-zinc-800/50" />
        <div className="space-y-1.5">
          <div className="text-[13px] font-medium text-zinc-600">{label}</div>
          <div className="h-2 w-16 rounded bg-zinc-800/60" />
        </div>
      </div>
      <div className="flex gap-1">
        <div className="h-3.5 w-12 rounded bg-zinc-800/50" />
        <div className="h-3.5 w-16 rounded bg-zinc-800/50" />
      </div>
    </div>
  );
}

function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>]/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function IntakeCard({ workOrder, selected, onSelect }: { readonly workOrder: WorkOrder; readonly selected: boolean; readonly onSelect: () => void }) {
  const template = useStore((state) =>
    workOrder.source.templateId ? state.templates.find((candidate) => candidate.id === workOrder.source.templateId) : undefined,
  );
  const source = workOrder.source.kind === "template" ? (template?.title ?? "Template") : "Custom brief";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cx(
        "flex w-full flex-col rounded-xl border border-zinc-700/80 bg-zinc-900/90 p-3 text-left shadow-lg shadow-black/20 transition-colors",
        selected ? "bg-zinc-800/80 outline-2 outline-offset-2 outline-zinc-300/60" : "hover:border-zinc-600 hover:bg-zinc-900",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-emerald-400/10 text-emerald-300 ring-1 ring-inset ring-emerald-400/20">
          <Inbox className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-zinc-50">Intake</div>
          <div className="truncate text-xs text-zinc-400">{source}</div>
        </div>
      </div>
      <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-zinc-400">{plainText(workOrder.brief)}</p>
      <span className="mt-2 inline-flex items-center gap-0.5 text-[11px] font-medium text-amber-300/90">
        Read brief <ChevronRight className="size-3" aria-hidden />
      </span>
    </button>
  );
}

function DeliverableCard({ workOrder, release }: { readonly workOrder: WorkOrder; readonly release: Station }) {
  const summary = workOrder.release;
  if (summary && release.status === "done") {
    return (
      <a
        href={workOrderHref(workOrder.id, "deliverable")}
        className="group flex w-full flex-col rounded-xl border border-emerald-400/45 bg-emerald-400/[0.07] p-3 shadow-[0_0_0_1px_rgb(52_211_153/0.12),0_0_32px_-8px_rgb(52_211_153/0.35)] transition-colors hover:bg-emerald-400/[0.11]"
      >
        <span className="grid size-8 place-items-center rounded-lg bg-emerald-400/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
          <PackageCheck className="size-4" aria-hidden />
        </span>
        <span className="mt-2 text-[13px] font-semibold text-emerald-100">Release ready</span>
        <span className="mt-0.5 text-xs text-emerald-200/70">
          {pluralize(summary.files, "file")} · {formatBytes(summary.bytes)}
        </span>
        {summary.tests ? (
          <span className="mt-0.5 text-xs text-emerald-200/70">{summary.tests.passed} tests passed</span>
        ) : null}
        <span className="mt-2 inline-flex items-center gap-0.5 text-[11px] font-medium text-emerald-300">
          Open <ChevronRight className="size-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </span>
      </a>
    );
  }
  if (release.status === "failed") {
    return (
      <div className="flex w-full flex-col rounded-xl border border-rose-400/35 bg-rose-400/[0.05] p-3">
        <span className="grid size-8 place-items-center rounded-lg bg-rose-400/10 text-rose-300 ring-1 ring-inset ring-rose-400/25">
          <PackageX className="size-4" aria-hidden />
        </span>
        <span className="mt-2 text-[13px] font-semibold text-rose-100">Release failed</span>
        <span className="mt-0.5 text-xs text-rose-200/70">See the release station for details.</span>
      </div>
    );
  }
  return (
    <div className="flex w-full flex-col rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-3">
      <span className="grid size-8 place-items-center rounded-lg bg-zinc-800/60 text-zinc-500 ring-1 ring-inset ring-white/5">
        <PackageOpen className="size-4" aria-hidden />
      </span>
      <span className="mt-2 text-[13px] font-semibold text-zinc-400">Deliverable</span>
      <span className="mt-0.5 text-xs leading-relaxed text-zinc-500">Lights up when the release is packaged.</span>
    </div>
  );
}
