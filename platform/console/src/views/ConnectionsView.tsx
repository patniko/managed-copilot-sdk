import type { OperatorConnection, OperatorUpstream } from "@managed-copilot/protocol/operator";
import { CpuIcon, PlugIcon } from "@primer/octicons-react";
import { getConnections } from "../lib/api.js";
import { formatNumber } from "../lib/format.js";
import { usePoll } from "../lib/poll.js";
import { AccountLabel, EnvironmentLink, IdText, RelativeTime, SessionLink } from "../components/common/Identity.js";
import { Page, PollContent } from "../components/layout/Page.js";
import { Card } from "../components/ui/Card.js";
import { Chip } from "../components/ui/Chip.js";
import { DataTable, TableSkeleton, type Column } from "../components/ui/DataTable.js";
import { EmptyState, None } from "../components/ui/Feedback.js";

const VISIBLE_SESSIONS = 3;

function SessionLinks({ ids }: { readonly ids: readonly string[] }) {
  if (ids.length === 0) return <None />;
  const shown = ids.slice(0, VISIBLE_SESSIONS);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      {shown.map((id) => (
        <SessionLink key={id} id={id} />
      ))}
      {ids.length > shown.length ? (
        <span className="text-xs text-fg-muted" title={ids.slice(VISIBLE_SESSIONS).join("\n")}>
          +{ids.length - shown.length} more
        </span>
      ) : null}
    </span>
  );
}

const CONNECTION_COLUMNS: readonly Column<OperatorConnection>[] = [
  { id: "id", header: "Connection", cell: (connection) => <IdText id={connection.id} label="connection ID" /> },
  { id: "kind", header: "Kind", cell: (connection) => <Chip tone={connection.kind === "cli" ? "accent" : "plain"}>{connection.kind === "cli" ? "Copilot CLI" : "SDK"}</Chip> },
  { id: "account", header: "Account", cell: (connection) => <AccountLabel account={connection.account} /> },
  { id: "environment", header: "Environment", cell: (connection) => <EnvironmentLink name={connection.environment} /> },
  { id: "client", header: "Client", cell: (connection) => (connection.clientName ? <span>{connection.clientName}</span> : <None />), hideBelow: "lg" },
  { id: "connected", header: "Connected", cell: (connection) => <RelativeTime value={connection.connectedAt} className="text-fg-muted" /> },
  { id: "activity", header: "Last activity", cell: (connection) => <RelativeTime value={connection.lastActivityAt} className="text-fg-muted" />, hideBelow: "xl" },
  {
    id: "requests",
    header: "Requests",
    align: "right",
    cell: (connection) => (connection.requests !== undefined ? <span title="JSON-RPC requests the client sent">{formatNumber(connection.requests)}</span> : <None />),
    hideBelow: "2xl",
  },
  {
    id: "notifications",
    header: "Notifications",
    align: "right",
    cell: (connection) => (connection.notifications !== undefined ? <span title="Notifications (events) the gateway sent">{formatNumber(connection.notifications)}</span> : <None />),
    hideBelow: "2xl",
  },
  { id: "sessions", header: "Sessions", cell: (connection) => <SessionLinks ids={connection.sessions} /> },
];

const UPSTREAM_COLUMNS: readonly Column<OperatorUpstream>[] = [
  { id: "id", header: "Upstream", cell: (upstream) => <span className="font-mono text-xs break-all">{upstream.id}</span> },
  { id: "kind", header: "Kind", cell: (upstream) => <Chip>{upstream.kind === "shared" ? "Shared runtime" : "Sandbox runtime"}</Chip> },
  { id: "version", header: "Runtime version", cell: (upstream) => (upstream.version ? <span className="font-mono text-xs">{upstream.version}</span> : <None />) },
  { id: "sessions", header: "Sessions", cell: (upstream) => <SessionLinks ids={upstream.sessions} /> },
];

export function ConnectionsView() {
  const poll = usePoll("connections", getConnections);
  return (
    <Page wide title="Connections" documentTitle="Connections" description="Clients connected to the gateway now, and the runtimes it bridges them to." poll={poll}>
      <PollContent
        poll={poll}
        boxed
        skeleton={
          <Card padded={false}>
            <TableSkeleton columns={7} />
          </Card>
        }
        errorTitle="Couldn't load connections"
      >
        {(data) => (
          <div className="space-y-6">
            <Card title="Clients" icon={PlugIcon} description={`${formatNumber(data.connections.length)} connected now`} padded={false}>
              <DataTable
                label="Connected clients"
                rows={data.connections}
                columns={CONNECTION_COLUMNS}
                rowKey={(connection) => connection.id}
                empty={
                  <EmptyState icon={PlugIcon} title="No clients are connected" compact>
                    SDK apps and the Copilot CLI show up here while they&apos;re connected.
                  </EmptyState>
                }
              />
            </Card>
            <Card title="Upstream runtimes" icon={CpuIcon} description="Runtime connections the gateway holds for those sessions." padded={false}>
              <DataTable
                label="Upstream runtimes"
                rows={data.upstreams}
                columns={UPSTREAM_COLUMNS}
                rowKey={(upstream) => upstream.id}
                empty={
                  <EmptyState icon={CpuIcon} title="No runtime connections" compact>
                    The gateway opens one when a session becomes resident.
                  </EmptyState>
                }
              />
            </Card>
          </div>
        )}
      </PollContent>
    </Page>
  );
}
