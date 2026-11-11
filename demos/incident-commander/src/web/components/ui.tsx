import { CheckCircleFillIcon, CheckIcon, ClockIcon, CopyIcon, DotFillIcon, LinkExternalIcon, StopIcon, WorkflowIcon, XCircleFillIcon } from "@primer/octicons-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { FactoryStatus, IncidentStatus, IncidentView, Severity } from "../../shared/types.js";
import { cx } from "../lib/format.js";
import { useDismiss } from "../lib/hooks.js";

/** A trigger with a popover under it, closed by Escape or a click outside. */
export function Popover({
  trigger,
  label,
  width,
  align = "right",
  className,
  children,
}: {
  readonly trigger: (open: boolean, toggle: () => void) => ReactNode;
  readonly label: string;
  readonly width: string;
  readonly align?: "left" | "right";
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(container, open, close);
  return (
    <div ref={container} className={cx("relative min-w-0", className)}>
      {trigger(open, () => setOpen((value) => !value))}
      {open ? (
        <div role="dialog" aria-label={label} className={cx("Overlay absolute top-full z-40 mt-2 max-w-[calc(100vw-2rem)] animate-scale-in", align === "right" ? "right-0" : "left-0", width)}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Hover/focus tooltip in a portal, so scroll containers never clip it. */
export function Tooltip({ content, children, className }: { readonly content: ReactNode; readonly children: ReactNode; readonly className?: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const id = useId();
  const hide = useCallback(() => setAnchor(null), []);
  return (
    <span
      className={cx("inline-flex min-w-0", className)}
      onMouseEnter={(event) => content && setAnchor(event.currentTarget.getBoundingClientRect())}
      onMouseLeave={hide}
      onFocus={(event) => content && setAnchor(event.currentTarget.getBoundingClientRect())}
      onBlur={hide}
      aria-describedby={anchor ? id : undefined}
    >
      {children}
      {anchor ? createPortal(<Bubble id={id} anchor={anchor} onDismiss={hide}>{content}</Bubble>, document.body) : null}
    </span>
  );
}

function Bubble({ id, anchor, onDismiss, children }: { readonly id: string; readonly anchor: DOMRect; readonly onDismiss: () => void; readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ readonly left: number; readonly top: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const above = anchor.top - height - 6 >= 4;
    const top = above ? anchor.top - height - 6 : anchor.bottom + 6;
    const left = Math.min(Math.max(6, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - width - 6);
    setPosition((current) => (current && current.left === left && current.top === top ? current : { left, top }));
  }, [anchor, children]);
  useEffect(() => {
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    return () => {
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
    };
  }, [onDismiss]);
  return (
    <div ref={ref} id={id} role="tooltip" style={{ position: "fixed", left: position?.left ?? -9999, top: position?.top ?? -9999 }} className="Tooltip max-w-xs animate-fade-in">
      {children}
    </div>
  );
}

export function Spinner({ size = 16, className }: { readonly size?: number; readonly className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className={cx("shrink-0 animate-spin", className)}>
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M15 8a7 7 0 0 0-7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const SEVERITY_CLASS: Record<Severity, string> = {
  SEV1: "bg-danger-emphasis",
  SEV2: "bg-severe-emphasis",
  SEV3: "bg-attention-emphasis",
  SEV4: "bg-neutral-emphasis",
};

const SEVERITY_TITLE: Record<Severity, string> = {
  SEV1: "Critical: customers can't use the product",
  SEV2: "Major: a core feature is failing for many customers",
  SEV3: "Minor: degraded for some customers",
  SEV4: "Low: no customer impact yet",
};

export function SeverityBadge({ severity, large = false }: { readonly severity: Severity; readonly large?: boolean }) {
  return (
    <Tooltip content={SEVERITY_TITLE[severity]}>
      <span
        className={cx(
          "inline-flex shrink-0 items-center rounded-md font-mono font-semibold tracking-wide text-fg-on-emphasis",
          large ? "px-2 py-0.5 text-sm" : "px-1.5 text-xs leading-5",
          SEVERITY_CLASS[severity],
        )}
      >
        {severity}
      </span>
    </Tooltip>
  );
}

export const STATUS_LABEL: Record<IncidentStatus, string> = { investigating: "Investigating", mitigating: "Mitigating", resolved: "Resolved" };
export const STATUS_TEXT: Record<IncidentStatus, string> = { investigating: "text-fg-attention", mitigating: "text-fg-accent", resolved: "text-fg-success" };

// ─── Software Factory ────────────────────────────────────────────────────────────────────────────────────────

/** Software Factory's identity color: Primer's indigo display color. */
export const FACTORY_TONE = "bg-display-indigo-muted text-display-indigo";

/** Why Software Factory can't be chosen: the words every app that routes to it uses. */
export const FACTORY_UNAVAILABLE = "Software Factory isn't connected. Start it with `aspire run`, or set SOFTWARE_FACTORY_URL.";

export const FACTORY_STATUS_LABEL: Record<FactoryStatus, string> = {
  queued: "Queued",
  planning: "Planning",
  building: "Building",
  releasing: "Releasing",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const FACTORY_ACTIVE: readonly FactoryStatus[] = ["queued", "planning", "building", "releasing"];

export const factoryActive = (status: FactoryStatus): boolean => FACTORY_ACTIVE.includes(status);

/** Copilot ended its turn for the factory: the work order runs, or how it ended hasn't reached Copilot yet. */
export function waitingForFactory(incident: IncidentView): boolean {
  return incident.factory !== undefined && incident.factory.deliveredAt === undefined && incident.status !== "resolved" && incident.coordinator.state !== "failed";
}

/** A work order's status, in the map's words and icons. */
export function FactoryStatusWord({ status }: { readonly status: FactoryStatus }) {
  const label = FACTORY_STATUS_LABEL[status];
  if (status === "completed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-success">
        <CheckCircleFillIcon size={12} /> {label}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-danger">
        <XCircleFillIcon size={12} /> {label}
      </span>
    );
  }
  if (status === "cancelled") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-muted">
        <StopIcon size={12} /> {label}
      </span>
    );
  }
  if (status === "queued") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-muted">
        <ClockIcon size={12} /> {label}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-fg-accent">
      <DotFillIcon size={16} className="animate-pulse" />
      {label}
    </span>
  );
}

/** **Open in Software Factory**: the work order's page, in a new tab. */
export function OpenInFactory({ url, className }: { readonly url: string; readonly className?: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className={cx("inline-flex items-center gap-1.5", className)}>
      <WorkflowIcon size={14} />
      Open in Software Factory
      <LinkExternalIcon size={12} />
    </a>
  );
}

/** Copies `text`, then shows a check for a moment. */
export function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Tooltip content={copied ? "Copied" : label}>
      <button
        type="button"
        aria-label={label}
        className="btn-octicon m-0"
        onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined)}
      >
        {copied ? <CheckIcon size={16} className="text-fg-success" /> : <CopyIcon size={16} />}
      </button>
    </Tooltip>
  );
}
