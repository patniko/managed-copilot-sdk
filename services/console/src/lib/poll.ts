import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { ApiError, isAbortError, toApiError } from "./errors.js";

/** How often views refresh while the console is visible. */
export const POLL_INTERVAL_MS = 5000;
const MAX_ERROR_INTERVAL_MS = 30_000;
const EVICT_AFTER_MS = 5 * 60_000;

export type Fetcher<T> = (signal: AbortSignal) => Promise<T>;

interface Snapshot<T> {
  readonly data: T | undefined;
  readonly error: ApiError | undefined;
  /** When `data` last loaded (client clock, ms). */
  readonly updatedAt: number | undefined;
  readonly loading: boolean;
}

interface Entry<T> {
  readonly key: string;
  fetcher: Fetcher<T>;
  intervalMs: number;
  snapshot: Snapshot<T>;
  readonly listeners: Set<() => void>;
  failures: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  evictTimer: ReturnType<typeof setTimeout> | undefined;
  controller: AbortController | undefined;
  inflight: Promise<void> | undefined;
}

const entries = new Map<string, Entry<unknown>>();
let paused = false;
const pauseListeners = new Set<() => void>();

function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function emit(entry: Entry<unknown>): void {
  for (const listener of entry.listeners) listener();
}

function setSnapshot(entry: Entry<unknown>, next: Partial<Snapshot<unknown>>): void {
  entry.snapshot = { ...entry.snapshot, ...next };
  emit(entry);
}

function clearTimer(entry: Entry<unknown>): void {
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  entry.timer = undefined;
}

function nextDelay(entry: Entry<unknown>): number {
  const error = entry.snapshot.error;
  if (!error || entry.failures === 0) return entry.intervalMs;
  const backoff = Math.min(MAX_ERROR_INTERVAL_MS, entry.intervalMs * 2 ** Math.min(4, entry.failures - 1));
  return Math.max(backoff, (error.retryAfterSeconds ?? 0) * 1000);
}

function schedule(entry: Entry<unknown>): void {
  clearTimer(entry);
  if (entry.listeners.size === 0 || paused || !isVisible() || entry.intervalMs <= 0) return;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    void run(entry);
  }, nextDelay(entry));
}

function run(entry: Entry<unknown>): Promise<void> {
  if (entry.inflight) return entry.inflight;
  clearTimer(entry);
  const controller = new AbortController();
  entry.controller = controller;
  setSnapshot(entry, { loading: true });
  const promise = (async () => {
    try {
      const data = await entry.fetcher(controller.signal);
      if (controller.signal.aborted) return;
      entry.failures = 0;
      setSnapshot(entry, { data, error: undefined, updatedAt: Date.now(), loading: false });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      entry.failures += 1;
      setSnapshot(entry, { error: toApiError(error), loading: false });
    } finally {
      if (entry.controller === controller) {
        entry.controller = undefined;
        entry.inflight = undefined;
        if (entry.snapshot.loading) setSnapshot(entry, { loading: false });
        schedule(entry);
      }
    }
  })();
  entry.inflight = promise;
  return promise;
}

function cancel(entry: Entry<unknown>): void {
  clearTimer(entry);
  const controller = entry.controller;
  entry.controller = undefined;
  entry.inflight = undefined;
  controller?.abort();
  if (entry.snapshot.loading) entry.snapshot = { ...entry.snapshot, loading: false };
}

function getEntry<T>(key: string, fetcher: Fetcher<T>, intervalMs: number): Entry<T> {
  let entry = entries.get(key) as Entry<T> | undefined;
  if (!entry) {
    entry = {
      key,
      fetcher,
      intervalMs,
      snapshot: { data: undefined, error: undefined, updatedAt: undefined, loading: false },
      listeners: new Set(),
      failures: 0,
      timer: undefined,
      evictTimer: undefined,
      controller: undefined,
      inflight: undefined,
    };
    entries.set(key, entry as Entry<unknown>);
  }
  return entry;
}

function subscribeEntry(entry: Entry<unknown>, listener: () => void): () => void {
  if (entry.evictTimer !== undefined) {
    clearTimeout(entry.evictTimer);
    entry.evictTimer = undefined;
  }
  entry.listeners.add(listener);
  if (entry.listeners.size === 1) {
    const fresh = entry.snapshot.updatedAt !== undefined && Date.now() - entry.snapshot.updatedAt < entry.intervalMs && !entry.snapshot.error;
    if (fresh) schedule(entry);
    else if (isVisible() || entry.snapshot.data === undefined) void run(entry);
  }
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0) return;
    cancel(entry);
    entry.evictTimer = setTimeout(() => {
      if (entry.listeners.size === 0 && entries.get(entry.key) === entry) entries.delete(entry.key);
    }, EVICT_AFTER_MS);
  };
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    for (const entry of entries.values()) {
      if (entry.listeners.size === 0) continue;
      if (isVisible() && !paused) void run(entry);
      else clearTimer(entry);
    }
  });
}

/** Pauses (or resumes) automatic refreshes everywhere; manual refreshes still work. */
export function setPollingPaused(value: boolean): void {
  if (paused === value) return;
  paused = value;
  for (const listener of pauseListeners) listener();
  for (const entry of entries.values()) {
    if (entry.listeners.size === 0) continue;
    if (paused) clearTimer(entry);
    else void run(entry);
  }
}

export function isPollingPaused(): boolean {
  return paused;
}

export function usePollingPaused(): boolean {
  return useSyncExternalStore(
    (listener) => {
      pauseListeners.add(listener);
      return () => pauseListeners.delete(listener);
    },
    () => paused,
  );
}

/** Refetches every resource that a view is showing now (after a guarded action, or when live updates resume). */
export function refreshActive(): void {
  for (const entry of entries.values()) if (entry.listeners.size > 0) void refreshEntry(entry);
}

function refreshEntry(entry: Entry<unknown>): Promise<void> {
  cancel(entry);
  return run(entry);
}

/** Drops every cached response (sign-out: the next operator must never see the previous one's data). */
export function clearPollCache(): void {
  for (const entry of entries.values()) {
    cancel(entry);
    if (entry.evictTimer !== undefined) clearTimeout(entry.evictTimer);
  }
  entries.clear();
}

export interface PollState<T> {
  readonly data: T | undefined;
  readonly error: ApiError | undefined;
  readonly updatedAt: number | undefined;
  /** A request is in flight (first load or a refresh). */
  readonly loading: boolean;
  /** `data` belongs to the previous key (filters just changed) and the new answer has not arrived yet. */
  readonly stale: boolean;
  readonly refresh: () => Promise<void>;
}

export interface PollOptions {
  readonly intervalMs?: number;
  /** While a new key loads, keep returning the previous key's data (marked `stale`). For filters, not for details. */
  readonly keepPreviousData?: boolean;
}

const EMPTY: Snapshot<never> = { data: undefined, error: undefined, updatedAt: undefined, loading: false };
const noop = (): void => undefined;

/**
 * Loads `fetcher` on mount and every 5 s while the document is visible (paused while hidden, refetched on becoming
 * visible). Requests with the same `key` are shared between components, and the last good data stays available while
 * refreshing or after a failed refresh. A `null` key disables loading.
 */
export function usePoll<T>(key: string | null, fetcher: Fetcher<T>, options: PollOptions = {}): PollState<T> {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  // The key names the request completely, so the entry only changes with it; the latest fetcher is kept below.
  const entry = useMemo(() => (key === null ? undefined : getEntry<T>(key, fetcher, intervalMs)), [key]);
  if (entry) {
    entry.fetcher = fetcher;
    entry.intervalMs = intervalMs;
  }
  const subscribe = useCallback((listener: () => void) => (entry ? subscribeEntry(entry as Entry<unknown>, listener) : noop), [entry]);
  const snapshot = useSyncExternalStore(subscribe, () => (entry ? entry.snapshot : (EMPTY as Snapshot<T>)));
  const refresh = useCallback(() => (entry ? refreshEntry(entry as Entry<unknown>) : Promise.resolve()), [entry]);

  const previous = useRef<{ readonly key: string; readonly data: T; readonly updatedAt: number | undefined } | undefined>(undefined);
  useEffect(() => {
    if (key !== null && snapshot.data !== undefined) previous.current = { key, data: snapshot.data, updatedAt: snapshot.updatedAt };
  }, [key, snapshot.data, snapshot.updatedAt]);

  // Only while the new key is still loading: a failed request shows its error, never the previous filter's rows.
  const fallback =
    options.keepPreviousData && snapshot.data === undefined && snapshot.error === undefined && previous.current && previous.current.key !== key ? previous.current : undefined;
  return useMemo(
    () => ({
      data: fallback ? fallback.data : snapshot.data,
      error: snapshot.error,
      updatedAt: fallback ? fallback.updatedAt : snapshot.updatedAt,
      loading: snapshot.loading || (entry !== undefined && snapshot.data === undefined && snapshot.error === undefined),
      stale: fallback !== undefined,
      refresh,
    }),
    [fallback, snapshot, refresh, entry],
  );
}
