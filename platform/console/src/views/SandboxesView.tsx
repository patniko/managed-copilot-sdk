import type { OperatorSandbox } from "@managed-copilot/protocol/operator";
import type { SandboxState } from "@managed-copilot/protocol";
import { Boxes, RefreshCw, Square } from "lucide-react";
import { listSandboxes } from "../lib/api.js";
import { formatDuration, formatNumber, shortId } from "../lib/format.js";
import { confirmProbeSandboxes, confirmStopSandbox } from "../lib/operatorActions.js";
import { usePoll } from "../lib/poll.js";
import { useOverview } from "../lib/resources.js";
import { useQueryUpdater } from "../lib/router.js";
import { buildSearch, type Query } from "../lib/routes.js";
import { SANDBOX_STATES, sandboxStateMeta } from "../lib/status.js";
import { NetworkChip } from "../components/common/Entities.js";
import { AccountLabel, EnvironmentLink, IdText, RelativeTime, SessionLink } from "../components/common/Identity.js";
import { SandboxPanel } from "../components/common/SandboxPanel.js";
import { Page, PollContent } from "../components/layout/Page.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Chip, StatusBadge } from "../components/ui/Chip.js";
import { SelectField } from "../components/ui/Controls.js";
import { DataTable, TableSkeleton, type Column } from "../components/ui/DataTable.js";
import { Drawer } from "../components/ui/Drawer.js";
import { EmptyState, None } from "../components/ui/Feedback.js";

function isSandboxState(value: string | undefined): value is SandboxState {
  return value !== undefined && (SANDBOX_STATES as readonly string[]).includes(value);
}

export function SandboxesView({ query }: { readonly query: Query }) {
  const state = isSandboxState(query["state"]) ? query["state"] : undefined;
  const filters = { state, limit: 200 };
  const poll = usePoll(`sandboxes${buildSearch(filters)}`, (signal) => listSandboxes(filters, signal), { keepPreviousData: true });
  const setQuery = useQueryUpdater();
  const counts = useOverview().data?.counts.sandboxes.byState;
  const selectedId = query["sandbox"];
  const selected = poll.data?.find((sandbox) => sandbox.id === selectedId);

  const columns: readonly Column<OperatorSandbox>[] = [
    {
      id: "id",
      header: "Sandbox",
      cell: (sandbox) => (
        <span className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={() => setQuery({ sandbox: sandbox.id }, { replace: false })}
            title={`Show details of ${sandbox.id}`}
            className="font-mono text-[12px] text-sky-300 hover:text-sky-200 hover:underline hover:underline-offset-2"
          >
            {shortId(sandbox.id)}
          </button>
        </span>
      ),
    },
    { id: "session", header: "Session", cell: (sandbox) => <SessionLink id={sandbox.sessionId} /> },
    { id: "owner", header: "Owner", cell: (sandbox) => <AccountLabel account={sandbox.owner} />, hideBelow: "lg" },
    { id: "environment", header: "Environment", cell: (sandbox) => <EnvironmentLink name={sandbox.environment} /> },
    { id: "state", header: "State", cell: (sandbox) => <StatusBadge meta={sandboxStateMeta(sandbox.state)} size="xs" title={sandbox.error?.message} /> },
    { id: "size", header: "Size", cell: (sandbox) => <Chip>{sandbox.size}</Chip>, hideBelow: "xl" },
    {
      id: "image",
      header: "Image",
      cell: (sandbox) =>
        sandbox.image ? (
          <span className="block max-w-56 truncate font-mono text-[12px] text-zinc-400" title={sandbox.imageId ? `${sandbox.image}\n${sandbox.imageId}` : sandbox.image}>
            {sandbox.image}
          </span>
        ) : (
          <None />
        ),
      hideBelow: "2xl",
    },
    { id: "network", header: "Network", cell: (sandbox) => <NetworkChip policy={sandbox.network} />, hideBelow: "xl" },
    {
      id: "activity",
      header: "Activity",
      cell: (sandbox) =>
        sandbox.activity ? (
          <span className="text-[12px] text-zinc-400" title={`${sandbox.activity.runtimes} runtime connections, ${sandbox.activity.pending} pending`}>
            {sandbox.activity.turnRunning ? <span className="text-sky-300">Turn running</span> : sandbox.activity.busy > 0 ? `${sandbox.activity.busy} busy` : "Idle"}
          </span>
        ) : (
          <None />
        ),
      hideBelow: "lg",
    },
    { id: "idle", header: "Idle timeout", cell: (sandbox) => <span className="text-zinc-400">{formatDuration(sandbox.idleTimeoutSeconds)}</span>, hideBelow: "2xl" },
    { id: "started", header: "Started", cell: (sandbox) => <RelativeTime value={sandbox.startedAt} className="text-zinc-400" /> },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (sandbox) =>
        sandbox.state === "running" ? (
          <Button size="xs" variant="danger" icon={Square} onClick={() => confirmStopSandbox(sandbox)}>
            Stop
          </Button>
        ) : null,
    },
  ];

  const total = counts ? Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0) : undefined;

  return (
    <Page
      title="Sandboxes"
      documentTitle="Sandboxes"
      icon={Boxes}
      description="Isolated compute for sandboxed sessions, across every owner."
      poll={poll}
      actions={
        <Button icon={RefreshCw} onClick={() => confirmProbeSandboxes(undefined)}>
          Check backend now
        </Button>
      }
    >
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <SelectField
          label="State"
          value={state ?? ""}
          allLabel={total !== undefined ? `All states (${formatNumber(total)})` : "All states"}
          options={SANDBOX_STATES.map((value) => ({
            value,
            label: `${sandboxStateMeta(value).label}${counts?.[value] !== undefined ? ` (${formatNumber(counts[value] ?? 0)})` : ""}`,
          }))}
          onChange={(value) => setQuery({ state: value || undefined })}
          className="w-52"
        />
      </div>
      <Card padded={false}>
        <PollContent poll={poll} skeleton={<TableSkeleton columns={8} />} errorTitle="Couldn't load sandboxes">
          {(sandboxes) => (
            <DataTable
              label="Sandboxes"
              rows={sandboxes}
              columns={columns}
              rowKey={(sandbox) => sandbox.id}
              dim={poll.stale}
              empty={
                <EmptyState icon={Boxes} title={state ? `No ${sandboxStateMeta(state).label.toLowerCase()} sandboxes` : "No sandboxes"} compact>
                  {state ? "Choose another state to see more." : "Sandboxes appear when sessions in isolated or promoted environments start."}
                </EmptyState>
              }
            />
          )}
        </PollContent>
      </Card>
      <Drawer
        open={Boolean(selectedId)}
        onClose={() => setQuery({ sandbox: undefined }, { replace: false })}
        title={
          <span className="inline-flex items-center gap-2">
            Sandbox <IdText id={selectedId} label="sandbox ID" length={12} />
          </span>
        }
      >
        {selected ? (
          <SandboxPanel sandbox={selected} />
        ) : poll.data ? (
          <EmptyState icon={Boxes} title="Sandbox not in this list" compact>
            It may have been deleted, or it doesn&apos;t match the state filter.
          </EmptyState>
        ) : null}
      </Drawer>
    </Page>
  );
}
