import type { OperatorAction } from "@managed-copilot/protocol/operator";
import type { ReactNode } from "react";
import { parseTime } from "../../lib/format.js";
import { ACTION_KIND_LABELS, actionStateMeta } from "../../lib/status.js";
import { useNow } from "../../lib/time.js";
import { DataTable, type Column } from "../ui/DataTable.js";
import { StatusBadge } from "../ui/Chip.js";
import { None } from "../ui/Feedback.js";
import { AccountLabel, EnvironmentLink, IdText, RelativeTime, SessionLink } from "./Identity.js";

const OPEN_STATES = new Set(["pending", "claimed", "executing", "needs_reconciliation"]);

function Deadline({ action }: { readonly action: OperatorAction }) {
  const now = useNow(5000);
  const deadline = parseTime(action.deadlineAt);
  const overdue = deadline !== undefined && deadline < now && OPEN_STATES.has(action.state);
  return <RelativeTime value={action.deadlineAt} className={overdue ? "text-rose-300" : "text-zinc-400"} />;
}

function columns(showSession: boolean): Column<OperatorAction>[] {
  const all: (Column<OperatorAction> | false)[] = [
    { id: "id", header: "Action", cell: (action) => <IdText id={action.id} label="action ID" /> },
    {
      id: "kind",
      header: "Kind",
      cell: (action) => <span className="text-zinc-300">{ACTION_KIND_LABELS[action.kind] ?? action.kind}</span>,
    },
    { id: "tool", header: "Tool", cell: (action) => (action.tool ? <span className="font-mono text-[12px] text-zinc-200">{action.tool}</span> : <None />) },
    {
      id: "state",
      header: "State",
      cell: (action) => <StatusBadge meta={actionStateMeta(action.state)} size="xs" title={action.reason ?? actionStateMeta(action.state).description} />,
    },
    showSession && { id: "session", header: "Session", cell: (action) => <SessionLink id={action.sessionId} /> },
    showSession && { id: "owner", header: "Owner", cell: (action) => <AccountLabel account={action.owner} />, hideBelow: "xl" },
    showSession && { id: "environment", header: "Environment", cell: (action) => <EnvironmentLink name={action.environment} />, hideBelow: "2xl" },
    { id: "responder", header: "Responder", cell: (action) => (action.responder ? <span className="text-zinc-300">{action.responder}</span> : <None />), hideBelow: "lg" },
    {
      id: "claimed",
      header: "Claimed by",
      cell: (action) => (action.claimedBy ? <span className="font-mono text-[12px] break-all text-zinc-300">{action.claimedBy}</span> : <None />),
      hideBelow: "xl",
    },
    { id: "generation", header: "Gen", align: "right", cell: (action) => <span className="text-zinc-400">{action.generation}</span>, hideBelow: "2xl" },
    { id: "created", header: "Created", cell: (action) => <RelativeTime value={action.createdAt} className="text-zinc-400" /> },
    { id: "deadline", header: "Deadline", cell: (action) => <Deadline action={action} /> },
    {
      id: "lease",
      header: "Lease",
      cell: (action) => (action.leaseExpiresAt ? <RelativeTime value={action.leaseExpiresAt} className="text-zinc-400" /> : <None />),
      hideBelow: "lg",
    },
    {
      id: "completed",
      header: "Completed",
      cell: (action) => (action.completedAt ? <RelativeTime value={action.completedAt} className="text-zinc-400" /> : <None />),
      hideBelow: "2xl",
    },
    {
      id: "reason",
      header: "Reason",
      cell: (action) =>
        action.reason ? (
          <span className="line-clamp-2 max-w-72 text-[12.5px] text-zinc-400" title={action.reason}>
            {action.reason}
          </span>
        ) : (
          <None />
        ),
    },
  ];
  return all.filter((column): column is Column<OperatorAction> => column !== false);
}

const WITH_SESSION = columns(true);
const WITHOUT_SESSION = columns(false);

/** Durable actions: metadata only (never arguments, payloads, or results). */
export function ActionsTable({ actions, showSession = true, empty, dim }: { readonly actions: readonly OperatorAction[]; readonly showSession?: boolean; readonly empty?: ReactNode; readonly dim?: boolean }) {
  return (
    <DataTable
      label="Durable actions"
      rows={actions}
      columns={showSession ? WITH_SESSION : WITHOUT_SESSION}
      rowKey={(action) => action.id}
      rowClassName={(action) => (action.state === "needs_reconciliation" ? "bg-rose-400/[0.04]" : undefined)}
      empty={empty}
      dim={dim}
    />
  );
}
