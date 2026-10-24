import type { LucideIcon } from "lucide-react";
import { ClipboardList, Download, Factory, FolderOpen, PackageCheck, RotateCcw, Square, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { formatWorkOrderNumber, type WorkOrder } from "../../shared/types.js";
import { bundleUrl, errorMessage, type ErrorInfo } from "../lib/api.js";
import { confirmAction } from "../lib/confirm.js";
import { cx } from "../lib/cx.js";
import { elapsedBetween, formatClock, formatDateTime, formatDuration, formatFullDateTime, pluralize } from "../lib/format.js";
import { homeHref, navigate, workOrderHref, type Query, type WorkOrderTab } from "../lib/router.js";
import { defaultStationId, findStation, isWorkOrderActive, isWorkOrderTerminal, workOrderStatusMeta } from "../lib/stations.js";
import { cancelWorkOrder, deleteWorkOrder, ensureWorkOrder, retryWorkOrder, useStore, useWorkOrder } from "../lib/store.js";
import { useNow } from "../lib/time.js";
import { toast } from "../lib/toast.js";
import { ArtifactsView } from "./ArtifactsView.js";
import { DeliverableView } from "./Deliverable.js";
import { Pipeline } from "./Floor.js";
import { PlanView } from "./PlanView.js";
import { IntakePanel, StationPanel } from "./StationPanel.js";
import { Button, buttonClass } from "./ui/Button.js";
import { StatusBadge } from "./ui/Chip.js";
import { Callout, EmptyState, Skeleton } from "./ui/Feedback.js";

export interface WorkOrderViewProps {
  readonly id: string;
  readonly tab: WorkOrderTab;
  readonly query: Query;
}

export function WorkOrderView({ id, tab, query }: WorkOrderViewProps) {
  const resource = useWorkOrder(id);
  const summary = useStore((state) => state.summaries.find((item) => item.id === id));
  const workOrder = resource?.data;
  const titleNumber = workOrder?.number ?? summary?.number;
  const titleText = workOrder?.title ?? summary?.title;

  useEffect(() => {
    if (titleNumber !== undefined && titleText) {
      document.title = `${formatWorkOrderNumber(titleNumber)} · ${titleText} — Software Factory`;
    }
    return () => {
      document.title = "Software Factory · Managed Copilot";
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
      <div className={cx("px-4 pt-4 pb-6 sm:px-6", fixedHeight && "min-h-0 flex-1")}>
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
      : defaultStationId(workOrder);
  const station = findStation(workOrder, selectedId);

  const select = (stationId: string): void => {
    navigate(workOrderHref(workOrder.id, "floor", { station: stationId }), { replace: true });
  };

  return (
    <div className="grid gap-4 xl:h-full xl:min-h-0 xl:grid-cols-[minmax(0,1fr)_23.75rem] 2xl:grid-cols-[minmax(0,1fr)_26.25rem]">
      <Pipeline workOrder={workOrder} selectedId={selectedId} onSelect={select} />
      <div className="min-w-0 xl:min-h-0">
        {selectedId === "intake" ? (
          <IntakePanel workOrder={workOrder} />
        ) : station ? (
          <StationPanel key={station.id} workOrder={workOrder} station={station} />
        ) : (
          <div className="flex h-full min-h-60 items-center justify-center rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/20">
            <EmptyState icon={Factory} title="This station hasn't started yet">
              It appears here once the work before it is done.
            </EmptyState>
          </div>
        )}
      </div>
    </div>
  );
}

const TABS: readonly { readonly id: WorkOrderTab; readonly label: string; readonly icon: LucideIcon }[] = [
  { id: "floor", label: "Floor", icon: Factory },
  { id: "plan", label: "Plan", icon: ClipboardList },
  { id: "artifacts", label: "Artifacts", icon: FolderOpen },
  { id: "deliverable", label: "Deliverable", icon: PackageCheck },
];

function Header({ workOrder, tab }: { readonly workOrder: WorkOrder; readonly tab: WorkOrderTab }) {
  const active = isWorkOrderActive(workOrder.status);
  const now = useNow(1000, active);
  const meta = workOrderStatusMeta(workOrder.status);
  const started = workOrder.startedAt ?? workOrder.createdAt;
  const elapsed = elapsedBetween(started, workOrder.completedAt, now);
  const number = formatWorkOrderNumber(workOrder.number);

  return (
    <header className="border-b border-zinc-800/80 bg-zinc-950/60 px-4 pt-5 sm:px-6">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="font-mono text-[13px] font-medium text-zinc-500">{number}</span>
            <StatusBadge meta={meta} size="sm" />
          </div>
          <h1 className="mt-1.5 truncate text-xl font-semibold tracking-tight text-zinc-50" title={workOrder.title}>
            {workOrder.title}
          </h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-zinc-400">
            <span title={formatFullDateTime(started)}>
              {workOrder.startedAt ? "Started" : "Created"} {formatDateTime(started)}
            </span>
            {elapsed !== undefined ? (
              <>
                <span className="text-zinc-700" aria-hidden>
                  ·
                </span>
                {active ? (
                  <span>
                    Elapsed <span className="font-mono text-zinc-200 tabular">{formatClock(elapsed)}</span>
                  </span>
                ) : (
                  <span>Took {formatDuration(elapsed)}</span>
                )}
              </>
            ) : null}
            <span className="text-zinc-700" aria-hidden>
              ·
            </span>
            <span>{workOrder.taskCount > 0 ? pluralize(workOrder.taskCount, "task") : "No tasks yet"}</span>
            <span className="text-zinc-700" aria-hidden>
              ·
            </span>
            <span>Up to {pluralize(workOrder.maxReviewRounds, "review round")}</span>
          </p>
        </div>
        <Actions workOrder={workOrder} />
      </div>

      {workOrder.error ? (
        <Callout tone="danger" role="alert" className="mt-4" title={workOrder.status === "cancelled" ? "Work order cancelled" : "Work order failed"}>
          <span>{workOrder.error.message}</span>{" "}
          <code className="ml-1 rounded bg-black/30 px-1.5 py-px font-mono text-[11px] text-rose-200">{workOrder.error.code}</code>
        </Callout>
      ) : null}

      <nav aria-label="Work order sections" className="-mb-px mt-4 flex gap-1 overflow-x-auto">
        {TABS.map((item) => {
          const disabled = item.id === "deliverable" && !workOrder.release;
          const current = item.id === tab;
          const className = cx(
            "inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
            current ? "border-amber-400 text-zinc-50" : "border-transparent text-zinc-400",
            !current && !disabled && "hover:border-zinc-600 hover:text-zinc-200",
            disabled && "cursor-not-allowed text-zinc-600",
          );
          const content = (
            <>
              <item.icon className="size-4" aria-hidden />
              {item.label}
              {item.id === "plan" && workOrder.plan ? (
                <span className="rounded-full bg-zinc-800 px-1.5 text-[10.5px] text-zinc-400 tabular">{workOrder.plan.tasks.length}</span>
              ) : null}
              {item.id === "deliverable" && workOrder.release && workOrder.status === "completed" ? (
                <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden />
              ) : null}
            </>
          );
          return disabled ? (
            <span key={item.id} className={className} aria-disabled="true" title="Available once the release is packaged">
              {content}
            </span>
          ) : (
            <a key={item.id} href={workOrderHref(workOrder.id, item.id)} aria-current={current ? "page" : undefined} className={className}>
              {content}
            </a>
          );
        })}
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
        <Button variant="danger" icon={Square} loading={pending === "cancel"} onClick={() => void run("cancel")}>
          Cancel
        </Button>
      ) : null}
      {retryable ? (
        <Button variant="primary" icon={RotateCcw} loading={pending === "retry"} onClick={() => void run("retry")}>
          Retry
        </Button>
      ) : null}
      {workOrder.status === "completed" ? (
        <a href={bundleUrl(workOrder.id)} download className={buttonClass("primary", "md")}>
          <Download className="size-4" aria-hidden />
          Download release
        </a>
      ) : null}
      {isWorkOrderTerminal(workOrder.status) ? (
        <Button variant="ghost" icon={Trash2} loading={pending === "delete"} onClick={() => void run("delete")} aria-label={`Delete ${number}`}>
          Delete
        </Button>
      ) : null}
    </div>
  );
}

function WorkOrderSkeleton() {
  return (
    <div className="px-4 pt-5 sm:px-6" role="status" aria-label="Loading work order">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="mt-3 h-6 w-72 max-w-full" />
      <Skeleton className="mt-3 h-4 w-96 max-w-full" />
      <div className="mt-6 flex gap-3">
        {[64, 56, 80, 96].map((width) => (
          <div key={width} style={{ width }}>
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
      </div>
      <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_23.75rem]">
        <Skeleton className="h-[28rem] rounded-2xl" />
        <Skeleton className="h-[28rem] rounded-2xl" />
      </div>
    </div>
  );
}

function WorkOrderError({ error, id }: { readonly error: ErrorInfo; readonly id: string }) {
  const notFound = error.status === 404;
  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <EmptyState
        icon={Factory}
        title={notFound ? "Work order not found" : "Couldn't load this work order"}
        action={
          <div className="flex justify-center gap-2">
            {notFound ? null : (
              <Button variant="secondary" icon={RotateCcw} onClick={() => ensureWorkOrder(id, true)}>
                Try again
              </Button>
            )}
            <a href={homeHref()} className={buttonClass("primary", "md")}>
              New work order
            </a>
          </div>
        }
      >
        {notFound ? "It may have been deleted. Pick another work order from the list." : error.message}
      </EmptyState>
    </div>
  );
}
