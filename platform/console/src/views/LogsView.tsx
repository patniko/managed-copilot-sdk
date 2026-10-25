import type { OperatorLogEntry, OperatorLogLevel } from "@managed-copilot/protocol/operator";
import { ChevronRight, Logs } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listLogs } from "../lib/api.js";
import { cx } from "../lib/cx.js";
import { atLeastLevel, isLogLevel, LOG_LEVELS, logMatches, mergeLogs } from "../lib/feed.js";
import { formatIso, formatValue, parseTime, prettyJson } from "../lib/format.js";
import { usePoll } from "../lib/poll.js";
import { useQueryUpdater } from "../lib/router.js";
import type { Query } from "../lib/routes.js";
import { logLevelMeta } from "../lib/status.js";
import { MAX_LIVE_LOGS, useStreamData, useStreamStatus } from "../lib/stream.js";
import { TONE_TEXT } from "../lib/tone.js";
import { FeedToolbar, FeedViewport, HistoryBanner, useAutoScroll, useFeed } from "../components/common/LiveFeed.js";
import { Page } from "../components/layout/Page.js";
import { Card } from "../components/ui/Card.js";
import { CodeBlock } from "../components/ui/CodeBlock.js";
import { FilterBar, Segmented, SelectField, TextField } from "../components/ui/Controls.js";
import { TableSkeleton } from "../components/ui/DataTable.js";
import { EmptyState, ErrorState } from "../components/ui/Feedback.js";

const HISTORY_LIMIT = 500;
const DEFAULT_LEVEL: OperatorLogLevel = "info";

const seqOf = (entry: OperatorLogEntry): number => entry.seq;

/** "14:03:27.512". */
function logTime(iso: string): string {
  const time = parseTime(iso);
  if (time === undefined) return iso;
  const date = new Date(time);
  const pad = (value: number, size = 2): string => String(value).padStart(size, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function LogsView({ query }: { readonly query: Query }) {
  const level = isLogLevel(query["level"]) ? query["level"] : DEFAULT_LEVEL;
  const logger = query["logger"] ?? "";
  const search = query["q"] ?? "";
  const setQuery = useQueryUpdater();
  const history = usePoll(`logs?level=${level}&limit=${HISTORY_LIMIT}`, (signal) => listLogs({ level, limit: HISTORY_LIMIT }, signal), { intervalMs: 0 });
  const live = useStreamData().logs;
  const connectedAt = useStreamStatus().connectedAt;

  // After a reconnect (not the first connection), reload recent lines so anything logged while disconnected shows up.
  const seenConnection = useRef(connectedAt);
  const { refresh } = history;
  useEffect(() => {
    const previous = seenConnection.current;
    seenConnection.current = connectedAt;
    if (connectedAt === undefined || previous === undefined || connectedAt === previous) return;
    void refresh();
  }, [connectedAt, refresh]);

  const merged = useMemo(() => mergeLogs([history.data ?? [], live], MAX_LIVE_LOGS), [history.data, live]);
  const loggers = useMemo(() => {
    const names = new Set(merged.map((entry) => entry.logger));
    if (logger) names.add(logger);
    return [...names].sort();
  }, [merged, logger]);
  const items = useMemo(
    () => merged.filter((entry) => atLeastLevel(entry.level, level) && (!logger || entry.logger === logger) && logMatches(entry, search)),
    [merged, level, logger, search],
  );
  const feed = useFeed(items, seqOf);
  const scroller = useRef<HTMLDivElement>(null);
  const { following, onScroll, jumpToLatest } = useAutoScroll(scroller, feed.shown, !feed.paused);
  const jump = useCallback(() => requestAnimationFrame(jumpToLatest), [jumpToLatest]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (seq: number): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });

  return (
    <Page title="Logs" documentTitle="Logs" icon={Logs} description="The gateway's own log lines, live (credential-like values are masked)." fill>
      <FilterBar className="mb-4">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-500" aria-hidden>
            Minimum level
          </span>
          <Segmented<OperatorLogLevel>
            label="Minimum level"
            value={level}
            onChange={(value) => setQuery({ level: value === DEFAULT_LEVEL ? undefined : value })}
            options={LOG_LEVELS.map((value) => ({ value, label: logLevelMeta(value).label, icon: logLevelMeta(value).icon }))}
          />
        </div>
        <SelectField
          label="Logger"
          value={logger}
          allLabel="All loggers"
          options={loggers.map((name) => ({ value: name, label: name }))}
          onChange={(value) => setQuery({ logger: value || undefined })}
          className="w-52"
        />
        <TextField label="Search" value={search} placeholder="Message, logger, or field" onChange={(value) => setQuery({ q: value || undefined })} className="w-72" />
      </FilterBar>
      <Card padded={false} className="flex min-h-[20rem] flex-1 flex-col" bodyClassName="flex min-h-0 flex-1 flex-col">
        <FeedToolbar feed={feed} following={following} onJump={jump} noun="lines" count={feed.shown.length} />
        {history.data === undefined && history.error && live.length === 0 ? (
          <ErrorState title="Couldn't load recent logs" message={history.error.message} onRetry={() => void history.refresh()} retrying={history.loading} />
        ) : history.data === undefined && history.loading && live.length === 0 ? (
          <TableSkeleton columns={4} rows={10} />
        ) : feed.shown.length === 0 ? (
          <>
            <HistoryBanner error={history.error} loading={history.loading} onRetry={() => void history.refresh()} noun="log lines" />
            <EmptyState icon={Logs} title={search || logger ? "No lines match" : "No log lines yet"} compact>
              {search || logger ? "Change the filters, or wait for new lines." : `Nothing at ${logLevelMeta(level).label.toLowerCase()} level or above yet.`}
            </EmptyState>
          </>
        ) : (
          <FeedViewport scrollRef={scroller} onScroll={onScroll} label="Log lines" className="bg-zinc-950/60">
            <HistoryBanner error={history.error} loading={history.loading} onRetry={() => void history.refresh()} noun="log lines" />
            <ol className="py-1 font-mono text-[12px] leading-5" aria-label="Log lines, oldest first">
              {feed.shown.map((entry) => (
                <LogLine key={entry.seq} entry={entry} open={expanded.has(entry.seq)} onToggle={() => toggle(entry.seq)} />
              ))}
            </ol>
          </FeedViewport>
        )}
      </Card>
    </Page>
  );
}

function LogLine({ entry, open, onToggle }: { readonly entry: OperatorLogEntry; readonly open: boolean; readonly onToggle: () => void }) {
  const meta = logLevelMeta(entry.level);
  const Icon = meta.icon;
  const fields = entry.fields && Object.keys(entry.fields).length > 0 ? entry.fields : undefined;
  return (
    <li className={cx("px-4 hover:bg-zinc-800/25", entry.level === "error" && "bg-rose-400/[0.04]", entry.level === "warn" && "bg-amber-400/[0.03]")}>
      <div className="flex min-w-0 items-start gap-3 py-0.5">
        <time dateTime={formatIso(entry.at)} title={formatIso(entry.at)} className="shrink-0 text-zinc-500 tabular">
          {logTime(entry.at)}
        </time>
        <span className={cx("inline-flex w-14 shrink-0 items-center gap-1 text-[11px] font-semibold uppercase", TONE_TEXT[meta.tone])}>
          <Icon className="size-3" aria-hidden />
          {meta.label}
        </span>
        <span className="w-40 shrink-0 truncate text-zinc-500" title={entry.logger}>
          {entry.logger}
        </span>
        <span className="min-w-0 flex-1 break-words whitespace-pre-wrap text-zinc-200">
          {entry.message}
          {fields && !open ? (
            <span className="ml-2 text-zinc-500">
              {Object.entries(fields)
                .slice(0, 4)
                .map(([key, value]) => `${key}=${formatValue(value, 48)}`)
                .join(" ")}
              {Object.keys(fields).length > 4 ? " …" : ""}
            </span>
          ) : null}
        </span>
        {fields ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={open ? "Hide fields" : "Show fields"}
            className="mt-0.5 grid size-5 shrink-0 place-items-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <ChevronRight className={cx("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
          </button>
        ) : (
          <span className="size-5 shrink-0" aria-hidden />
        )}
      </div>
      {fields && open ? <CodeBlock className="my-1.5 ml-[12.5rem]" text={prettyJson(fields)} label="Log fields" copyLabel="Copy fields" maxHeight="md" wrap={false} /> : null}
    </li>
  );
}
