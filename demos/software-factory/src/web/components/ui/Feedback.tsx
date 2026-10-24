import type { LucideIcon } from "lucide-react";
import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { splitInlineCode } from "../../lib/format.js";
import { TONE_CALLOUT, type Tone } from "../../lib/tone.js";

export function Spinner({ className, label }: { readonly className?: string; readonly label?: string }) {
  return (
    <LoaderCircle
      className={cx("size-4 shrink-0 animate-spin text-zinc-400", className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "status" : undefined}
    />
  );
}

export function Skeleton({ className }: { readonly className?: string }) {
  return <div className={cx("skeleton rounded-md", className)} aria-hidden />;
}

/** Renders text, turning `backtick` spans into inline code. */
export function InlineCode({ text, className }: { readonly text: string; readonly className?: string }) {
  return (
    <span className={className}>
      {splitInlineCode(text).map((part, index) =>
        part.code ? (
          <code
            key={index}
            className="rounded-md bg-black/30 px-1.5 py-px font-mono text-[0.88em] text-zinc-100 ring-1 ring-inset ring-white/10"
          >
            {part.text}
          </code>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

const CALLOUT_ICONS: Readonly<Record<Tone, LucideIcon>> = {
  active: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
  neutral: Info,
};

const CALLOUT_ICON_COLORS: Readonly<Record<Tone, string>> = {
  active: "text-sky-300",
  success: "text-emerald-300",
  warning: "text-amber-300",
  danger: "text-rose-300",
  neutral: "text-zinc-400",
};

export interface CalloutProps {
  readonly tone?: Tone;
  readonly title?: ReactNode;
  readonly icon?: LucideIcon;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly role?: "alert" | "status";
}

export function Callout({ tone = "neutral", title, icon, children, actions, className, role }: CalloutProps) {
  const Icon = icon ?? CALLOUT_ICONS[tone];
  return (
    <div role={role} className={cx("flex gap-3 rounded-xl border px-3.5 py-3 text-[13px]", TONE_CALLOUT[tone], className)}>
      <Icon className={cx("mt-0.5 size-4 shrink-0", CALLOUT_ICON_COLORS[tone])} aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <div className="font-medium leading-5">{title}</div> : null}
        {children ? <div className={cx("leading-relaxed opacity-85", title ? "mt-1" : undefined)}>{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-start gap-2">{actions}</div> : null}
    </div>
  );
}

export interface EmptyStateProps {
  readonly icon: LucideIcon;
  readonly title: ReactNode;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}

export function EmptyState({ icon: Icon, title, children, action, className }: EmptyStateProps) {
  return (
    <div className={cx("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      <div className="relative mb-4">
        <div className="absolute inset-0 -m-3 rounded-full bg-amber-400/5 blur-xl" aria-hidden />
        <div className="relative grid size-12 place-items-center rounded-2xl bg-zinc-900 text-zinc-400 ring-1 ring-inset ring-white/10">
          <Icon className="size-5" aria-hidden />
        </div>
      </div>
      <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
      {children ? <div className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-zinc-500">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function SectionLabel({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <h3 className={cx("text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500", className)}>{children}</h3>;
}
