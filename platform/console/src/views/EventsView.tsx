import type { OperatorEvent } from "@managed-copilot/protocol/operator";
import type { PlatformEventType } from "@managed-copilot/protocol";
import { BroadcastIcon } from "@primer/octicons-react";
import { useCallback, useMemo, useRef } from "react";
import { mergeEvents } from "../lib/feed.js";
import { formatClockTime, formatIso, formatValue, prettyJson } from "../lib/format.js";
import { useEventHistory } from "../lib/resources.js";
import { useQueryUpdater } from "../lib/router.js";
import type { Query } from "../lib/routes.js";
import { eventTypeMeta, PLATFORM_EVENT_TYPES } from "../lib/status.js";
import { MAX_LIVE_EVENTS, useStreamData } from "../lib/stream.js";
import { AccountLabel, EnvironmentLink, SessionLink } from "../components/common/Identity.js";
import { FeedToolbar, FeedViewport, HistoryBanner, useAutoScroll, useFeed } from "../components/common/LiveFeed.js";
import { Page } from "../components/layout/Page.js";
import { StatusBadge } from "../components/ui/Chip.js";
import { FilterBar, SelectField } from "../components/ui/Controls.js";
import { TableSkeleton } from "../components/ui/DataTable.js";
import { EmptyState, ErrorState, None } from "../components/ui/Feedback.js";

function isEventType(value: string | undefined): value is PlatformEventType {
  return value !== undefined && (PLATFORM_EVENT_TYPES as readonly string[]).includes(value);
}

const idOf = (event: OperatorEvent): string => event.id;

/** Platform events, live, laid out like GitHub's audit log: time, event, actor, and target. */
export function EventsView({ query }: { readonly query: Query }) {
  const type = isEventType(query["type"]) ? query["type"] : undefined;
  const setQuery = useQueryUpdater();
  const history = useEventHistory(type);
  const live = useStreamData().events;

  const items = useMemo(() => mergeEvents([history.data ?? [], type ? live.filter((event) => event.type === type) : live], MAX_LIVE_EVENTS), [history.data, live, type]);
  const feed = useFeed(items, idOf);
  const scroller = useRef<HTMLDivElement>(null);
  const { following, onScroll, jumpToLatest } = useAutoScroll(scroller, feed.shown, !feed.paused);
  const jump = useCallback(() => requestAnimationFrame(jumpToLatest), [jumpToLatest]);

  return (
    <Page title="Events" documentTitle="Events" description="Platform events of every owner as they happen (metadata only: no prompts, arguments, or results)." fill wide>
      <FilterBar className="mb-4">
        <SelectField
          label="Event type"
          value={type ?? ""}
          allLabel="All event types"
          options={PLATFORM_EVENT_TYPES.map((value) => ({ value, label: eventTypeMeta(value).label }))}
          onChange={(value) => setQuery({ type: value || undefined })}
          className="w-full sm:w-64"
        />
      </FilterBar>
      <div className="Box flex min-h-[20rem] flex-1 flex-col overflow-hidden">
        <FeedToolbar feed={feed} following={following} onJump={jump} noun="events" count={feed.shown.length} />
        {history.data === undefined && history.error && live.length === 0 ? (
          <ErrorState title="Couldn't load recent events" message={history.error.message} onRetry={() => void history.refresh()} retrying={history.loading} />
        ) : history.data === undefined && history.loading && live.length === 0 ? (
          <TableSkeleton columns={6} />
        ) : feed.shown.length === 0 ? (
          <>
            <HistoryBanner error={history.error} loading={history.loading} onRetry={() => void history.refresh()} noun="events" />
            <EmptyState icon={BroadcastIcon} title={type ? `No ${eventTypeMeta(type).label.toLowerCase()} events yet` : "No events yet"} compact>
              New events appear here as they happen.
            </EmptyState>
          </>
        ) : (
          <FeedViewport scrollRef={scroller} onScroll={onScroll} label="Event feed">
            <HistoryBanner error={history.error} loading={history.loading} onRetry={() => void history.refresh()} noun="events" />
            <table className="Table Table--sticky" aria-label="Platform events, oldest first">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Event</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Session</th>
                  <th scope="col" className="hidden lg:table-cell">
                    Environment
                  </th>
                  <th scope="col">Data</th>
                </tr>
              </thead>
              <tbody>
                {feed.shown.map((event) => (
                  <EventRow key={event.id} event={event} />
                ))}
              </tbody>
            </table>
          </FeedViewport>
        )}
      </div>
    </Page>
  );
}

function EventRow({ event }: { readonly event: OperatorEvent }) {
  const meta = eventTypeMeta(event.type);
  const entries = Object.entries(event.data ?? {});
  return (
    <tr className="align-top">
      <td className="whitespace-nowrap">
        <time dateTime={formatIso(event.createdAt)} title={formatIso(event.createdAt)} className="font-mono text-xs text-fg-muted tabular-nums">
          {formatClockTime(event.createdAt)}
        </time>
      </td>
      <td>
        <StatusBadge meta={meta} title={meta.label}>
          <span className="font-mono">{event.type}</span>
        </StatusBadge>
      </td>
      <td>
        <AccountLabel account={event.owner} size="xs" />
      </td>
      <td>{event.sessionId ? <SessionLink id={event.sessionId} /> : <None />}</td>
      <td className="hidden lg:table-cell">{event.environment ? <EnvironmentLink name={event.environment} /> : <None />}</td>
      <td>
        {entries.length === 0 && !event.sandboxId ? (
          <None />
        ) : (
          <span className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs" title={prettyJson(event.data)}>
            {event.sandboxId ? (
              <span className="min-w-0 break-all">
                <span className="text-fg-muted">sandboxId=</span>
                {event.sandboxId}
              </span>
            ) : null}
            {entries.map(([key, value]) => (
              <span key={key} className="min-w-0 break-all">
                <span className="text-fg-muted">{key}=</span>
                {formatValue(value, 80)}
              </span>
            ))}
          </span>
        )}
      </td>
    </tr>
  );
}
