import { CheckIcon, CopilotIcon, MarkGithubIcon, PlugIcon, PlusIcon, WorkflowIcon, XIcon } from "@primer/octicons-react";
import { useEffect, useId, useRef } from "react";
import { formatWorkOrderNumber, type WorkOrderOrigin, type WorkOrderSummary } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { formatFullDateTime, formatRelative } from "../lib/format.js";
import { originIcon, originText } from "../lib/origin.js";
import { modeLabel } from "../lib/platform.js";
import { workOrderHref } from "../lib/router.js";
import { workOrderStatusMeta } from "../lib/stations.js";
import { useStore } from "../lib/store.js";
import { useNow } from "../lib/time.js";
import { buttonClass, IconButton } from "./ui/Button.js";
import { EmptyState } from "./ui/Feedback.js";
import { Tooltip } from "./ui/Tooltip.js";

export interface SidebarProps {
  readonly activeId?: string;
  readonly drawerOpen: boolean;
  readonly onCloseDrawer: () => void;
}

export function Sidebar({ activeId, drawerOpen, onCloseDrawer }: SidebarProps) {
  return (
    <>
      <aside className="hidden w-72 shrink-0 border-r border-line bg-canvas lg:block xl:w-80" aria-label="Work orders">
        <SidebarContent activeId={activeId} />
      </aside>
      {drawerOpen ? <Drawer activeId={activeId} onClose={onCloseDrawer} /> : null}
    </>
  );
}

/** The work order list as a side sheet on small screens, like github.com's mobile navigation. */
function Drawer({ activeId, onClose }: { readonly activeId?: string; readonly onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="absolute inset-0 animate-fade-in bg-backdrop" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Work orders"
        tabIndex={-1}
        className="absolute inset-y-0 left-0 flex w-[min(20rem,88vw)] animate-slide-in-left flex-col rounded-r-lg bg-canvas-overlay shadow-xl outline-none"
      >
        <SidebarContent activeId={activeId} onNavigate={onClose} onClose={onClose} />
      </div>
    </div>
  );
}

function SidebarContent({
  activeId,
  onNavigate,
  onClose,
}: {
  readonly activeId?: string;
  readonly onNavigate?: () => void;
  readonly onClose?: () => void;
}) {
  const summaries = useStore((state) => state.summaries);
  const now = useNow(20_000);
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-12 items-center gap-2 px-4 pt-4">
        <h2 className="text-sm font-semibold">Work orders</h2>
        {summaries.length > 0 ? <span className="Counter">{summaries.length}</span> : null}
        {onClose ? (
          <div className="-my-2 ml-auto">
            <IconButton icon={XIcon} label="Close work orders" onClick={onClose} />
          </div>
        ) : null}
      </div>
      <div className="px-4 pt-2 pb-3">
        <a href="#/" onClick={onNavigate} className={buttonClass("default", "md", "btn-block")}>
          <PlusIcon size={16} />
          New work order
        </a>
      </div>
      <nav aria-label="Work order list" className="min-h-0 flex-1 overflow-y-auto border-t border-line-muted px-2 pt-2 pb-4">
        {summaries.length === 0 ? (
          <EmptyState icon={WorkflowIcon} title="No work orders yet" size="sm">
            Pick a template to start one.
          </EmptyState>
        ) : (
          <ul className="NavList">
            {summaries.map((summary) => (
              <li key={summary.id}>
                <WorkOrderItem summary={summary} active={summary.id === activeId} now={now} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        )}
      </nav>
    </div>
  );
}

/** Agent-led or App-driven as a small glyph; the label is for screen readers and the tooltip. */
function ModeGlyph({ mode }: { readonly mode: WorkOrderSummary["mode"] }) {
  const label = modeLabel(mode);
  const Glyph = mode === "agent" ? CopilotIcon : PlugIcon;
  return (
    <span className="inline-flex shrink-0" title={label}>
      <Glyph size={12} className={mode === "agent" ? "text-fg-done" : undefined} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The app that routed the work order here: its icon and name, the full origin in the tooltip. */
function OriginGlyph({ origin }: { readonly origin: WorkOrderOrigin }) {
  const Glyph = originIcon(origin);
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 font-semibold text-fg-accent" title={originText(origin)}>
      <Glyph size={12} />
      {origin.name}
      <span aria-hidden className="font-normal text-fg-muted">
        ·
      </span>
    </span>
  );
}

function WorkOrderItem({
  summary,
  active,
  now,
  onNavigate,
}: {
  readonly summary: WorkOrderSummary;
  readonly active: boolean;
  readonly now: number;
  readonly onNavigate?: () => void;
}) {
  const id = useId();
  const meta = workOrderStatusMeta(summary.status);
  const Glyph = meta.icon;
  const tests = summary.tests;
  const testsLabel = tests ? `${tests.passed} passed, ${tests.failed} failed${tests.skipped ? `, ${tests.skipped} skipped` : ""}` : undefined;
  const needsYou = summary.gates?.some((gate) => gate.state === "open") ?? false;
  return (
    <a
      href={workOrderHref(summary.id)}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      // Number first, so the link reads "WO-0007 CSV toolkit …" (and never starts like a work order tab).
      aria-labelledby={`${id}-number ${id}-title ${id}-meta${needsYou ? ` ${id}-gate` : tests && tests.total > 0 ? ` ${id}-tests` : ""}`}
      className="NavList-item items-start py-2"
    >
      <Glyph size={16} className={cx("mt-0.5", meta.iconClass)} />
      <span className="min-w-0 flex-1">
        <span id={`${id}-title`} className="block truncate" title={summary.title}>
          {summary.title}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs font-normal text-fg-muted">
          <span id={`${id}-number`} className="shrink-0">
            {formatWorkOrderNumber(summary.number)}
          </span>
          <span aria-hidden>·</span>
          <span id={`${id}-meta`} className="inline-flex min-w-0 items-center gap-1">
            {summary.github ? (
              <span className="inline-flex shrink-0" title={`GitHub: ${summary.github.repository}`}>
                <MarkGithubIcon size={12} />
                <span className="sr-only">GitHub</span>
              </span>
            ) : (
              <ModeGlyph mode={summary.mode} />
            )}
            {summary.origin ? <OriginGlyph origin={summary.origin} /> : null}
            <span className="truncate">
              {summary.github ? `${summary.github.repository.split("/")[1] ?? summary.github.repository}${summary.github.pullRequest ? ` #${summary.github.pullRequest}` : ""} · ` : ""}
              {meta.label} · <span title={formatFullDateTime(summary.createdAt)}>{formatRelative(summary.createdAt, now)}</span>
            </span>
          </span>
        </span>
      </span>
      {needsYou ? (
        <span id={`${id}-gate`} className="Label Label--attention mt-0.5 shrink-0" title="A deploy request waits for you">
          Needs you
        </span>
      ) : tests && tests.total > 0 && testsLabel ? (
        <Tooltip content={testsLabel}>
          <span id={`${id}-tests`} className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 text-xs font-normal text-fg-muted tabular-nums">
            {tests.failed > 0 ? <XIcon size={16} className="text-fg-danger" /> : <CheckIcon size={16} className="text-fg-success" />}
            <span aria-hidden>{tests.failed > 0 ? tests.failed : tests.passed}</span>
            <span className="sr-only">{testsLabel}</span>
          </span>
        </Tooltip>
      ) : null}
    </a>
  );
}
