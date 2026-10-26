import { AlertIcon, CheckCircleIcon, InfoIcon, StopIcon, type Icon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { splitInlineCode } from "../../lib/format.js";
import { TONE_FLASH, type Tone } from "../../lib/tone.js";

/** Primer skeleton loader; size it with utilities. */
export function Skeleton({ className }: { readonly className?: string }) {
  return <div className={cx("SkeletonBox", className)} aria-hidden />;
}

/** Renders text, turning `backtick` spans into inline code. */
export function InlineCode({ text, className }: { readonly text: string; readonly className?: string }) {
  return (
    <span className={className}>
      {splitInlineCode(text).map((part, index) =>
        part.code ? (
          <code key={index} className="inline-code">
            {part.text}
          </code>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

const CALLOUT_ICONS: Readonly<Record<Tone, Icon>> = {
  active: InfoIcon,
  accent: InfoIcon,
  success: CheckCircleIcon,
  warning: AlertIcon,
  danger: StopIcon,
  neutral: InfoIcon,
};

export interface CalloutProps {
  readonly tone?: Tone;
  readonly title?: ReactNode;
  readonly icon?: Icon;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  /** Tighter padding for panels and inline messages (`flash-sm`). */
  readonly compact?: boolean;
  readonly className?: string;
  readonly role?: "alert" | "status";
}

/** Primer flash banner. */
export function Callout({ tone = "neutral", title, icon, children, actions, compact = false, className, role }: CalloutProps) {
  const Glyph = icon ?? CALLOUT_ICONS[tone];
  return (
    <div role={role} className={cx("flash", TONE_FLASH[tone], compact && "flash-sm", className)}>
      <Glyph size={16} />
      <div className="flash-content">
        {title ? <div className="flash-title">{title}</div> : null}
        {children ? <div className={title ? "mt-1" : undefined}>{children}</div> : null}
      </div>
      {actions ? <div className="flash-actions">{actions}</div> : null}
    </div>
  );
}

export interface EmptyStateProps {
  readonly icon: Icon;
  readonly title: ReactNode;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly size?: "sm" | "md" | "lg";
  readonly className?: string;
}

/** Primer blankslate: a 24px Octicon, a heading, a muted description, and an optional action. */
export function EmptyState({ icon: Glyph, title, children, action, size = "md", className }: EmptyStateProps) {
  return (
    <div className={cx("blankslate", size === "sm" && "blankslate--sm", size === "lg" && "blankslate--spacious", className)}>
      <Glyph size={24} className="blankslate-icon" />
      <h3 className="blankslate-heading">{title}</h3>
      {children ? <div className="blankslate-description">{children}</div> : null}
      {action ? <div className="blankslate-action">{action}</div> : null}
    </div>
  );
}

/** Small group heading: 12px, semibold, muted, sentence case (like `NavList-groupHeading`). */
export function SectionLabel({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <h3 className={cx("text-xs font-semibold text-fg-muted", className)}>{children}</h3>;
}
