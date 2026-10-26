import type { OperatorEnvironmentRequest, OperatorPromotion, OperatorSessionDetail } from "@managed-copilot/protocol/operator";
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CalendarIcon,
  ChecklistIcon,
  CommentDiscussionIcon,
  CpuIcon,
  DotFillIcon,
  FileIcon,
  GlobeIcon,
  HistoryIcon,
  InfoIcon,
  PackageIcon,
  PlugIcon,
  SandboxIcon,
  ShieldLockIcon,
  ShieldXIcon,
  StackIcon,
  ToolsIcon,
} from "@primer/octicons-react";
import { getSession } from "../lib/api.js";
import { formatBytes, formatNumber, formatValue, shortId, summarizeNetwork } from "../lib/format.js";
import { usePoll } from "../lib/poll.js";
import { hrefs, type Query } from "../lib/routes.js";
import { egressReasonLabel, freeformStateMeta, scheduleStateMeta, sessionLifecycle, sessionStateMeta, turnStatusMeta } from "../lib/status.js";
import { ActionsTable } from "../components/common/ActionsTable.js";
import { ChipList, EnvironmentTypeChip, NetworkPolicyView, PlacementChip, YesNo } from "../components/common/Entities.js";
import { HarnessPanel } from "../components/common/HarnessPanel.js";
import { AccountLabel, EnvironmentLink, IdText, RelativeTime } from "../components/common/Identity.js";
import { SandboxPanel } from "../components/common/SandboxPanel.js";
import { Page, PollContent } from "../components/layout/Page.js";
import { buttonClass } from "../components/ui/Button.js";
import { Card, Field, FieldGrid } from "../components/ui/Card.js";
import { Chip, StateLabel, StatusBadge } from "../components/ui/Chip.js";
import { Tabs } from "../components/ui/Controls.js";
import { CopyButton } from "../components/ui/CopyButton.js";
import { DataTable } from "../components/ui/DataTable.js";
import { Callout, Code, EmptyState, None, Skeleton, SkeletonLines } from "../components/ui/Feedback.js";
import { Link } from "../components/ui/Link.js";

const TABS = ["overview", "harness", "network", "actions", "sandbox", "artifacts"] as const;
type Tab = (typeof TABS)[number];

const OPEN_ACTION_STATES = new Set(["pending", "claimed", "executing", "needs_reconciliation"]);

function tabFrom(query: Query): Tab {
  const value = query["tab"];
  return (TABS as readonly string[]).includes(value ?? "") ? (value as Tab) : "overview";
}

export function SessionDetailView({ id, query }: { readonly id: string; readonly query: Query }) {
  const poll = usePoll(`session:${id}`, (signal) => getSession(id, signal));
  const tab = tabFrom(query);
  const session = poll.data;
  const openActions = session?.actions.filter((action) => OPEN_ACTION_STATES.has(action.state)).length ?? 0;
  const reconciliation = session?.actions.some((action) => action.state === "needs_reconciliation") ?? false;
  const blocks = session?.network?.recentBlocks.length ?? 0;
  return (
    <Page
      wide
      title={
        <span className="inline-flex flex-wrap items-center gap-1">
          <span className="font-mono">{shortId(id)}</span>
          <CopyButton text={id} label={`Copy session ID ${id}`} />
        </span>
      }
      documentTitle={`Session ${shortId(id)}`}
      breadcrumbs={[{ label: "Sessions", href: hrefs.view("sessions") }, { label: shortId(id) }]}
      description={
        session ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <StateLabel meta={sessionStateMeta(session.state)} lifecycle={sessionLifecycle(session.state)} />
            <span className="inline-flex items-center gap-1">
              <AccountLabel account={session.owner} />
            </span>
            <span aria-hidden>·</span>
            <EnvironmentLink name={session.environment} />
            <span aria-hidden>·</span>
            <span>
              created <RelativeTime value={session.createdAt} />
            </span>
            <PlacementChip placement={session.placement} />
            <Chip title="Increments when the session moves to a new runtime (promotion, restore)">gen {session.generation}</Chip>
            {session.live ? (
              <span className="Label Label--success" title="Open on a runtime connection now">
                <DotFillIcon size={12} />
                Live
              </span>
            ) : (
              <Chip tone="neutral" title="Not resident on a runtime right now">
                Not live
              </Chip>
            )}
          </span>
        ) : undefined
      }
      poll={poll}
      headerExtra={
        <Tabs
          label="Session sections"
          active={tab}
          hrefFor={(next) => hrefs.session(id, { tab: next === "overview" ? undefined : next })}
          items={[
            { id: "overview", label: "Overview", icon: InfoIcon },
            { id: "harness", label: "Harness", icon: ToolsIcon, countTone: "danger", count: session?.harnessProblem ? 1 : undefined },
            { id: "network", label: "Network", icon: GlobeIcon, count: blocks, countTone: "attention" },
            { id: "actions", label: "Actions", icon: ChecklistIcon, count: openActions, countTone: reconciliation ? "danger" : "attention" },
            { id: "sandbox", label: "Sandbox", icon: SandboxIcon },
            { id: "artifacts", label: "Artifacts & schedules", icon: PackageIcon },
          ]}
        />
      }
    >
      <PollContent
        poll={poll}
        skeleton={<DetailSkeleton />}
        errorTitle="Couldn't load this session"
        boxed
        notFound={() => (
          <div className="Box">
            <EmptyState
              icon={CommentDiscussionIcon}
              title="Session not found"
              spacious
              action={
                <Link href={hrefs.view("sessions")} className={buttonClass("default")}>
                  Back to sessions
                </Link>
              }
            >
              No session has the ID <Code className="break-all">{id}</Code>. It may have been deleted.
            </EmptyState>
          </div>
        )}
      >
        {(data) => (
          <>
            {tab === "overview" ? <OverviewTab session={data} /> : null}
            {tab === "harness" ? <HarnessPanel harness={data.harness} problem={data.harnessProblem} /> : null}
            {tab === "network" ? <NetworkTab session={data} /> : null}
            {tab === "actions" ? <ActionsTab session={data} /> : null}
            {tab === "sandbox" ? <SandboxTab session={data} /> : null}
            {tab === "artifacts" ? <ArtifactsTab session={data} /> : null}
          </>
        )}
      </PollContent>
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------------------------

function OverviewTab({ session }: { readonly session: OperatorSessionDetail }) {
  return (
    <div className="space-y-6">
      <Card title="Session" icon={CommentDiscussionIcon}>
        <FieldGrid columns={4}>
          <Field label="Session ID" wide>
            <span className="inline-flex max-w-full items-center gap-1">
              <span className="min-w-0 font-mono text-xs break-all">{session.id}</span>
              <CopyButton text={session.id} label="Copy session ID" className="size-6" />
            </span>
          </Field>
          <Field label="Owner">
            <AccountLabel account={session.owner} showName />
          </Field>
          <Field label="Environment">
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <EnvironmentLink name={session.environment} />
              <EnvironmentTypeChip type={session.type} />
            </span>
          </Field>
          <Field label="Placement">
            <PlacementChip placement={session.placement} />
          </Field>
          <Field label="State">
            <StatusBadge meta={sessionStateMeta(session.state)} />
          </Field>
          <Field label="Created">
            <RelativeTime value={session.createdAt} />
          </Field>
          <Field label="Updated">
            <RelativeTime value={session.updatedAt} />
          </Field>
          <Field label="Model" mono>
            {session.model}
          </Field>
          <Field label="Agent">{session.agent}</Field>
          <Field label="Client">{session.clientName}</Field>
          <Field label="Generation">
            <span className="tabular-nums">{session.generation}</span>
          </Field>
          <Field label="Created by schedule">
            {session.scheduleId ? (
              <Link href={hrefs.view("schedules", { schedule: session.scheduleId })} className="Link font-mono text-xs">
                {shortId(session.scheduleId)}
              </Link>
            ) : undefined}
          </Field>
          <Field label="Webhook" mono>
            {session.webhook}
          </Field>
          <Field label="Incarnation" wide hint="Changes if a deleted session's ID is reused">
            <span className="inline-flex max-w-full items-center gap-1">
              <span className="min-w-0 font-mono text-xs break-all">{session.incarnation}</span>
              <CopyButton text={session.incarnation} label="Copy incarnation" className="size-6" />
            </span>
          </Field>
        </FieldGrid>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Last turn" icon={HistoryIcon}>
          {session.lastTurn ? (
            <FieldGrid columns={3}>
              <Field label="Status">
                <StatusBadge meta={turnStatusMeta(session.lastTurn.status)} />
              </Field>
              <Field label="Turn">
                <IdText id={session.lastTurn.turnId} label="turn ID" />
              </Field>
              <Field label="Completed">{session.lastTurn.completedAt ? <RelativeTime value={session.lastTurn.completedAt} /> : undefined}</Field>
            </FieldGrid>
          ) : (
            <p className="text-fg-muted">No turns yet.</p>
          )}
        </Card>
        <Card title="Runtime" icon={CpuIcon} description="In-memory state while the session is resident.">
          {session.runtime ? (
            <FieldGrid columns={4}>
              <Field label="Ready">
                <YesNo value={session.runtime.ready} />
              </Field>
              <Field label="Restoring">
                <YesNo value={session.runtime.restoring} />
              </Field>
              <Field label="Cutover">
                <YesNo value={session.runtime.cutover} />
              </Field>
              <Field label="Deleting">
                <YesNo value={session.runtime.deleting} />
              </Field>
              <Field label="Waits">
                <span className="tabular-nums">{session.runtime.waits}</span>
              </Field>
              <Field label="Presences">
                <span className="tabular-nums">{session.runtime.presences}</span>
              </Field>
              <Field label="Upstream" wide mono>
                {session.runtime.upstream}
              </Field>
            </FieldGrid>
          ) : (
            <p className="text-fg-muted">Not resident on a runtime right now.</p>
          )}
        </Card>
      </div>

      <Card title="Attached clients" icon={PlugIcon} padded={session.attachments.length === 0} description={`${formatNumber(session.attachments.length)} attached now`}>
        {session.attachments.length === 0 ? (
          <p className="text-fg-muted">No clients are attached.</p>
        ) : (
          <DataTable
            label="Attached clients"
            rows={session.attachments}
            rowKey={(attachment) => attachment.connectionId}
            columns={[
              { id: "kind", header: "Kind", cell: (attachment) => <Chip>{attachment.kind === "cli" ? "Copilot CLI" : "SDK"}</Chip> },
              { id: "account", header: "Account", cell: (attachment) => <AccountLabel account={attachment.account} /> },
              { id: "client", header: "Client", cell: (attachment) => attachment.clientName ?? <None /> },
              { id: "attached", header: "Attached", cell: (attachment) => <RelativeTime value={attachment.attachedAt} className="text-fg-muted" /> },
              { id: "tools", header: "Tools", cell: (attachment) => <ChipList items={attachment.tools} mono /> },
              { id: "callbacks", header: "Callbacks", cell: (attachment) => <ChipList items={attachment.callbacks} mono /> },
              { id: "connection", header: "Connection", cell: (attachment) => <IdText id={attachment.connectionId} label="connection ID" />, hideBelow: "xl" },
            ]}
          />
        )}
      </Card>

      {session.promotion ? <PromotionCard promotion={session.promotion} /> : null}

      <EnvironmentRequestCard request={session.environmentRequest} />
    </div>
  );
}

function PromotionCard({ promotion }: { readonly promotion: OperatorPromotion }) {
  return (
    <Card title="Promotion" icon={ArrowUpRightIcon} actions={<StatusBadge meta={freeformStateMeta(promotion.state)} />}>
      {promotion.error || promotion.errorCode ? (
        <Callout tone="danger" title={promotion.errorCode ? `Failed: ${promotion.errorCode}` : "Failed"} className="mb-4">
          {promotion.error ?? "No details."}
        </Callout>
      ) : null}
      <FieldGrid columns={4}>
        <Field label="Promotion ID">
          <IdText id={promotion.id} label="promotion ID" />
        </Field>
        <Field label="Trigger">{promotion.trigger}</Field>
        <Field label="Target">
          <EnvironmentLink name={promotion.target} />
        </Field>
        <Field label="Generation">
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            {promotion.fromGeneration}
            <ArrowRightIcon size={12} className="text-fg-muted" aria-label="to" />
            {promotion.toGeneration ?? "…"}
          </span>
        </Field>
        <Field label="Sandbox">{promotion.sandboxId ? <IdText id={promotion.sandboxId} label="sandbox ID" /> : undefined}</Field>
        <Field label="Started">
          <RelativeTime value={promotion.createdAt} />
        </Field>
        <Field label="Updated">
          <RelativeTime value={promotion.updatedAt} />
        </Field>
        <Field label="Committed">{promotion.committedAt ? <RelativeTime value={promotion.committedAt} /> : undefined}</Field>
      </FieldGrid>
    </Card>
  );
}

function EnvironmentRequestCard({ request }: { readonly request: OperatorEnvironmentRequest }) {
  const files = request.files ?? [];
  return (
    <Card title="Environment request" icon={StackIcon} description="What the client asked for when it created the session (contents and values left out).">
      <FieldGrid columns={4}>
        <Field label="Name" mono>
          {request.name}
        </Field>
        <Field label="Type">{request.type ? <EnvironmentTypeChip type={request.type} /> : undefined}</Field>
        <Field label="Size">{request.size}</Field>
        <Field label="Network">{request.network !== undefined ? <code className="font-mono text-xs break-all">{formatValue(request.network, 400)}</code> : undefined}</Field>
        <Field label="Vaults">
          <ChipList items={request.vaults} mono />
        </Field>
        <Field label="Python packages">
          <ChipList items={request.packages?.python} mono />
        </Field>
        <Field label="npm packages">
          <ChipList items={request.packages?.npm} mono />
        </Field>
        <Field label="Variables (names)">
          <ChipList items={request.env} mono />
        </Field>
        <Field label="Files" wide>
          {files.length > 0 ? (
            <ul className="space-y-1">
              {files.map((file) => (
                <li key={file.path} className="flex items-center gap-2">
                  <FileIcon size={16} className="text-fg-muted" />
                  <span className="min-w-0 truncate font-mono text-xs">{file.path}</span>
                  <span className="text-xs text-fg-muted tabular-nums">{formatBytes(file.bytes)}</span>
                </li>
              ))}
            </ul>
          ) : undefined}
        </Field>
      </FieldGrid>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------

function NetworkTab({ session }: { readonly session: OperatorSessionDetail }) {
  const network = session.network;
  if (!network) {
    return (
      <div className="Box">
        <EmptyState icon={ShieldLockIcon} title="No network information" spacious>
          The gateway reports no network policy for this session.
        </EmptyState>
      </div>
    );
  }
  const summary = summarizeNetwork(network.policy);
  return (
    <div className="space-y-6">
      <Card title="Effective policy" icon={ShieldLockIcon} description="The environment's ceiling, narrowed by what the client asked for.">
        <div className="space-y-4">
          <NetworkPolicyView policy={network.policy} />
          <FieldGrid columns={2}>
            <Field label="Vaults">
              <ChipList items={network.vaults} mono empty="None" />
            </Field>
            <Field label="Promoted into">{network.promotedTo ? <EnvironmentLink name={network.promotedTo} /> : undefined}</Field>
          </FieldGrid>
        </div>
      </Card>
      <Card title="Recent blocks" icon={ShieldXIcon} description="Outbound requests the policy refused (no credentials or query strings are recorded)." padded={network.recentBlocks.length === 0}>
        {network.recentBlocks.length === 0 ? (
          <p className="text-fg-muted">{summary?.kind === "disabled" ? "Nothing blocked recently (network access is disabled)." : "Nothing blocked recently."}</p>
        ) : (
          <DataTable
            label="Blocked requests"
            rows={network.recentBlocks}
            rowKey={(block) => String(block.id)}
            columns={[
              { id: "at", header: "Time", cell: (block) => <RelativeTime value={block.at} className="text-fg-muted" /> },
              {
                id: "reason",
                header: "Reason",
                cell: (block) => (
                  <Chip tone="attention" title={block.reason}>
                    {egressReasonLabel(block.reason)}
                  </Chip>
                ),
              },
              {
                id: "destination",
                header: "Destination",
                cell: (block) =>
                  block.host ? (
                    <span className="font-mono text-xs break-all">
                      {block.host}
                      {block.port !== undefined ? `:${block.port}` : ""}
                    </span>
                  ) : (
                    <None />
                  ),
              },
              {
                id: "request",
                header: "Request",
                cell: (block) => (block.method || block.path ? <span className="font-mono text-xs break-all">{[block.method, block.path].filter(Boolean).join(" ")}</span> : <None />),
              },
              { id: "message", header: "Message", cell: (block) => <span className="text-fg-muted">{block.message}</span> },
              { id: "sandbox", header: "Sandbox", cell: (block) => (block.sandboxId ? <IdText id={block.sandboxId} label="sandbox ID" /> : <None />), hideBelow: "xl" },
            ]}
          />
        )}
      </Card>
    </div>
  );
}

function ActionsTab({ session }: { readonly session: OperatorSessionDetail }) {
  return (
    <Card title="Durable actions" icon={ChecklistIcon} description="Tool calls, permissions, and input requests waiting on responders (metadata only)." padded={false}>
      <ActionsTable
        actions={session.actions}
        showSession={false}
        empty={
          <EmptyState icon={ChecklistIcon} title="No durable actions" compact>
            This session has no tool calls, permission requests, or input requests on record.
          </EmptyState>
        }
      />
    </Card>
  );
}

function SandboxTab({ session }: { readonly session: OperatorSessionDetail }) {
  if (session.sandbox) return <SandboxPanel sandbox={session.sandbox} showSession={false} />;
  return (
    <div className="Box">
      <EmptyState icon={SandboxIcon} title={session.placement === "shared" ? "Runs on the shared runtime" : "No sandbox yet"} spacious>
        {session.placement === "shared"
          ? session.type === "promotable"
            ? "Shared sessions have no sandbox. This one gets a sandbox if it's promoted."
            : "Shared sessions have no sandbox."
          : "The sandbox appears here once it's provisioned."}
      </EmptyState>
    </div>
  );
}

function ArtifactsTab({ session }: { readonly session: OperatorSessionDetail }) {
  const artifacts = session.artifacts;
  return (
    <div className="space-y-6">
      <Card
        title="Artifacts"
        icon={PackageIcon}
        description={artifacts ? `${formatNumber(artifacts.count)} published · ${formatBytes(artifacts.bytes)}` : "Files the session published from /workspace/outputs."}
        padded={!artifacts || artifacts.latest.length === 0}
      >
        {!artifacts || artifacts.latest.length === 0 ? (
          <p className="text-fg-muted">No artifacts published.</p>
        ) : (
          <DataTable
            label="Latest artifacts"
            rows={artifacts.latest}
            rowKey={(artifact) => `${artifact.path}@${artifact.version}`}
            columns={[
              { id: "path", header: "Path", cell: (artifact) => <span className="font-mono text-xs break-all">{artifact.path}</span> },
              { id: "version", header: "Version", align: "right", cell: (artifact) => <span className="text-fg-muted">v{artifact.version}</span> },
              { id: "size", header: "Size", align: "right", cell: (artifact) => <span className="text-fg-muted">{formatBytes(artifact.size)}</span> },
              { id: "state", header: "State", cell: (artifact) => <StatusBadge meta={freeformStateMeta(artifact.state)} /> },
              { id: "published", header: "Published", cell: (artifact) => (artifact.publishedAt ? <RelativeTime value={artifact.publishedAt} className="text-fg-muted" /> : <None />) },
            ]}
          />
        )}
      </Card>
      <Card title="Schedules" icon={CalendarIcon} description="Schedules that target this session." padded={session.schedules.length === 0}>
        {session.schedules.length === 0 ? (
          <p className="text-fg-muted">{session.scheduleId ? "None target it, but a schedule run created it (see Overview)." : "None."}</p>
        ) : (
          <ul>
            {session.schedules.map((schedule) => (
              <li key={schedule.id} className="Box-row Box-row--hover-gray flex flex-wrap items-center gap-3 px-4 py-3">
                <CalendarIcon size={16} className="text-fg-muted" />
                <Link href={hrefs.view("schedules", { schedule: schedule.id })} className="Link--primary font-semibold">
                  {schedule.name}
                </Link>
                <span className="font-mono text-xs text-fg-muted">{shortId(schedule.id)}</span>
                <StatusBadge meta={scheduleStateMeta(schedule.state)} className="ml-auto" />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading the session">
      <div className="Box">
        <div className="Box-header">
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="p-4">
          <SkeletonLines lines={5} />
        </div>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="Box h-32 p-4">
            <SkeletonLines lines={3} />
          </div>
        ))}
      </div>
    </div>
  );
}
