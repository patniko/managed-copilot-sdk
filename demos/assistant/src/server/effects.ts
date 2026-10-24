import type { Store } from "./store.js";
import { ToolError } from "./tools/types.js";

/**
 * Records side effects (sending mail, changing events) by tool call ID so a replayed or duplicated call returns the
 * recorded result instead of acting twice. An interrupted effect with an unknown outcome is never retried blindly
 * (spec section 12, "One owner for each action").
 */
export class EffectLedger {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  async run<T>(key: string, tool: string, effect: () => Promise<T>): Promise<T> {
    const existing = this.#store.getEffect(key);
    if (existing?.state === "completed") return JSON.parse(existing.result ?? "null") as T;
    if (existing?.state === "started" || !this.#store.startEffect(key, tool)) {
      throw new ToolError(
        "This action was started earlier and its outcome is unknown, so it was not repeated. Check whether it happened (for example in Sent mail or on the calendar) before asking to try again.",
        { uncertain: true },
      );
    }
    try {
      const result = await effect();
      this.#store.completeEffect(key, JSON.stringify(result ?? null));
      return result;
    } catch (error) {
      // A definite failure means nothing happened, so a retry is safe; an uncertain one stays recorded as started.
      if (!(error instanceof ToolError && error.uncertain)) this.#store.clearEffect(key);
      throw error;
    }
  }
}
