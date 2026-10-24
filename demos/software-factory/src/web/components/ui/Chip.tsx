import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import type { StatusMeta } from "../../lib/stations.js";
import { TONE_BADGE, TONE_DOT, TONE_TEXT, type Tone } from "../../lib/tone.js";

export interface ChipProps {
  readonly children: ReactNode;
  readonly tone?: Tone | "plain";
  readonly mono?: boolean;
  readonly icon?: LucideIcon;
  readonly title?: string;
  readonly className?: string;
}

/** Small, muted metadata label. */
export function Chip({ children, tone = "plain", mono = false, icon: Icon, title, className }: ChipProps) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-px text-[11px] leading-[18px] ring-1 ring-inset",
        tone === "plain" ? "bg-zinc-800/60 text-zinc-400 ring-white/[0.06]" : TONE_BADGE[tone],
        mono && "font-mono text-[10.5px]",
        className,
      )}
    >
      {Icon ? <Icon className="size-3 shrink-0 opacity-80" aria-hidden /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

export interface StatusBadgeProps {
  readonly meta: StatusMeta;
  readonly size?: "xs" | "sm" | "md";
  readonly className?: string;
}

/** Status pill: icon + label (color is never the only signal). */
export function StatusBadge({ meta, size = "sm", className }: StatusBadgeProps) {
  const Icon = meta.icon;
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full font-medium ring-1 ring-inset",
        TONE_BADGE[meta.tone],
        size === "xs" && "px-1.5 py-px text-[10.5px] leading-4",
        size === "sm" && "px-2 py-0.5 text-[11px] leading-4",
        size === "md" && "px-2.5 py-1 text-xs",
        className,
      )}
    >
      <Icon className={cx("shrink-0", size === "md" ? "size-3.5" : "size-3", meta.spin && "animate-spin")} aria-hidden />
      {meta.label}
    </span>
  );
}

/** Inline status: icon + colored label, without a pill. */
export function StatusText({ meta, className }: { readonly meta: StatusMeta; readonly className?: string }) {
  const Icon = meta.icon;
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-1.5 font-medium", TONE_TEXT[meta.tone], className)}>
      <Icon className={cx("size-3.5 shrink-0", meta.spin && "animate-spin")} aria-hidden />
      <span className="truncate">{meta.label}</span>
    </span>
  );
}

export function Dot({ tone, pulse = false, className }: { readonly tone: Tone; readonly pulse?: boolean; readonly className?: string }) {
  return (
    <span className={cx("relative inline-flex size-2 shrink-0", className)} aria-hidden>
      {pulse ? <span className={cx("absolute inline-flex size-full animate-ping rounded-full opacity-60", TONE_DOT[tone])} /> : null}
      <span className={cx("relative inline-flex size-2 rounded-full", TONE_DOT[tone])} />
    </span>
  );
}
