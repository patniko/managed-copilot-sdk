export interface BackoffOptions {
  readonly baseMs?: number;
  readonly maxMs?: number;
  /** Fraction of the delay to randomize (0.2 spreads ±10%). */
  readonly jitter?: number;
  readonly random?: () => number;
}

/**
 * Exponential reconnect delay for attempt 1, 2, 3, ...: 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s, with a little jitter so
 * many consoles do not reconnect in lockstep. Always within [base, max].
 */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 1000;
  const max = options.maxMs ?? 30_000;
  const jitter = options.jitter ?? 0.2;
  const random = options.random ?? Math.random;
  const exponent = Math.max(0, Math.min(30, Math.floor(attempt) - 1));
  const raw = Math.min(max, base * 2 ** exponent);
  const spread = raw * jitter * (random() - 0.5);
  return Math.round(Math.min(max, Math.max(base, raw + spread)));
}
