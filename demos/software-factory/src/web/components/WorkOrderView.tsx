import {
  AlertIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  ClockIcon,
  CopilotIcon,
  DownloadIcon,
  FileDirectoryIcon,
  GitPullRequestIcon,
  InfoIcon,
  KebabHorizontalIcon,
  LinkExternalIcon,
  MarkGithubIcon,
  PackageIcon,
  PlugIcon,
  StopIcon,
  SyncIcon,
  TasklistIcon,
  TrashIcon,
  WorkflowIcon,
  XCircleIcon,
  type Icon,
} from "@primer/octicons-react";
import { useEffect, useState, type ReactNode } from "react";
import { formatWorkOrderNumber, type WorkOrder, type WorkOrderMode, type WorkOrderOrigin } from "../../shared/types.js";
import { bundleUrl, errorMessage, type ErrorInfo } from "../lib/api.js";
import { confirmAction } from "../lib/confirm.js";
import { cx } from "../lib/cx.js";
import { elapsedBetween, formatClock, formatDuration, formatFullDateTime, pluralize } from "../lib/format.js";
import { originHref, originIcon, originText } from "../lib/origin.js";
import { modeLabel } from "../lib/platform.js";
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
import { DeliverableView } from "./Deliverable.js";
import { Floor } from "./Floor.js";
import { PlanView } from "./PlanView.js";
import { PullRequestDeliverable } from "./PullRequestDeliverable.js";
import { IntakePanel, StationPanel } from "./StationPanel.js";
import { Button, buttonClass, IconButton } from "./ui/Button.js";
import { Callout, EmptyState, Skeleton } from "./ui/Feedback.js";
import { MenuItem, Popover } from "./ui/Popover.js";
import { Spinner } from "./ui/Spinner.js";

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
        {tab === "deliverable" ? workOrder.github ? <PullRequestDeliverable workOrder={workOrder} /> : <DeliverableView workOrder={workOrder} /> : null}
      </div>
    </div>
  );
}

function FloorTab({ workOrder, query }: { readonly workOrder: WorkOrder; readonly query: Query }) {
  const requested = query.station;
  const stationExists = requested === "intake" || (requested !== undefined && findStation(workOrder, requested) !== undefined);
  const placeholders = ["plan", "release", "coordinator"];
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
      <Floor workOrder={workOrder} selectedId={selectedId} onSelect={select} />
      <div className="min-w-0 xl:min-h-0">
        {selectedId === "intake" ? (
          <IntakePanel workOrder={workOrder} />
        ) : station ? (
          <StationPanel key={station.id} workOrder={workOrder} station={station} />
        ) : (
          <div className="Box flex h-full min-h-60 items-center justify-center">
            <EmptyState icon={ClockIcon} title="Not started yet" size="sm">
              It starts when the work before it is done.
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

/** GitHub work orders have no plan, and their deliverable is the pull request. */
const GITHUB_TABS: readonly { readonly id: WorkOrderTab; readonly label: string; readonly icon: Icon }[] = [
  { id: "floor", label: "Floor", icon: WorkflowIcon },
  { id: "artifacts", label: "Artifacts", icon: FileDirectoryIcon },
  { id: "deliverable", label: "Pull request", icon: GitPullRequestIcon },
];

/** Whether a GitHub work order has something to show on its deliverable tab: a pull request or an answer. */
export function hasGitHubDeliverable(workOrder: WorkOrder): boolean {
  return Boolean(workOrder.github && (workOrder.github.pullRequest || workOrder.github.revisions.some((revision) => revision.completedAt)));
}

/** The repository (and issue) a GitHub work order changes, as a Label linking to GitHub. */
export function RepositoryLabel({ workOrder }: { readonly workOrder: WorkOrder }) {
  const work = workOrder.github;
  if (!work) return null;
  return (
    <a href={work.issue?.htmlUrl ?? work.repository.htmlUrl} target="_blank" rel="noreferrer" className="Label Label--secondary shrink-0 hover:no-underline" title={`On GitHub: ${work.repository.fullName}`}>
      <MarkGithubIcon size={12} />
      {work.repository.fullName}
      {work.issue ? `#${work.issue.number}` : ""}
    </a>
  );
}

/** Agent-led or App-driven, as a Label. */
export function ModeLabel({ mode }: { readonly mode: WorkOrderMode | undefined }) {
  const agent = mode === "agent";
  const Glyph = agent ? CopilotIcon : PlugIcon;
  return (
    <span className={cx("Label shrink-0", agent ? "Label--done" : "Label--secondary")}>
      <Glyph size={12} />
      {modeLabel(mode)}
    </span>
  );
}

/** The app that routed the work order here, as a Label linking back to it when it can. */
export function OriginLabel({ origin }: { readonly origin: WorkOrderOrigin }) {
  const Glyph = originIcon(origin);
  const href = originHref(origin);
  const content = (
    <>
      <Glyph size={12} />
      <span className="truncate">{originText(origin)}</span>
      {href ? <LinkExternalIcon size={12} /> : null}
    </>
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="Label Label--accent max-w-full min-w-0 hover:no-underline" title={`Open in ${origin.name}`}>
      {content}
    </a>
  ) : (
    <span className="Label Label--accent max-w-full min-w-0">{content}</span>
  );
}

/** An icon and a value; the label is in the tooltip and for screen readers. */
function Stat({ icon: Glyph, label, title, className, children }: {
  readonly icon: Icon;
  readonly label: string;
  readonly title?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1" title={title ?? label}>
      <Glyph size={16} className={cx("shrink-0", className ?? "text-fg-muted")} />
      <span className="sr-only">{label}:</span>
      <span className="text-fg tabular-nums">{children}</span>
    </span>
  );
}

/** Pull request style header: title with a muted number, then the state, mode, and a few icon stats; tabs below. */
function Header({ workOrder, tab }: { readonly workOrder: WorkOrder; readonly tab: WorkOrderTab }) {
  const active = isWorkOrderActive(workOrder.status);
  const now = useNow(1000, active);
  const meta = workOrderStatusMeta(workOrder.status);
  const StateIcon = meta.icon;
  const started = workOrder.startedAt ?? workOrder.createdAt;
  const elapsed = elapsedBetween(started, workOrder.completedAt, now);
  const number = formatWorkOrderNumber(workOrder.number);
  const artifactCount = useStore((state) => state.artifacts[workOrder.id]?.data?.files.length);
  const tests = workOrder.tests;
  const startedText = `${workOrder.startedAt ? "Started" : "Created"} ${formatFullDateTime(started)}`;

  return (
    <header>
      <div className="px-4 pt-4 md:px-6 md:pt-6">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <h1 className="gh-header-title min-w-0 flex-1 basis-72 break-words max-sm:text-xl">
            {workOrder.title} <span className="gh-header-number whitespace-nowrap">{number}</span>
          </h1>
          <Actions workOrder={workOrder} tab={tab} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className={cx("State", STATE_CLASS[meta.state])}>
            <StateIcon size={16} />
            {meta.label}
          </span>
          {workOrder.github ? <RepositoryLabel workOrder={workOrder} /> : <ModeLabel mode={workOrder.mode} />}
          {workOrder.origin ? <OriginLabel origin={workOrder.origin} /> : null}
          {elapsed !== undefined ? (
            <Stat icon={ClockIcon} label={active ? "Elapsed" : "Took"} title={`${active ? "Elapsed" : `Took ${formatDuration(elapsed)}`} · ${startedText}`}>
              {active ? formatClock(elapsed) : formatDuration(elapsed)}
            </Stat>
          ) : null}
          {workOrder.taskCount > 0 && !workOrder.github ? (
            <Stat icon={TasklistIcon} label="Tasks">
              {pluralize(workOrder.taskCount, "task")}
            </Stat>
          ) : null}
          {tests && tests.total > 0 ? (
            <Stat
              icon={tests.failed > 0 ? XCircleIcon : CheckCircleIcon}
              label="Tests"
              title={`${tests.passed} passed · ${tests.failed} failed`}
              className={tests.failed > 0 ? "text-fg-danger" : "text-fg-success"}
            >
              {tests.failed > 0 ? `${tests.failed} failing` : pluralize(tests.passed, "test")}
            </Stat>
          ) : null}
          <DetailsPopover workOrder={workOrder} startedText={startedText} />
        </div>

        {workOrder.error ? (
          <Callout tone="danger" role="alert" compact className="mt-3">
            <span>{workOrder.error.message}</span> <code className="inline-code">{workOrder.error.code}</code>
          </Callout>
        ) : null}
      </div>

      <nav aria-label="Work order sections" className="UnderlineNav mt-2 px-4 md:px-6">
        <ul className="UnderlineNav-body">
          {(workOrder.github ? GITHUB_TABS : TABS).map((item) => {
            const disabled = item.id === "deliverable" && (workOrder.github ? !hasGitHubDeliverable(workOrder) : !workOrder.release);
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
                    title={workOrder.github ? "Available once the pull request is open" : "Available once the release is packaged"}
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

/** The work order's settings and origin, one click away from the header. */
function DetailsPopover({ workOrder, startedText }: { readonly workOrder: WorkOrder; readonly startedText: string }) {
  const template = useStore((state) =>
    workOrder.source.templateId ? state.templates.find((candidate) => candidate.id === workOrder.source.templateId) : undefined,
  );
  const source = workOrder.github
    ? workOrder.github.repository.fullName
    : workOrder.origin
      ? workOrder.origin.name
      : workOrder.source.kind === "template"
        ? (template?.title ?? "Template")
        : "Custom brief";
  return (
    <Popover
      label="Work order details"
      align="start"
      overlayClassName="w-72 max-sm:fixed max-sm:inset-x-3 max-sm:top-auto max-sm:w-auto"
      trigger={(props) => <IconButton {...props} icon={InfoIcon} label="Work order details" size="sm" />}
    >
      <ul className="space-y-1.5 px-4 py-3 text-xs">
        <li>{startedText}</li>
        <li>Up to {pluralize(workOrder.maxReviewRounds, "review round")}{workOrder.github ? " per request" : ""}</li>
        {workOrder.mode === "agent" ? (
          <li>{pluralize(workOrder.workersStarted ?? 0, "sandbox", "sandboxes")} created by the coordinator</li>
        ) : null}
        {workOrder.github ? (
          <li>
            Branch <code className="inline-code">{workOrder.github.branch}</code> from {workOrder.github.repository.defaultBranch}@{workOrder.github.baseSha.slice(0, 7)}
          </li>
        ) : null}
        <li>
          From {workOrder.source.kind === "template" ? "the template " : ""}
          <span className="font-semibold">{source}</span>
          {workOrder.owner ? ` · requested by @${workOrder.owner.login}` : ""}
        </li>
      </ul>
      <div className="border-t border-line-muted px-4 py-2">
        <a href={workOrderHref(workOrder.id, "floor", { station: "intake" })} className="inline-flex items-center gap-0.5 text-xs font-semibold">
          Read the brief
          <ChevronRightIcon size={12} />
        </a>
      </div>
    </Popover>
  );
}

function Actions({ workOrder, tab }: { readonly workOrder: WorkOrder; readonly tab: WorkOrderTab }) {
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
    <div className="flex items-center gap-2">
      {pending === "cancel" || pending === "delete" ? (
        <span role="status" className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
          <Spinner size={16} />
          {pending === "cancel" ? "Cancelling…" : "Deleting…"}
        </span>
      ) : null}
      {retryable ? (
        <Button variant="primary" icon={SyncIcon} loading={pending === "retry"} onClick={() => void run("retry")}>
          Retry
        </Button>
      ) : null}
      {workOrder.status === "completed" && tab !== "deliverable" && workOrder.github?.pullRequest ? (
        <a href={workOrderHref(workOrder.id, "deliverable")} className={buttonClass("primary")}>
          <GitPullRequestIcon size={16} />
          Review #{workOrder.github.pullRequest.number}
        </a>
      ) : null}
      {workOrder.status === "completed" && tab !== "deliverable" && !workOrder.github ? (
        <a href={bundleUrl(workOrder.id)} download className={buttonClass("primary")}>
          <DownloadIcon size={16} />
          Download release
        </a>
      ) : null}
      <Popover
        role="menu"
        label={`${number} actions`}
        overlayClassName="w-56 max-sm:fixed max-sm:inset-x-3 max-sm:top-auto max-sm:w-auto"
        trigger={(props) => <IconButton {...props} icon={KebabHorizontalIcon} label="More actions" variant="default" disabled={pending !== undefined} />}
      >
        {(close) => (
          <div className="ActionList">
            {active ? (
              <MenuItem
                danger
                icon={StopIcon}
                onSelect={() => {
                  close();
                  void run("cancel");
                }}
              >
                Cancel work order
              </MenuItem>
            ) : null}
            {isWorkOrderTerminal(workOrder.status) ? (
              <MenuItem
                danger
                icon={TrashIcon}
                onSelect={() => {
                  close();
                  void run("delete");
                }}
              >
                Delete work order
              </MenuItem>
            ) : null}
          </div>
        )}
      </Popover>
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
