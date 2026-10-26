import type { AttentionItem, ComponentHealth, OperatorComponentId, OperatorOverview, OperatorView, TrafficCounter } from "@managed-copilot/protocol/operator";
import {
  ArrowRightIcon,
  BroadcastIcon,
  CalendarIcon,
  CheckCircleIcon,
  ChecklistIcon,
  CommentDiscussionIcon,
  CpuIcon,
  DatabaseIcon,
  GlobeIcon,
  PeopleIcon,
  PlugIcon,
  RocketIcon,
  SandboxIcon,
  ServerIcon,
  ShieldLockIcon,
  WebhookIcon,
  type Icon,
} from "@primer/octicons-react";
import { useMemo, type ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { mergeEvents } from "../lib/feed.js";
import { formatCompact, formatDateTime, formatIso, formatNumber, pluralize } from "../lib/format.js";
import { sortAttention, TRAFFIC_COUNTERS, TRAFFIC_ORDER } from "../lib/overview.js";
import { useEventHistory, useOverview } from "../lib/resources.js";
import { hrefs, viewHref } from "../lib/routes.js";
import { eventTypeMeta, healthMeta, sandboxStateMeta, sessionStateMeta, severityMeta, type StatusMeta } from "../lib/status.js";
import { MAX_LIVE_EVENTS, useStreamData } from "../lib/stream.js";
import { TONE_BORDER, TONE_TEXT, type Tone } from "../lib/tone.js";
import { AccountLabel, EnvironmentLink, RelativeTime, SessionLink } from "../components/common/Identity.js";
import { Page, PollContent } from "../components/layout/Page.js";
import { buttonClass } from "../components/ui/Button.js";
import { Card, Field, FieldGrid } from "../components/ui/Card.js";
import { Chip, StatusBadge } from "../components/ui/Chip.js";
import { CopyButton } from "../components/ui/CopyButton.js";
import { Callout, EmptyState, Skeleton, SkeletonLines } from "../components/ui/Feedback.js";
import { Link } from "../components/ui/Link.js";
import { Sparkline, type ChartColor } from "../components/ui/Sparkline.js";

export const COMPONENT_ICONS: Readonly<Record<OperatorComponentId, Icon>> = {
  gateway: GlobeIcon,
  runtime: CpuIcon,
  sandboxes: SandboxIcon,
  egress: ShieldLockIcon,
  scheduler: CalendarIcon,
  webhooks: WebhookIcon,
  storage: DatabaseIcon,
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

/** One Primer display color per traffic chart, so the grid reads at a glance. */
const TRAFFIC_COLORS: Readonly<Record<TrafficCounter, ChartColor>> = {
  "http.requests": "blue",
  "http.errors": "red",
  "rpc.requests": "indigo",
  "rpc.notifications": "purple",
  "connections.opened": "teal",
  "sessions.created": "green",
  "events.published": "orange",
  "inference.requests": "pink",
};

export function OverviewView() {
  const poll = useOverview();
  return (
    <Page title="Overview" documentTitle="Overview" description="Health, attention items, and activity across the whole deployment." poll={poll}>
      <PollContent poll={poll} skeleton={<OverviewSkeleton />} errorTitle="Couldn't load the overview" boxed>
        {(overview) => <OverviewBody overview={overview} />}
      </PollContent>
    </Page>
  );
}

function OverviewBody({ overview }: { readonly overview: OperatorOverview }) {
  return (
    <div className="space-y-8">
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
      <section aria-labelledby="events-heading">
        <SectionHeading id="events-heading" action={<ViewLink href={hrefs.view("events")}>All events</ViewLink>}>
          Recent events
        </SectionHeading>
        <RecentEvents />
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
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 id={id} className="text-base font-semibold">
        {children}
      </h2>
      {hint ? <span className="text-xs text-fg-muted">{hint}</span> : null}
      {action ? <div className="ml-auto">{action}</div> : null}
    </div>
  );
}

function ViewLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <Link href={href} className="Link inline-flex items-center gap-1 text-sm">
      {children}
      <ArrowRightIcon size={16} />
    </Link>
  );
}

function AttentionList({ items }: { readonly items: readonly AttentionItem[] }) {
  if (items.length === 0) {
    return (
      <Callout tone="success" icon={CheckCircleIcon} title="Nothing needs attention">
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
      <ul>
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
  const SeverityIcon = meta.icon;
  return (
    <li className="Box-row Box-row--hover-gray flex flex-wrap items-start gap-x-3 gap-y-2">
      <SeverityIcon size={16} className={cx("mt-0.5", TONE_TEXT[meta.tone])} />
      <div className="min-w-0 flex-1 basis-60">
        <p className="font-semibold">{item.title}</p>
        {item.detail ? <p className="mt-0.5 text-fg-muted">{item.detail}</p> : null}
        <p className="mt-1 text-xs text-fg-muted">
          <span className={cx("font-semibold", TONE_TEXT[meta.tone])}>{meta.label}</span>
          {item.at ? (
            <>
              {" "}
              · <RelativeTime value={item.at} />
            </>
          ) : null}
        </p>
      </div>
      {target && label ? (
        <Link href={viewHref(target.view, target.id)} className={buttonClass("default", "sm", "ml-7 shrink-0 sm:ml-0")}>
          {label}
          <ArrowRightIcon size={16} />
        </Link>
      ) : null}
    </li>
  );
}

const RECENT_EVENTS = 6;

/** The newest platform events, as rows like GitHub's audit log: event, actor, target, and time. */
function RecentEvents() {
  const history = useEventHistory(undefined);
  const live = useStreamData().events;
  const events = useMemo(() => mergeEvents([history.data ?? [], live], MAX_LIVE_EVENTS).slice(-RECENT_EVENTS).reverse(), [history.data, live]);
  if (events.length === 0) {
    if (history.data === undefined && history.loading) {
      return (
        <div className="Box p-4" role="status" aria-label="Loading recent events">
          <SkeletonLines lines={3} />
        </div>
      );
    }
    return (
      <div className="Box">
        {history.error ? (
          <EmptyState icon={BroadcastIcon} title="Couldn't load recent events" compact>
            {history.error.message} New events still appear here live.
          </EmptyState>
        ) : (
          <EmptyState icon={BroadcastIcon} title="No events yet" compact>
            Platform events of every owner appear here as they happen.
          </EmptyState>
        )}
      </div>
    );
  }
  return (
    <ul className="Box" aria-label="Recent events, newest first">
      {events.map((event) => {
        const meta = eventTypeMeta(event.type);
        const EventIcon = meta.icon;
        return (
          <li key={event.id} className="Box-row Box-row--hover-gray flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
            <EventIcon size={16} className={TONE_TEXT[meta.tone]} />
            <span className="font-semibold">{meta.label}</span>
            <AccountLabel account={event.owner} size="xs" />
            {event.sessionId ? <SessionLink id={event.sessionId} /> : null}
            {event.environment ? <EnvironmentLink name={event.environment} /> : null}
            <RelativeTime value={event.createdAt} className="ml-auto text-xs text-fg-muted" />
          </li>
        );
      })}
    </ul>
  );
}

export function HealthGrid({ health, onSelect }: { readonly health: readonly ComponentHealth[]; readonly onSelect?: (id: OperatorComponentId) => void }) {
  if (health.length === 0) return <p className="text-fg-muted">The gateway reported no components.</p>;
  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
  const ComponentIcon = COMPONENT_ICONS[component.id] ?? ServerIcon;
  const unhealthy = component.status === "degraded" || component.status === "unavailable";
  const body = (
    <>
      <div className="flex items-center gap-2">
        <ComponentIcon size={16} className={TONE_TEXT[meta.tone]} />
        <span className="min-w-0 flex-1 truncate font-semibold" title={component.name}>
          {component.name}
        </span>
      </div>
      <div className="mt-2">
        <StatusBadge meta={meta} />
      </div>
      <p className="mt-2 break-words text-fg-muted">{component.summary}</p>
      {component.detail && component.status !== "healthy" ? <p className={cx("mt-2 break-words", unhealthy ? TONE_TEXT[meta.tone] : "text-fg-muted")}>{component.detail}</p> : null}
      {component.since ? (
        <p className="mt-2 text-xs text-fg-muted">
          {meta.label} since <RelativeTime value={component.since} />
        </p>
      ) : null}
    </>
  );
  const classes = cx("Box block h-full p-4 text-left", unhealthy && TONE_BORDER[meta.tone]);
  if (onSelect) {
    return (
      <button type="button" onClick={() => onSelect(component.id)} className={cx(classes, "flex w-full flex-col items-stretch justify-start transition-colors duration-150 hover:bg-canvas-muted")}>
        {body}
      </button>
    );
  }
  return <div className={classes}>{body}</div>;
}

interface TileProps {
  readonly label: string;
  readonly icon: Icon;
  readonly value: number;
  readonly href: string;
  readonly sub?: ReactNode;
  readonly tone?: Tone;
  readonly children?: ReactNode;
}

/** An Insights-style number: a 12px muted label, a large semibold count, and its breakdown. */
function CountTile({ label, icon: TileIcon, value, href, sub, tone, children }: TileProps) {
  return (
    <Link href={href} className="Box group flex h-full flex-col p-4 transition-colors duration-150 hover:bg-canvas-muted">
      <span className="flex items-center gap-1.5 text-xs text-fg-muted">
        <TileIcon size={16} />
        {label}
        <ArrowRightIcon size={16} className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      </span>
      <span className={cx("mt-1 text-2xl font-semibold tabular-nums", tone ? TONE_TEXT[tone] : "text-fg")} title={formatNumber(value)}>
        {formatCompact(value)}
      </span>
      {sub ? <span className="text-xs text-fg-muted">{sub}</span> : null}
      {children ? <span className="mt-3 flex flex-wrap gap-1">{children}</span> : null}
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
          <StatusBadge key={key} meta={metaFor(key)} title={`${metaFor(key).label}: ${formatNumber(count)}`}>
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
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <CountTile label="Sessions" icon={CommentDiscussionIcon} value={counts.sessions.total} href={hrefs.view("sessions")} sub={`${formatNumber(counts.sessions.live)} live${placements ? ` · ${placements}` : ""}`}>
        <Breakdown entries={counts.sessions.byState} metaFor={sessionStateMeta} />
      </CountTile>
      <CountTile
        label="Connections"
        icon={PlugIcon}
        value={counts.connections.sdk + counts.connections.cli}
        href={hrefs.view("connections")}
        sub={`${formatNumber(counts.connections.sdk)} SDK · ${formatNumber(counts.connections.cli)} Copilot CLI`}
      />
      <CountTile label="Sandboxes" icon={SandboxIcon} value={counts.sandboxes.total} href={hrefs.view("sandboxes")}>
        <Breakdown entries={counts.sandboxes.byState} metaFor={sandboxStateMeta} />
      </CountTile>
      <CountTile label="Schedules" icon={CalendarIcon} value={counts.schedules.active} href={hrefs.view("schedules")} sub={`active · ${formatNumber(counts.schedules.paused)} paused`} />
      <CountTile
        label="Open actions"
        icon={ChecklistIcon}
        value={counts.actions.open}
        href={hrefs.view("actions", counts.actions.needsReconciliation > 0 ? { state: "attention" } : undefined)}
        tone={counts.actions.needsReconciliation > 0 ? "danger" : undefined}
        sub={
          counts.actions.needsReconciliation > 0 ? (
            <span className="font-semibold text-fg-danger">{pluralize(counts.actions.needsReconciliation, "needs", "need")} reconciliation</span>
          ) : (
            "None need reconciliation"
          )
        }
      />
      <CountTile
        label="Webhook deliveries"
        icon={WebhookIcon}
        value={counts.webhooks.pending}
        href={hrefs.view("webhooks", counts.webhooks.failed > 0 ? { state: "failed" } : undefined)}
        sub={counts.webhooks.failed > 0 ? <span className="font-semibold text-fg-danger">pending · {formatNumber(counts.webhooks.failed)} failed</span> : "pending · none failed"}
      />
      <CountTile label="Accounts" icon={PeopleIcon} value={counts.accounts} href={hrefs.view("accounts")} sub="seen by this deployment" />
    </div>
  );
}

function TrafficGrid({ overview }: { readonly overview: OperatorOverview }) {
  const series = TRAFFIC_ORDER.filter((counter) => overview.traffic[counter] !== undefined);
  if (series.length === 0) {
    return (
      <div className="Box blankslate blankslate--sm">
        <p className="blankslate-description">No traffic recorded yet.</p>
      </div>
    );
  }
  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {series.map((counter) => {
        const data = overview.traffic[counter];
        if (!data) return null;
        const info = TRAFFIC_COUNTERS[counter];
        const errors = counter === "http.errors";
        return (
          <li key={counter} className="Box min-w-0 p-4">
            <h3 className="text-xs text-fg-muted" title={info.description}>
              {info.label}
            </h3>
            <p className={cx("mt-1 text-xl font-semibold tabular-nums", errors && data.total > 0 ? "text-fg-danger" : "text-fg")} title={`${formatNumber(data.total)} in the last hour`}>
              {formatCompact(data.total)}
            </p>
            <div className="mt-2">
              <Sparkline label={info.label} unit={info.unit} series={data} generatedAt={overview.generatedAt} color={errors && data.total === 0 ? "gray" : TRAFFIC_COLORS[counter]} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function DeploymentCard({ deployment }: { readonly deployment: OperatorOverview["deployment"] }) {
  return (
    <Card title="Deployment" icon={RocketIcon} description={`${deployment.name} · ${deployment.mode === "azure" ? "Azure" : "local"}`}>
      <FieldGrid columns={4}>
        <Field label="Name">{deployment.name}</Field>
        <Field label="Mode">
          <Chip mono tone={deployment.mode === "azure" ? "accent" : "plain"}>
            {deployment.mode}
          </Chip>
        </Field>
        <Field label="Version" mono>
          {deployment.version}
        </Field>
        <Field label="Started">
          <span title={formatIso(deployment.startedAt)}>
            <RelativeTime value={deployment.startedAt} /> <span className="text-fg-muted">· {formatDateTime(deployment.startedAt)}</span>
          </span>
        </Field>
        <Field label="Public URL" className="sm:col-span-2">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate font-mono text-xs" title={deployment.publicUrl}>
              {deployment.publicUrl}
            </span>
            <CopyButton text={deployment.publicUrl} label="Copy public URL" className="size-6" />
          </span>
        </Field>
        <Field label="Copilot SDK" mono>
          {deployment.sdk.copilotSdk}
        </Field>
        <Field label="Copilot runtime" mono>
          {deployment.sdk.copilotRuntime}
        </Field>
        <Field label="Capabilities" wide>
          {deployment.capabilities.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Capabilities">
              {deployment.capabilities.map((capability) => (
                <li key={capability}>
                  <Chip mono>{capability}</Chip>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-fg-muted">None qualified yet.</span>
          )}
        </Field>
      </FieldGrid>
    </Card>
  );
}

function TileSkeleton({ tall = false }: { readonly tall?: boolean }) {
  return (
    <div className={cx("Box p-4", tall ? "h-32" : "h-28")}>
      <SkeletonLines lines={1} className="w-1/2" />
      <Skeleton className="mt-2 h-8 w-16" />
      <SkeletonLines lines={1} className="mt-2 w-3/4" />
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-8" role="status" aria-label="Loading the overview">
      <div className="Box p-4">
        <SkeletonLines lines={2} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <TileSkeleton key={index} />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 7 }, (_, index) => (
          <TileSkeleton key={index} tall />
        ))}
      </div>
    </div>
  );
}
