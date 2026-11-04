import { AlertIcon, ChecklistIcon } from "@primer/octicons-react";
import { listActions } from "../lib/api.js";
import { formatNumber } from "../lib/format.js";
import { usePoll } from "../lib/poll.js";
import { useOverview } from "../lib/resources.js";
import { useQueryUpdater } from "../lib/router.js";
import { buildSearch, type Query } from "../lib/routes.js";
import { ActionsTable } from "../components/common/ActionsTable.js";
import { Page, PollContent } from "../components/layout/Page.js";
import { Card } from "../components/ui/Card.js";
import { Segmented } from "../components/ui/Controls.js";
import { TableSkeleton } from "../components/ui/DataTable.js";
import { EmptyState } from "../components/ui/Feedback.js";

type Filter = "open" | "attention" | "all";

const LIMIT = 200;

const EMPTY: Readonly<Record<Filter, { readonly title: string; readonly body: string }>> = {
  open: { title: "No open actions", body: "No tool calls, permission requests, or input requests are waiting on a responder." },
  attention: { title: "Nothing needs attention", body: "No actions need reconciliation or are past their deadline." },
  all: { title: "No durable actions yet", body: "Actions appear when sessions ask for tools, permissions, or input." },
};

export function ActionsView({ query }: { readonly query: Query }) {
  const filter: Filter = query["state"] === "attention" || query["state"] === "all" ? query["state"] : "open";
  // The gateway treats a missing state as "open", so "all" is sent explicitly.
  const filters = { state: filter, limit: LIMIT };
  const poll = usePoll(`actions${buildSearch(filters)}`, (signal) => listActions(filters, signal), { keepPreviousData: true });
  const setQuery = useQueryUpdater();
  const counts = useOverview().data?.counts.actions;

  return (
    <Page wide title="Actions" documentTitle="Actions" description="Durable tool calls, permission requests, and input requests of every session (metadata only)." poll={poll}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented<Filter>
          label="Which actions"
          value={filter}
          onChange={(value) => setQuery({ state: value === "open" ? undefined : value })}
          options={[
            { value: "open", label: "Open", count: counts?.open },
            { value: "attention", label: "Needs attention", icon: AlertIcon, count: counts?.needsReconciliation },
            { value: "all", label: "All" },
          ]}
        />
      </div>
      <Card padded={false}>
        <PollContent poll={poll} skeleton={<TableSkeleton columns={8} />} errorTitle="Couldn't load actions">
          {(actions) => (
            <>
              <ActionsTable
                actions={actions}
                dim={poll.stale}
                empty={
                  <EmptyState icon={ChecklistIcon} title={EMPTY[filter].title} spacious>
                    {EMPTY[filter].body}
                  </EmptyState>
                }
              />
              {actions.length >= LIMIT ? <p className="border-t border-line bg-canvas-muted px-4 py-2 text-xs text-fg-muted">Showing the newest {formatNumber(actions.length)} actions.</p> : null}
            </>
          )}
        </PollContent>
      </Card>
    </Page>
  );
}
