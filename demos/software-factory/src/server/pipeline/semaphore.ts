import { CancelledError } from "./errors.js";

/** Counting semaphore with abortable waits (limits concurrent sandboxes). */
export class Semaphore {
  #available: number;
  readonly #waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];

  constructor(count: number) {
    this.#available = count;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new CancelledError();
    if (this.#available > 0) {
      this.#available--;
      return this.#releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject,
      };
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new CancelledError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
    });
    return this.#releaser();
  }

  #releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) next.resolve();
      else this.#available++;
    };
  }
}
