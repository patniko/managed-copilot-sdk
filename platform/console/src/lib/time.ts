import { useCallback, useSyncExternalStore } from "react";

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
 * Current time in ms, re-rendering every `intervalMs` (components using the same interval share one timer). Each render
 * reads the clock too, so a timestamp that just arrived never looks like it lies in the future between ticks.
 */
export function useNow(intervalMs: number, live = true): number {
  const ticker = tickerFor(intervalMs);
  const subscribe = useCallback(
    (listener: () => void) => (live ? subscribeTicker(ticker, intervalMs, listener) : noopUnsubscribe),
    [ticker, intervalMs, live],
  );
  const now = useSyncExternalStore(subscribe, () => ticker.now);
  return Math.max(now, Date.now());
}
