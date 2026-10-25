import type { LucideIcon } from "lucide-react";
import { CircleAlert, CircleCheck, Info, LoaderCircle, RotateCcw, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { TONE_CALLOUT, type Tone } from "../../lib/tone.js";
import { Button } from "./Button.js";

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
  const parts: { readonly code: boolean; readonly text: string }[] = [];
  const pattern = /`([^`]+)`/g;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) parts.push({ code: false, text: text.slice(last, match.index) });
    parts.push({ code: true, text: match[1] ?? "" });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return (
    <span className={className}>
      {parts.map((part, index) =>
        part.code ? (
          <code key={index} className="rounded-md bg-black/30 px-1.5 py-px font-mono text-[0.88em] text-zinc-100 ring-1 ring-inset ring-white/10">
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
        {children ? <div className={cx("leading-relaxed opacity-90", title ? "mt-1" : undefined)}>{children}</div> : null}
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
  readonly compact?: boolean;
}

export function EmptyState({ icon: Icon, title, children, action, className, compact = false }: EmptyStateProps) {
  return (
    <div className={cx("flex flex-col items-center justify-center text-center", compact ? "px-4 py-8" : "px-6 py-14", className)}>
      <div className="relative mb-4">
        <div className="absolute inset-0 -m-3 rounded-full bg-amber-400/5 blur-xl" aria-hidden />
        <div className="relative grid size-11 place-items-center rounded-2xl bg-zinc-900 text-zinc-400 ring-1 ring-inset ring-white/10">
          <Icon className="size-5" aria-hidden />
        </div>
      </div>
      <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
      {children ? <div className="mt-1.5 max-w-md text-[13px] leading-relaxed text-zinc-500">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export interface ErrorStateProps {
  readonly title: string;
  readonly message?: string;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
  readonly className?: string;
}

/** A section that could not load at all (no earlier data to show). */
export function ErrorState({ title, message, onRetry, retrying = false, className }: ErrorStateProps) {
  return (
    <div role="alert" className={cx("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      <div className="grid size-11 place-items-center rounded-2xl bg-rose-400/10 text-rose-300 ring-1 ring-inset ring-rose-400/25">
        <CircleAlert className="size-5" aria-hidden />
      </div>
      <h3 className="mt-4 text-sm font-semibold text-zinc-100">{title}</h3>
      {message ? <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-zinc-400">{message}</p> : null}
      {onRetry ? (
        <Button className="mt-5" icon={RotateCcw} loading={retrying} onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function SectionLabel({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <h3 className={cx("text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500", className)}>{children}</h3>;
}

/** A muted placeholder for missing values in tables and field lists. */
export function None({ children = "—", label = "None" }: { readonly children?: ReactNode; readonly label?: string }) {
  return (
    <span className="text-zinc-600" aria-label={label}>
      {children}
    </span>
  );
}
