import { CopilotIcon } from "@primer/octicons-react";
import { STEP_ACTORS, STEP_LABELS, type StepId, type StepView } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { between, clock, duration } from "../lib/format.js";
import { STEP_STATUS_LABEL, StepStatusIcon } from "./Status.js";

/** The link into a step: moving while it runs, green once it ran. */
function linkState(step: StepView): "active" | "done" | "idle" {
  if (step.status === "running") return "active";
  return step.status === "passed" || step.status === "failed" ? "done" : "idle";
}

const RING: Readonly<Record<StepView["status"], string>> = {
  pending: "border-line",
  running: "border-line-attention",
  passed: "border-line-success",
  failed: "border-line-danger",
  skipped: "border-line-muted",
};

function stepMetric(step: StepView, now: number): string {
  const elapsed = between(step.startedAt, step.finishedAt, now);
  if (step.status === "running") return elapsed !== undefined ? clock(elapsed) : "";
  if (step.status === "skipped") return "Skipped";
  return step.summary ?? (elapsed !== undefined ? duration(elapsed) : "");
}

/** The run's steps, left to right (top to bottom on phones). Copilot's steps carry its mark. */
export function Pipeline({ steps, selected, onSelect, now }: { readonly steps: readonly StepView[]; readonly selected?: StepId; readonly onSelect: (id: StepId) => void; readonly now: number }) {
  return (
    <ol className="grid grid-cols-1 sm:grid-cols-6">
      {steps.map((step, index) => {
        const next = steps[index + 1];
        const copilot = STEP_ACTORS[step.id] === "copilot";
        const metric = stepMetric(step, now);
        const isSelected = selected === step.id;
        const elapsed = between(step.startedAt, step.finishedAt, now);
        const hint = `${STEP_LABELS[step.id]}: ${STEP_STATUS_LABEL[step.status].toLowerCase()}${elapsed !== undefined ? ` in ${duration(elapsed)}` : ""}. ${copilot ? "Copilot works" : "Repo Doctor runs commands"} in the sandbox.`;
        return (
          <li key={step.id} className="relative">
            {index > 0 ? <span aria-hidden className="rd-link absolute top-[27px] left-0 hidden h-0.5 w-[calc(50%-24px)] sm:block" data-state={linkState(step)} /> : null}
            {next ? <span aria-hidden className="rd-link absolute top-[27px] right-0 hidden h-0.5 w-[calc(50%-24px)] sm:block" data-state={linkState(next)} /> : null}
            {next ? <span aria-hidden className="rd-link absolute top-[52px] bottom-[-4px] left-[27px] w-0.5 sm:hidden" data-state={linkState(next)} /> : null}
            <button
              type="button"
              aria-pressed={isSelected}
              title={hint}
              onClick={() => onSelect(step.id)}
              className={cx(
                "group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-control-transparent-hover focus-visible:outline-2 sm:flex-col sm:gap-2 sm:text-center",
                isSelected && "bg-control-transparent-selected",
              )}
            >
              <span className={cx("relative grid size-10 shrink-0 place-items-center rounded-full border-2 bg-canvas transition-colors", RING[step.status])}>
                <StepStatusIcon status={step.status} size={20} />
                {copilot ? (
                  <span className="absolute -right-1.5 -bottom-1 grid size-5 place-items-center rounded-full border border-line bg-canvas text-fg">
                    <CopilotIcon size={12} />
                  </span>
                ) : null}
              </span>
              <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2 sm:flex-none sm:flex-col sm:items-center sm:gap-0">
                <span className={cx("font-semibold", isSelected && "text-fg-accent")}>{STEP_LABELS[step.id]}</span>
                <span className={cx("max-w-full truncate text-xs", step.status === "failed" ? "text-fg-danger" : "text-fg-muted", step.status === "running" && "tabular-nums")} title={metric}>
                  {metric || "\u00a0"}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
