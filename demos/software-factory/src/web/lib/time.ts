import { useCallback, useState, useSyncExternalStore } from "react";

interface Ticker {
  now: number;
  readonly listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | undefined;
}

const tickers = new Map<number, Ticker>();

function tickerFor(intervalMs: number): Ticker {
  let ticker = tickers.get(intervalMs);
  if (!ticker) {
    ticker = { now: Date.now(), listeners: new Set(), timer: undefined };
    tickers.set(intervalMs, ticker);
  }
  return ticker;
}

function subscribeTicker(ticker: Ticker, intervalMs: number, listener: () => void): () => void {
  if (ticker.listeners.size === 0) {
    ticker.now = Date.now();
    ticker.timer = setInterval(() => {
      ticker.now = Date.now();
      for (const notify of ticker.listeners) notify();
    }, intervalMs);
  }
  ticker.listeners.add(listener);
  return () => {
    ticker.listeners.delete(listener);
    if (ticker.listeners.size === 0 && ticker.timer !== undefined) {
      clearInterval(ticker.timer);
      ticker.timer = undefined;
    }
  };
}

const noopUnsubscribe = (): void => undefined;

/**
 * Current time in ms, re-rendering every `intervalMs` while `live` is true. Components using the same interval share
 * one timer. When not live the value only changes on re-render, which is enough for finished timers.
 */
export function useNow(intervalMs: number, live = true): number {
  const [mountedAt] = useState(() => Date.now());
  const ticker = tickerFor(intervalMs);
  const subscribe = useCallback(
    (listener: () => void) => (live ? subscribeTicker(ticker, intervalMs, listener) : noopUnsubscribe),
    [ticker, intervalMs, live],
  );
  const now = useSyncExternalStore(subscribe, () => ticker.now);
  return live ? now : Math.max(now, mountedAt);
}
