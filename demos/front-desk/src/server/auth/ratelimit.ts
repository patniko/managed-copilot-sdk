/** Fixed-window counters that slow down password guessing and message floods. In memory: one replica at a time. */
export class RateLimiter {
  readonly #windows = new Map<string, { count: number; resetAt: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Whether `key` has used `limit` attempts in its current window; when not, counts one more. */
  take(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterMs: number } {
    const at = this.#now();
    let window = this.#windows.get(key);
    if (!window || window.resetAt <= at) {
      window = { count: 0, resetAt: at + windowMs };
      this.#windows.set(key, window);
    }
    if (window.count >= limit) return { allowed: false, retryAfterMs: window.resetAt - at };
    window.count++;
    if (this.#windows.size > 10_000) this.#prune(at);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Whether `key` is out of attempts, without counting one. */
  blocked(key: string, limit: number): { blocked: boolean; retryAfterMs: number } {
    const at = this.#now();
    const window = this.#windows.get(key);
    if (!window || window.resetAt <= at) return { blocked: false, retryAfterMs: 0 };
    return { blocked: window.count >= limit, retryAfterMs: window.resetAt - at };
  }

  reset(key: string): void {
    this.#windows.delete(key);
  }

  #prune(at: number): void {
    for (const [key, window] of this.#windows) if (window.resetAt <= at) this.#windows.delete(key);
  }
}

export function retryAfterText(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  return minutes <= 1 ? "in a minute" : `in ${minutes} minutes`;
}
