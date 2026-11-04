import { cx } from "../../lib/cx.js";

/** Primer's loading spinner. Give it a `label` when nothing else tells assistive technology that work is in progress. */
export function Spinner({ size = 16, className, label }: { readonly size?: number; readonly className?: string; readonly label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx("shrink-0 animate-spin", className)}
    >
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <path d="M15 8a7.002 7.002 0 00-7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
