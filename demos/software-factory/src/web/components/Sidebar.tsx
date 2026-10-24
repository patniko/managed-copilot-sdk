import { ChevronRight, ClipboardList, Hammer, PackageCheck, Plus, ScanSearch, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { formatWorkOrderNumber, type WorkOrderSummary } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { formatFullDateTime, formatRelative } from "../lib/format.js";
import { workOrderHref } from "../lib/router.js";
import { workOrderStatusMeta } from "../lib/stations.js";
import { useStore } from "../lib/store.js";
import { useNow } from "../lib/time.js";
import { buttonClass, IconButton } from "./ui/Button.js";
import { StatusBadge } from "./ui/Chip.js";
import { SectionLabel } from "./ui/Feedback.js";

export interface SidebarProps {
  readonly activeId?: string;
  readonly drawerOpen: boolean;
  readonly onCloseDrawer: () => void;
}

export function Sidebar({ activeId, drawerOpen, onCloseDrawer }: SidebarProps) {
  return (
    <>
      <aside className="hidden w-[17rem] shrink-0 border-r border-zinc-800/80 bg-zinc-950 lg:block xl:w-72" aria-label="Work orders">
        <SidebarContent activeId={activeId} />
      </aside>
      {drawerOpen ? <Drawer activeId={activeId} onClose={onCloseDrawer} /> : null}
    </>
  );
}

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
      <div className="absolute inset-0 animate-fade-in bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Work orders"
        tabIndex={-1}
        className="absolute inset-y-0 left-0 flex w-[min(20rem,88vw)] animate-slide-in flex-col border-r border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/60 outline-none"
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
      <div className="flex items-center gap-2 p-3">
        <a href="#/" onClick={onNavigate} className={buttonClass("primary", "md", "flex-1")}>
          <Plus className="size-4" aria-hidden />
          New work order
        </a>
        {onClose ? <IconButton icon={X} label="Close work orders" onClick={onClose} /> : null}
      </div>
      <div className="flex items-center justify-between px-4 pt-1 pb-2">
        <SectionLabel>Work orders</SectionLabel>
        {summaries.length > 0 ? <span className="text-[11px] text-zinc-600 tabular">{summaries.length}</span> : null}
      </div>
      <nav aria-label="Work order list" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {summaries.length === 0 ? (
          <SidebarEmpty />
        ) : (
          <ul className="space-y-0.5">
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
  const meta = workOrderStatusMeta(summary.status);
  const failed = summary.status === "failed";
  const tests = summary.tests;
  return (
    <a
      href={workOrderHref(summary.id)}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cx(
        "group relative block rounded-lg px-3 py-2.5 transition-colors",
        active ? "bg-zinc-800/70 ring-1 ring-inset ring-white/10" : "hover:bg-zinc-900",
      )}
    >
      {active ? <span className="absolute inset-y-2.5 left-0 w-0.5 rounded-full bg-amber-400" aria-hidden /> : null}
      <div className="flex items-center gap-2">
        <span className={cx("font-mono text-[11px]", active ? "text-zinc-400" : "text-zinc-500")}>
          {formatWorkOrderNumber(summary.number)}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-zinc-500" title={formatFullDateTime(summary.createdAt)}>
          {formatRelative(summary.createdAt, now)}
        </span>
      </div>
      <p
        className={cx("mt-0.5 truncate text-[13px] font-medium", failed ? "text-rose-200" : active ? "text-zinc-50" : "text-zinc-200")}
        title={summary.title}
      >
        {summary.title}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <StatusBadge meta={meta} size="xs" />
        {tests && tests.total > 0 ? (
          <span
            className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] leading-4 font-medium text-zinc-400 ring-1 ring-inset ring-white/10"
            title={`${tests.passed} passed, ${tests.failed} failed${tests.skipped ? `, ${tests.skipped} skipped` : ""}`}
          >
            <span className="text-emerald-300">{tests.passed} ✓</span>
            {tests.failed > 0 ? <span className="text-rose-300">{tests.failed} ✗</span> : null}
          </span>
        ) : null}
        {summary.taskCount > 0 ? (
          <span className="text-[10.5px] text-zinc-500">
            {summary.taskCount} {summary.taskCount === 1 ? "task" : "tasks"}
          </span>
        ) : null}
      </div>
    </a>
  );
}

function SidebarEmpty() {
  const steps = [ClipboardList, Hammer, ScanSearch, PackageCheck];
  return (
    <div className="mx-2 mt-2 rounded-xl border border-dashed border-zinc-800 px-4 py-6 text-center">
      <div className="flex items-center justify-center gap-1" aria-hidden>
        {steps.map((Icon, index) => (
          <span key={index} className="flex items-center gap-1">
            <span
              className={cx(
                "grid size-7 place-items-center rounded-lg ring-1 ring-inset",
                index === steps.length - 1
                  ? "bg-amber-400/10 text-amber-300 ring-amber-400/25"
                  : "bg-zinc-900 text-zinc-500 ring-white/10",
              )}
            >
              <Icon className="size-3.5" />
            </span>
            {index < steps.length - 1 ? <ChevronRight className="size-3 text-zinc-700" /> : null}
          </span>
        ))}
      </div>
      <p className="mt-4 text-[13px] font-medium text-zinc-300">No work orders yet.</p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">Pick a template to watch the factory build something.</p>
    </div>
  );
}
