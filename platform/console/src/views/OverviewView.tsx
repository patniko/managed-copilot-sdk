import type { AttentionItem, ComponentHealth, OperatorComponentId, OperatorOverview, OperatorView } from "@managed-copilot/protocol/operator";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Boxes,
  Cable,
  CalendarClock,
  CircleCheck,
  Cpu,
  Database,
  GlobeLock,
  LayoutDashboard,
  ListChecks,
  MessagesSquare,
  Network,
  Rocket,
  Users,
  Webhook,
} from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { formatCompact, formatDateTime, formatIso, formatNumber, pluralize } from "../lib/format.js";
import { sortAttention, TRAFFIC_COUNTERS, TRAFFIC_ORDER } from "../lib/overview.js";
import { useOverview } from "../lib/resources.js";
import { hrefs, viewHref } from "../lib/routes.js";
import { healthMeta, sandboxStateMeta, sessionStateMeta, severityMeta, type StatusMeta } from "../lib/status.js";
import { TONE_TEXT, type Tone } from "../lib/tone.js";
import { RelativeTime } from "../components/common/Identity.js";
import { Page, PollContent } from "../components/layout/Page.js";
import { Card } from "../components/ui/Card.js";
import { Chip, StatusBadge } from "../components/ui/Chip.js";
import { CopyButton } from "../components/ui/CopyButton.js";
import { Callout, Skeleton } from "../components/ui/Feedback.js";
import { Link } from "../components/ui/Link.js";
import { Sparkline } from "../components/ui/Sparkline.js";

export const COMPONENT_ICONS: Readonly<Record<OperatorComponentId, LucideIcon>> = {
  gateway: Network,
  runtime: Cpu,
  sandboxes: Boxes,
  egress: GlobeLock,
  scheduler: CalendarClock,
  webhooks: Webhook,
  storage: Database,
};

const VIEW_NAMES: Readonly<Record<OperatorView, string>> = {
  overview: "overview",
  infrastructure: "infrastructure",
  environments: "environments",
  sessions: "sessions",
  connections: "connections",
  sandboxes: "sandboxes",
  schedules: "schedules",
  webhooks: "webhooks",
  actions: "actions",
  accounts: "accounts",
  events: "events",
  logs: "logs",
  audit: "audit log",
};

export function OverviewView() {
  const poll = useOverview();
  return (
    <Page
      title="Overview"
      documentTitle="Overview"
      icon={LayoutDashboard}
      description="Health, attention items, and activity across the whole deployment."
      poll={poll}
    >
      <PollContent poll={poll} skeleton={<OverviewSkeleton />} errorTitle="Couldn't load the overview">
        {(overview) => <OverviewBody overview={overview} />}
      </PollContent>
    </Page>
  );
}

function OverviewBody({ overview }: { readonly overview: OperatorOverview }) {
  return (
    <div className="space-y-6">
      <AttentionList items={overview.attention} />
      <section aria-labelledby="health-heading">
        <SectionHeading id="health-heading" action={<ViewLink href={hrefs.view("infrastructure")}>Infrastructure</ViewLink>}>
          Health
        </SectionHeading>
        <HealthGrid health={overview.health} />
      </section>
      <section aria-labelledby="activity-heading">
        <SectionHeading id="activity-heading">Activity</SectionHeading>
        <CountTiles overview={overview} />
      </section>
      <section aria-labelledby="traffic-heading">
        <SectionHeading id="traffic-heading" hint="Last hour, per minute">
          Traffic
        </SectionHeading>
        <TrafficGrid overview={overview} />
      </section>
      <DeploymentCard deployment={overview.deployment} />
    </div>
  );
}

function SectionHeading({ id, children, hint, action }: { readonly id: string; readonly children: ReactNode; readonly hint?: string; readonly action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline gap-3">
      <h2 id={id} className="text-[15px] font-semibold text-zinc-100">
        {children}
      </h2>
      {hint ? <span className="text-[12px] text-zinc-500">{hint}</span> : null}
      {action ? <div className="ml-auto">{action}</div> : null}
    </div>
  );
}

function ViewLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-zinc-400 hover:text-zinc-100">
      {children}
      <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  );
}

function AttentionList({ items }: { readonly items: readonly AttentionItem[] }) {
  if (items.length === 0) {
    return (
      <Callout tone="success" icon={CircleCheck} title="Nothing needs attention">
        The gateway reports nothing that needs an operator right now.
      </Callout>
    );
  }
  const sorted = sortAttention(items);
  const errors = items.filter((item) => item.severity === "error").length;
  return (
    <Card
      title={`${pluralize(items.length, "item")} need${items.length === 1 ? "s" : ""} attention`}
      description={errors > 0 ? `${pluralize(errors, "error")} first.` : undefined}
      padded={false}
    >
      <ul className="divide-y divide-zinc-800/70">
        {sorted.map((item) => (
          <AttentionRow key={item.id} item={item} />
        ))}
      </ul>
    </Card>
  );
}

function AttentionRow({ item }: { readonly item: AttentionItem }) {
  const meta = severityMeta(item.severity);
  const target = item.target;
  const label = target ? (target.id && (target.view === "sessions" || target.view === "environments") ? `Open ${target.view === "sessions" ? "session" : "environment"}` : `View ${VIEW_NAMES[target.view] ?? target.view}`) : undefined;
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
      <StatusBadge meta={meta} size="xs" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium text-zinc-100">{item.title}</p>
        {item.detail ? <p className="mt-0.5 text-[13px] leading-relaxed text-zinc-400">{item.detail}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-[12px] text-zinc-500">
        {item.at ? <RelativeTime value={item.at} /> : null}
        {target && label ? (
          <Link
            href={viewHref(target.view, target.id)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-zinc-200 ring-1 ring-inset ring-white/10 hover:bg-zinc-800"
          >
            {label}
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>
    </li>
  );
}

export function HealthGrid({ health, onSelect }: { readonly health: readonly ComponentHealth[]; readonly onSelect?: (id: OperatorComponentId) => void }) {
  if (health.length === 0) return <p className="text-[13px] text-zinc-500">The gateway reported no components.</p>;
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {health.map((component) => (
        <li key={component.id} className="min-w-0">
          <HealthCard component={component} onSelect={onSelect} />
        </li>
      ))}
    </ul>
  );
}

function HealthCard({ component, onSelect }: { readonly component: ComponentHealth; readonly onSelect?: (id: OperatorComponentId) => void }) {
  const meta = healthMeta(component.status);
  const Icon = COMPONENT_ICONS[component.id] ?? Network;
  const unhealthy = component.status === "degraded" || component.status === "unavailable";
  const body = (
    <>
      <div className="flex items-center gap-2.5">
        <Icon className={cx("size-4 shrink-0", TONE_TEXT[meta.tone])} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-zinc-100">{component.name}</span>
        <StatusBadge meta={meta} size="xs" />
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed break-words text-zinc-400">{component.summary}</p>
      {component.detail && component.status !== "healthy" ? (
        <p className={cx("mt-2 text-[12.5px] leading-relaxed break-words", unhealthy ? TONE_TEXT[meta.tone] : "text-zinc-400")}>{component.detail}</p>
      ) : null}
      {component.since ? (
        <p className="mt-2 text-[11.5px] text-zinc-500">
          {meta.label} since <RelativeTime value={component.since} />
        </p>
      ) : null}
    </>
  );
  const classes = cx(
    "block h-full rounded-xl border bg-zinc-900/40 p-3.5 text-left transition-colors",
    component.status === "unavailable" ? "border-rose-400/30" : component.status === "degraded" ? "border-amber-400/30" : "border-zinc-800/80",
  );
  if (onSelect) {
    return (
      <button type="button" onClick={() => onSelect(component.id)} className={cx(classes, "flex w-full flex-col items-stretch justify-start hover:border-zinc-700 hover:bg-zinc-900/70")}>
        {body}
      </button>
    );
  }
  return <div className={classes}>{body}</div>;
}

interface TileProps {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly value: number;
  readonly href: string;
  readonly sub?: ReactNode;
  readonly tone?: Tone;
  readonly children?: ReactNode;
}

function CountTile({ label, icon: Icon, value, href, sub, tone, children }: TileProps) {
  return (
    <Link href={href} className="group flex h-full flex-col rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5 transition-colors hover:border-zinc-700 hover:bg-zinc-900/70">
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-zinc-400">
        <Icon className="size-4 text-zinc-500 group-hover:text-zinc-300" aria-hidden />
        {label}
        <ArrowRight className="ml-auto size-3.5 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
      </div>
      <p className={cx("mt-2 text-2xl font-semibold tracking-tight tabular", tone ? TONE_TEXT[tone] : "text-zinc-50")} title={formatNumber(value)}>
        {formatCompact(value)}
      </p>
      {sub ? <div className="mt-0.5 text-[12.5px] text-zinc-400">{sub}</div> : null}
      {children ? <div className="mt-2.5 flex flex-wrap gap-1">{children}</div> : null}
    </Link>
  );
}

function Breakdown({ entries, metaFor }: { readonly entries: Readonly<Partial<Record<string, number>>>; readonly metaFor: (key: string) => StatusMeta }) {
  const items = Object.entries(entries).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0);
  if (items.length === 0) return null;
  return (
    <>
      {items
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => (
          <StatusBadge key={key} meta={metaFor(key)} size="xs" title={`${metaFor(key).label}: ${formatNumber(count)}`}>
            {metaFor(key).label} {formatNumber(count)}
          </StatusBadge>
        ))}
    </>
  );
}

function CountTiles({ overview }: { readonly overview: OperatorOverview }) {
  const counts = overview.counts;
  const placements = Object.entries(counts.sessions.byPlacement)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .map(([placement, count]) => `${formatNumber(count)} ${placement}`)
    .join(" · ");
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <CountTile label="Sessions" icon={MessagesSquare} value={counts.sessions.total} href={hrefs.view("sessions")} sub={`${formatNumber(counts.sessions.live)} live${placements ? ` · ${placements}` : ""}`}>
        <Breakdown entries={counts.sessions.byState} metaFor={sessionStateMeta} />
      </CountTile>
      <CountTile
        label="Connections"
        icon={Cable}
        value={counts.connections.sdk + counts.connections.cli}
        href={hrefs.view("connections")}
        sub={`${formatNumber(counts.connections.sdk)} SDK · ${formatNumber(counts.connections.cli)} Copilot CLI`}
      />
      <CountTile label="Sandboxes" icon={Boxes} value={counts.sandboxes.total} href={hrefs.view("sandboxes")}>
        <Breakdown entries={counts.sandboxes.byState} metaFor={sandboxStateMeta} />
      </CountTile>
      <CountTile label="Schedules" icon={CalendarClock} value={counts.schedules.active} href={hrefs.view("schedules")} sub={`active · ${formatNumber(counts.schedules.paused)} paused`} />
      <CountTile
        label="Open actions"
        icon={ListChecks}
        value={counts.actions.open}
        href={hrefs.view("actions", counts.actions.needsReconciliation > 0 ? { state: "attention" } : undefined)}
        tone={counts.actions.needsReconciliation > 0 ? "danger" : undefined}
        sub={
          counts.actions.needsReconciliation > 0 ? (
            <span className="text-rose-300">{pluralize(counts.actions.needsReconciliation, "needs", "need")} reconciliation</span>
          ) : (
            "None need reconciliation"
          )
        }
      />
      <CountTile
        label="Webhook deliveries"
        icon={Webhook}
        value={counts.webhooks.pending}
        href={hrefs.view("webhooks", counts.webhooks.failed > 0 ? { state: "failed" } : undefined)}
        sub={counts.webhooks.failed > 0 ? <span className="text-rose-300">pending · {formatNumber(counts.webhooks.failed)} failed</span> : "pending · none failed"}
      />
      <CountTile label="Accounts" icon={Users} value={counts.accounts} href={hrefs.view("accounts")} sub="seen by this deployment" />
    </div>
  );
}

function TrafficGrid({ overview }: { readonly overview: OperatorOverview }) {
  const series = TRAFFIC_ORDER.filter((counter) => overview.traffic[counter] !== undefined);
  if (series.length === 0) return <p className="rounded-xl border border-dashed border-zinc-800 px-4 py-6 text-center text-[13px] text-zinc-500">No traffic recorded yet.</p>;
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {series.map((counter) => {
        const data = overview.traffic[counter];
        if (!data) return null;
        const info = TRAFFIC_COUNTERS[counter];
        const tone: Tone = counter === "http.errors" ? (data.total > 0 ? "danger" : "neutral") : "active";
        return (
          <li key={counter} className="min-w-0 rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="truncate text-[12.5px] font-medium text-zinc-400" title={info.description}>
                {info.label}
              </h3>
              <span className={cx("text-lg font-semibold tabular", counter === "http.errors" && data.total > 0 ? "text-rose-300" : "text-zinc-50")} title={`${formatNumber(data.total)} in the last hour`}>
                {formatCompact(data.total)}
              </span>
            </div>
            <div className="mt-3">
              <Sparkline label={info.label} unit={info.unit} series={data} generatedAt={overview.generatedAt} tone={tone} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function DeploymentCard({ deployment }: { readonly deployment: OperatorOverview["deployment"] }) {
  return (
    <Card title="Deployment" icon={Rocket} description={`${deployment.name} · ${deployment.mode === "azure" ? "Azure" : "local"}`}>
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-500">Name</dt>
          <dd className="mt-1 text-[13px] text-zinc-200">{deployment.name}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-500">Mode</dt>
          <dd className="mt-1">
            <Chip mono tone={deployment.mode === "azure" ? "active" : "plain"}>
              {deployment.mode}
            </Chip>
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-500">Version</dt>
          <dd className="mt-1 font-mono text-[12px] text-zinc-200">{deployment.version}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-500">Started</dt>
          <dd className="mt-1 text-[13px] text-zinc-200" title={formatIso(deployment.startedAt)}>
            <RelativeTime value={deployment.startedAt} /> <span className="text-zinc-500">· {formatDateTime(deployment.startedAt)}</span>
          </dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-500">Public URL</dt>
          <dd className="mt-1 flex min-w-0 items-center gap-1">
            <span className="truncate font-mono text-[12px] text-zinc-200" title={deployment.publicUrl}>
              {deployment.publicUrl}
            </span>
            <CopyButton text={deployment.publicUrl} label="Copy public URL" />
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-500">Copilot SDK</dt>
          <dd className="mt-1 font-mono text-[12px] text-zinc-200">{deployment.sdk.copilotSdk}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-500">Copilot runtime</dt>
          <dd className="mt-1 font-mono text-[12px] text-zinc-200">{deployment.sdk.copilotRuntime}</dd>
        </div>
        <div className="min-w-0 sm:col-span-full">
          <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-500">Capabilities</dt>
          <dd className="mt-1.5">
            {deployment.capabilities.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5" aria-label="Capabilities">
                {deployment.capabilities.map((capability) => (
                  <li key={capability}>
                    <Chip mono>{capability}</Chip>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-[13px] text-zinc-500">None qualified yet.</span>
            )}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading the overview">
      <Skeleton className="h-14 rounded-xl" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-28 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 7 }, (_, index) => (
          <Skeleton key={index} className="h-28 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
