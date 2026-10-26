import type { OperatorAccount } from "@managed-copilot/protocol/operator";
import { DotFillIcon, PeopleIcon, ShieldCheckIcon } from "@primer/octicons-react";
import { formatNumber } from "../lib/format.js";
import { useAccounts } from "../lib/resources.js";
import { hrefs } from "../lib/routes.js";
import { backgroundMeta } from "../lib/status.js";
import { AccountLabel, RelativeTime } from "../components/common/Identity.js";
import { Page, PollContent } from "../components/layout/Page.js";
import { Card } from "../components/ui/Card.js";
import { Chip, StatusBadge } from "../components/ui/Chip.js";
import { DataTable, TableSkeleton, type Column } from "../components/ui/DataTable.js";
import { EmptyState, None } from "../components/ui/Feedback.js";
import { Link } from "../components/ui/Link.js";

const COLUMNS: readonly Column<OperatorAccount>[] = [
  { id: "account", header: "Account", cell: (row) => <AccountLabel account={row.account} showName size="md" /> },
  {
    id: "operator",
    header: "Operator",
    cell: (row) =>
      row.operator ? (
        <Chip icon={ShieldCheckIcon} tone="success" title="Named in the AppHost's operators (or every account on a local gateway that names none)">
          Operator
        </Chip>
      ) : (
        <None label="Not named as an operator" />
      ),
  },
  { id: "seen", header: "Last seen", cell: (row) => <RelativeTime value={row.lastSeenAt} className="text-fg-muted" /> },
  {
    id: "sessions",
    header: "Sessions",
    cell: (row) => (
      <Link href={hrefs.view("sessions", { owner: row.account.login })} className="Link--primary inline-flex items-center gap-1 whitespace-nowrap tabular-nums" title={`Show ${row.account.login}'s sessions`}>
        {formatNumber(row.sessions.total)}
        <span className="inline-flex items-center gap-0.5 text-fg-muted">
          · <DotFillIcon size={12} className={row.sessions.live > 0 ? "text-fg-success" : undefined} />
          {formatNumber(row.sessions.live)} live
        </span>
      </Link>
    ),
  },
  { id: "connections", header: "Connections", align: "right", cell: (row) => <span className={row.connections > 0 ? undefined : "text-fg-muted"}>{formatNumber(row.connections)}</span>, hideBelow: "lg" },
  {
    id: "schedules",
    header: "Schedules",
    cell: (row) => (
      <span className="tabular-nums">
        {formatNumber(row.schedules.active)} active
        {row.schedules.paused > 0 ? <span className="text-fg-attention"> · {formatNumber(row.schedules.paused)} paused</span> : null}
      </span>
    ),
    hideBelow: "2xl",
  },
  {
    id: "background",
    header: "Background sign-in",
    cell: (row) => (
      <span className="inline-flex flex-col items-start gap-1">
        <StatusBadge meta={backgroundMeta(row.background.state)} title={row.background.reason} />
        {row.background.reason ? (
          <span className="line-clamp-2 max-w-64 text-xs text-fg-muted" title={row.background.reason}>
            {row.background.reason}
          </span>
        ) : null}
        {row.background.lastVerifiedAt ? (
          <span className="text-xs text-fg-muted">
            Verified <RelativeTime value={row.background.lastVerifiedAt} />
          </span>
        ) : null}
      </span>
    ),
  },
];

export function AccountsView() {
  const poll = useAccounts();
  return (
    <Page
      wide
      title="Accounts"
      documentTitle="Accounts"
      description="GitHub accounts that have used this deployment. Operators named through an organization show as not named here."
      poll={poll}
    >
      <Card padded={false}>
        <PollContent poll={poll} skeleton={<TableSkeleton columns={6} />} errorTitle="Couldn't load accounts">
          {(accounts) => (
            <DataTable
              label="Accounts"
              rows={[...accounts].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))}
              columns={COLUMNS}
              rowKey={(row) => String(row.account.id)}
              empty={
                <EmptyState icon={PeopleIcon} title="No accounts yet" spacious>
                  Accounts appear after they sign in to the deployment.
                </EmptyState>
              }
            />
          )}
        </PollContent>
      </Card>
    </Page>
  );
}
