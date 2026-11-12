import { CheckCircleFillIcon, ClockIcon, CommentIcon, DotFillIcon, ShieldIcon, XCircleFillIcon } from "@primer/octicons-react";
import type { AvatarColor, CustomerCard, TicketStatus } from "../../../shared/types.js";
import { cx } from "../../lib/cx.js";
import { STATUS, type Tone } from "../../lib/format.js";
import { Spinner } from "./Spinner.js";

export const TONE_TEXT: Readonly<Record<Tone, string>> = {
  accent: "text-fg-accent",
  attention: "text-fg-attention",
  success: "text-fg-success",
  danger: "text-fg-danger",
  done: "text-fg-done",
  muted: "text-fg-muted",
};

const AVATAR: Readonly<Record<AvatarColor, string>> = {
  blue: "bg-display-blue-muted text-display-blue",
  green: "bg-display-green-muted text-display-green",
  orange: "bg-display-orange-muted text-display-orange",
  purple: "bg-display-purple-muted text-display-purple",
  pink: "bg-display-pink-muted text-display-pink",
  teal: "bg-display-teal-muted text-display-teal",
  indigo: "bg-display-indigo-muted text-display-indigo",
  yellow: "bg-display-yellow-muted text-display-yellow",
  red: "bg-display-red-muted text-display-red",
};

/** A customer's or player's initials on their identity color. */
export function CustomerAvatar({ customer, size = 24, className }: { readonly customer: Pick<CustomerCard, "initials" | "color">; readonly size?: number; readonly className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("inline-grid shrink-0 place-items-center rounded-full font-semibold select-none", AVATAR[customer.color], className)}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) }}
    >
      {customer.initials}
    </span>
  );
}

/** A ticket's status: an icon and one or two words. */
export function StatusLabel({ status, className }: { readonly status: TicketStatus; readonly className?: string }) {
  const { label, tone } = STATUS[status];
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1 text-xs font-medium whitespace-nowrap", TONE_TEXT[tone], className)}>
      <StatusIcon status={status} />
      {label}
    </span>
  );
}

function StatusIcon({ status }: { readonly status: TicketStatus }) {
  switch (status) {
    case "opened":
      return <CommentIcon size={12} />;
    case "starting":
      return <Spinner size={12} />;
    case "answering":
      return <DotFillIcon size={12} className="animate-pulse" />;
    case "approval":
      return <ShieldIcon size={12} />;
    case "waiting":
      return <ClockIcon size={12} />;
    case "resolved":
      return <CheckCircleFillIcon size={12} />;
    case "failed":
      return <XCircleFillIcon size={12} />;
  }
}

/** A status as a small dot, for the counters' session strip. */
export const STATUS_DOT: Readonly<Record<TicketStatus, string>> = {
  opened: "bg-accent-muted",
  starting: "bg-neutral-muted",
  answering: "bg-accent-emphasis animate-pulse",
  approval: "bg-attention-emphasis",
  waiting: "bg-neutral-emphasis opacity-60",
  resolved: "bg-success-emphasis",
  failed: "bg-danger-emphasis",
};

/** A live player: a pulsing dot and "Live". */
export function LiveBadge({ className }: { readonly className?: string }) {
  return (
    <span className={cx("Label Label--success shrink-0 gap-1", className)} title="A live player, from the Downhill Shop">
      <span className="live-dot" aria-hidden />
      Live
    </span>
  );
}

/** The product a player came from. */
export function ProductChip({ className }: { readonly className?: string }) {
  return <span className={cx("Label Label--accent shrink-0", className)}>Downhill</span>;
}
