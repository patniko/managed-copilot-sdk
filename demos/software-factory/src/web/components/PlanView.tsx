import { ArrowRightIcon, CheckCircleFillIcon, CircleIcon, CopilotIcon, FileIcon, LinkIcon, TasklistIcon, TerminalIcon } from "@primer/octicons-react";
import type { PlanTask, WorkOrder } from "../../shared/types.js";
import { formatDateTime, formatFullDateTime, pluralize } from "../lib/format.js";
import { workOrderHref } from "../lib/router.js";
import { isWorkOrderActive, stationStatusMeta, taskRows, taskTitle, type TaskRow } from "../lib/stations.js";
import { Chip, StatusBadge, StatusIcon } from "./ui/Chip.js";
import { EmptyState, SectionLabel } from "./ui/Feedback.js";
import { CodeBlock } from "./viewers/CodeViewer.js";
import { MarkdownView } from "./viewers/MarkdownView.js";

/** The plan like an issue with tracked tasks: the planner's summary, then one row per task. */
export function PlanView({ workOrder }: { readonly workOrder: WorkOrder }) {
  const plan = workOrder.plan;
  if (!plan) {
    const planning = isWorkOrderActive(workOrder.status);
    return (
      <div className="Box">
        <EmptyState icon={TasklistIcon} title={planning ? "The planner is still working" : "No plan was submitted"} size="lg">
          {planning
            ? "The plan appears here once the planner splits the work order into tasks: files, interfaces, acceptance criteria, and dependencies."
            : "This work order ended before the planner submitted a plan."}
        </EmptyState>
      </div>
    );
  }
  const rows = taskRows(workOrder);
  const bins = Object.entries(plan.bin);
  const planner = workOrder.stations.find((station) => station.kind === "plan");
  const approved = rows.filter((row) => row.review?.status === "done").length;
  return (
    <div className="mx-auto max-w-[1012px] space-y-6">
      <section aria-labelledby="plan-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="plan-heading" className="text-lg font-semibold break-words">
              {plan.projectName}
            </h2>
            {plan.packageDescription ? <p className="text-fg-muted">{plan.packageDescription}</p> : null}
          </div>
          <Chip icon={TasklistIcon}>{pluralize(plan.tasks.length, "task")}</Chip>
        </div>
        <div className="mt-3 flex gap-3">
          <span className="avatar avatar--square grid size-8 shrink-0 place-items-center text-fg max-sm:hidden" aria-hidden>
            <CopilotIcon size={16} />
          </span>
          <div className="timeline-comment timeline-comment--caret min-w-0 flex-1 max-sm:before:hidden max-sm:after:hidden">
            <div className="timeline-comment-header">
              <span>
                <span className="font-semibold text-fg">@{planner?.agent ?? "planner"}</span> submitted the plan
              </span>
              {planner?.finishedAt ? (
                <span className="ml-auto text-xs" title={formatFullDateTime(planner.finishedAt)}>
                  {formatDateTime(planner.finishedAt)}
                </span>
              ) : null}
            </div>
            <div className="comment-body">
              <MarkdownView source={plan.summary} />
              {bins.length > 0 ? (
                <div className="mt-4 border-t border-line-muted pt-3">
                  <SectionLabel>Commands</SectionLabel>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {bins.map(([command, script]) => (
                      <li key={command} className="inline-flex items-center gap-2 rounded-md border border-line bg-canvas-muted px-2 py-1">
                        <TerminalIcon size={16} className="text-fg-muted" />
                        <code className="font-mono text-xs font-semibold">{command}</code>
                        <ArrowRightIcon size={12} className="text-fg-muted" />
                        <code className="font-mono text-xs text-fg-muted">{script}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="plan-tasks" className="Box">
        <div className="Box-header px-4 py-3">
          <h2 id="plan-tasks" className="Box-title">
            Tasks
          </h2>
          <span className="Counter">{plan.tasks.length}</span>
          <span className="ml-auto text-xs text-fg-muted">
            {approved} of {pluralize(plan.tasks.length, "task")} approved
          </span>
        </div>
        <ol>
          {plan.tasks.map((task, index) => {
            const row = rows.find((candidate) => candidate.id === task.id);
            return <TaskItem key={task.id} index={index} task={task} workOrder={workOrder} row={row} />;
          })}
        </ol>
      </section>

      {plan.integration ? (
        <section className="Box">
          <div className="Box-header block px-4 py-3">
            <h2 className="Box-title">Integration notes</h2>
            <p className="text-xs text-fg-muted">Guidance for the release station: how the pieces fit and what to verify end to end.</p>
          </div>
          <div className="Box-body">
            <MarkdownView source={plan.integration} />
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** Signatures read best as TypeScript; CLI contracts as shell. */
function interfaceLanguage(text: string): string {
  return /\b(export|function|interface|type|const|class|import|declare)\b|=>|:\s*(string|number|boolean|void|unknown|Promise)\b/.test(text)
    ? "typescript"
    : "bash";
}

function TaskItem({
  task,
  index,
  workOrder,
  row,
}: {
  readonly task: PlanTask;
  readonly index: number;
  readonly workOrder: WorkOrder;
  readonly row?: TaskRow;
}) {
  const approved = row?.review?.status === "done";
  const statusStation = approved ? row?.review : (row?.build ?? row?.review);
  const meta = statusStation ? stationStatusMeta(statusStation) : undefined;
  const stationId = row?.review?.status === "done" ? row.review.id : (row?.build?.id ?? row?.review?.id);
  return (
    <li className="Box-row">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex shrink-0">
          {meta ? <StatusIcon meta={meta} label /> : <CircleIcon size={16} className="text-fg-muted" aria-label="Not started" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-semibold break-words">
              {stationId ? (
                <a href={workOrderHref(workOrder.id, "floor", { station: stationId })} className="Link--primary">
                  {task.title}
                </a>
              ) : (
                task.title
              )}
            </h3>
            <code className="font-mono text-xs text-fg-muted">{task.id}</code>
            {meta ? <StatusBadge meta={meta} className="ml-auto" /> : null}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
            <span>Task {index + 1}</span>
            {row?.build ? (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1">
                  <CopilotIcon size={12} />@{row.build.agent}
                </span>
              </>
            ) : null}
            {task.dependsOn.length > 0 ? (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex flex-wrap items-center gap-1">
                  <LinkIcon size={12} /> Depends on
                  {task.dependsOn.map((id) => (
                    <Chip key={id}>{taskTitle(workOrder, id)}</Chip>
                  ))}
                </span>
              </>
            ) : null}
          </p>

          <MarkdownView source={task.description} className="mt-2" />

          {task.files.length > 0 ? (
            <div className="mt-3">
              <SectionLabel>Files</SectionLabel>
              <ul className="mt-1 flex flex-wrap gap-1">
                {task.files.map((file) => (
                  <li key={file}>
                    <Chip mono icon={FileIcon}>
                      {file}
                    </Chip>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {task.interface ? (
            <div className="mt-3">
              <SectionLabel>Interface</SectionLabel>
              <CodeBlock code={task.interface} language={interfaceLanguage(task.interface)} className="mt-1" maxHeightClass="max-h-72" />
            </div>
          ) : null}

          {task.acceptance.length > 0 ? (
            <div className="mt-3">
              <SectionLabel>Acceptance criteria</SectionLabel>
              <ul className="mt-1 space-y-1">
                {task.acceptance.map((criterion, criterionIndex) => (
                  <li key={criterionIndex} className="flex items-start gap-2">
                    {approved ? (
                      <CheckCircleFillIcon size={16} className="mt-0.5 shrink-0 text-fg-success" aria-label="Met" />
                    ) : (
                      <CircleIcon size={16} className="mt-0.5 shrink-0 text-fg-muted" aria-label="Not verified yet" />
                    )}
                    <span>{criterion}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}
