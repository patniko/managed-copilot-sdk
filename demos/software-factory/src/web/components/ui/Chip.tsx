import { DotFillIcon, type Icon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import type { StatusMeta } from "../../lib/stations.js";
import { TONE_LABEL, TONE_TEXT, type Tone } from "../../lib/tone.js";
import { Spinner } from "./Spinner.js";

export interface ChipProps {
  readonly children: ReactNode;
  readonly tone?: Tone | "plain";
  readonly mono?: boolean;
  readonly icon?: Icon;
  readonly title?: string;
  readonly className?: string;
}

/** Small metadata label (Primer `Label`). */
export function Chip({ children, tone = "plain", mono = false, icon: Glyph, title, className }: ChipProps) {
  return (
    <span title={title} className={cx("Label min-w-0", tone === "plain" ? "Label--secondary" : TONE_LABEL[tone], mono && "font-mono", className)}>
      {Glyph ? <Glyph size={12} /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A status Octicon in its color, or the Primer spinner for work in progress. `label` names it for assistive technology. */
export function StatusIcon({
  meta,
  size = 16,
  label = false,
  className,
}: {
  readonly meta: StatusMeta;
  readonly size?: number;
  readonly label?: boolean;
  readonly className?: string;
}) {
  const color = cx(TONE_TEXT[meta.tone], className);
  if (meta.spin) return <Spinner size={size} className={color} label={label ? meta.label : undefined} />;
  const Glyph = meta.icon;
  return <Glyph size={size} className={color} aria-label={label ? meta.label : undefined} />;
}

export interface StatusBadgeProps {
  readonly meta: StatusMeta;
  readonly size?: "sm" | "md";
  readonly className?: string;
}

/** Status pill: icon and label (color is never the only signal). */
export function StatusBadge({ meta, size = "sm", className }: StatusBadgeProps) {
  return (
    <span className={cx("Label shrink-0", TONE_LABEL[meta.tone], size === "md" && "Label--large", className)}>
      <StatusIcon meta={meta} size={12} />
      {meta.label}
    </span>
  );
}

/** Inline status: colored icon and label, without a pill. */
export function StatusText({ meta, className }: { readonly meta: StatusMeta; readonly className?: string }) {
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-1", className)}>
      <StatusIcon meta={meta} />
      <span className="truncate">{meta.label}</span>
    </span>
  );
}

/** Status dot; a spinner while something is in progress. */
export function Dot({ tone, pulse = false, className }: { readonly tone: Tone; readonly pulse?: boolean; readonly className?: string }) {
  return pulse ? <Spinner size={12} className={cx(TONE_TEXT[tone], className)} /> : <DotFillIcon size={16} className={cx(TONE_TEXT[tone], className)} />;
}
