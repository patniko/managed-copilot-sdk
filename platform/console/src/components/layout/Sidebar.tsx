import type { OperatorOverview, OperatorView } from "@managed-copilot/protocol/operator";
import {
  AlertIcon,
  BroadcastIcon,
  CalendarIcon,
  ChecklistIcon,
  HomeIcon,
  LogIcon,
  MarkGithubIcon,
  PeopleIcon,
  PlugIcon,
  SandboxIcon,
  ServerIcon,
  ShieldCheckIcon,
  StackIcon,
  WebhookIcon,
  CommentDiscussionIcon,
  XCircleFillIcon,
  XIcon,
  type Icon,
} from "@primer/octicons-react";
import { Fragment, useId, useLayoutEffect, useRef } from "react";
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
  readonly icon: Icon;
}

const GROUPS: readonly { readonly label: string; readonly items: readonly NavItem[] }[] = [
  {
    label: "Control plane",
    items: [
      { view: "overview", label: "Overview", icon: HomeIcon },
      { view: "infrastructure", label: "Infrastructure", icon: ServerIcon },
      { view: "environments", label: "Environments", icon: StackIcon },
      { view: "audit", label: "Audit log", icon: ShieldCheckIcon },
    ],
  },
  {
    label: "Data plane",
    items: [
      { view: "sessions", label: "Sessions", icon: CommentDiscussionIcon },
      { view: "connections", label: "Connections", icon: PlugIcon },
      { view: "sandboxes", label: "Sandboxes", icon: SandboxIcon },
      { view: "schedules", label: "Schedules", icon: CalendarIcon },
      { view: "webhooks", label: "Webhooks", icon: WebhookIcon },
      { view: "actions", label: "Actions", icon: ChecklistIcon },
      { view: "events", label: "Events", icon: BroadcastIcon },
      { view: "logs", label: "Logs", icon: LogIcon },
      { view: "accounts", label: "Accounts", icon: PeopleIcon },
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
      return total > 0 ? { value: total, tone: errors > 0 ? "danger" : "attention", label: `${total} need attention` } : undefined;
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
          ? { value: counts.actions.open, tone: "attention", label: "open actions" }
          : undefined;
    case "accounts":
      return { value: counts.accounts, tone: "neutral", label: "accounts" };
    default:
      return undefined;
  }
}

/** Worst component health, shown as an alert Octicon next to Infrastructure. */
function infrastructureTone(overview: OperatorOverview | undefined): { readonly tone: Tone; readonly label: string } | undefined {
  if (!overview || overview.health.length === 0) return undefined;
  let tone: Tone = "success";
  for (const component of overview.health) {
    const meta = healthMeta(component.status);
    if (meta.tone === "danger" || meta.tone === "attention") tone = worseTone(tone, meta.tone);
  }
  const label = tone === "danger" ? "A component is unavailable" : tone === "attention" ? "A component is degraded" : "All components healthy";
  return { tone, label };
}

export interface SidebarProps {
  readonly active: OperatorView | undefined;
  readonly drawerOpen: boolean;
  readonly onCloseDrawer: () => void;
}

/** The console's navigation: a GitHub settings-style `NavList` beside the content, or a drawer on small screens. */
export function Sidebar({ active, drawerOpen, onCloseDrawer }: SidebarProps) {
  return (
    <>
      <aside className="hidden w-64 shrink-0 overflow-y-auto border-r border-line bg-canvas lg:block" aria-label="Console navigation">
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
      className="fixed inset-y-0 right-auto left-0 m-0 hidden h-dvh max-h-dvh w-[min(20rem,85vw)] max-w-none animate-slide-in-left flex-col overflow-hidden rounded-r-lg bg-canvas-overlay p-0 text-fg shadow-xl backdrop:animate-fade-in open:flex"
    >
      <div className="flex shrink-0 items-center gap-3 px-4 pt-4 pb-2">
        <MarkGithubIcon size={32} />
        <span className="min-w-0 flex-1 truncate font-semibold">Console</span>
        <IconButton icon={XIcon} label="Close navigation" onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SidebarContent active={active} onNavigate={onClose} />
      </div>
    </dialog>
  );
}

function SidebarContent({ active, onNavigate }: { readonly active: OperatorView | undefined; readonly onNavigate?: () => void }) {
  const overview = useOverview().data;
  const infra = infrastructureTone(overview);
  const baseId = useId();
  return (
    <nav aria-label="Console" className="px-4 py-3">
      {GROUPS.map((group, groupIndex) => {
        const headingId = `${baseId}-${groupIndex}`;
        return (
          <Fragment key={group.label}>
            {groupIndex > 0 ? <hr className="NavList-divider" /> : null}
            <h2 id={headingId} className="NavList-groupHeading mt-0">
              {group.label}
            </h2>
            <ul className="NavList" aria-labelledby={headingId}>
              {group.items.map((item) => {
                const selected = item.view === active;
                const badge = badgeFor(item.view, overview);
                const ItemIcon = item.icon;
                return (
                  <li key={item.view}>
                    <Link
                      href={item.view === "overview" ? hrefs.overview() : viewHref(item.view)}
                      onClick={onNavigate}
                      aria-current={selected ? "page" : undefined}
                      className="NavList-item"
                    >
                      <ItemIcon size={16} />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.view === "infrastructure" && infra && infra.tone !== "success" ? (
                        <span className="inline-flex items-center" title={infra.label}>
                          {infra.tone === "danger" ? <XCircleFillIcon size={16} className="text-fg-danger" /> : <AlertIcon size={16} className="text-fg-attention" />}
                          <span className="sr-only">{infra.label}</span>
                        </span>
                      ) : null}
                      {badge && badge.value > 0 ? <CountBadge value={badge.value} tone={badge.tone} label={badge.label} /> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Fragment>
        );
      })}
    </nav>
  );
}
