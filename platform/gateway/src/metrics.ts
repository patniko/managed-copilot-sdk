// In-process traffic counters for the operator console: a running total plus per-minute counts for the last hour.
// Counters are cheap (no allocation per increment) and reset with the process.

const BUCKETS = 60;
const MINUTE_MS = 60_000;

class Counter {
  total = 0;
  readonly #buckets = new Array<number>(BUCKETS).fill(0);
  /** The minute (epoch minutes) the last bucket holds. */
  #minute: number;

  constructor(now: number) {
    this.#minute = Math.floor(now / MINUTE_MS);
  }

  add(by: number, now: number): void {
    this.#advance(now);
    this.total += by;
    this.#buckets[BUCKETS - 1]! += by;
  }

  series(now: number): { total: number; perMinute: number[] } {
    this.#advance(now);
    return { total: this.total, perMinute: [...this.#buckets] };
  }

  #advance(now: number): void {
    const minute = Math.floor(now / MINUTE_MS);
    const elapsed = minute - this.#minute;
    if (elapsed <= 0) return;
    if (elapsed >= BUCKETS) this.#buckets.fill(0);
    else {
      this.#buckets.splice(0, elapsed);
      for (let i = 0; i < elapsed; i++) this.#buckets.push(0);
    }
    this.#minute = minute;
  }
}

export class Metrics {
  readonly #counters = new Map<string, Counter>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  increment(name: string, by = 1): void {
    const now = this.#now();
    let counter = this.#counters.get(name);
    if (!counter) {
      counter = new Counter(now);
      this.#counters.set(name, counter);
    }
    counter.add(by, now);
  }

  /** Every counter's total and its last 60 minutes, oldest first (the last entry is the current minute). */
  snapshot(): Record<string, { total: number; perMinute: number[] }> {
    const now = this.#now();
    return Object.fromEntries([...this.#counters].map(([name, counter]) => [name, counter.series(now)]));
  }
}
