import {
  AlertIcon,
  ClockIcon,
  CopilotIcon,
  DownloadIcon,
  FileDirectoryIcon,
  PackageIcon,
  StopIcon,
  SyncIcon,
  TasklistIcon,
  TrashIcon,
  WorkflowIcon,
  type Icon,
} from "@primer/octicons-react";
import { useEffect, useState } from "react";
import { formatWorkOrderNumber, type WorkOrder } from "../../shared/types.js";
import { bundleUrl, errorMessage, type ErrorInfo } from "../lib/api.js";
import { confirmAction } from "../lib/confirm.js";
import { cx } from "../lib/cx.js";
import { elapsedBetween, formatClock, formatDateTime, formatDuration, formatFullDateTime, pluralize } from "../lib/format.js";
import { homeHref, navigate, workOrderHref, type Query, type WorkOrderTab } from "../lib/router.js";
import {
  defaultStationId,
  findStation,
  isWorkOrderActive,
  isWorkOrderTerminal,
  STATE_CLASS,
  workOrderStatusMeta,
} from "../lib/stations.js";
import { cancelWorkOrder, deleteWorkOrder, ensureWorkOrder, retryWorkOrder, useStore, useWorkOrder } from "../lib/store.js";
import { useNow } from "../lib/time.js";
import { toast } from "../lib/toast.js";
import { ArtifactsView } from "./ArtifactsView.js";
import { AgentFloor } from "./AgentFloor.js";
import { DeliverableView } from "./Deliverable.js";
import { Pipeline } from "./Floor.js";
import { PlanView } from "./PlanView.js";
import { IntakePanel, StationPanel } from "./StationPanel.js";
import { Button, buttonClass } from "./ui/Button.js";
import { Callout, EmptyState, Skeleton } from "./ui/Feedback.js";

export interface WorkOrderViewProps {
  readonly id: string;
  readonly tab: WorkOrderTab;
  readonly query: Query;
}

const DEFAULT_TITLE = "Software Factory · Managed Copilot";

export function WorkOrderView({ id, tab, query }: WorkOrderViewProps) {
  const resource = useWorkOrder(id);
  const summary = useStore((state) => state.summaries.find((item) => item.id === id));
  const workOrder = resource?.data;
  const titleNumber = workOrder?.number ?? summary?.number;
  const titleText = workOrder?.title ?? summary?.title;

  useEffect(() => {
    if (titleNumber !== undefined && titleText) {
      document.title = `${titleText} · ${formatWorkOrderNumber(titleNumber)} · ${DEFAULT_TITLE}`;
    }
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [titleNumber, titleText]);

  if (!workOrder) {
    if (resource?.error) return <WorkOrderError error={resource.error} id={id} />;
    return <WorkOrderSkeleton />;
  }

  const fixedHeight = tab === "floor" ? "xl:h-full" : tab === "artifacts" ? "lg:h-full" : undefined;
  return (
    <div className={cx("flex min-h-full flex-col", fixedHeight)}>
      <Header workOrder={workOrder} tab={tab} />
      <div className={cx("px-4 pt-4 pb-6 md:px-6", fixedHeight && "min-h-0 flex-1")}>
        {tab === "floor" ? <FloorTab workOrder={workOrder} query={query} /> : null}
        {tab === "plan" ? <PlanView workOrder={workOrder} /> : null}
        {tab === "artifacts" ? <ArtifactsView workOrder={workOrder} query={query} /> : null}
        {tab === "deliverable" ? <DeliverableView workOrder={workOrder} /> : null}
      </div>
    </div>
  );
}

function FloorTab({ workOrder, query }: { readonly workOrder: WorkOrder; readonly query: Query }) {
  const requested = query.station;
  const stationExists = requested === "intake" || (requested !== undefined && findStation(workOrder, requested) !== undefined);
  const placeholders = ["plan", "release"];
  const selectedId =
    requested && (stationExists || placeholders.includes(requested) || requested.startsWith("build:") || requested.startsWith("review:"))
      ? requested
      : workOrder.mode === "agent" ? "coordinator" : defaultStationId(workOrder);
  const station = findStation(workOrder, selectedId);

  const select = (stationId: string): void => {
    navigate(workOrderHref(workOrder.id, "floor", { station: stationId }), { replace: true });
  };

  return (
    <div className="grid gap-4 xl:h-full xl:min-h-0 xl:grid-cols-[minmax(0,1fr)_23.75rem] 2xl:grid-cols-[minmax(0,1fr)_26.25rem]">
      {workOrder.mode === "agent"
        ? <AgentFloor workOrder={workOrder} selectedId={selectedId} onSelect={select} />
        : <Pipeline workOrder={workOrder} selectedId={selectedId} onSelect={select} />}
      <div className="min-w-0 xl:min-h-0">
        {selectedId === "intake" ? (
          <IntakePanel workOrder={workOrder} />
        ) : station ? (
          <StationPanel key={station.id} workOrder={workOrder} station={station} />
        ) : (
          <div className="Box flex h-full min-h-60 items-center justify-center">
            <EmptyState icon={ClockIcon} title="This station hasn't started yet" size="sm">
              It appears here once the work before it is done.
            </EmptyState>
          </div>
        )}
      </div>
    </div>
  );
}

const TABS: readonly { readonly id: WorkOrderTab; readonly label: string; readonly icon: Icon }[] = [
  { id: "floor", label: "Floor", icon: WorkflowIcon },
  { id: "plan", label: "Plan", icon: TasklistIcon },
  { id: "artifacts", label: "Artifacts", icon: FileDirectoryIcon },
  { id: "deliverable", label: "Deliverable", icon: PackageIcon },
];

/** Pull request style header: title with a muted number, a state pill and meta line, actions, and the tabs. */
function Header({ workOrder, tab }: { readonly workOrder: WorkOrder; readonly tab: WorkOrderTab }) {
  const active = isWorkOrderActive(workOrder.status);
  const now = useNow(1000, active);
  const meta = workOrderStatusMeta(workOrder.status);
  const StateIcon = meta.icon;
  const started = workOrder.startedAt ?? workOrder.createdAt;
  const elapsed = elapsedBetween(started, workOrder.completedAt, now);
  const number = formatWorkOrderNumber(workOrder.number);
  const artifactCount = useStore((state) => state.artifacts[workOrder.id]?.data?.files.length);

  return (
    <header>
      <div className="px-4 pt-4 md:px-6 md:pt-6">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <h1 className="gh-header-title min-w-0 flex-1 basis-80 break-words max-sm:text-xl">
            {workOrder.title} <span className="gh-header-number whitespace-nowrap">{number}</span>
          </h1>
          <Actions workOrder={workOrder} />
        </div>
        <div className="gh-header-meta mt-3 border-b-0 pb-0">
          <span className={cx("State", STATE_CLASS[meta.state])}>
            <StateIcon size={16} />
            {meta.label}
          </span>
          <span className={cx("Label", workOrder.mode === "agent" ? "Label--done" : "Label--secondary")}>
            {workOrder.mode === "agent" ? <CopilotIcon size={12} /> : null}
            {workOrder.mode === "agent" ? "Agent-led" : "Classic"}
          </span>
          <span title={formatFullDateTime(started)}>
            {workOrder.startedAt ? "Started" : "Created"} {formatDateTime(started)}
          </span>
          {elapsed !== undefined ? (
            <>
              <span aria-hidden>·</span>
              {active ? (
                <span>
                  Elapsed <span className="font-mono text-fg tabular-nums">{formatClock(elapsed)}</span>
                </span>
              ) : (
                <span>
                  Took <span className="text-fg">{formatDuration(elapsed)}</span>
                </span>
              )}
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span>{workOrder.taskCount > 0 ? pluralize(workOrder.taskCount, "task") : "No tasks yet"}</span>
          <span aria-hidden>·</span>
          <span>Up to {pluralize(workOrder.maxReviewRounds, "review round")}</span>
          {workOrder.mode === "agent" ? <><span aria-hidden>·</span><span>{workOrder.workersStarted ?? 0} workers created by the coordinator</span></> : null}
        </div>

        {workOrder.error ? (
          <Callout
            tone="danger"
            role="alert"
            className="mt-4"
            title={workOrder.status === "cancelled" ? "Work order cancelled" : "Work order failed"}
          >
            <span>{workOrder.error.message}</span> <code className="inline-code">{workOrder.error.code}</code>
          </Callout>
        ) : null}
      </div>

      <nav aria-label="Work order sections" className="UnderlineNav mt-2 px-4 md:px-6">
        <ul className="UnderlineNav-body">
          {TABS.map((item) => {
            const disabled = item.id === "deliverable" && !workOrder.release;
            const count = item.id === "plan" ? workOrder.plan?.tasks.length : item.id === "artifacts" ? artifactCount : undefined;
            const content = (
              <>
                <item.icon size={16} />
                {item.label}
                {count !== undefined ? <span className="Counter">{count}</span> : null}
              </>
            );
            return (
              <li key={item.id}>
                {disabled ? (
                  <span
                    className="UnderlineNav-item cursor-not-allowed text-fg-disabled hover:bg-transparent [&_.octicon]:text-fg-disabled"
                    aria-disabled="true"
                    title="Available once the release is packaged"
                  >
                    {content}
                  </span>
                ) : (
                  <a href={workOrderHref(workOrder.id, item.id)} aria-current={item.id === tab ? "page" : undefined} className="UnderlineNav-item">
                    {content}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}

function Actions({ workOrder }: { readonly workOrder: WorkOrder }) {
  const [pending, setPending] = useState<"cancel" | "retry" | "delete">();
  const number = formatWorkOrderNumber(workOrder.number);
  const active = isWorkOrderActive(workOrder.status);
  const retryable = workOrder.status === "failed" || workOrder.status === "cancelled";

  const run = async (action: "cancel" | "retry" | "delete"): Promise<void> => {
    if (action === "cancel") {
      const ok = await confirmAction({
        title: `Cancel ${number}?`,
        message: "Running stations stop and their sandboxes are shut down. You can retry the work order afterwards.",
        confirmLabel: "Cancel work order",
        cancelLabel: "Keep running",
        tone: "danger",
      });
      if (!ok) return;
    }
    if (action === "delete") {
      const ok = await confirmAction({
        title: `Delete ${number}?`,
        message:
          "This removes the work order and its platform sessions, sandboxes, and artifacts, along with its activity. It can't be undone.",
        confirmLabel: "Delete work order",
        tone: "danger",
      });
      if (!ok) return;
    }
    setPending(action);
    try {
      if (action === "cancel") {
        await cancelWorkOrder(workOrder.id);
        toast.info(`${number} cancelled`);
      } else if (action === "retry") {
        await retryWorkOrder(workOrder.id);
        toast.success(`Retrying ${number}`, "Failed and cancelled stations start again.");
      } else {
        await deleteWorkOrder(workOrder.id);
        toast.info(`${number} deleted`);
        navigate(homeHref());
      }
    } catch (error) {
      const verb = action === "cancel" ? "cancel" : action === "retry" ? "retry" : "delete";
      toast.error(`Couldn't ${verb} ${number}`, errorMessage(error));
    } finally {
      setPending(undefined);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {active ? (
        <Button variant="danger" icon={StopIcon} loading={pending === "cancel"} onClick={() => void run("cancel")}>
          Cancel
        </Button>
      ) : null}
      {isWorkOrderTerminal(workOrder.status) ? (
        <Button variant="danger" icon={TrashIcon} loading={pending === "delete"} onClick={() => void run("delete")} aria-label={`Delete ${number}`}>
          Delete
        </Button>
      ) : null}
      {retryable ? (
        <Button variant="primary" icon={SyncIcon} loading={pending === "retry"} onClick={() => void run("retry")}>
          Retry
        </Button>
      ) : null}
      {workOrder.status === "completed" ? (
        <a href={bundleUrl(workOrder.id)} download className={buttonClass("primary")}>
          <DownloadIcon size={16} />
          Download release
        </a>
      ) : null}
    </div>
  );
}

function WorkOrderSkeleton() {
  return (
    <div role="status" aria-label="Loading work order">
      <div className="px-4 pt-4 md:px-6 md:pt-6">
        <Skeleton className="h-8 w-96 max-w-full" />
        <div className="mt-3 flex items-center gap-2">
          <Skeleton className="h-8 w-24 rounded-full" />
          <div className="SkeletonText w-72 max-w-[60%]" />
        </div>
      </div>
      <div className="UnderlineNav mt-2 gap-4 px-4 md:px-6">
        <div className="flex items-center gap-6">
          {[56, 56, 80, 96].map((width, index) => (
            <div key={index} className="SkeletonText" style={{ width }} />
          ))}
        </div>
      </div>
      <div className="grid gap-4 px-4 pt-4 md:px-6 xl:grid-cols-[minmax(0,1fr)_23.75rem]">
        <Skeleton className="h-[28rem] rounded-md" />
        <Skeleton className="h-[28rem] rounded-md" />
      </div>
    </div>
  );
}

function WorkOrderError({ error, id }: { readonly error: ErrorInfo; readonly id: string }) {
  const notFound = error.status === 404;
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 md:py-16">
      <div className="Box">
        <EmptyState
          icon={notFound ? WorkflowIcon : AlertIcon}
          title={notFound ? "Work order not found" : "Couldn't load this work order"}
          size="lg"
          action={
            <>
              {notFound ? null : (
                <Button icon={SyncIcon} onClick={() => ensureWorkOrder(id, true)}>
                  Try again
                </Button>
              )}
              <a href={homeHref()} className={buttonClass("primary")}>
                New work order
              </a>
            </>
          }
        >
          {notFound ? "It may have been deleted. Pick another work order from the list." : error.message}
        </EmptyState>
      </div>
    </div>
  );
}
