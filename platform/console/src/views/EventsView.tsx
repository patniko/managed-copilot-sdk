import type { OperatorEvent } from "@managed-copilot/protocol/operator";
import type { PlatformEventType } from "@managed-copilot/protocol";
import { Radio } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { listEvents } from "../lib/api.js";
import { mergeEvents } from "../lib/feed.js";
import { formatClockTime, formatIso, formatValue, prettyJson } from "../lib/format.js";
import { usePoll } from "../lib/poll.js";
import { useQueryUpdater } from "../lib/router.js";
import type { Query } from "../lib/routes.js";
import { eventTypeMeta, PLATFORM_EVENT_TYPES } from "../lib/status.js";
import { MAX_LIVE_EVENTS, useStreamData, useStreamStatus } from "../lib/stream.js";
import { AccountLabel, EnvironmentLink, SessionLink } from "../components/common/Identity.js";
import { FeedToolbar, FeedViewport, HistoryBanner, useAutoScroll, useFeed } from "../components/common/LiveFeed.js";
import { Page } from "../components/layout/Page.js";
import { Card } from "../components/ui/Card.js";
import { StatusBadge } from "../components/ui/Chip.js";
import { Segmented } from "../components/ui/Controls.js";
import { TableSkeleton } from "../components/ui/DataTable.js";
import { EmptyState, ErrorState, None } from "../components/ui/Feedback.js";

const HISTORY_LIMIT = 200;

function isEventType(value: string | undefined): value is PlatformEventType {
  return value !== undefined && (PLATFORM_EVENT_TYPES as readonly string[]).includes(value);
}

const idOf = (event: OperatorEvent): string => event.id;

export function EventsView({ query }: { readonly query: Query }) {
  const type = isEventType(query["type"]) ? query["type"] : undefined;
  const setQuery = useQueryUpdater();
  const history = usePoll(`events?type=${type ?? ""}&limit=${HISTORY_LIMIT}`, (signal) => listEvents({ limit: HISTORY_LIMIT, type }, signal), { intervalMs: 0 });
  const live = useStreamData().events;
  const connectedAt = useStreamStatus().connectedAt;

  // After a reconnect (not the first connection), reload the history so events missed while disconnected show up.
  const seenConnection = useRef(connectedAt);
  const { refresh } = history;
  useEffect(() => {
    const previous = seenConnection.current;
    seenConnection.current = connectedAt;
    if (connectedAt === undefined || previous === undefined || connectedAt === previous) return;
    void refresh();
  }, [connectedAt, refresh]);

  const items = useMemo(
    () => mergeEvents([history.data ?? [], type ? live.filter((event) => event.type === type) : live], MAX_LIVE_EVENTS),
    [history.data, live, type],
  );
  const feed = useFeed(items, idOf);
  const scroller = useRef<HTMLDivElement>(null);
  const { following, onScroll, jumpToLatest } = useAutoScroll(scroller, feed.shown, !feed.paused);
  const jump = useCallback(() => requestAnimationFrame(jumpToLatest), [jumpToLatest]);

  return (
    <Page
      title="Events"
      documentTitle="Events"
      icon={Radio}
      description="Platform events of every owner as they happen (metadata only: no prompts, arguments, or results)."
      fill
    >
      <div className="mb-4">
        <Segmented<string>
          label="Filter by event type"
          value={type ?? "all"}
          onChange={(value) => setQuery({ type: value === "all" ? undefined : value })}
          options={[{ value: "all", label: "All" }, ...PLATFORM_EVENT_TYPES.map((value) => ({ value, label: eventTypeMeta(value).label, icon: eventTypeMeta(value).icon }))]}
        />
      </div>
      <Card padded={false} className="flex min-h-[20rem] flex-1 flex-col" bodyClassName="flex min-h-0 flex-1 flex-col">
        <FeedToolbar feed={feed} following={following} onJump={jump} noun="events" count={feed.shown.length} />
        {history.data === undefined && history.error && live.length === 0 ? (
          <ErrorState title="Couldn't load recent events" message={history.error.message} onRetry={() => void history.refresh()} retrying={history.loading} />
        ) : history.data === undefined && history.loading && live.length === 0 ? (
          <TableSkeleton columns={6} />
        ) : feed.shown.length === 0 ? (
          <>
            <HistoryBanner error={history.error} loading={history.loading} onRetry={() => void history.refresh()} noun="events" />
            <EmptyState icon={Radio} title={type ? `No ${eventTypeMeta(type).label.toLowerCase()} events yet` : "No events yet"} compact>
              New events appear here as they happen.
            </EmptyState>
          </>
        ) : (
          <FeedViewport scrollRef={scroller} onScroll={onScroll} label="Event feed">
            <HistoryBanner error={history.error} loading={history.loading} onRetry={() => void history.refresh()} noun="events" />
            <table className="w-full border-collapse text-left text-[12.5px]" aria-label="Platform events, oldest first">
              <thead className="sticky top-0 z-10 bg-zinc-950/95 text-[11px] uppercase tracking-[0.06em] text-zinc-500 backdrop-blur">
                <tr className="border-b border-zinc-800">
                  <th scope="col" className="py-2 pr-3 pl-4 font-medium">
                    Time
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Type
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Owner
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Session
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">
                    Environment
                  </th>
                  <th scope="col" className="py-2 pr-4 pl-3 font-medium">
                    Data
                  </th>
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
      </Card>
    </Page>
  );
}

function EventRow({ event }: { readonly event: OperatorEvent }) {
  const meta = eventTypeMeta(event.type);
  const entries = Object.entries(event.data ?? {});
  return (
    <tr className="border-b border-zinc-800/50 align-top hover:bg-zinc-800/20">
      <td className="py-2 pr-3 pl-4 whitespace-nowrap">
        <time dateTime={formatIso(event.createdAt)} title={formatIso(event.createdAt)} className="font-mono text-[12px] text-zinc-400 tabular">
          {formatClockTime(event.createdAt)}
        </time>
      </td>
      <td className="px-3 py-2">
        <StatusBadge meta={meta} size="xs" title={meta.label}>
          <span className="font-mono">{event.type}</span>
        </StatusBadge>
      </td>
      <td className="px-3 py-2">
        <AccountLabel account={event.owner} size="xs" />
      </td>
      <td className="px-3 py-2">{event.sessionId ? <SessionLink id={event.sessionId} /> : <None />}</td>
      <td className="hidden px-3 py-2 lg:table-cell">{event.environment ? <EnvironmentLink name={event.environment} /> : <None />}</td>
      <td className="py-2 pr-4 pl-3">
        {entries.length === 0 && !event.sandboxId ? (
          <None />
        ) : (
          <span className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11.5px]" title={prettyJson(event.data)}>
            {event.sandboxId ? (
              <span className="min-w-0 break-all">
                <span className="text-zinc-500">sandboxId=</span>
                <span className="text-zinc-300">{event.sandboxId}</span>
              </span>
            ) : null}
            {entries.map(([key, value]) => (
              <span key={key} className="min-w-0 break-all">
                <span className="text-zinc-500">{key}=</span>
                <span className="text-zinc-300">{formatValue(value, 80)}</span>
              </span>
            ))}
          </span>
        )}
      </td>
    </tr>
  );
}
