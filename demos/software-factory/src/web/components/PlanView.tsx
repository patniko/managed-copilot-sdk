import { Check, ClipboardList, FileCode, Link2, SquareTerminal } from "lucide-react";
import type { PlanTask, WorkOrder } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { pluralize } from "../lib/format.js";
import { isWorkOrderActive, stationStatusMeta, taskRows, taskTitle, type TaskRow } from "../lib/stations.js";
import { Chip, StatusBadge } from "./ui/Chip.js";
import { EmptyState, SectionLabel } from "./ui/Feedback.js";
import { CodeBlock } from "./viewers/CodeViewer.js";
import { MarkdownView } from "./viewers/MarkdownView.js";

export function PlanView({ workOrder }: { readonly workOrder: WorkOrder }) {
  const plan = workOrder.plan;
  if (!plan) {
    const planning = isWorkOrderActive(workOrder.status);
    return (
      <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30">
        <EmptyState icon={ClipboardList} title={planning ? "The planner is still working" : "No plan was submitted"}>
          {planning
            ? "The plan appears here once the planner splits the work order into tasks: files, interfaces, acceptance criteria, and dependencies."
            : "This work order ended before the planner submitted a plan."}
        </EmptyState>
      </div>
    );
  }
  const rows = taskRows(workOrder);
  const bins = Object.entries(plan.bin);
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <SectionLabel>Plan</SectionLabel>
            <h2 className="mt-1.5 font-mono text-lg font-semibold text-zinc-50">{plan.projectName}</h2>
            {plan.packageDescription ? <p className="mt-1 text-[13px] text-zinc-400">{plan.packageDescription}</p> : null}
          </div>
          <Chip>{pluralize(plan.tasks.length, "task")}</Chip>
        </div>
        <MarkdownView source={plan.summary} className="mt-4" />
        {bins.length > 0 ? (
          <div className="mt-5">
            <SectionLabel>Commands</SectionLabel>
            <ul className="mt-2 flex flex-wrap gap-2">
              {bins.map(([command, script]) => (
                <li
                  key={command}
                  className="inline-flex items-center gap-2 rounded-lg bg-zinc-950/70 px-2.5 py-1.5 ring-1 ring-inset ring-white/5"
                >
                  <SquareTerminal className="size-3.5 text-amber-300/80" aria-hidden />
                  <code className="font-mono text-[12px] font-semibold text-zinc-100">{command}</code>
                  <span className="text-zinc-600" aria-hidden>
                    →
                  </span>
                  <code className="font-mono text-[12px] text-zinc-400">{script}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="plan-tasks">
        <h2 id="plan-tasks" className="sr-only">
          Tasks
        </h2>
        <ol className="grid gap-4 lg:grid-cols-2">
          {plan.tasks.map((task, index) => {
            const row = rows.find((candidate) => candidate.id === task.id);
            return <TaskCard key={task.id} index={index} task={task} workOrder={workOrder} row={row} />;
          })}
        </ol>
      </section>

      {plan.integration ? (
        <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-5">
          <SectionLabel>Integration notes</SectionLabel>
          <p className="mt-1 text-xs text-zinc-500">Guidance for the release station: how the pieces fit and what to verify end to end.</p>
          <MarkdownView source={plan.integration} className="mt-3" />
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

function TaskCard({
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
  return (
    <li className="flex flex-col rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-zinc-800 font-mono text-xs font-semibold text-zinc-300 ring-1 ring-inset ring-white/10">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-zinc-100">{task.title}</h3>
          <code className="font-mono text-[11.5px] text-zinc-500">{task.id}</code>
        </div>
        {statusStation ? <StatusBadge meta={stationStatusMeta(statusStation)} size="xs" /> : null}
      </div>

      <MarkdownView source={task.description} className="mt-3 text-[13px]" />

      {task.dependsOn.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-xs text-zinc-500">
            <Link2 className="size-3.5" aria-hidden /> Depends on
          </span>
          {task.dependsOn.map((id) => (
            <Chip key={id}>{taskTitle(workOrder, id)}</Chip>
          ))}
        </div>
      ) : null}

      {task.files.length > 0 ? (
        <div className="mt-4">
          <SectionLabel>Files</SectionLabel>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {task.files.map((file) => (
              <li key={file}>
                <Chip mono icon={FileCode}>
                  {file}
                </Chip>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {task.interface ? (
        <div className="mt-4">
          <SectionLabel>Interface</SectionLabel>
          <CodeBlock
            code={task.interface}
            language={interfaceLanguage(task.interface)}
            className="mt-2 mb-0 border-amber-400/20"
            maxHeightClass="max-h-72"
          />
        </div>
      ) : null}

      {task.acceptance.length > 0 ? (
        <div className="mt-4">
          <SectionLabel>Acceptance criteria</SectionLabel>
          <ul className="mt-2 space-y-1.5">
            {task.acceptance.map((criterion, criterionIndex) => (
              <li key={criterionIndex} className="flex items-start gap-2 text-[13px] leading-relaxed text-zinc-300">
                <span
                  role="img"
                  aria-label={approved ? "Met" : "Not verified yet"}
                  className={cx(
                    "mt-[3px] grid size-3.5 shrink-0 place-items-center rounded border",
                    approved ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300" : "border-zinc-600",
                  )}
                >
                  {approved ? <Check className="size-2.5" strokeWidth={3} aria-hidden /> : null}
                </span>
                <span>{criterion}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}
