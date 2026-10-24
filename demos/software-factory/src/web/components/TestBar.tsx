import { cx } from "../lib/cx.js";

export interface TestCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped?: number;
}

/** Thin proportional bar: passed (green), failed (red), skipped (gray). */
export function TestBar({ counts, className }: { readonly counts: TestCounts; readonly className?: string }) {
  const skipped = counts.skipped ?? 0;
  const total = Math.max(counts.total, counts.passed + counts.failed + skipped, 1);
  const pct = (value: number): string => `${(value / total) * 100}%`;
  return (
    <div
      className={cx("flex h-1.5 w-full overflow-hidden rounded-full bg-zinc-800", className)}
      role="img"
      aria-label={`${counts.passed} passed, ${counts.failed} failed${skipped ? `, ${skipped} skipped` : ""}`}
    >
      {counts.passed > 0 ? <div className="h-full bg-emerald-400/90" style={{ width: pct(counts.passed) }} /> : null}
      {counts.failed > 0 ? <div className="h-full bg-rose-400/90" style={{ width: pct(counts.failed) }} /> : null}
      {skipped > 0 ? <div className="h-full bg-zinc-500/80" style={{ width: pct(skipped) }} /> : null}
    </div>
  );
}

/** "12 passed" (green) or "2 failed" (red). */
export function testChipLabel(counts: TestCounts): { readonly label: string; readonly tone: "success" | "danger" | "neutral" } {
  if (counts.failed > 0) return { label: `${counts.failed} failed`, tone: "danger" };
  if (counts.passed > 0) return { label: `${counts.passed} passed`, tone: "success" };
  return { label: counts.total > 0 ? `${counts.total} tests` : "No tests", tone: "neutral" };
}
