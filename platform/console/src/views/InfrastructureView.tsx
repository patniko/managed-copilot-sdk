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
import { Boxes, CalendarClock, Cpu, Database, GlobeLock, Network, RefreshCw, Server, Webhook } from "lucide-react";
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
import { Callout, Skeleton } from "../components/ui/Feedback.js";
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
    <Page
      title="Infrastructure"
      documentTitle="Infrastructure"
      icon={Server}
      description="The gateway, its runtimes, and the services behind them."
      poll={poll}
    >
      <PollContent poll={poll} skeleton={<InfrastructureSkeleton />} errorTitle="Couldn't load the infrastructure">
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
    <div className="mt-5 border-t border-zinc-800/70 pt-4">
      <h3 className="mb-3 text-[12px] font-semibold text-zinc-300">{title}</h3>
      <FieldGrid columns={3}>
        {facts.map((fact) => (
          <Field key={`${fact.label}:${fact.value}`} label={fact.label} mono={fact.mono}>
            <span className="inline-flex max-w-full items-center gap-1">
              <span className="min-w-0 break-all">{fact.value}</span>
              {fact.mono && fact.value.length > 12 ? <CopyButton text={fact.value} label={`Copy ${fact.label}`} /> : null}
            </span>
          </Field>
        ))}
      </FieldGrid>
    </div>
  );
}

function StateCounts({ counts, metaFor, empty }: { readonly counts: Readonly<Partial<Record<string, number>>>; readonly metaFor: (key: string) => StatusMeta; readonly empty: string }) {
  const entries = Object.entries(counts).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0);
  if (entries.length === 0) return <span className="text-zinc-500">{empty}</span>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {entries.map(([key, count]) => (
        <li key={key}>
          <StatusBadge meta={metaFor(key)} size="xs">
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
    <div className="mt-1.5 h-1.5 w-full max-w-48 overflow-hidden rounded-full bg-zinc-800" role="img" aria-label={`${Math.round(ratio * 100)}% of the reserved heap in use`}>
      <div className="h-full rounded-full bg-sky-400/80" style={{ width: `${ratio * 100}%` }} />
    </div>
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
              <Chip title="Every member of this GitHub organization">org: {org}</Chip>
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
    <Card id="infra-gateway" title="Gateway" icon={Network} description={`${gateway.version} · ${gateway.mode} · pid ${gateway.pid}`} actions={<HealthBadge meta={health} />}>
      <FieldGrid columns={4}>
        <Field label="Version" mono>
          {gateway.version}
        </Field>
        <Field label="Mode">
          <Chip mono tone={gateway.mode === "azure" ? "active" : "plain"}>
            {gateway.mode}
          </Chip>
        </Field>
        <Field label="Started">
          <RelativeTime value={gateway.startedAt} />
        </Field>
        <Field label="Uptime">{formatDuration(gateway.uptimeSeconds)}</Field>
        <Field label="Public URL" wide>
          <span className="inline-flex max-w-full items-center gap-1">
            <span className="min-w-0 truncate font-mono text-[12px]" title={gateway.publicUrl}>
              {gateway.publicUrl}
            </span>
            <CopyButton text={gateway.publicUrl} label="Copy public URL" />
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
          <span className="tabular">
            p50 {formatMilliseconds(delay.p50)} · p99 <span className={delay.p99 > 200 ? "text-amber-300" : undefined}>{formatMilliseconds(delay.p99)}</span> · max {formatMilliseconds(delay.max)}
          </span>
        </Field>
      </FieldGrid>

      <div className="mt-5 grid gap-x-6 gap-y-4 border-t border-zinc-800/70 pt-4 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-[12px] font-semibold text-zinc-300">Who may use it</h3>
          <p className="mt-0.5 mb-2 text-[12px] text-zinc-500">
            <code className="font-mono">access</code> in the AppHost
          </p>
          {gateway.access.open ? (
            <span className="text-[13px] text-zinc-200">Any GitHub account</span>
          ) : gateway.access.githubUsers.length === 0 && gateway.access.githubOrgs.length === 0 ? (
            <span className="text-[13px] text-zinc-500">Nobody is listed.</span>
          ) : (
            <AccountList users={gateway.access.githubUsers} orgs={gateway.access.githubOrgs} />
          )}
        </div>
        <div className="min-w-0">
          <h3 className="text-[12px] font-semibold text-zinc-300">Who may operate it</h3>
          <p className="mt-0.5 mb-2 text-[12px] text-zinc-500">
            <code className="font-mono">operators</code> in the AppHost
          </p>
          <AccountList users={gateway.operators.githubUsers} orgs={gateway.operators.githubOrgs} />
          {gateway.operators.localDefault ? (
            <p className="text-[13px] text-zinc-200">Every account that can use this loopback gateway (no operators are named).</p>
          ) : gateway.operators.githubUsers.length === 0 && gateway.operators.githubOrgs.length === 0 ? (
            <p className="text-[13px] text-zinc-500">No operators are named.</p>
          ) : null}
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 text-[12px] font-semibold text-zinc-300">Modules</h3>
          <ChipList items={gateway.modules} mono label="Gateway modules" />
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 text-[12px] font-semibold text-zinc-300">Capabilities</h3>
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
      icon={Cpu}
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
          <StatusBadge meta={runtimeStateMeta(runtime.state)} size="xs" />
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
          <span className="tabular">{runtime.generation}</span>
        </Field>
        <Field label="Connected">
          {runtime.connectedAt ? <RelativeTime value={runtime.connectedAt} /> : undefined}
        </Field>
        <Field label="Restarts">
          <span className={cx("tabular", runtime.restarts > 0 && "text-amber-300")}>{runtime.restarts}</span>
        </Field>
        <Field label="Open sessions">
          <Link href={hrefs.view("sessions", { placement: "shared" })} className="tabular text-sky-300 hover:underline hover:underline-offset-2">
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
      icon={Boxes}
      description={provider ? `Isolated sessions run on ${provider === "azure" ? "Azure" : provider === "docker" ? "Docker" : provider}.` : "This gateway has no sandbox module."}
      actions={
        <>
          <HealthBadge meta={health} />
          {provider ? (
            <Button size="sm" icon={RefreshCw} onClick={check}>
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
          <StatusBadge meta={backend.available ? healthMeta("healthy") : healthMeta("unavailable")} size="xs">
            {backend.available ? "Available" : "Unavailable"}
          </StatusBadge>
        </Field>
        <Field label="Last checked">{backend.checkedAt ? <RelativeTime value={backend.checkedAt} /> : <span className="text-zinc-500">Not checked yet</span>}</Field>
        <Field label="Default idle timeout">{backend.defaultIdleSeconds !== undefined ? formatDuration(backend.defaultIdleSeconds) : undefined}</Field>
        <Field label="Sandboxes" wide>
          <span className="flex flex-wrap items-center gap-3">
            <StateCounts counts={backend.counts} metaFor={sandboxStateMeta} empty="No sandboxes." />
            <Link href={hrefs.view("sandboxes")} className="text-[12.5px] text-sky-300 hover:underline hover:underline-offset-2">
              View sandboxes
            </Link>
          </span>
        </Field>
      </FieldGrid>
      <Facts facts={backend.facts} />
    </Card>
  );
}

function NotConfigured({ id, title, icon, children }: { readonly id: string; readonly title: string; readonly icon: typeof Server; readonly children: ReactNode }) {
  return (
    <Card id={id} title={title} icon={icon} actions={<Chip>Not configured</Chip>}>
      <p className="text-[13px] text-zinc-500">{children}</p>
    </Card>
  );
}

function EgressSection({ egress, health }: { readonly egress: EgressStatus | undefined; readonly health: StatusMeta | undefined }) {
  if (!egress) {
    return (
      <NotConfigured id="infra-egress" title="Egress proxy" icon={GlobeLock}>
        This gateway runs no egress proxy. Sandboxes that need network access or vault credentials can't start until one is connected.
      </NotConfigured>
    );
  }
  return (
    <Card
      id="infra-egress"
      title="Egress proxy"
      icon={GlobeLock}
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
          <span className="tabular">{formatNumber(egress.registrations)}</span>
        </Field>
        <Field label="Blocked (24 h)">
          <span className={cx("tabular", egress.blockedLastDay > 0 && "text-amber-300")}>{formatNumber(egress.blockedLastDay)}</span>
        </Field>
        <Field label="CA certificate (SHA-256)" wide>
          {egress.caFingerprint ? (
            <span className="inline-flex max-w-full items-center gap-1">
              <span className="min-w-0 font-mono text-[12px] break-all">{egress.caFingerprint}</span>
              <CopyButton text={egress.caFingerprint} label="Copy CA fingerprint" />
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
      <NotConfigured id="infra-scheduler" title="Scheduler" icon={CalendarClock}>
        This gateway runs no scheduler module.
      </NotConfigured>
    );
  }
  return (
    <Card
      id="infra-scheduler"
      title="Scheduler"
      icon={CalendarClock}
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
        <Field label="Next run due">{scheduler.nextDueAt ? <RelativeTime value={scheduler.nextDueAt} /> : <span className="text-zinc-500">Nothing scheduled</span>}</Field>
        <Field label="Runs">
          <span className="tabular">
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
      <NotConfigured id="infra-webhooks" title="Webhook worker" icon={Webhook}>
        This gateway runs no webhook worker.
      </NotConfigured>
    );
  }
  return (
    <Card
      id="infra-webhooks"
      title="Webhook worker"
      icon={Webhook}
      actions={
        <>
          <StatusBadge meta={worker.running ? runtimeStateMeta("running") : runtimeStateMeta("stopped")} />
          <HealthBadge meta={health} />
        </>
      }
    >
      <FieldGrid columns={2}>
        <Field label="Subscriptions">
          <span className="tabular">{formatNumber(worker.subscriptions)}</span>
        </Field>
        <Field label="Deliveries">
          <StateCounts counts={worker.counts} metaFor={deliveryStateMeta} empty="No deliveries." />
        </Field>
      </FieldGrid>
      <Link href={hrefs.view("webhooks")} className="mt-4 inline-block text-[12.5px] text-sky-300 hover:underline hover:underline-offset-2">
        View webhooks and deliveries
      </Link>
    </Card>
  );
}

function StorageSection({ storage, health }: { readonly storage: StorageStatus; readonly health: StatusMeta | undefined }) {
  return (
    <Card id="infra-storage" title="Storage" icon={Database} description="The gateway's SQLite database." actions={<HealthBadge meta={health} />}>
      <FieldGrid columns={3}>
        <Field label="Data directory">
          <span className="inline-flex max-w-full items-center gap-1">
            <span className="min-w-0 font-mono text-[12px] break-all">{storage.dataDir}</span>
            <CopyButton text={storage.dataDir} label="Copy data directory" />
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
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-56 rounded-2xl" />
      ))}
    </div>
  );
}
