import type { OperatorAuditEntry } from "@managed-copilot/protocol/operator";
import { ShieldCheckIcon } from "@primer/octicons-react";
import { listAudit } from "../lib/api.js";
import { formatNumber } from "../lib/format.js";
import { usePoll } from "../lib/poll.js";
import { hrefs } from "../lib/routes.js";
import { auditActionLabel, outcomeMeta } from "../lib/status.js";
import { AccountLabel, IdText, RelativeTime } from "../components/common/Identity.js";
import { Page, PollContent } from "../components/layout/Page.js";
import { Card } from "../components/ui/Card.js";
import { StatusBadge } from "../components/ui/Chip.js";
import { DataTable, TableSkeleton, type Column } from "../components/ui/DataTable.js";
import { EmptyState, None } from "../components/ui/Feedback.js";

const LIMIT = 200;

/** Links a target to the view that shows it (sessions for sandbox stops, schedules, deliveries). */
function targetHref(entry: OperatorAuditEntry): string | undefined {
  if (!entry.target) return undefined;
  switch (entry.action) {
    case "sandbox.stop":
      return hrefs.session(entry.target);
    case "schedule.pause":
    case "schedule.resume":
      return hrefs.view("schedules", { schedule: entry.target });
    case "webhook.retry":
      return hrefs.view("webhooks");
    default:
      return undefined;
  }
}

const COLUMNS: readonly Column<OperatorAuditEntry>[] = [
  { id: "actor", header: "Operator", cell: (entry) => <AccountLabel account={entry.actor} /> },
  {
    id: "action",
    header: "Action",
    cell: (entry) => (
      <span className="inline-flex flex-col">
        <span>{auditActionLabel(entry.action)}</span>
        <span className="font-mono text-xs text-fg-muted">{entry.action}</span>
      </span>
    ),
  },
  { id: "target", header: "Target", cell: (entry) => (entry.target ? <IdText id={entry.target} label="target" href={targetHref(entry)} length={12} /> : <None />) },
  { id: "outcome", header: "Outcome", cell: (entry) => <StatusBadge meta={outcomeMeta(entry.outcome)} /> },
  {
    id: "detail",
    header: "Detail",
    cell: (entry) =>
      entry.detail ? (
        <span className="line-clamp-2 max-w-md text-fg-muted" title={entry.detail}>
          {entry.detail}
        </span>
      ) : (
        <None />
      ),
  },
  { id: "at", header: "Time", align: "right", cell: (entry) => <RelativeTime value={entry.at} className="text-fg-muted" /> },
];

/** Console sign-ins and guarded actions, laid out like GitHub's audit log. */
export function AuditView() {
  const poll = usePoll(`audit?limit=${LIMIT}`, (signal) => listAudit({ limit: LIMIT }, signal));
  return (
    <Page wide title="Audit log" documentTitle="Audit log" description="Console sign-ins and every guarded operator action, newest first." poll={poll}>
      <Card padded={false}>
        <PollContent poll={poll} skeleton={<TableSkeleton columns={6} />} errorTitle="Couldn't load the audit log">
          {(entries) => (
            <>
              <DataTable
                label="Audit log"
                rows={[...entries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id - a.id)}
                columns={COLUMNS}
                rowKey={(entry) => String(entry.id)}
                empty={
                  <EmptyState icon={ShieldCheckIcon} title="Nothing audited yet" spacious>
                    Sign-ins and operator actions are recorded here.
                  </EmptyState>
                }
              />
              {entries.length >= LIMIT ? <p className="border-t border-line bg-canvas-muted px-4 py-2 text-xs text-fg-muted">Showing the newest {formatNumber(entries.length)} entries.</p> : null}
            </>
          )}
        </PollContent>
      </Card>
    </Page>
  );
}
