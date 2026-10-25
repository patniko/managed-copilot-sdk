import type { OperatorEnvironmentRequest, OperatorPromotion, OperatorSessionDetail } from "@managed-copilot/protocol/operator";
import { ArrowRight, Box, CalendarClock, FileText, ListChecks, MessagesSquare, ShieldAlert } from "lucide-react";
import { getSession } from "../lib/api.js";
import { formatBytes, formatNumber, formatValue, shortId, summarizeNetwork } from "../lib/format.js";
import { usePoll } from "../lib/poll.js";
import { hrefs, type Query } from "../lib/routes.js";
import { egressReasonLabel, freeformStateMeta, scheduleStateMeta, sessionStateMeta, turnStatusMeta } from "../lib/status.js";
import { ActionsTable } from "../components/common/ActionsTable.js";
import { ChipList, EnvironmentTypeChip, NetworkPolicyView, PlacementChip, YesNo } from "../components/common/Entities.js";
import { HarnessPanel } from "../components/common/HarnessPanel.js";
import { AccountLabel, EnvironmentLink, IdText, RelativeTime } from "../components/common/Identity.js";
import { SandboxPanel } from "../components/common/SandboxPanel.js";
import { Page, PollContent } from "../components/layout/Page.js";
import { Card, Field, FieldGrid } from "../components/ui/Card.js";
import { Chip, Dot, StatusBadge } from "../components/ui/Chip.js";
import { Tabs } from "../components/ui/Controls.js";
import { CopyButton } from "../components/ui/CopyButton.js";
import { DataTable } from "../components/ui/DataTable.js";
import { Callout, EmptyState, None, Skeleton } from "../components/ui/Feedback.js";
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
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          Session <span className="font-mono text-[18px] text-zinc-300">{shortId(id)}</span>
          <CopyButton text={id} label={`Copy session ID ${id}`} size="sm" />
        </span>
      }
      documentTitle={`Session ${shortId(id)}`}
      icon={MessagesSquare}
      breadcrumbs={[{ label: "Sessions", href: hrefs.view("sessions") }, { label: shortId(id) }]}
      description={
        session ? (
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <AccountLabel account={session.owner} />
            <span className="text-zinc-600">·</span>
            <EnvironmentLink name={session.environment} />
            <span className="text-zinc-600">·</span>
            <span>
              created <RelativeTime value={session.createdAt} />
            </span>
          </span>
        ) : undefined
      }
      poll={poll}
      actions={
        session ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge meta={sessionStateMeta(session.state)} />
            <PlacementChip placement={session.placement} />
            <Chip title="Increments when the session moves to a new runtime (promotion, restore)">gen {session.generation}</Chip>
            {session.live ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/25" title="Open on a runtime connection now">
                <Dot tone="success" pulse />
                Live
              </span>
            ) : (
              <Chip title="Not resident on a runtime right now">Not live</Chip>
            )}
          </div>
        ) : null
      }
      headerExtra={
        <Tabs
          label="Session sections"
          active={tab}
          hrefFor={(next) => hrefs.session(id, { tab: next === "overview" ? undefined : next })}
          items={[
            { id: "overview", label: "Overview" },
            { id: "harness", label: "Harness", countTone: "danger", count: session?.harnessProblem ? 1 : undefined },
            { id: "network", label: "Network", count: blocks, countTone: "warning" },
            { id: "actions", label: "Actions", count: openActions, countTone: reconciliation ? "danger" : "warning" },
            { id: "sandbox", label: "Sandbox" },
            { id: "artifacts", label: "Artifacts & schedules" },
          ]}
        />
      }
    >
      <PollContent
        poll={poll}
        skeleton={<DetailSkeleton />}
        errorTitle="Couldn't load this session"
        notFound={() => (
          <EmptyState
            icon={MessagesSquare}
            title="Session not found"
            action={
              <Link href={hrefs.view("sessions")} className="text-[13px] font-medium text-sky-300 hover:underline hover:underline-offset-2">
                Back to sessions
              </Link>
            }
          >
            No session has the ID <code className="font-mono break-all text-zinc-300">{id}</code>. It may have been deleted.
          </EmptyState>
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
    <div className="space-y-5">
      <Card title="Session">
        <FieldGrid columns={4}>
          <Field label="Session ID" wide>
            <span className="inline-flex max-w-full items-center gap-1">
              <span className="min-w-0 font-mono text-[12px] break-all">{session.id}</span>
              <CopyButton text={session.id} label="Copy session ID" />
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
            <StatusBadge meta={sessionStateMeta(session.state)} size="xs" />
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
            <span className="tabular">{session.generation}</span>
          </Field>
          <Field label="Created by schedule">
            {session.scheduleId ? (
              <Link href={hrefs.view("schedules", { schedule: session.scheduleId })} className="font-mono text-[12px] text-sky-300 hover:underline hover:underline-offset-2">
                {shortId(session.scheduleId)}
              </Link>
            ) : undefined}
          </Field>
          <Field label="Webhook" mono>
            {session.webhook}
          </Field>
          <Field label="Incarnation" wide hint="Changes if a deleted session's ID is reused">
            <span className="inline-flex max-w-full items-center gap-1">
              <span className="min-w-0 font-mono text-[12px] break-all">{session.incarnation}</span>
              <CopyButton text={session.incarnation} label="Copy incarnation" />
            </span>
          </Field>
        </FieldGrid>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Last turn">
          {session.lastTurn ? (
            <FieldGrid columns={3}>
              <Field label="Status">
                <StatusBadge meta={turnStatusMeta(session.lastTurn.status)} size="xs" />
              </Field>
              <Field label="Turn">
                <IdText id={session.lastTurn.turnId} label="turn ID" />
              </Field>
              <Field label="Completed">{session.lastTurn.completedAt ? <RelativeTime value={session.lastTurn.completedAt} /> : undefined}</Field>
            </FieldGrid>
          ) : (
            <p className="text-[13px] text-zinc-500">No turns yet.</p>
          )}
        </Card>
        <Card title="Runtime" description="In-memory state while the session is resident.">
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
                <span className="tabular">{session.runtime.waits}</span>
              </Field>
              <Field label="Presences">
                <span className="tabular">{session.runtime.presences}</span>
              </Field>
              <Field label="Upstream" wide mono>
                {session.runtime.upstream}
              </Field>
            </FieldGrid>
          ) : (
            <p className="text-[13px] text-zinc-500">Not resident on a runtime right now.</p>
          )}
        </Card>
      </div>

      <Card title="Attached clients" padded={session.attachments.length === 0} description={`${formatNumber(session.attachments.length)} attached now`}>
        {session.attachments.length === 0 ? (
          <p className="text-[13px] text-zinc-500">No clients are attached.</p>
        ) : (
          <DataTable
            label="Attached clients"
            rows={session.attachments}
            rowKey={(attachment) => attachment.connectionId}
            columns={[
              { id: "kind", header: "Kind", cell: (attachment) => <Chip>{attachment.kind === "cli" ? "Copilot CLI" : "SDK"}</Chip> },
              { id: "account", header: "Account", cell: (attachment) => <AccountLabel account={attachment.account} /> },
              { id: "client", header: "Client", cell: (attachment) => attachment.clientName ?? <None /> },
              { id: "attached", header: "Attached", cell: (attachment) => <RelativeTime value={attachment.attachedAt} className="text-zinc-400" /> },
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
    <Card title="Promotion" actions={<StatusBadge meta={freeformStateMeta(promotion.state)} />}>
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
          <span className="inline-flex items-center gap-1.5 tabular">
            {promotion.fromGeneration}
            <ArrowRight className="size-3 text-zinc-500" aria-label="to" />
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
    <Card title="Environment request" description="What the client asked for when it created the session (contents and values left out).">
      <FieldGrid columns={4}>
        <Field label="Name" mono>
          {request.name}
        </Field>
        <Field label="Type">{request.type ? <EnvironmentTypeChip type={request.type} /> : undefined}</Field>
        <Field label="Size">{request.size}</Field>
        <Field label="Network">{request.network !== undefined ? <code className="font-mono text-[12px] break-all">{formatValue(request.network, 400)}</code> : undefined}</Field>
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
                <li key={file.path} className="flex items-center gap-3 text-[12.5px]">
                  <FileText className="size-3.5 text-zinc-500" aria-hidden />
                  <span className="min-w-0 truncate font-mono text-zinc-200">{file.path}</span>
                  <span className="text-zinc-500 tabular">{formatBytes(file.bytes)}</span>
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
      <Card>
        <EmptyState icon={ShieldAlert} title="No network information">
          The gateway reports no network policy for this session.
        </EmptyState>
      </Card>
    );
  }
  const summary = summarizeNetwork(network.policy);
  return (
    <div className="space-y-5">
      <Card title="Effective policy" description="The environment's ceiling, narrowed by what the client asked for.">
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
      <Card title="Recent blocks" description="Outbound requests the policy refused (no credentials or query strings are recorded)." padded={network.recentBlocks.length === 0}>
        {network.recentBlocks.length === 0 ? (
          <p className="text-[13px] text-zinc-500">{summary?.kind === "disabled" ? "Nothing blocked recently (network access is disabled)." : "Nothing blocked recently."}</p>
        ) : (
          <DataTable
            label="Blocked requests"
            rows={network.recentBlocks}
            rowKey={(block) => String(block.id)}
            columns={[
              { id: "at", header: "Time", cell: (block) => <RelativeTime value={block.at} className="text-zinc-400" /> },
              {
                id: "reason",
                header: "Reason",
                cell: (block) => (
                  <Chip tone="warning" title={block.reason}>
                    {egressReasonLabel(block.reason)}
                  </Chip>
                ),
              },
              {
                id: "destination",
                header: "Destination",
                cell: (block) =>
                  block.host ? (
                    <span className="font-mono text-[12px] break-all text-zinc-200">
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
                cell: (block) =>
                  block.method || block.path ? (
                    <span className="font-mono text-[12px] break-all text-zinc-300">{[block.method, block.path].filter(Boolean).join(" ")}</span>
                  ) : (
                    <None />
                  ),
              },
              { id: "message", header: "Message", cell: (block) => <span className="text-[12.5px] text-zinc-400">{block.message}</span> },
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
    <Card title="Durable actions" icon={ListChecks} description="Tool calls, permissions, and input requests waiting on responders (metadata only)." padded={false}>
      <ActionsTable
        actions={session.actions}
        showSession={false}
        empty={
          <EmptyState icon={ListChecks} title="No durable actions" compact>
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
    <Card>
      <EmptyState icon={Box} title={session.placement === "shared" ? "Runs on the shared runtime" : "No sandbox yet"}>
        {session.placement === "shared"
          ? session.type === "promotable"
            ? "Shared sessions have no sandbox. This one gets a sandbox if it's promoted."
            : "Shared sessions have no sandbox."
          : "The sandbox appears here once it's provisioned."}
      </EmptyState>
    </Card>
  );
}

function ArtifactsTab({ session }: { readonly session: OperatorSessionDetail }) {
  const artifacts = session.artifacts;
  return (
    <div className="space-y-5">
      <Card
        title="Artifacts"
        icon={FileText}
        description={artifacts ? `${formatNumber(artifacts.count)} published · ${formatBytes(artifacts.bytes)}` : "Files the session published from /workspace/outputs."}
        padded={!artifacts || artifacts.latest.length === 0}
      >
        {!artifacts || artifacts.latest.length === 0 ? (
          <p className="text-[13px] text-zinc-500">No artifacts published.</p>
        ) : (
          <DataTable
            label="Latest artifacts"
            rows={artifacts.latest}
            rowKey={(artifact) => `${artifact.path}@${artifact.version}`}
            columns={[
              { id: "path", header: "Path", cell: (artifact) => <span className="font-mono text-[12px] break-all text-zinc-200">{artifact.path}</span> },
              { id: "version", header: "Version", align: "right", cell: (artifact) => <span className="text-zinc-400">v{artifact.version}</span> },
              { id: "size", header: "Size", align: "right", cell: (artifact) => <span className="text-zinc-400">{formatBytes(artifact.size)}</span> },
              { id: "state", header: "State", cell: (artifact) => <StatusBadge meta={freeformStateMeta(artifact.state)} size="xs" /> },
              { id: "published", header: "Published", cell: (artifact) => (artifact.publishedAt ? <RelativeTime value={artifact.publishedAt} className="text-zinc-400" /> : <None />) },
            ]}
          />
        )}
      </Card>
      <Card title="Schedules" icon={CalendarClock} description="Schedules that target this session." padded={session.schedules.length === 0}>
        {session.schedules.length === 0 ? (
          <p className="text-[13px] text-zinc-500">{session.scheduleId ? "None target it, but a schedule run created it (see Overview)." : "None."}</p>
        ) : (
          <ul className="divide-y divide-zinc-800/70">
            {session.schedules.map((schedule) => (
              <li key={schedule.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Link href={hrefs.view("schedules", { schedule: schedule.id })} className="text-[13px] font-medium text-sky-300 hover:underline hover:underline-offset-2">
                  {schedule.name}
                </Link>
                <span className="font-mono text-[11.5px] text-zinc-500">{shortId(schedule.id)}</span>
                <StatusBadge meta={scheduleStateMeta(schedule.state)} size="xs" className="ml-auto" />
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
    <div className="space-y-5" role="status" aria-label="Loading the session">
      <Skeleton className="h-52 rounded-2xl" />
      <div className="grid gap-5 xl:grid-cols-2">
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-32 rounded-2xl" />
      </div>
      <Skeleton className="h-40 rounded-2xl" />
    </div>
  );
}
