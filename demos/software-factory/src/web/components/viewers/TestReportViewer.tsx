import { CheckCircleFillIcon, ChevronRightIcon, SkipIcon, TerminalIcon, XCircleFillIcon } from "@primer/octicons-react";
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
  passed: { icon: CheckCircleFillIcon, className: "text-fg-success", label: "Passed" },
  failed: { icon: XCircleFillIcon, className: "text-fg-danger", label: "Failed" },
  skipped: { icon: SkipIcon, className: "text-fg-muted", label: "Skipped" },
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
        <Callout tone="warning" compact className="m-4">
          This test report couldn't be read, so the raw file is shown instead.
        </Callout>
        <CodeViewer code={prettyJson(text)} language="json" className="py-2" />
      </div>
    );
  }
  return <Report report={report} />;
}

/** A test report like a GitHub Actions checks summary: the verdict, the counts, and every test as a row. */
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
  const Verdict = ok ? CheckCircleFillIcon : XCircleFillIcon;

  return (
    <div className="space-y-4 p-4">
      <section className="Box">
        <div className="flex flex-wrap items-start gap-3 p-4">
          <Verdict size={24} className={cx("shrink-0", ok ? "text-fg-success" : "text-fg-danger")} />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold">
              {report.mode === "release" ? "Release test suite" : "Task tests"}
              {report.taskId ? <span className="font-normal text-fg-muted"> · {report.taskId}</span> : null}
            </h3>
            <p className="text-fg-muted">
              {ok ? "All tests passed" : `${pluralize(summary.failed, "test")} failed`}
              {report.startedAt ? ` · ${formatDateTime(report.startedAt)}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Chip tone={report.exitCode === 0 ? "plain" : "danger"} mono>
              exit {report.exitCode}
            </Chip>
            {report.durationMs > 0 ? <Chip mono>{formatDuration(report.durationMs)}</Chip> : null}
          </div>
        </div>

        <dl className="grid grid-cols-2 border-t border-line-muted sm:grid-cols-4">
          <Stat label="Passed" value={summary.passed} className="text-fg-success" />
          <Stat label="Failed" value={summary.failed} className={summary.failed > 0 ? "text-fg-danger" : undefined} border="border-l" />
          <Stat label="Skipped" value={summary.skipped} border="max-sm:border-t sm:border-l" />
          <Stat label="Total" value={summary.total} border="border-l max-sm:border-t" />
        </dl>

        <div className="space-y-3 border-t border-line-muted p-4">
          <TestBar counts={summary} />
          {report.command ? (
            <div className="flex items-center gap-2 rounded-md border border-line bg-canvas-inset py-1 pr-1 pl-3">
              <TerminalIcon size={16} className="shrink-0 text-fg-muted" />
              <code className="min-w-0 flex-1 truncate font-mono text-xs" title={report.command}>
                {report.command}
              </code>
              <CopyButton text={report.command} label="Copy test command" />
            </div>
          ) : null}
          {report.files.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-xs text-fg-muted">Test files</span>
              {report.files.map((file) => (
                <Chip key={file} mono>
                  {file}
                </Chip>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className="Box overflow-hidden">
        <div className="Box-header flex-wrap justify-between gap-2 px-4 py-2">
          <h3 className="Box-title">{pluralize(report.tests.length, "test")}</h3>
          <div className="SegmentedControl SegmentedControl--sm" role="group" aria-label="Filter tests">
            {filters.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={filter === option.id}
                onClick={() => setFilter(option.id)}
                disabled={option.id !== "all" && option.count === 0}
                className="SegmentedControl-item"
              >
                {option.label}
                <span className="Counter">{option.count}</span>
              </button>
            ))}
          </div>
        </div>
        {visible.length === 0 ? (
          <p className="px-4 py-6 text-center text-fg-muted">No tests match this filter.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
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
        <details className="group Box overflow-hidden">
          <summary className="flex items-center gap-2 px-4 py-2 font-semibold hover:bg-canvas-muted [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon size={16} className="text-fg-muted transition-transform duration-100 group-open:rotate-90" />
            Raw output <span className="font-normal text-fg-muted">(tail)</span>
          </summary>
          <pre className="max-h-96 overflow-auto border-t border-line bg-canvas-inset p-3 font-mono text-xs leading-5 whitespace-pre">
            {report.output}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  className,
  border,
}: {
  readonly label: string;
  readonly value: number;
  readonly className?: string;
  readonly border?: string;
}) {
  return (
    <div className={cx("border-line-muted px-4 py-3", border)}>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className={cx("text-xl font-semibold tabular-nums", className)}>{value}</dd>
    </div>
  );
}

function TestRow({ test, open, onToggle }: { readonly test: TestCase; readonly open: boolean; readonly onToggle: () => void }) {
  const meta = STATUS_ICONS[test.status] ?? STATUS_ICONS.skipped;
  const Glyph = meta.icon;
  const expandable = test.status === "failed" && Boolean(test.error);
  return (
    <Fragment>
      <tr className="border-t border-line-muted first:border-t-0 hover:bg-canvas-muted">
        <td className="w-8 py-2 pl-4 align-top">
          <Glyph size={16} className={cx("mt-0.5", meta.className)} aria-label={meta.label} />
        </td>
        <td className="py-2 pr-3 pl-2 align-top">
          {expandable ? (
            <button type="button" onClick={onToggle} aria-expanded={open} className="inline-flex items-start gap-1 text-left hover:text-fg-accent">
              <ChevronRightIcon size={16} className={cx("mt-0.5 shrink-0 text-fg-muted transition-transform duration-100", open && "rotate-90")} />
              <span>{test.name}</span>
            </button>
          ) : (
            <span className={test.status === "skipped" ? "text-fg-muted" : undefined}>{test.name}</span>
          )}
        </td>
        <td className="hidden py-2 pr-3 align-top font-mono text-xs leading-6 text-fg-muted sm:table-cell">{test.file ?? ""}</td>
        <td className="w-20 py-2 pr-4 text-right align-top font-mono text-xs leading-6 text-fg-muted tabular-nums">
          {test.durationMs !== undefined ? formatDuration(test.durationMs) : ""}
        </td>
      </tr>
      {expandable && open ? (
        <tr>
          <td />
          <td colSpan={3} className="pr-4 pb-3">
            <pre className="max-h-72 overflow-auto rounded-md border border-line-danger-muted bg-canvas-inset p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
              {test.error}
            </pre>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}
