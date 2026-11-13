import type { ShopAvailability } from '../../shared/shop';

const POLL_MS = 3_000;

export interface ShopWatch {
  /** Settles with the server's first answer. */
  readonly ready: Promise<void>;
  stop(): void;
}

/**
 * Watches whether the Downhill Shop is open (`GET /api/shop`), so a presenter can roll it out mid-demo and every open
 * game shows it within seconds. Calls `changed` with the first answer and on every change. A server that doesn't
 * answer, or doesn't know the route, leaves the shop open, as it shipped.
 */
export function watchShop(changed: (open: boolean) => void, fetcher: typeof fetch = fetch): ShopWatch {
  let last: boolean | undefined;
  let stopped = false;
  const check = async (): Promise<void> => {
    let open = true;
    try {
      const response = await fetcher('/api/shop', { cache: 'no-store' });
      if (response.ok) open = ((await response.json()) as ShopAvailability).open !== false;
    } catch {
      // Unreachable: keep the shop as it shipped.
    }
    if (stopped || open === last) return;
    last = open;
    changed(open);
  };
  const ready = check();
  const timer = setInterval(() => {
    if (document.visibilityState !== 'hidden') void check();
  }, POLL_MS);
  return {
    ready,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
