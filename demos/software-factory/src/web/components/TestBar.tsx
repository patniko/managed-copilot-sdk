import { CheckCircleFillIcon, SkipIcon, XCircleFillIcon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { pluralize } from "../lib/format.js";

export interface TestCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped?: number;
}

/** Primer progress bar of a test run: passed (green), failed (red), skipped (gray). */
export function TestBar({ counts, className }: { readonly counts: TestCounts; readonly className?: string }) {
  const skipped = counts.skipped ?? 0;
  const total = Math.max(counts.total, counts.passed + counts.failed + skipped, 1);
  const pct = (value: number): string => `${(value / total) * 100}%`;
  return (
    <div
      className={cx("Progress", className)}
      role="img"
      aria-label={`${counts.passed} passed, ${counts.failed} failed${skipped ? `, ${skipped} skipped` : ""}`}
    >
      {counts.passed > 0 ? <span className="Progress-item" style={{ width: pct(counts.passed) }} /> : null}
      {counts.failed > 0 ? <span className="Progress-item bg-danger-emphasis" style={{ width: pct(counts.failed) }} /> : null}
      {skipped > 0 ? <span className="Progress-item bg-neutral-emphasis" style={{ width: pct(skipped) }} /> : null}
    </div>
  );
}

/** "12 passed" (green) or "2 failed" (red). */
export function testChipLabel(counts: TestCounts): { readonly label: string; readonly tone: "success" | "danger" | "neutral" } {
  if (counts.failed > 0) return { label: `${counts.failed} failed`, tone: "danger" };
  if (counts.passed > 0) return { label: `${counts.passed} passed`, tone: "success" };
  return { label: counts.total > 0 ? `${counts.total} tests` : "No tests", tone: "neutral" };
}

/** "34 passed · 1 skipped" */
export function testCountsText(counts: TestCounts): string {
  const skipped = counts.skipped ?? 0;
  return [`${counts.passed} passed`, `${counts.failed} failed`, skipped > 0 ? `${skipped} skipped` : ""].filter(Boolean).join(" · ");
}

/** Pull request merge box style summary: "All tests passed" or "2 failing tests", the counts, and the bar. */
export function ChecksSummary({
  counts,
  meta,
  compact = false,
  className,
}: {
  readonly counts: TestCounts;
  /** Extra muted text after the counts, e.g. the duration. */
  readonly meta?: ReactNode;
  /** 16px icon for log rows and lists. */
  readonly compact?: boolean;
  readonly className?: string;
}) {
  const failed = counts.failed > 0;
  const ran = counts.passed + counts.failed > 0;
  const Glyph = failed ? XCircleFillIcon : ran ? CheckCircleFillIcon : SkipIcon;
  return (
    <div className={cx("flex items-start", compact ? "gap-2" : "gap-3", className)}>
      <Glyph
        size={compact ? 16 : 24}
        className={cx("shrink-0", compact && "mt-0.5", failed ? "text-fg-danger" : ran ? "text-fg-success" : "text-fg-muted")}
      />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{failed ? pluralize(counts.failed, "failing test") : ran ? "All tests passed" : "No tests ran"}</p>
        <p className="text-xs text-fg-muted">
          {testCountsText(counts)}
          {meta ? <> · {meta}</> : null}
        </p>
        <TestBar counts={counts} className="mt-2" />
      </div>
    </div>
  );
}
