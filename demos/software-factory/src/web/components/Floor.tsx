import { CheckCircleFillIcon, ClockIcon, ContainerIcon, CpuIcon, LinkIcon, PackageIcon, XCircleFillIcon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import { FACTORY_ENVIRONMENTS, ROLE_AGENTS } from "../../shared/environments.js";
import type { EnvironmentView, Station, StationKind, StationRole, WorkOrder } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { formatBytes } from "../lib/format.js";
import { workOrderHref } from "../lib/router.js";
import { edgeState, isStationActive, KIND_LABELS, taskRows, taskTitle, type EdgeState, type TaskRow } from "../lib/stations.js";
import { useStore } from "../lib/store.js";
import { StationCard, stationCardClass } from "./StationCard.js";

const ROLES: Readonly<Record<StationKind, StationRole>> = {
  plan: "planner",
  coordinate: "coordinator",
  build: "builder",
  review: "reviewer",
  release: "release",
};

const IDS: Readonly<Partial<Record<StationKind, string>>> = { plan: "plan", coordinate: "coordinator", release: "release" };

/** Stand-in for a station the server hasn't created yet, described from the platform's environments. */
function placeholderStation(kind: StationKind, environments: readonly EnvironmentView[] | undefined, row?: TaskRow): Station {
  const role = ROLES[kind];
  const environment = environments?.find((candidate) => candidate.role === role);
  const shared = environment ? environment.type === "shared" || environment.type === "orchestrator" : kind !== "build" && kind !== "release";
  return {
    id: row ? `${kind}:${row.id}` : (IDS[kind] ?? kind),
    kind,
    taskId: row?.id,
    title: row ? `${KIND_LABELS[kind]} · ${row.title}` : KIND_LABELS[kind],
    status: "waiting",
    role,
    environment: environment?.name ?? FACTORY_ENVIRONMENTS[role],
    placement: shared ? "shared" : "sandbox",
    agent: environment?.agents[0] ?? ROLE_AGENTS[role],
    model: environment?.model,
    round: 0,
  };
}

export interface FloorProps {
  readonly workOrder: WorkOrder;
  readonly selectedId: string;
  readonly onSelect: (stationId: string) => void;
}

/**
 * The assembly line, top to bottom: Plan (and, agent-led, the coordinator), one lane per task (Build → Review), then
 * Release → the deliverable. Connectors show flow: dashed while idle, moving while the next station works.
 */
export function Floor({ workOrder, selectedId, onSelect }: FloorProps) {
  const environments = useStore((state) => state.platform?.environments);
  const agentLed = workOrder.mode === "agent";
  const find = (kind: StationKind): Station | undefined => workOrder.stations.find((station) => station.kind === kind);
  const plan = find("plan");
  const coordinator = agentLed ? find("coordinate") : undefined;
  const release = find("release");
  const rows = taskRows(workOrder);
  const planStatus = plan?.status ?? "waiting";
  const planDone = planStatus === "done";
  const releaseStatus = release?.status ?? "waiting";

  const card = (station: Station | undefined, kind: StationKind, heading?: string, row?: TaskRow): ReactNode => {
    const shown = station ?? placeholderStation(kind, environments, row);
    return (
      <StationCard
        station={shown}
        workOrder={workOrder}
        heading={heading}
        ghost={station === undefined}
        selected={selectedId === shown.id}
        onSelect={() => onSelect(shown.id)}
      />
    );
  };

  const builds = rows.map((row) => row.build?.status);
  const spine: EdgeState = builds.some((status) => status !== undefined && isStationActive(status))
    ? "active"
    : rows.length > 0 && builds.every((status) => status === "done")
      ? "done"
      : planDone
        ? "ready"
        : "idle";
  const delivered: EdgeState =
    workOrder.release && releaseStatus === "done" ? "done" : releaseStatus === "failed" ? "failed" : "idle";

  return (
    <section aria-label="Factory floor" className="Box @container min-w-0 overflow-auto bg-dot-grid p-4 xl:h-full xl:min-h-0">
      <div className="max-w-3xl">
        <Pair
          left={card(plan, "plan")}
          right={agentLed ? card(coordinator, "coordinate") : undefined}
          state={edgeState(planDone, coordinator?.status)}
        />
        <div className="relative py-4 pl-10">
          <span className={cx("pipe pipe-y absolute top-0 bottom-0 left-[19px]", `pipe-${spine}`)} aria-hidden />
          {rows.length > 0 ? (
            <ol className="space-y-4" aria-label="Tasks">
              {rows.map((row) => (
                <li key={row.id}>
                  <LaneTitle row={row} workOrder={workOrder} />
                  <Pair
                    lane
                    left={card(row.build, "build", "Build", row)}
                    right={card(row.review, "review", "Review", row)}
                    state={edgeState(row.build?.status === "done", row.review?.status)}
                    tick={edgeState(planDone, row.build?.status)}
                  />
                </li>
              ))}
            </ol>
          ) : planStatus === "failed" || planStatus === "cancelled" ? (
            <p className="py-2 text-xs text-fg-muted">No plan was submitted.</p>
          ) : (
            <GhostLanes />
          )}
        </div>
        <Pair left={card(release, "release")} right={<DeliverableNode workOrder={workOrder} releaseStatus={releaseStatus} />} state={delivered} />
      </div>
    </section>
  );
}

/** Two nodes joined by a connector: side by side when the floor is wide enough, stacked on phones. */
function Pair({
  left,
  right,
  state,
  lane = false,
  tick,
}: {
  readonly left: ReactNode;
  readonly right?: ReactNode;
  readonly state: EdgeState;
  /** Inside the indented task lanes; otherwise the left node also covers the spine's gutter. */
  readonly lane?: boolean;
  /** The branch from the spine into this lane. */
  readonly tick?: EdgeState;
}) {
  return (
    <div
      className={cx(
        "grid grid-cols-1 @lg:items-center",
        lane ? "@lg:grid-cols-[minmax(0,1fr)_1.5rem_minmax(0,1fr)]" : "@lg:grid-cols-[2.5rem_minmax(0,1fr)_1.5rem_minmax(0,1fr)]",
      )}
    >
      <div className={cx("relative flex min-w-0", !lane && "@lg:col-span-2")}>
        {tick ? <span className={cx("pipe pipe-x absolute top-1/2 -left-5 w-5 -translate-y-1/2", `pipe-${tick}`)} aria-hidden /> : null}
        {left}
      </div>
      {right ? (
        <>
          <span className={cx("pipe pipe-link", `pipe-${state}`)} aria-hidden />
          <div className="flex min-w-0">{right}</div>
        </>
      ) : null}
    </div>
  );
}

function LaneTitle({ row, workOrder }: { readonly row: TaskRow; readonly workOrder: WorkOrder }) {
  const waiting = row.build === undefined || row.build.status === "waiting";
  return (
    <div className="mb-1.5 flex min-w-0 items-center gap-2" title={row.task?.description}>
      <span className="truncate font-semibold">{row.title}</span>
      {row.dependsOn.length > 0 ? (
        <span className={cx("inline-flex min-w-0 shrink items-center gap-1 text-xs", waiting ? "text-fg-attention" : "text-fg-muted")}>
          <LinkIcon size={12} className="shrink-0" />
          <span className="truncate">
            {waiting ? "waits for" : "after"} {row.dependsOn.map((id) => taskTitle(workOrder, id)).join(", ")}
          </span>
        </span>
      ) : null}
    </div>
  );
}

/** Where the lanes go before the plan exists. */
function GhostLanes() {
  return (
    <ol className="space-y-4" aria-label="Tasks appear once the plan is ready">
      {[0, 1].map((index) => (
        <li key={index} aria-hidden>
          <div className="SkeletonText mt-0 mb-2 w-28" />
          <Pair lane left={<GhostCard label="Build" sandbox />} right={<GhostCard label="Review" />} state="idle" tick="idle" />
        </li>
      ))}
    </ol>
  );
}

const STATIC_NODE = "flex w-full min-w-0 flex-col rounded-md border border-dashed border-line bg-canvas px-3 py-2";

function GhostCard({ label, sandbox = false }: { readonly label: string; readonly sandbox?: boolean }) {
  const Glyph = sandbox ? ContainerIcon : CpuIcon;
  return (
    <div className={STATIC_NODE}>
      <span className="flex items-center gap-2 text-fg-muted">
        <Glyph size={16} className="shrink-0" />
        <span className="font-semibold">{label}</span>
      </span>
      <span className="mt-1.5 flex items-center gap-1.5 text-xs text-fg-muted">
        <ClockIcon size={16} />
        Waiting
      </span>
    </div>
  );
}

/** The product at the end of the line: the release bundle once it's packaged. */
function DeliverableNode({ workOrder, releaseStatus }: { readonly workOrder: WorkOrder; readonly releaseStatus: Station["status"] }) {
  const summary = workOrder.release;
  if (summary && releaseStatus === "done") {
    const name = `${workOrder.plan?.projectName ?? "release"}.zip`;
    return (
      <a
        href={workOrderHref(workOrder.id, "deliverable")}
        aria-label={`Open the release, ${name}, ${formatBytes(summary.bytes)}`}
        className={cx(stationCardClass(false), "group text-fg hover:no-underline")}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <PackageIcon size={16} className="shrink-0 text-fg-success" />
          <span className="min-w-0 truncate font-semibold group-hover:text-fg-accent group-hover:underline">{name}</span>
        </span>
        <span className="mt-1.5 flex w-full items-center gap-1.5 text-xs">
          <CheckCircleFillIcon size={16} className="shrink-0 text-fg-success" />
          Ready
          <span className="ml-auto pl-1 text-fg-muted tabular-nums">{formatBytes(summary.bytes)}</span>
        </span>
      </a>
    );
  }
  const failed = releaseStatus === "failed";
  return (
    <div className={STATIC_NODE}>
      <span className="flex items-center gap-2 text-fg-muted">
        <PackageIcon size={16} className="shrink-0" />
        <span className="font-semibold">Deliverable</span>
      </span>
      <span className="mt-1.5 flex items-center gap-1.5 text-xs text-fg-muted">
        {failed ? <XCircleFillIcon size={16} className="text-fg-danger" /> : <ClockIcon size={16} />}
        {failed ? "Not released" : "Waiting"}
      </span>
    </div>
  );
}
