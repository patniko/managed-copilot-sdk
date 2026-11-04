import { ArrowRightIcon, BeakerIcon, CheckCircleFillIcon, CircleIcon, XCircleFillIcon } from "@primer/octicons-react";
import type { RunView, TestReport } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { duration } from "../lib/format.js";
import { Spinner } from "./ui/Spinner.js";

function Result({ title, report, waiting }: { readonly title: string; readonly report: TestReport | undefined; readonly waiting: boolean }) {
  if (!report) {
    return (
      <div className="min-w-0 rounded-md bg-canvas-muted p-3">
        <div className="text-xs font-semibold text-fg-muted">{title}</div>
        <div className="mt-1 flex h-7 items-center text-fg-muted">{waiting ? <Spinner size={20} /> : "—"}</div>
        <div className="mt-0.5 text-xs">&nbsp;</div>
      </div>
    );
  }
  const passed = report.exitCode === 0;
  const headline = passed ? `${report.passed ?? "All"} passing` : report.failed ? `${report.failed} failing` : report.exitCode === undefined ? "Didn't finish" : `Exit code ${report.exitCode}`;
  const detail = [report.total !== undefined ? `${report.total} tests` : undefined, duration(report.durationMs)].filter(Boolean).join(" · ");
  return (
    <div className={cx("min-w-0 rounded-md p-3", passed ? "bg-success-muted" : "bg-danger-muted")}>
      <div className="text-xs font-semibold text-fg-muted">{title}</div>
      <div className="mt-1 flex h-7 items-center gap-2">
        {passed ? <CheckCircleFillIcon size={20} className="shrink-0 text-fg-success" /> : <XCircleFillIcon size={20} className="shrink-0 text-fg-danger" />}
        <span className="truncate text-base font-semibold sm:text-lg" title={headline}>
          {headline}
        </span>
      </div>
      <div className="mt-0.5 truncate text-xs text-fg-muted">{detail}</div>
    </div>
  );
}

/** The failing tests before the fix, and how each one did after. */
export function TestsPanel({ run }: { readonly run: RunView }) {
  const { before, after } = run;
  const verifying = run.steps.find((step) => step.id === "verify")?.status === "running";
  const afterFailures = new Set(after?.failures ?? []);
  return (
    <section className="Box min-w-0" aria-label="Tests">
      <div className="Box-header flex items-center gap-2 py-2">
        <BeakerIcon size={16} className="text-fg-muted" />
        <h2 className="Box-title text-sm">Tests</h2>
        {run.testCommand ? (
          <code className="ml-auto max-w-[60%] truncate font-mono text-xs text-fg-muted" title={run.testCommand}>
            {run.testCommand}
          </code>
        ) : null}
      </div>
      <div className="Box-body flex flex-col gap-3">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <Result title="Before" report={before} waiting={run.status === "running" && !before} />
          <ArrowRightIcon size={16} className="text-fg-muted" />
          <Result title="After" report={after} waiting={verifying} />
        </div>
        {before?.failures.length ? (
          <ul className="flex flex-col gap-1.5 text-sm">
            {before.failures.map((name) => {
              const still = after ? (after.exitCode === 0 ? false : afterFailures.has(name) || afterFailures.size === 0) : undefined;
              return (
                <li key={name} className="flex min-w-0 items-center gap-2">
                  <XCircleFillIcon size={14} className="shrink-0 text-fg-danger" />
                  <ArrowRightIcon size={12} className="shrink-0 text-fg-muted" />
                  {still === undefined ? (
                    verifying ? <Spinner size={14} className="text-fg-attention" /> : <CircleIcon size={14} className="shrink-0 text-fg-muted" />
                  ) : still ? (
                    <XCircleFillIcon size={14} className="shrink-0 text-fg-danger" />
                  ) : (
                    <CheckCircleFillIcon size={14} className="shrink-0 text-fg-success" />
                  )}
                  <span className="min-w-0 truncate" title={name}>
                    {name}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
