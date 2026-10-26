import { AlertFillIcon, DotFillIcon, XCircleFillIcon, type Icon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import type { Lifecycle, StatusMeta } from "../../lib/status.js";
import { TONE_LABEL, TONE_TEXT, type Tone } from "../../lib/tone.js";
import { Spinner } from "./Spinner.js";

export interface ChipProps {
  readonly children: ReactNode;
  /** `plain` is an outlined default Label; a tone colors it. */
  readonly tone?: Tone | "plain";
  /** Identifiers (tools, hosts, packages): a monospace token like inline code. */
  readonly mono?: boolean;
  readonly icon?: Icon;
  readonly title?: string;
  readonly className?: string;
}

/** Small metadata: a Primer `Label`, or an inline-code token for identifiers. */
export function Chip({ children, tone = "plain", mono = false, icon: ChipIcon, title, className }: ChipProps) {
  if (mono && tone === "plain" && !ChipIcon) {
    return (
      <code title={title} className={cx("inline-block max-w-full truncate rounded-md bg-neutral-muted px-1.5 align-middle font-mono text-xs leading-5 text-fg", className)}>
        {children}
      </code>
    );
  }
  return (
    <span title={title} className={cx("Label min-w-0", tone !== "plain" && TONE_LABEL[tone], mono && "font-mono", className)}>
      {ChipIcon ? <ChipIcon size={12} /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

function StatusIcon({ meta, size = 12, className }: { readonly meta: StatusMeta; readonly size?: number; readonly className?: string }) {
  if (meta.spin) return <Spinner size={size} className={className} />;
  const MetaIcon = meta.icon;
  return <MetaIcon size={size} className={className} />;
}

export interface StatusBadgeProps {
  readonly meta: StatusMeta;
  readonly size?: "sm" | "md";
  /** Text to show instead of the status label (the label stays the accessible name). */
  readonly children?: ReactNode;
  readonly title?: string;
  readonly className?: string;
}

/** Status pill (Primer `Label`): Octicon + label, so state never depends on color alone. */
export function StatusBadge({ meta, size = "sm", children, title, className }: StatusBadgeProps) {
  return (
    <span title={title ?? meta.description} className={cx("Label shrink-0", TONE_LABEL[meta.tone], size === "md" && "Label--large", className)}>
      <StatusIcon meta={meta} />
      {children ?? meta.label}
    </span>
  );
}

/** Inline status: a colored Octicon (or spinner) and its label, like a check run's status in a list. */
export function StatusText({ meta, children, className }: { readonly meta: StatusMeta; readonly children?: ReactNode; readonly className?: string }) {
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-1.5", className)} title={meta.description}>
      <StatusIcon meta={meta} size={16} className={TONE_TEXT[meta.tone]} />
      <span className="truncate">{children ?? meta.label}</span>
    </span>
  );
}

const LIFECYCLE_CLASS: Readonly<Record<Lifecycle, string>> = {
  open: "State--open",
  closed: "State--closed",
  draft: "State--draft",
  merged: "State--merged",
};

/** An entity's lifecycle as a Primer `State` pill (filled, like "Open" on a pull request), with its Octicon and label. */
export function StateLabel({ meta, lifecycle, small = false, className }: { readonly meta: StatusMeta; readonly lifecycle: Lifecycle; readonly small?: boolean; readonly className?: string }) {
  return (
    <span className={cx("State", LIFECYCLE_CLASS[lifecycle], small && "State--small", className)} title={meta.description}>
      <StatusIcon meta={meta} size={16} />
      {meta.label}
    </span>
  );
}

/** A colored dot (DotFillIcon); always pair it with text. */
export function Dot({ tone, className }: { readonly tone: Tone; readonly className?: string }) {
  return (
    <span className={cx("inline-flex shrink-0", className)} aria-hidden>
      <DotFillIcon size={16} className={TONE_TEXT[tone]} />
    </span>
  );
}

/**
 * A count for navigation and tabs (Primer `Counter`). Attention and danger counts lead with an alert Octicon, so the
 * severity reads without color.
 */
export function CountBadge({ value, tone = "neutral", label }: { readonly value: number; readonly tone?: Tone; readonly label?: string }) {
  const SeverityIcon = tone === "danger" ? XCircleFillIcon : tone === "attention" || tone === "severe" ? AlertFillIcon : undefined;
  return (
    <span className="inline-flex shrink-0 items-center gap-1" title={label}>
      {SeverityIcon ? <SeverityIcon size={12} className={TONE_TEXT[tone]} /> : null}
      <span className="Counter tabular-nums">{value > 999 ? "999+" : value}</span>
      {label ? <span className="sr-only"> {label}</span> : null}
    </span>
  );
}
