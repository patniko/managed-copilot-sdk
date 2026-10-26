import { AlertIcon, CheckCircleIcon, InfoIcon, StopIcon, SyncIcon, type Icon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { TONE_FLASH, type Tone } from "../../lib/tone.js";
import { Button } from "./Button.js";

export { Spinner } from "./Spinner.js";

/** A loading placeholder block (Primer SkeletonBox); size it with utilities. */
export function Skeleton({ className }: { readonly className?: string }) {
  return <span className={cx("SkeletonBox", className)} aria-hidden />;
}

/** Placeholder lines of text (Primer SkeletonText). */
export function SkeletonLines({ lines = 3, className }: { readonly lines?: number; readonly className?: string }) {
  return (
    <span className={cx("block", className)} aria-hidden>
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className={cx("SkeletonText", index === lines - 1 && lines > 1 ? "w-2/3" : "w-full")} />
      ))}
    </span>
  );
}

/** Inline code, as GitHub renders `backticks` in comments. */
export function Code({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <code className={cx("rounded-md bg-neutral-muted px-1 py-0.5 font-mono text-xs break-words", className)}>{children}</code>;
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
      {parts.map((part, index) => (part.code ? <Code key={index}>{part.text}</Code> : <span key={index}>{part.text}</span>))}
    </span>
  );
}

const FLASH_ICONS: Readonly<Record<Tone, Icon>> = {
  accent: InfoIcon,
  success: CheckCircleIcon,
  attention: AlertIcon,
  severe: AlertIcon,
  danger: StopIcon,
  done: InfoIcon,
  neutral: InfoIcon,
};

export interface CalloutProps {
  readonly tone?: Tone;
  readonly title?: ReactNode;
  readonly icon?: Icon;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly role?: "alert" | "status";
  /** The compact banner (flash-sm). */
  readonly small?: boolean;
}

/** A Primer flash banner: icon, optional title, message, and actions. */
export function Callout({ tone = "accent", title, icon, children, actions, className, role, small = false }: CalloutProps) {
  const FlashIcon = icon ?? FLASH_ICONS[tone];
  return (
    <div role={role} className={cx("flash", TONE_FLASH[tone], small && "flash-sm", className)}>
      <FlashIcon size={16} />
      <div className="flash-content">
        {title ? <p className="flash-title">{title}</p> : null}
        {children ? <div className={cx("break-words", title ? "mt-1" : undefined)}>{children}</div> : null}
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
  readonly className?: string;
  /** The smaller blankslate for panels and table bodies. */
  readonly compact?: boolean;
  readonly spacious?: boolean;
}

/** GitHub's blankslate: a 24px Octicon, a heading, a muted description, and an action. */
export function EmptyState({ icon: BlankIcon, title, children, action, className, compact = false, spacious = false }: EmptyStateProps) {
  return (
    <div className={cx("blankslate", compact && "blankslate--sm", spacious && "blankslate--spacious", className)}>
      <BlankIcon size={24} className="blankslate-icon" />
      <h3 className="blankslate-heading">{title}</h3>
      {children ? <div className="blankslate-description">{children}</div> : null}
      {action ? <div className="blankslate-action">{action}</div> : null}
    </div>
  );
}

export interface ErrorStateProps {
  readonly title: string;
  readonly message?: string;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
  readonly className?: string;
  /** Draw a Box around it (when it stands alone on the page rather than inside a Box). */
  readonly boxed?: boolean;
}

/** A section that could not load at all (no earlier data to show). */
export function ErrorState({ title, message, onRetry, retrying = false, className, boxed = false }: ErrorStateProps) {
  return (
    <div role="alert" className={cx("blankslate", boxed && "Box", className)}>
      <AlertIcon size={24} className="blankslate-icon text-fg-danger" />
      <h3 className="blankslate-heading">{title}</h3>
      {message ? <p className="blankslate-description break-words">{message}</p> : null}
      {onRetry ? (
        <div className="blankslate-action">
          <Button icon={SyncIcon} loading={retrying} onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** A sentence-case 12px section heading (GitHub's sidebar and group headings). */
export function SectionLabel({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <h3 className={cx("text-xs font-semibold text-fg-muted", className)}>{children}</h3>;
}

/** A muted placeholder for missing values in tables and field lists. */
export function None({ children = "—", label = "None" }: { readonly children?: ReactNode; readonly label?: string }) {
  return (
    <span className="text-fg-muted" aria-label={label}>
      {children}
    </span>
  );
}
