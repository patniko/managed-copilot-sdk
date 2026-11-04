import type {
  EgressStatus,
  GatewayStatus,
  InfraFact,
  OperatorComponentId,
  OperatorInfrastructure,
  SandboxBackendStatus,
  SchedulerStatus,
  SharedRuntimeStatus,
  StorageStatus,
  WebhookWorkerStatus,
} from "@managed-copilot/protocol/operator";
import { CalendarIcon, CpuIcon, DatabaseIcon, GlobeIcon, OrganizationIcon, SandboxIcon, ShieldLockIcon, SyncIcon, WebhookIcon, type Icon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import { getInfrastructure } from "../lib/api.js";
import { cx } from "../lib/cx.js";
import { formatBytes, formatDuration, formatMilliseconds, formatNumber, pluralize } from "../lib/format.js";
import { confirmProbeSandboxes } from "../lib/operatorActions.js";
import { usePoll } from "../lib/poll.js";
import { hrefs } from "../lib/routes.js";
import { deliveryStateMeta, healthMeta, runtimeStateMeta, sandboxStateMeta, type StatusMeta } from "../lib/status.js";
import { ChipList } from "../components/common/Entities.js";
import { RelativeTime } from "../components/common/Identity.js";
import { Page, PollContent } from "../components/layout/Page.js";
import { Button } from "../components/ui/Button.js";
import { Card, Field, FieldGrid } from "../components/ui/Card.js";
import { Chip, StatusBadge } from "../components/ui/Chip.js";
import { CopyButton } from "../components/ui/CopyButton.js";
import { Callout, Code, SectionLabel, Skeleton, SkeletonLines } from "../components/ui/Feedback.js";
import { Link } from "../components/ui/Link.js";
import { HealthGrid } from "./OverviewView.js";

const SECTION_IDS: Partial<Record<OperatorComponentId, string>> = {
  gateway: "infra-gateway",
  runtime: "infra-runtime",
  sandboxes: "infra-sandboxes",
  egress: "infra-egress",
  scheduler: "infra-scheduler",
  webhooks: "infra-webhooks",
  storage: "infra-storage",
};

function scrollToSection(id: OperatorComponentId): void {
  const sectionId = SECTION_IDS[id];
  const element = sectionId ? document.getElementById(sectionId) : null;
  if (!element) return;
  element.scrollIntoView({ behavior: "smooth", block: "start" });
  element.setAttribute("tabindex", "-1");
  element.focus({ preventScroll: true });
}

export function InfrastructureView() {
  const poll = usePoll("infrastructure", getInfrastructure);
  return (
    <Page title="Infrastructure" documentTitle="Infrastructure" description="The gateway, its runtimes, and the services behind them." poll={poll}>
      <PollContent poll={poll} skeleton={<InfrastructureSkeleton />} errorTitle="Couldn't load the infrastructure" boxed>
        {(data) => <InfrastructureBody data={data} />}
      </PollContent>
    </Page>
  );
}

function InfrastructureBody({ data }: { readonly data: OperatorInfrastructure }) {
  const healthOf = (id: OperatorComponentId): StatusMeta | undefined => {
    const component = data.health.find((item) => item.id === id);
    return component ? healthMeta(component.status) : undefined;
  };
  return (
    <div className="space-y-6">
      <HealthGrid health={data.health} onSelect={scrollToSection} />
      <GatewaySection gateway={data.gateway} health={healthOf("gateway")} />
      <RuntimeSection runtime={data.runtime} health={healthOf("runtime")} />
      <SandboxSection backend={data.sandboxes} health={healthOf("sandboxes")} />
      <EgressSection egress={data.egress} health={healthOf("egress")} />
      <div className="grid gap-6 xl:grid-cols-2">
        <SchedulerSection scheduler={data.scheduler} health={healthOf("scheduler")} />
        <WebhookSection worker={data.webhooks} health={healthOf("webhooks")} />
      </div>
      <StorageSection storage={data.storage} health={healthOf("storage")} />
    </div>
  );
}

function HealthBadge({ meta }: { readonly meta: StatusMeta | undefined }) {
  return meta ? <StatusBadge meta={meta} /> : null;
}

function Facts({ facts, title = "Facts" }: { readonly facts: readonly InfraFact[]; readonly title?: string }) {
  if (facts.length === 0) return null;
  return (
    <div className="mt-5 border-t border-line-muted pt-4">
      <SectionLabel className="mb-3">{title}</SectionLabel>
      <FieldGrid columns={3}>
        {facts.map((fact) => (
          <Field key={`${fact.label}:${fact.value}`} label={fact.label} mono={fact.mono}>
            <span className="inline-flex max-w-full items-center gap-1">
              <span className="min-w-0 break-all">{fact.value}</span>
              {fact.mono && fact.value.length > 12 ? <CopyButton text={fact.value} label={`Copy ${fact.label}`} className="size-6" /> : null}
            </span>
          </Field>
        ))}
      </FieldGrid>
    </div>
  );
}

function StateCounts({ counts, metaFor, empty }: { readonly counts: Readonly<Partial<Record<string, number>>>; readonly metaFor: (key: string) => StatusMeta; readonly empty: string }) {
  const entries = Object.entries(counts).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0);
  if (entries.length === 0) return <span className="text-fg-muted">{empty}</span>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {entries.map(([key, count]) => (
        <li key={key}>
          <StatusBadge meta={metaFor(key)}>
            {metaFor(key).label} {formatNumber(count)}
          </StatusBadge>
        </li>
      ))}
    </ul>
  );
}

/** Heap in use of the heap V8 has reserved so far (it grows on demand, so a full bar is not by itself a problem). */
function MemoryBar({ used, total }: { readonly used: number; readonly total: number }) {
  const ratio = total > 0 ? Math.min(1, used / total) : 0;
  return (
    <span className="Progress mt-2 max-w-48" role="img" aria-label={`${Math.round(ratio * 100)}% of the reserved heap in use`}>
      <span className="Progress-item bg-accent-emphasis" style={{ width: `${ratio * 100}%` }} />
    </span>
  );
}

function AccountList({ users, orgs }: { readonly users: readonly string[]; readonly orgs: readonly string[] }) {
  if (users.length === 0 && orgs.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {users.length > 0 ? <ChipList items={users.map((user) => `@${user}`)} label="GitHub users" /> : null}
      {orgs.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="GitHub organizations">
          {orgs.map((org) => (
            <li key={org}>
              <Chip icon={OrganizationIcon} title="Every member of this GitHub organization">
                {org}
              </Chip>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function GatewaySection({ gateway, health }: { readonly gateway: GatewayStatus; readonly health: StatusMeta | undefined }) {
  const { memory, eventLoopDelayMs: delay } = gateway;
  return (
    <Card id="infra-gateway" title="Gateway" icon={GlobeIcon} description={`${gateway.version} · ${gateway.mode} · pid ${gateway.pid}`} actions={<HealthBadge meta={health} />}>
      <FieldGrid columns={4}>
        <Field label="Version" mono>
          {gateway.version}
        </Field>
        <Field label="Mode">
          <Chip mono tone={gateway.mode === "azure" ? "accent" : "plain"}>
            {gateway.mode}
          </Chip>
        </Field>
        <Field label="Started">
          <RelativeTime value={gateway.startedAt} />
        </Field>
        <Field label="Uptime">{formatDuration(gateway.uptimeSeconds)}</Field>
        <Field label="Public URL" wide>
          <span className="inline-flex max-w-full items-center gap-1">
            <span className="min-w-0 truncate font-mono text-xs" title={gateway.publicUrl}>
              {gateway.publicUrl}
            </span>
            <CopyButton text={gateway.publicUrl} label="Copy public URL" className="size-6" />
          </span>
        </Field>
        <Field label="Listening on" mono>
          {gateway.listen}
        </Field>
        <Field label="Process ID" mono>
          {gateway.pid}
        </Field>
        <Field label="Node.js" mono>
          {gateway.node}
        </Field>
        <Field label="Platform" mono>
          {gateway.platform}
        </Field>
        <Field label="Memory (RSS)">{formatBytes(memory.rssBytes)}</Field>
        <Field label="Heap">
          {formatBytes(memory.heapUsedBytes)} of {formatBytes(memory.heapTotalBytes)}
          <MemoryBar used={memory.heapUsedBytes} total={memory.heapTotalBytes} />
        </Field>
        <Field label="Event-loop delay" hint="Over the last minute">
          <span className="tabular-nums">
            p50 {formatMilliseconds(delay.p50)} · p99 <span className={delay.p99 > 200 ? "font-semibold text-fg-attention" : undefined}>{formatMilliseconds(delay.p99)}</span> · max{" "}
            {formatMilliseconds(delay.max)}
          </span>
        </Field>
      </FieldGrid>

      <div className="mt-5 grid gap-x-6 gap-y-5 border-t border-line-muted pt-4 lg:grid-cols-2">
        <div className="min-w-0">
          <SectionLabel>Who may use it</SectionLabel>
          <p className="mt-0.5 mb-2 text-xs text-fg-muted">
            <Code>access</Code> in the AppHost
          </p>
          {gateway.access.open ? (
            <span>Any GitHub account</span>
          ) : gateway.access.githubUsers.length === 0 && gateway.access.githubOrgs.length === 0 ? (
            <span className="text-fg-muted">Nobody is listed.</span>
          ) : (
            <AccountList users={gateway.access.githubUsers} orgs={gateway.access.githubOrgs} />
          )}
        </div>
        <div className="min-w-0">
          <SectionLabel>Who may operate it</SectionLabel>
          <p className="mt-0.5 mb-2 text-xs text-fg-muted">
            <Code>operators</Code> in the AppHost
          </p>
          <AccountList users={gateway.operators.githubUsers} orgs={gateway.operators.githubOrgs} />
          {gateway.operators.localDefault ? (
            <p>Every account that can use this loopback gateway (no operators are named).</p>
          ) : gateway.operators.githubUsers.length === 0 && gateway.operators.githubOrgs.length === 0 ? (
            <p className="text-fg-muted">No operators are named.</p>
          ) : null}
        </div>
        <div className="min-w-0">
          <SectionLabel className="mb-2">Modules</SectionLabel>
          <ChipList items={gateway.modules} mono label="Gateway modules" />
        </div>
        <div className="min-w-0">
          <SectionLabel className="mb-2">Capabilities</SectionLabel>
          <ChipList items={gateway.capabilities} mono label="Capabilities" empty="None qualified yet." />
        </div>
      </div>
      <Facts facts={gateway.facts} title="Hosting" />
    </Card>
  );
}

function RuntimeSection({ runtime, health }: { readonly runtime: SharedRuntimeStatus; readonly health: StatusMeta | undefined }) {
  return (
    <Card
      id="infra-runtime"
      title="Shared runtime"
      icon={CpuIcon}
      description="The stock Copilot runtime that shared sessions run on."
      actions={
        <>
          <StatusBadge meta={runtimeStateMeta(runtime.state)} />
          <HealthBadge meta={health} />
        </>
      }
    >
      {runtime.lastError ? (
        <Callout tone="danger" title="Last error" className="mb-4">
          {runtime.lastError}
        </Callout>
      ) : null}
      <FieldGrid columns={4}>
        <Field label="State">
          <StatusBadge meta={runtimeStateMeta(runtime.state)} />
        </Field>
        <Field label="Started by" hint={runtime.external ? "Set with MANAGED_COPILOT_RUNTIME_URL" : undefined}>
          {runtime.external ? "External (not started by the gateway)" : "The gateway"}
        </Field>
        <Field label="Version" mono>
          {runtime.version}
        </Field>
        <Field label="Protocol version" mono>
          {runtime.protocolVersion}
        </Field>
        <Field label="Process ID" mono>
          {runtime.pid}
        </Field>
        <Field label="Generation" hint="Increments with every new runtime connection">
          <span className="tabular-nums">{runtime.generation}</span>
        </Field>
        <Field label="Connected">{runtime.connectedAt ? <RelativeTime value={runtime.connectedAt} /> : undefined}</Field>
        <Field label="Restarts">
          <span className={cx("tabular-nums", runtime.restarts > 0 && "font-semibold text-fg-attention")}>{runtime.restarts}</span>
        </Field>
        <Field label="Open sessions">
          <Link href={hrefs.view("sessions", { placement: "shared" })} className="Link tabular-nums">
            {pluralize(runtime.sessions, "session")}
          </Link>
        </Field>
      </FieldGrid>
    </Card>
  );
}

function SandboxSection({ backend, health }: { readonly backend: SandboxBackendStatus; readonly health: StatusMeta | undefined }) {
  const provider = backend.provider;
  const check = (): void => confirmProbeSandboxes(provider);
  return (
    <Card
      id="infra-sandboxes"
      title="Sandbox backend"
      icon={SandboxIcon}
      description={provider ? `Isolated sessions run on ${provider === "azure" ? "Azure" : provider === "docker" ? "Docker" : provider}.` : "This gateway has no sandbox module."}
      actions={
        <>
          <HealthBadge meta={health} />
          {provider ? (
            <Button size="sm" icon={SyncIcon} onClick={check}>
              Check now
            </Button>
          ) : null}
        </>
      }
    >
      {backend.lastError ? (
        <Callout tone="danger" title="Last error" className="mb-4">
          {backend.lastError}
        </Callout>
      ) : null}
      <FieldGrid columns={4}>
        <Field label="Provider" mono>
          {provider ?? "None"}
        </Field>
        <Field label="Available">
          <StatusBadge meta={backend.available ? healthMeta("healthy") : healthMeta("unavailable")}>{backend.available ? "Available" : "Unavailable"}</StatusBadge>
        </Field>
        <Field label="Last checked">{backend.checkedAt ? <RelativeTime value={backend.checkedAt} /> : <span className="text-fg-muted">Not checked yet</span>}</Field>
        <Field label="Default idle timeout">{backend.defaultIdleSeconds !== undefined ? formatDuration(backend.defaultIdleSeconds) : undefined}</Field>
        <Field label="Sandboxes" wide>
          <span className="flex flex-wrap items-center gap-3">
            <StateCounts counts={backend.counts} metaFor={sandboxStateMeta} empty="No sandboxes." />
            <Link href={hrefs.view("sandboxes")} className="Link">
              View sandboxes
            </Link>
          </span>
        </Field>
      </FieldGrid>
      <Facts facts={backend.facts} />
    </Card>
  );
}

function NotConfigured({ id, title, icon, children }: { readonly id: string; readonly title: string; readonly icon: Icon; readonly children: ReactNode }) {
  return (
    <Card id={id} title={title} icon={icon} actions={<Chip tone="neutral">Not configured</Chip>}>
      <p className="text-fg-muted">{children}</p>
    </Card>
  );
}

function EgressSection({ egress, health }: { readonly egress: EgressStatus | undefined; readonly health: StatusMeta | undefined }) {
  if (!egress) {
    return (
      <NotConfigured id="infra-egress" title="Egress proxy" icon={ShieldLockIcon}>
        This gateway runs no egress proxy. Sandboxes that need network access or vault credentials can&apos;t start until one is connected.
      </NotConfigured>
    );
  }
  return (
    <Card
      id="infra-egress"
      title="Egress proxy"
      icon={ShieldLockIcon}
      description="Enforces sandbox network policy and substitutes vault credentials."
      actions={
        <>
          <StatusBadge meta={egress.connected ? healthMeta("healthy") : healthMeta("unavailable")}>{egress.connected ? "Connected" : "Disconnected"}</StatusBadge>
          <HealthBadge meta={health} />
        </>
      }
    >
      <FieldGrid columns={4}>
        <Field label="Mode" mono>
          {egress.mode}
        </Field>
        <Field label="Version" mono>
          {egress.version}
        </Field>
        <Field label="Instance" mono>
          {egress.instanceId}
        </Field>
        <Field label="Connected since">{egress.since ? <RelativeTime value={egress.since} /> : undefined}</Field>
        <Field label="Registered sandboxes">
          <span className="tabular-nums">{formatNumber(egress.registrations)}</span>
        </Field>
        <Field label="Blocked (24 h)">
          <span className={cx("tabular-nums", egress.blockedLastDay > 0 && "font-semibold text-fg-attention")}>{formatNumber(egress.blockedLastDay)}</span>
        </Field>
        <Field label="CA certificate (SHA-256)" wide>
          {egress.caFingerprint ? (
            <span className="inline-flex max-w-full items-center gap-1">
              <span className="min-w-0 font-mono text-xs break-all">{egress.caFingerprint}</span>
              <CopyButton text={egress.caFingerprint} label="Copy CA fingerprint" className="size-6" />
            </span>
          ) : undefined}
        </Field>
      </FieldGrid>
    </Card>
  );
}

function SchedulerSection({ scheduler, health }: { readonly scheduler: SchedulerStatus | undefined; readonly health: StatusMeta | undefined }) {
  if (!scheduler) {
    return (
      <NotConfigured id="infra-scheduler" title="Scheduler" icon={CalendarIcon}>
        This gateway runs no scheduler module.
      </NotConfigured>
    );
  }
  return (
    <Card
      id="infra-scheduler"
      title="Scheduler"
      icon={CalendarIcon}
      actions={
        <>
          <StatusBadge meta={scheduler.running ? runtimeStateMeta("running") : runtimeStateMeta("stopped")} />
          <HealthBadge meta={health} />
        </>
      }
    >
      {scheduler.lastTickError ? (
        <Callout tone="danger" title="Last tick failed" className="mb-4">
          {scheduler.lastTickError}
        </Callout>
      ) : null}
      <FieldGrid columns={2}>
        <Field label="Tick interval">{formatMilliseconds(scheduler.tickIntervalMs)}</Field>
        <Field label="Last tick">{scheduler.lastTickAt ? <RelativeTime value={scheduler.lastTickAt} /> : undefined}</Field>
        <Field label="Next run due">{scheduler.nextDueAt ? <RelativeTime value={scheduler.nextDueAt} /> : <span className="text-fg-muted">Nothing scheduled</span>}</Field>
        <Field label="Runs">
          <span className="tabular-nums">
            {formatNumber(scheduler.activeRuns)} active · {formatNumber(scheduler.queuedRuns)} queued
          </span>
        </Field>
      </FieldGrid>
    </Card>
  );
}

function WebhookSection({ worker, health }: { readonly worker: WebhookWorkerStatus | undefined; readonly health: StatusMeta | undefined }) {
  if (!worker) {
    return (
      <NotConfigured id="infra-webhooks" title="Webhook worker" icon={WebhookIcon}>
        This gateway runs no webhook worker.
      </NotConfigured>
    );
  }
  return (
    <Card
      id="infra-webhooks"
      title="Webhook worker"
      icon={WebhookIcon}
      actions={
        <>
          <StatusBadge meta={worker.running ? runtimeStateMeta("running") : runtimeStateMeta("stopped")} />
          <HealthBadge meta={health} />
        </>
      }
    >
      <FieldGrid columns={2}>
        <Field label="Subscriptions">
          <span className="tabular-nums">{formatNumber(worker.subscriptions)}</span>
        </Field>
        <Field label="Deliveries">
          <StateCounts counts={worker.counts} metaFor={deliveryStateMeta} empty="No deliveries." />
        </Field>
      </FieldGrid>
      <Link href={hrefs.view("webhooks")} className="Link mt-4 inline-block">
        View webhooks and deliveries
      </Link>
    </Card>
  );
}

function StorageSection({ storage, health }: { readonly storage: StorageStatus; readonly health: StatusMeta | undefined }) {
  return (
    <Card id="infra-storage" title="Storage" icon={DatabaseIcon} description="The gateway's SQLite database." actions={<HealthBadge meta={health} />}>
      <FieldGrid columns={3}>
        <Field label="Data directory">
          <span className="inline-flex max-w-full items-center gap-1">
            <span className="min-w-0 font-mono text-xs break-all">{storage.dataDir}</span>
            <CopyButton text={storage.dataDir} label="Copy data directory" className="size-6" />
          </span>
        </Field>
        <Field label="Database">{formatBytes(storage.databaseBytes)}</Field>
        <Field label="Write-ahead log">{formatBytes(storage.walBytes)}</Field>
      </FieldGrid>
    </Card>
  );
}

function InfrastructureSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading the infrastructure">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="Box h-28 p-4">
            <SkeletonLines lines={2} />
          </div>
        ))}
      </div>
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="Box">
          <div className="Box-header">
            <Skeleton className="h-4 w-40" />
          </div>
          <div className="p-4">
            <SkeletonLines lines={4} />
          </div>
        </div>
      ))}
    </div>
  );
}
