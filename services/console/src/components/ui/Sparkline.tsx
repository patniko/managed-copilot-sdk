import type { TrafficSeries } from "@managed-copilot/protocol/operator";
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cx } from "../../lib/cx.js";
import { formatHourMinute, formatNumber, pluralize } from "../../lib/format.js";
import { bucketStart, seriesStats, sparklinePaths } from "../../lib/overview.js";
import { TONE_FILL, TONE_STROKE, type Tone } from "../../lib/tone.js";

const WIDTH = 240;
const HEIGHT = 40;

/** Primer display colors for charts. */
export type ChartColor = "blue" | "green" | "orange" | "purple" | "pink" | "red" | "yellow" | "teal" | "indigo" | "gray";

const CHART_STROKE: Readonly<Record<ChartColor, string>> = {
  blue: "stroke-display-blue",
  green: "stroke-display-green",
  orange: "stroke-display-orange",
  purple: "stroke-display-purple",
  pink: "stroke-display-pink",
  red: "stroke-display-red",
  yellow: "stroke-display-yellow",
  teal: "stroke-display-teal",
  indigo: "stroke-display-indigo",
  gray: "stroke-display-gray",
};

const CHART_FILL: Readonly<Record<ChartColor, string>> = {
  blue: "fill-display-blue-muted",
  green: "fill-display-green-muted",
  orange: "fill-display-orange-muted",
  purple: "fill-display-purple-muted",
  pink: "fill-display-pink-muted",
  red: "fill-display-red-muted",
  yellow: "fill-display-yellow-muted",
  teal: "fill-display-teal-muted",
  indigo: "fill-display-indigo-muted",
  gray: "fill-display-gray-muted",
};

export interface SparklineProps {
  readonly label: string;
  readonly unit: string;
  readonly series: TrafficSeries;
  readonly generatedAt: string;
  /** A Primer role (accent, danger, …). */
  readonly tone?: Tone;
  /** A Primer display color; wins over `tone`. */
  readonly color?: ChartColor;
}

/**
 * Per-minute counts for the last hour as an inline SVG in Primer colors. Hover or focus it and use the arrow keys to
 * read single minutes; the reading is announced to screen readers.
 */
export function Sparkline({ label, unit, series, generatedAt, tone = "accent", color }: SparklineProps) {
  const values = series.perMinute;
  const [active, setActive] = useState<number | undefined>(undefined);
  const id = useId();
  const paths = useMemo(() => sparklinePaths(values, WIDTH, HEIGHT), [values]);
  const stats = useMemo(() => seriesStats(series), [series]);
  const count = values.length;

  const describe = (index: number): string => {
    const start = bucketStart(generatedAt, index, count);
    const value = values[index] ?? 0;
    return `${formatHourMinute(start)}${index === count - 1 ? " (this minute)" : ""}: ${pluralize(value, unit)}`;
  };

  const indexAt = (event: PointerEvent<HTMLDivElement>): number | undefined => {
    if (count === 0) return undefined;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return Math.round(ratio * (count - 1));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (count === 0) return;
    const current = active ?? count - 1;
    let next: number | undefined;
    if (event.key === "ArrowLeft") next = Math.max(0, current - 1);
    else if (event.key === "ArrowRight") next = Math.min(count - 1, current + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else if (event.key === "Escape") {
      setActive(undefined);
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
  };

  const markerX = active !== undefined && count > 1 ? (active / (count - 1)) * 100 : undefined;
  const summary = `${label}: ${pluralize(series.total, unit)} in the last hour, peak ${formatNumber(stats.peak)} per minute.`;

  return (
    <div className="min-w-0">
      <div
        role="img"
        tabIndex={0}
        aria-label={summary}
        aria-describedby={`${id}-reading`}
        onPointerMove={(event) => setActive(indexAt(event))}
        onPointerLeave={() => setActive(undefined)}
        onFocus={() => setActive((value) => value ?? (count > 0 ? count - 1 : undefined))}
        onBlur={() => setActive(undefined)}
        onKeyDown={onKeyDown}
        className="relative h-10 w-full rounded-sm"
      >
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className="size-full overflow-visible" aria-hidden>
          <line x1="0" x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} className="stroke-line-muted" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {paths.area ? <path d={paths.area} className={cx(color ? CHART_FILL[color] : TONE_FILL[tone], "stroke-none")} /> : null}
          {paths.line ? (
            <path
              d={paths.line}
              className={cx(color ? CHART_STROKE[color] : TONE_STROKE[tone], "fill-none")}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {markerX !== undefined && active !== undefined ? (
          <>
            <span className="pointer-events-none absolute inset-y-0 w-px bg-line-emphasis" style={{ left: `${markerX}%` }} aria-hidden />
            <span
              className="Tooltip pointer-events-none absolute -top-9 z-10 max-w-none whitespace-nowrap"
              style={{ left: `${markerX}%`, transform: `translateX(${markerX > 70 ? "-100%" : markerX < 30 ? "0" : "-50%"})` }}
              aria-hidden
            >
              {describe(active)}
            </span>
          </>
        ) : null}
      </div>
      <span id={`${id}-reading`} className="sr-only" aria-live="polite">
        {active !== undefined ? describe(active) : ""}
      </span>
    </div>
  );
}
