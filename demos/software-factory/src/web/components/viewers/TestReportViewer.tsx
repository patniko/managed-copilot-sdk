import { ChevronDown, ChevronRight, CircleCheck, CircleMinus, CircleX, FlaskConical, Terminal } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import type { TestReport } from "../../../shared/types.js";
import { parseTestReport } from "../../lib/artifacts.js";
import { cx } from "../../lib/cx.js";
import { formatDateTime, formatDuration, pluralize } from "../../lib/format.js";
import { TestBar } from "../TestBar.js";
import { Chip } from "../ui/Chip.js";
import { CopyButton } from "../ui/CopyButton.js";
import { Callout } from "../ui/Feedback.js";
import { CodeViewer } from "./CodeViewer.js";

type Filter = "all" | "failed" | "skipped";
type TestCase = TestReport["tests"][number];

const STATUS_ICONS = {
  passed: { icon: CircleCheck, className: "text-emerald-400", label: "Passed" },
  failed: { icon: CircleX, className: "text-rose-400", label: "Failed" },
  skipped: { icon: CircleMinus, className: "text-zinc-500", label: "Skipped" },
} as const;

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function TestReportViewer({ text }: { readonly text: string }) {
  const report = useMemo(() => parseTestReport(text), [text]);
  if (!report) {
    return (
      <div>
        <Callout tone="warning" className="m-4">
          This test report couldn't be read, so the raw file is shown instead.
        </Callout>
        <CodeViewer code={prettyJson(text)} language="json" />
      </div>
    );
  }
  return <Report report={report} />;
}

function Report({ report }: { readonly report: TestReport }) {
  const [filter, setFilter] = useState<Filter>(report.summary.failed > 0 ? "failed" : "all");
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => {
    const failed = report.tests.flatMap((test, index) => (test.status === "failed" && test.error ? [index] : []));
    return new Set(failed.slice(0, 3));
  });
  const { summary } = report;
  const ok = summary.failed === 0 && report.exitCode === 0;
  const visible = report.tests
    .map((test, index) => ({ test, index }))
    .filter(({ test }) => filter === "all" || test.status === filter);

  const toggle = (index: number): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const filters: { readonly id: Filter; readonly label: string; readonly count: number }[] = [
    { id: "all", label: "All", count: report.tests.length },
    { id: "failed", label: "Failed", count: report.tests.filter((test) => test.status === "failed").length },
    { id: "skipped", label: "Skipped", count: report.tests.filter((test) => test.status === "skipped").length },
  ];

  return (
    <div className="space-y-4 p-4">
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className={cx(
                "grid size-9 place-items-center rounded-xl ring-1 ring-inset",
                ok ? "bg-emerald-400/10 text-emerald-300 ring-emerald-400/25" : "bg-rose-400/10 text-rose-300 ring-rose-400/25",
              )}
            >
              <FlaskConical className="size-4" aria-hidden />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">
                {report.mode === "release" ? "Release test suite" : "Task tests"}
                {report.taskId ? <span className="font-normal text-zinc-500"> · {report.taskId}</span> : null}
              </h3>
              <p className="text-xs text-zinc-500">
                {ok ? "All tests passed" : `${pluralize(summary.failed, "test")} failed`}
                {report.startedAt ? ` · ${formatDateTime(report.startedAt)}` : ""}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tone={report.exitCode === 0 ? "plain" : "danger"} mono>
              exit {report.exitCode}
            </Chip>
            {report.durationMs > 0 ? <Chip mono>{formatDuration(report.durationMs)}</Chip> : null}
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Passed" value={summary.passed} className="text-emerald-300" />
          <Stat label="Failed" value={summary.failed} className={summary.failed > 0 ? "text-rose-300" : "text-zinc-300"} />
          <Stat label="Skipped" value={summary.skipped} className="text-zinc-300" />
          <Stat label="Total" value={summary.total} className="text-zinc-100" />
        </dl>
        <TestBar counts={summary} className="mt-3" />

        {report.command ? (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/70 py-1.5 pr-1.5 pl-3">
            <Terminal className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
            <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-200" title={report.command}>
              {report.command}
            </code>
            <CopyButton text={report.command} label="Copy test command" />
          </div>
        ) : null}
        {report.files.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-zinc-500">Test files</span>
            {report.files.map((file) => (
              <Chip key={file} mono>
                {file}
              </Chip>
            ))}
          </div>
        ) : null}
      </section>

      <section className="overflow-hidden rounded-xl border border-zinc-800">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
          <h3 className="text-xs font-semibold text-zinc-300">{pluralize(report.tests.length, "test")}</h3>
          <div className="flex rounded-lg bg-zinc-950/70 p-0.5 ring-1 ring-inset ring-white/5" role="group" aria-label="Filter tests">
            {filters.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={filter === option.id}
                onClick={() => setFilter(option.id)}
                disabled={option.id !== "all" && option.count === 0}
                className={cx(
                  "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-40",
                  filter === option.id ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200",
                )}
              >
                {option.label} <span className="tabular text-zinc-500">{option.count}</span>
              </button>
            ))}
          </div>
        </div>
        {visible.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-zinc-500">No tests match this filter.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="sr-only">
                <tr>
                  <th>Status</th>
                  <th>Test</th>
                  <th>File</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(({ test, index }) => (
                  <TestRow key={index} test={test} open={expanded.has(index)} onToggle={() => toggle(index)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {report.output ? (
        <details className="group overflow-hidden rounded-xl border border-zinc-800">
          <summary className="flex items-center gap-2 bg-zinc-900/60 px-3 py-2 text-xs font-medium text-zinc-300 hover:text-zinc-100 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 text-zinc-500 transition-transform group-open:rotate-90" aria-hidden />
            Raw output <span className="text-zinc-500">(tail)</span>
          </summary>
          <pre className="max-h-96 overflow-auto border-t border-zinc-800 bg-zinc-950/70 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre text-zinc-300">
            {report.output}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function Stat({ label, value, className }: { readonly label: string; readonly value: number; readonly className?: string }) {
  return (
    <div className="rounded-lg bg-zinc-950/60 px-3 py-2 ring-1 ring-inset ring-white/5">
      <dt className="text-[11px] text-zinc-500">{label}</dt>
      <dd className={cx("text-lg font-semibold tabular", className)}>{value}</dd>
    </div>
  );
}

function TestRow({ test, open, onToggle }: { readonly test: TestCase; readonly open: boolean; readonly onToggle: () => void }) {
  const meta = STATUS_ICONS[test.status] ?? STATUS_ICONS.skipped;
  const Icon = meta.icon;
  const expandable = test.status === "failed" && Boolean(test.error);
  return (
    <Fragment>
      <tr className={cx("border-t border-zinc-800/70 first:border-t-0", test.status === "failed" && "bg-rose-400/[0.04]")}>
        <td className="w-8 py-2 pl-3 align-top">
          <Icon className={cx("mt-px size-4", meta.className)} aria-label={meta.label} />
        </td>
        <td className="py-2 pr-3 align-top">
          {expandable ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className="inline-flex items-start gap-1 text-left text-zinc-100 hover:text-white"
            >
              {open ? (
                <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-zinc-500" aria-hidden />
              ) : (
                <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-zinc-500" aria-hidden />
              )}
              <span>{test.name}</span>
            </button>
          ) : (
            <span className={test.status === "skipped" ? "text-zinc-400" : "text-zinc-200"}>{test.name}</span>
          )}
        </td>
        <td className="hidden py-2 pr-3 align-top font-mono text-[11px] text-zinc-500 sm:table-cell">{test.file ?? ""}</td>
        <td className="w-20 py-2 pr-3 text-right align-top font-mono text-[11px] text-zinc-500 tabular">
          {test.durationMs !== undefined ? formatDuration(test.durationMs) : ""}
        </td>
      </tr>
      {expandable && open ? (
        <tr className="bg-rose-400/[0.04]">
          <td />
          <td colSpan={3} className="pr-3 pb-3">
            <pre className="max-h-72 overflow-auto rounded-lg border border-rose-400/20 bg-zinc-950/80 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-rose-100/90">
              {test.error}
            </pre>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}
