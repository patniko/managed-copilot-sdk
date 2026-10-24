import type { Store } from "./store.js";
import { TimeInputError } from "./time.js";
import { ToolError } from "./tools/types.js";

const UNKNOWN_OUTCOME =
  "This action was started earlier and its outcome is unknown, so it was not repeated. Check whether it happened (for example in Sent mail or on the calendar) before asking to try again.";

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

  /** `aliases` are older keys for the same action (records written before the key format changed). */
  async run<T>(key: string, tool: string, effect: () => Promise<T>, options: { aliases?: readonly string[] } = {}): Promise<T> {
    for (const alias of options.aliases ?? []) {
      const earlier = this.#store.getEffect(alias);
      if (earlier?.state === "completed") return JSON.parse(earlier.result ?? "null") as T;
      if (earlier?.state === "started") throw new ToolError(UNKNOWN_OUTCOME, { uncertain: true });
    }
    const existing = this.#store.getEffect(key);
    if (existing?.state === "completed") return JSON.parse(existing.result ?? "null") as T;
    if (existing?.state === "started" || !this.#store.startEffect(key, tool)) {
      throw new ToolError(UNKNOWN_OUTCOME, { uncertain: true });
    }
    try {
      const result = await effect();
      this.#store.completeEffect(key, JSON.stringify(result ?? null));
      return result;
    } catch (error) {
      // Only a definite failure proves nothing happened, so a retry is safe. Anything else (an uncertain ToolError or an
      // unexpected error after the request may have been sent) stays recorded as started and is never repeated blindly.
      if ((error instanceof ToolError && !error.uncertain) || error instanceof TimeInputError) {
        this.#store.clearEffect(key);
        throw error;
      }
      if (error instanceof ToolError) throw error;
      throw new ToolError("Something went wrong partway through, so this action may or may not have happened. Check before trying again.", { uncertain: true });
    }
  }
}
