import { ArrowDownIcon, PauseIcon, PlayIcon, SyncIcon } from "@primer/octicons-react";
import { useCallback, useLayoutEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { cx } from "../../lib/cx.js";
import { formatNumber } from "../../lib/format.js";
import { setLiveUpdatesPaused, useStreamStatus } from "../../lib/stream.js";
import { Button } from "../ui/Button.js";
import { Dot } from "../ui/Chip.js";
import { Callout } from "../ui/Feedback.js";
import { Spinner } from "../ui/Spinner.js";

export interface Feed<T> {
  /** What to render: the live list, or the list as it was when the operator paused. */
  readonly shown: readonly T[];
  readonly paused: boolean;
  /** Items that arrived while paused. */
  readonly pending: number;
  readonly pause: () => void;
  readonly resume: () => void;
}

/** Freezes a live list while paused, counting what arrives meanwhile. */
export function useFeed<T>(items: readonly T[], idOf: (item: T) => string | number): Feed<T> {
  const [frozen, setFrozen] = useState<readonly T[] | null>(null);
  const pending = useMemo(() => {
    if (!frozen) return 0;
    const seen = new Set(frozen.map(idOf));
    return items.reduce((count, item) => (seen.has(idOf(item)) ? count : count + 1), 0);
  }, [frozen, items, idOf]);
  return {
    shown: frozen ?? items,
    paused: frozen !== null,
    pending,
    pause: () => setFrozen(items),
    resume: () => setFrozen(null),
  };
}

/** Keeps a scroll container pinned to its newest (bottom) entry while the operator is at the bottom. */
export function useAutoScroll(container: RefObject<HTMLElement | null>, contentKey: unknown, enabled: boolean): { readonly following: boolean; readonly onScroll: () => void; readonly jumpToLatest: () => void } {
  const [following, setFollowing] = useState(true);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || !enabled || !following) return;
    element.scrollTop = element.scrollHeight;
  }, [container, contentKey, enabled, following]);
  const onScroll = useCallback(() => {
    const element = container.current;
    if (!element) return;
    setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 48);
  }, [container]);
  const jumpToLatest = useCallback(() => {
    setFollowing(true);
    const element = container.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [container]);
  return { following, onScroll, jumpToLatest };
}

/** Live stream state, pause/resume, and "jump to latest" above a feed (the header of its Box). */
export function FeedToolbar({
  feed,
  following,
  onJump,
  noun,
  count,
}: {
  readonly feed: Feed<unknown>;
  readonly following: boolean;
  readonly onJump: () => void;
  readonly noun: string;
  readonly count: number;
}) {
  const stream = useStreamStatus();
  const status = stream.userPaused ? "paused" : stream.status;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-canvas-muted px-4 py-2">
      <span className="inline-flex min-w-0 items-center gap-1.5" role="status">
        {status === "live" ? (
          <>
            <Dot tone="success" />
            <span className="font-semibold">Live</span>
          </>
        ) : status === "connecting" || status === "reconnecting" ? (
          <>
            <Spinner className="text-fg-attention" />
            <span>{status === "connecting" ? "Connecting to the live stream…" : "Reconnecting to the live stream…"}</span>
          </>
        ) : status === "paused" ? (
          <>
            <PauseIcon size={16} className="text-fg-muted" />
            <span>Live updates are paused for the whole console.</span>
            <button type="button" onClick={() => setLiveUpdatesPaused(false)} className="Link font-semibold">
              Resume
            </button>
          </>
        ) : (
          <span className="text-fg-muted">Not connected to the live stream.</span>
        )}
      </span>
      <span className="text-fg-muted" aria-hidden>
        ·
      </span>
      <span className="text-fg-muted tabular-nums">
        {formatNumber(count)} {noun}
      </span>
      <div className="ml-auto flex items-center gap-2">
        {!following && !feed.paused ? (
          <Button size="sm" icon={ArrowDownIcon} onClick={onJump}>
            Jump to latest
          </Button>
        ) : null}
        {feed.paused ? (
          <Button
            size="sm"
            variant="primary"
            icon={PlayIcon}
            onClick={() => {
              feed.resume();
              onJump();
            }}
          >
            Resume{feed.pending > 0 ? ` · ${formatNumber(feed.pending)} new` : ""}
          </Button>
        ) : (
          <Button size="sm" icon={PauseIcon} onClick={feed.pause} title={`Stop adding new ${noun} while you read`}>
            Pause
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Shown when reloading a feed's recent history failed (initially or after a reconnect). Live entries keep arriving,
 * but entries from while the stream was down may be missing until a reload succeeds.
 */
export function HistoryBanner({ error, loading, onRetry, noun }: { readonly error: { readonly message: string } | undefined; readonly loading: boolean; readonly onRetry: () => void; readonly noun: string }) {
  if (!error) return null;
  return (
    <Callout
      tone="attention"
      role="status"
      small
      className="m-3"
      actions={
        <Button size="sm" icon={SyncIcon} loading={loading} onClick={onRetry}>
          Retry
        </Button>
      }
    >
      Couldn&apos;t load recent {noun}: {error.message} New {noun} still appear live; some from before may be missing.
    </Callout>
  );
}

/** The scrolling region of a feed. */
export function FeedViewport({
  scrollRef,
  onScroll,
  label,
  children,
  className,
}: {
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly onScroll: () => void;
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div ref={scrollRef} onScroll={onScroll} tabIndex={0} aria-label={label} className={cx("relative min-h-0 flex-1 overflow-auto focus-visible:-outline-offset-2", className)}>
      {children}
    </div>
  );
}
