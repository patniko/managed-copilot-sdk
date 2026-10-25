import type { OperatorOverview, OperatorView } from "@managed-copilot/protocol/operator";
import type { LucideIcon } from "lucide-react";
import { Boxes, CalendarClock, Cable, CircleX, LayoutDashboard, Layers, ListChecks, Logs, MessagesSquare, Radio, ScrollText, Server, TriangleAlert, Users, Webhook, X } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { cx } from "../../lib/cx.js";
import { useOverview } from "../../lib/resources.js";
import { hrefs, viewHref } from "../../lib/routes.js";
import { healthMeta } from "../../lib/status.js";
import { worseTone, type Tone } from "../../lib/tone.js";
import { IconButton } from "../ui/Button.js";
import { CountBadge } from "../ui/Chip.js";
import { Link } from "../ui/Link.js";

interface NavItem {
  readonly view: OperatorView;
  readonly label: string;
  readonly icon: LucideIcon;
}

const GROUPS: readonly { readonly label: string; readonly items: readonly NavItem[] }[] = [
  {
    label: "Control plane",
    items: [
      { view: "overview", label: "Overview", icon: LayoutDashboard },
      { view: "infrastructure", label: "Infrastructure", icon: Server },
      { view: "environments", label: "Environments", icon: Layers },
      { view: "audit", label: "Audit", icon: ScrollText },
    ],
  },
  {
    label: "Data plane",
    items: [
      { view: "sessions", label: "Sessions", icon: MessagesSquare },
      { view: "connections", label: "Connections", icon: Cable },
      { view: "sandboxes", label: "Sandboxes", icon: Boxes },
      { view: "schedules", label: "Schedules", icon: CalendarClock },
      { view: "webhooks", label: "Webhooks", icon: Webhook },
      { view: "actions", label: "Actions", icon: ListChecks },
      { view: "events", label: "Events", icon: Radio },
      { view: "logs", label: "Logs", icon: Logs },
      { view: "accounts", label: "Accounts", icon: Users },
    ],
  },
];

interface Badge {
  readonly value: number;
  readonly tone: Tone;
  readonly label: string;
}

/** Count badges from the overview (no extra requests). */
function badgeFor(view: OperatorView, overview: OperatorOverview | undefined): Badge | undefined {
  if (!overview) return undefined;
  const counts = overview.counts;
  switch (view) {
    case "overview": {
      const errors = overview.attention.filter((item) => item.severity === "error").length;
      const total = overview.attention.length;
      return total > 0 ? { value: total, tone: errors > 0 ? "danger" : "warning", label: `${total} need attention` } : undefined;
    }
    case "sessions":
      return { value: counts.sessions.total, tone: "neutral", label: `sessions, ${counts.sessions.live} live` };
    case "connections":
      return { value: counts.connections.sdk + counts.connections.cli, tone: "neutral", label: "connected clients" };
    case "sandboxes":
      return { value: counts.sandboxes.total, tone: "neutral", label: "sandboxes" };
    case "schedules":
      return counts.schedules.active > 0 ? { value: counts.schedules.active, tone: "neutral", label: "active schedules" } : undefined;
    case "webhooks":
      return counts.webhooks.failed > 0
        ? { value: counts.webhooks.failed, tone: "danger", label: "failed deliveries" }
        : counts.webhooks.pending > 0
          ? { value: counts.webhooks.pending, tone: "neutral", label: "pending deliveries" }
          : undefined;
    case "actions":
      return counts.actions.needsReconciliation > 0
        ? { value: counts.actions.needsReconciliation, tone: "danger", label: "actions need reconciliation" }
        : counts.actions.open > 0
          ? { value: counts.actions.open, tone: "warning", label: "open actions" }
          : undefined;
    case "accounts":
      return { value: counts.accounts, tone: "neutral", label: "accounts" };
    default:
      return undefined;
  }
}

/** Worst component health, shown as a dot next to Infrastructure. */
function infrastructureTone(overview: OperatorOverview | undefined): { readonly tone: Tone; readonly label: string } | undefined {
  if (!overview || overview.health.length === 0) return undefined;
  let tone: Tone = "success";
  for (const component of overview.health) {
    const meta = healthMeta(component.status);
    if (meta.tone === "danger" || meta.tone === "warning") tone = worseTone(tone, meta.tone);
  }
  const label = tone === "danger" ? "A component is unavailable" : tone === "warning" ? "A component is degraded" : "All components healthy";
  return { tone, label };
}

export interface SidebarProps {
  readonly active: OperatorView | undefined;
  readonly drawerOpen: boolean;
  readonly onCloseDrawer: () => void;
}

export function Sidebar({ active, drawerOpen, onCloseDrawer }: SidebarProps) {
  return (
    <>
      <aside className="hidden w-60 shrink-0 border-r border-zinc-800/80 bg-zinc-950 lg:block" aria-label="Console navigation">
        <SidebarContent active={active} />
      </aside>
      {drawerOpen ? <Drawer active={active} onClose={onCloseDrawer} /> : null}
    </>
  );
}

/** Narrow screens: the navigation as a native modal dialog (focus stays inside; Escape closes; focus returns). */
function Drawer({ active, onClose }: { readonly active: OperatorView | undefined; readonly onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!element.open) element.showModal();
    return () => {
      if (element.open) element.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label="Console navigation"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-y-0 right-auto left-0 m-0 hidden h-dvh max-h-dvh w-[min(17rem,88vw)] max-w-none animate-slide-in flex-col border-r border-zinc-800 bg-zinc-950 p-0 text-zinc-300 shadow-2xl shadow-black/60 backdrop:animate-fade-in open:flex"
    >
      <div className="flex justify-end p-2">
        <IconButton icon={X} label="Close navigation" onClick={onClose} />
      </div>
      <SidebarContent active={active} onNavigate={onClose} />
    </dialog>
  );
}

function SidebarContent({ active, onNavigate }: { readonly active: OperatorView | undefined; readonly onNavigate?: () => void }) {
  const overview = useOverview().data;
  const infra = infrastructureTone(overview);
  return (
    <nav aria-label="Console" className="h-full overflow-y-auto px-2 py-4">
      {GROUPS.map((group) => (
        <div key={group.label} className="mb-5">
          <h2 className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">{group.label}</h2>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const selected = item.view === active;
              const badge = badgeFor(item.view, overview);
              const Icon = item.icon;
              return (
                <li key={item.view}>
                  <Link
                    href={item.view === "overview" ? hrefs.overview() : viewHref(item.view)}
                    onClick={onNavigate}
                    aria-current={selected ? "page" : undefined}
                    className={cx(
                      "group relative flex h-8 items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium transition-colors",
                      selected ? "bg-zinc-800/80 text-zinc-50 ring-1 ring-inset ring-white/10" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100",
                    )}
                  >
                    {selected ? <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-amber-400" aria-hidden /> : null}
                    <Icon className={cx("size-4 shrink-0", selected ? "text-amber-300" : "text-zinc-500 group-hover:text-zinc-300")} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.view === "infrastructure" && infra && infra.tone !== "success" ? (
                      <span className="inline-flex items-center" title={infra.label}>
                        {infra.tone === "danger" ? <CircleX className="size-3.5 text-rose-400" aria-hidden /> : <TriangleAlert className="size-3.5 text-amber-400" aria-hidden />}
                        <span className="sr-only">{infra.label}</span>
                      </span>
                    ) : null}
                    {badge && badge.value > 0 ? <CountBadge value={badge.value} tone={badge.tone} label={badge.label} /> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
