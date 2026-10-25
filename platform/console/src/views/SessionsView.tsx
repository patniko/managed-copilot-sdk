import type { OperatorSessionQuery, OperatorSessionSummary } from "@managed-copilot/protocol/operator";
import type { Placement, SessionState } from "@managed-copilot/protocol";
import { FunnelX, MessagesSquare, Plug, SearchX } from "lucide-react";
import { useId, useMemo, type ReactNode } from "react";
import { listSessions } from "../lib/api.js";
import { formatNumber } from "../lib/format.js";
import { usePoll } from "../lib/poll.js";
import { useAccounts, useEnvironments } from "../lib/resources.js";
import { useQueryUpdater } from "../lib/router.js";
import { buildSearch, hrefs, type Query } from "../lib/routes.js";
import { SESSION_STATES, sessionStateMeta, turnStatusMeta } from "../lib/status.js";
import { EnvironmentTypeChip, PlacementChip } from "../components/common/Entities.js";
import { AccountLabel, EnvironmentLink, IdText, RelativeTime } from "../components/common/Identity.js";
import { Page, PollContent } from "../components/layout/Page.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Dot, StatusBadge, StatusText } from "../components/ui/Chip.js";
import { FilterBar, SelectField, TextField } from "../components/ui/Controls.js";
import { DataTable, TableSkeleton, type Column } from "../components/ui/DataTable.js";
import { EmptyState, None } from "../components/ui/Feedback.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const PLACEMENTS: readonly Placement[] = ["shared", "sandbox"];
/** Deleted sessions are not listed, so the gateway does not accept them as a filter. */
const FILTER_STATES = SESSION_STATES.filter((state) => state !== "deleted");

function isSessionState(value: string | undefined): value is Exclude<SessionState, "deleted"> {
  return value !== undefined && (FILTER_STATES as readonly string[]).includes(value);
}

function isPlacement(value: string | undefined): value is Placement {
  return value !== undefined && (PLACEMENTS as readonly string[]).includes(value);
}

/** Filters from the address bar, in the shape of `OPERATOR_ROUTES.sessions` query parameters. */
export function sessionQueryFrom(query: Query): OperatorSessionQuery {
  const limit = Number(query["limit"]);
  return {
    owner: query["owner"]?.trim() || undefined,
    environment: query["environment"] || undefined,
    state: isSessionState(query["state"]) ? query["state"] : undefined,
    placement: isPlacement(query["placement"]) ? query["placement"] : undefined,
    q: query["q"]?.trim() || undefined,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
  };
}

export function SessionsView({ query }: { readonly query: Query }) {
  const filters = sessionQueryFrom(query);
  const key = `sessions${buildSearch({ ...filters })}`;
  const poll = usePoll(key, (signal) => listSessions(filters, signal), { keepPreviousData: true });
  const setQuery = useQueryUpdater();
  const filtered = Boolean(filters.owner || filters.environment || filters.state || filters.placement || filters.q);
  const limit = filters.limit ?? DEFAULT_LIMIT;

  return (
    <Page
      title="Sessions"
      documentTitle="Sessions"
      icon={MessagesSquare}
      description="Every session of every owner: metadata and harness, never conversation content."
      poll={poll}
    >
      <SessionFilters filters={filters} onChange={(changes) => setQuery({ ...changes, limit: undefined })} />
      <Card padded={false} className="mt-4">
        <PollContent poll={poll} skeleton={<TableSkeleton columns={7} />} errorTitle="Couldn't load sessions">
          {(sessions) => (
            <>
              <SessionsTable
                sessions={sessions}
                dim={poll.stale}
                empty={
                  filtered ? (
                    <EmptyState
                      icon={SearchX}
                      title="No sessions match these filters"
                      action={
                        <Button icon={FunnelX} onClick={() => setQuery({ owner: undefined, environment: undefined, state: undefined, placement: undefined, q: undefined, limit: undefined })}>
                          Clear filters
                        </Button>
                      }
                    >
                      Try a different owner, state, or ID prefix.
                    </EmptyState>
                  ) : (
                    <EmptyState icon={MessagesSquare} title="No sessions yet">
                      Sessions appear here as soon as an SDK client or the Copilot CLI creates one.
                    </EmptyState>
                  )
                }
              />
              {sessions.length > 0 ? (
                <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800/70 px-4 py-2.5 text-[12.5px] text-zinc-500">
                  <span className="tabular">
                    {sessions.length >= limit ? `Showing the first ${formatNumber(sessions.length)} sessions.` : `${formatNumber(sessions.length)} ${sessions.length === 1 ? "session" : "sessions"}.`}
                  </span>
                  {sessions.length >= limit && limit < MAX_LIMIT ? (
                    <Button size="xs" onClick={() => setQuery({ limit: Math.min(MAX_LIMIT, limit * 2) })}>
                      Show more
                    </Button>
                  ) : null}
                  {sessions.length >= limit && limit >= MAX_LIMIT ? <span>Narrow the filters to see the rest.</span> : null}
                </div>
              ) : null}
            </>
          )}
        </PollContent>
      </Card>
    </Page>
  );
}

function SessionFilters({ filters, onChange }: { readonly filters: OperatorSessionQuery; readonly onChange: (changes: Record<string, string | undefined>) => void }) {
  const environments = useEnvironments().data;
  const accounts = useAccounts().data;
  const ownersId = useId();
  const environmentOptions = useMemo(() => {
    const names = new Set((environments?.environments ?? []).map((environment) => environment.name));
    if (filters.environment) names.add(filters.environment);
    return [...names].sort().map((name) => ({ value: name, label: name }));
  }, [environments, filters.environment]);
  const anyFilter = Boolean(filters.owner || filters.environment || filters.state || filters.placement || filters.q);
  return (
    <FilterBar>
      <TextField label="Owner" value={filters.owner ?? ""} placeholder="Login or account ID" list={ownersId} onChange={(value) => onChange({ owner: value || undefined })} className="w-44" />
      <datalist id={ownersId}>
        {(accounts ?? []).map((account) => (
          <option key={account.account.id} value={account.account.login} />
        ))}
      </datalist>
      <SelectField label="Environment" value={filters.environment ?? ""} allLabel="All environments" options={environmentOptions} onChange={(value) => onChange({ environment: value || undefined })} className="w-44" />
      <SelectField
        label="State"
        value={filters.state ?? ""}
        allLabel="All states"
        options={FILTER_STATES.map((state) => ({ value: state, label: sessionStateMeta(state).label }))}
        onChange={(value) => onChange({ state: value || undefined })}
        className="w-36"
      />
      <SelectField
        label="Placement"
        value={filters.placement ?? ""}
        allLabel="Any placement"
        options={[
          { value: "shared", label: "Shared runtime" },
          { value: "sandbox", label: "Sandbox" },
        ]}
        onChange={(value) => onChange({ placement: value || undefined })}
        className="w-36"
      />
      <TextField label="Session ID" value={filters.q ?? ""} placeholder="ID prefix" mono onChange={(value) => onChange({ q: value || undefined })} className="w-44" />
      {anyFilter ? (
        <Button variant="ghost" icon={FunnelX} onClick={() => onChange({ owner: undefined, environment: undefined, state: undefined, placement: undefined, q: undefined })}>
          Clear
        </Button>
      ) : null}
    </FilterBar>
  );
}

const COLUMNS: readonly Column<OperatorSessionSummary>[] = [
  { id: "id", header: "Session", cell: (session) => <IdText id={session.id} label="session ID" href={hrefs.session(session.id)} />, className: "whitespace-nowrap" },
  { id: "owner", header: "Owner", cell: (session) => <AccountLabel account={session.owner} />, className: "max-w-48" },
  { id: "environment", header: "Environment", cell: (session) => <EnvironmentLink name={session.environment} />, className: "whitespace-nowrap" },
  { id: "type", header: "Type", cell: (session) => <EnvironmentTypeChip type={session.type} />, hideBelow: "2xl" },
  { id: "placement", header: "Placement", cell: (session) => <PlacementChip placement={session.placement} />, hideBelow: "xl", className: "whitespace-nowrap" },
  { id: "state", header: "State", cell: (session) => <StatusBadge meta={sessionStateMeta(session.state)} size="xs" /> },
  {
    id: "model",
    header: "Model",
    cell: (session) => (session.model ? <span className="font-mono text-[12px] whitespace-nowrap text-zinc-300">{session.model}</span> : <None />),
    hideBelow: "xl",
  },
  { id: "agent", header: "Agent", cell: (session) => (session.agent ? <span className="text-zinc-300">{session.agent}</span> : <None />), hideBelow: "2xl" },
  {
    id: "attached",
    header: "Clients",
    align: "right",
    cell: (session) => (
      <span className={session.attached > 0 ? "inline-flex items-center gap-1 text-zinc-200" : "text-zinc-500"} title={`${session.attached} attached now`}>
        {session.attached > 0 ? <Plug className="size-3 text-zinc-500" aria-hidden /> : null}
        {session.attached}
      </span>
    ),
    hideBelow: "xl",
  },
  {
    id: "live",
    header: "Live",
    className: "whitespace-nowrap",
    cell: (session) =>
      session.live ? (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-emerald-300" title="Open on a runtime connection now">
          <Dot tone="success" />
          Live
        </span>
      ) : (
        <None label="Not live">—</None>
      ),
  },
  {
    id: "turn",
    header: "Last turn",
    className: "whitespace-nowrap",
    cell: (session) =>
      session.lastTurn ? (
        <span className="inline-flex items-center gap-2 text-[12px]">
          <StatusText meta={turnStatusMeta(session.lastTurn.status)} />
          {session.lastTurn.completedAt ? <RelativeTime value={session.lastTurn.completedAt} className="text-zinc-500" /> : null}
        </span>
      ) : (
        <None />
      ),
    hideBelow: "xl",
  },
  { id: "updated", header: "Updated", cell: (session) => <RelativeTime value={session.updatedAt} className="text-zinc-400" /> },
];

export function SessionsTable({ sessions, dim = false, empty }: { readonly sessions: readonly OperatorSessionSummary[]; readonly dim?: boolean; readonly empty?: ReactNode }) {
  return (
    <DataTable
      label="Sessions"
      rows={sessions}
      columns={COLUMNS}
      rowKey={(session) => session.id}
      rowHref={(session) => hrefs.session(session.id)}
      dim={dim}
      empty={empty}
    />
  );
}
