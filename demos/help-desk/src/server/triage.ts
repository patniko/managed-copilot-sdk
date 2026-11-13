// Ticket classification: each customer message is classified by a stock Copilot session in the triage environment,
// which the AppHost routes to the decision model (Microsoft-Decision-1) through Help Desk's OpenAI-compatible endpoint.
// The session asks for structured output, so the reply is the schema's values: a category and whether it's urgent.
// Classification is fast and cheap, so it runs on every message before the support sessions answer.
// The same classifier also runs on an ordinary LLM (`method: "llm"`: sessions in Help Desk's own environment, on the
// support sessions' model), so Classify can show the two side by side: their time and tokens.
// The decision model also answers other questions in batches of sessions of their own (`batch`): Answer matching
// tickets asks it whether each open ticket is about a known issue.
import type { MessageOptions, ResponseSchema, SessionConfig } from "@github/copilot-sdk";
import type { SessionInfo } from "@managed-copilot/sdk";
import { z } from "zod";
import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_INFO,
  type ClassificationMethod,
  type ClassificationUsage,
  type PlatformStatus,
  type TicketCategory,
  type TriageInfo,
} from "../shared/types.js";
import { log } from "./log.js";
import type { QuestionSpecs } from "./triage-endpoint.js";

/** The parts of a stock `CopilotSession` classification uses. */
export interface ClassifierSession {
  readonly sessionId: string;
  sendAndWait<T>(options: MessageOptions | string, schema: ResponseSchema<T>, timeout?: number): Promise<T>;
  disconnect(): Promise<void>;
  readonly rpc: { readonly usage: { getMetrics(): Promise<SessionMetrics> } };
}

/** The parts of the session's usage metrics (`session.rpc.usage.getMetrics()`) classification reports. */
export interface SessionMetrics {
  readonly modelMetrics: Readonly<Record<string, { readonly usage: { readonly inputTokens: number; readonly outputTokens: number } } | undefined>>;
}

/** What classification needs from Managed Copilot: a connection to the triage environment. */
export interface TriagePlatform {
  readonly status: PlatformStatus;
  readonly model: string | undefined;
  onStatus(listener: (status: PlatformStatus) => void): () => void;
  onConnected(listener: () => void): () => void;
  createSession(config: SessionConfig): Promise<ClassifierSession>;
  deleteSession(sessionId: string): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;
}

export interface Classification {
  readonly category: TicketCategory;
  readonly urgent: boolean;
  /** What this classification cost, from its session's usage metrics; missing when they couldn't be read. */
  readonly usage?: ClassificationUsage;
}

/** The questions, as the system message Help Desk's endpoint reads. Their names are the schema's properties. */
export const TRIAGE_QUESTIONS: QuestionSpecs = {
  category: {
    instructions: "Which kind of support request is this message from an outdoor gear shop's customer? Pick the customer's main need.",
    criteria: Object.fromEntries(TICKET_CATEGORIES.map((category) => [category, TICKET_CATEGORY_INFO[category].description])),
  },
  urgent: {
    instructions: "Does the customer need an answer urgently?",
    criteria: {
      true: "There's a near deadline (a trip, an event, a gift), the product is broken or unsafe, or the customer was charged wrongly.",
      false: "A routine question or request that can wait a day.",
    },
  },
};

/** The same questions for an ordinary LLM, in words. */
export const LLM_TRIAGE_INSTRUCTIONS = [
  "You classify messages from an outdoor gear shop's customers. Answer with the requested JSON only.",
  `category: ${TRIAGE_QUESTIONS["category"]!.instructions}`,
  ...TICKET_CATEGORIES.map((category) => `- ${category}: ${TICKET_CATEGORY_INFO[category].description}`),
  `urgent: ${TRIAGE_QUESTIONS["urgent"]!.instructions}`,
  `- true: ${TRIAGE_QUESTIONS["urgent"]!.criteria!["true"]}`,
  `- false: ${TRIAGE_QUESTIONS["urgent"]!.criteria!["false"]}`,
].join("\n");

export const CLASSIFICATION = z.object({ category: z.enum(TICKET_CATEGORIES), urgent: z.boolean() });

/** Classifier sessions are named `hdt-…` (decision model) or `hdl-…` (LLM), so leftovers are found and deleted on (re)connection. */
export const TRIAGE_SESSION_PREFIX = "hdt-";
export const LLM_TRIAGE_SESSION_PREFIX = "hdl-";
/** Classifications run in parallel, each on a session of its own. */
export const POOL_SIZE = 4;
/** The endpoint ignores history, but the session keeps it: a session is replaced after this many classifications. */
export const USES_PER_SESSION = 50;
const TIMEOUT_MS = 60_000;

interface Pooled {
  readonly session: ClassifierSession;
  /** The pool it belongs to. */
  readonly pool: Pool;
  uses: number;
  /** The session's usage metrics after its last classification. */
  metrics: SessionMetrics | undefined;
}

function tokens(metrics: SessionMetrics | undefined): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const model of Object.values(metrics?.modelMetrics ?? {})) {
    input += model?.usage.inputTokens ?? 0;
    output += model?.usage.outputTokens ?? 0;
  }
  return { input, output };
}

/** What happened between two readings of a session's usage metrics. */
export function usageBetween(before: SessionMetrics | undefined, after: SessionMetrics): ClassificationUsage {
  const start = tokens(before);
  const end = tokens(after);
  return {
    inputTokens: end.input - start.input,
    outputTokens: end.output - start.output,
  };
}

/** Sessions that share a system message: the classifier's, or a batch's of other questions. */
interface Pool {
  readonly system: string;
  idle: Pooled[];
  size: number;
  readonly waiting: Array<() => void>;
  /** Replaced (a new connection) or done (a batch): its sessions are deleted as they come back. */
  closed: boolean;
}

/** Other questions for the same model, on sessions of their own until `close()` deletes them. */
export interface DecisionBatch<T> {
  /** Asks about one text. Throws, with a plain message, when it can't. */
  ask(text: string): Promise<T>;
  close(): void;
}

export class Triage {
  readonly #platform: TriagePlatform | undefined;
  readonly #environment: string | undefined;
  readonly #method: ClassificationMethod;
  readonly #prefix: string;
  #pool: Pool;
  /** Sessions this process created, which aren't leftovers. */
  readonly #mine = new Set<string>();
  #failure: string | undefined;
  readonly #listeners = new Set<() => void>();

  /**
   * No platform: classification isn't set up, and `status` says so. `decision` sessions send the questions as JSON for
   * Help Desk's decision endpoint; `llm` sessions send them in words to the platform's model.
   */
  constructor(platform?: TriagePlatform, environment?: string, method: ClassificationMethod = "decision") {
    this.#platform = platform;
    this.#environment = environment;
    this.#method = method;
    this.#prefix = method === "llm" ? LLM_TRIAGE_SESSION_PREFIX : TRIAGE_SESSION_PREFIX;
    this.#pool = Triage.#newPool(method === "llm" ? LLM_TRIAGE_INSTRUCTIONS : JSON.stringify(TRIAGE_QUESTIONS));
    platform?.onStatus(() => this.#changed());
    platform?.onConnected(() => {
      // Sessions belong to the client that created them: start a new pool on the new one.
      const stale = this.#pool;
      this.#pool = Triage.#newPool(stale.system);
      this.#close(stale);
      void this.#deleteLeftovers();
      this.#changed();
    });
  }

  static #newPool(system: string): Pool {
    return { system, idle: [], size: 0, waiting: [], closed: false };
  }

  get method(): ClassificationMethod {
    return this.#method;
  }

  /** The model the sessions use, once connected. */
  get model(): string | undefined {
    return this.#platform?.model;
  }

  get enabled(): boolean {
    return this.#platform !== undefined;
  }

  /** Connected to the triage environment, so `classify` can try. */
  get connected(): boolean {
    return this.#platform?.status.state === "connected";
  }

  get status(): TriageInfo {
    const platform = this.#platform;
    if (!platform) return { state: "off" };
    const base = { ...(this.#environment ? { environment: this.#environment } : {}), ...(platform.model ? { model: platform.model } : {}) };
    const status = platform.status;
    if (status.state === "connected") return this.#failure ? { state: "unavailable", ...base, message: this.#failure } : { state: "ready", ...base };
    if (status.state === "unavailable") return { state: "unavailable", ...base, ...(status.message ? { message: status.message } : {}) };
    return { state: "connecting", ...base };
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Classifies one customer message. Throws, with a plain message, when it can't. */
  async classify(text: string): Promise<Classification> {
    const { result, usage } = await this.#ask(() => this.#pool, text, CLASSIFICATION, "Classification failed");
    return { category: result.category, urgent: result.urgent, ...(usage ? { usage } : {}) };
  }

  /**
   * Other questions for the decision model (the questions as JSON, the answers as `schema`), on up to `POOL_SIZE`
   * sessions of their own, which `close()` deletes. Classification's own sessions carry on undisturbed.
   */
  batch<T>(questions: QuestionSpecs, schema: ResponseSchema<T>): DecisionBatch<T> {
    if (this.#method !== "decision") throw new Error("Only the decision model takes questions as JSON.");
    const pool = Triage.#newPool(JSON.stringify(questions));
    return {
      ask: async (text) => (await this.#ask(() => pool, text, schema, "The decision model couldn't answer")).result,
      close: () => this.#close(pool),
    };
  }

  /** `pool`: the pool to ask in, as it is when a session frees up (a new connection replaces classification's). */
  async #ask<T>(pool: () => Pool, text: string, schema: ResponseSchema<T>, failed: string): Promise<{ result: T; usage?: ClassificationUsage }> {
    const platform = this.#platform;
    if (!platform) throw new Error("Ticket classification isn't set up.");
    if (platform.status.state !== "connected") throw new Error(platform.status.message ?? "The triage environment isn't connected yet.");
    const pooled = await this.#acquire(platform, pool);
    try {
      const result = await pooled.session.sendAndWait(text, schema, TIMEOUT_MS);
      pooled.uses++;
      let usage: ClassificationUsage | undefined;
      try {
        const metrics = await pooled.session.rpc.usage.getMetrics();
        usage = usageBetween(pooled.metrics, metrics);
        pooled.metrics = metrics;
      } catch (error) {
        log.debug("Couldn't read a classification session's usage", { session: pooled.session.sessionId, error: (error as Error)?.message });
      }
      this.#release(pooled);
      this.#setFailure(undefined);
      return { result, ...(usage ? { usage } : {}) };
    } catch (error) {
      // A session whose turn failed may be mid-turn: replace it rather than reuse it.
      this.#discard(pooled);
      const message = `${failed}: ${(error as Error)?.message ?? String(error)}`;
      this.#setFailure(message);
      throw new Error(message, { cause: error });
    }
  }

  async #acquire(platform: TriagePlatform, current: () => Pool): Promise<Pooled> {
    for (;;) {
      const pool = current();
      if (pool.closed) throw new Error("This batch of questions is over.");
      const idle = pool.idle.pop();
      if (idle) return idle;
      if (pool.size < POOL_SIZE) {
        pool.size++;
        const config = this.#sessionConfig(platform, pool.system);
        this.#mine.add(config.sessionId!);
        try {
          return { session: await platform.createSession(config), pool, uses: 0, metrics: undefined };
        } catch (error) {
          if (!pool.closed) pool.size--;
          this.#mine.delete(config.sessionId!);
          pool.waiting.shift()?.();
          const message = `Couldn't start a classification session: ${(error as Error)?.message ?? String(error)}`;
          this.#setFailure(message);
          throw new Error(message, { cause: error });
        }
      }
      await new Promise<void>((resolve) => pool.waiting.push(resolve));
    }
  }

  #sessionConfig(platform: TriagePlatform, system: string): SessionConfig {
    return {
      sessionId: `${this.#prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      ...(platform.model ? { model: platform.model } : {}),
      streaming: false,
      availableTools: [],
      systemMessage: { mode: "replace", content: system },
      onPermissionRequest: () => ({ kind: "reject", feedback: "Classification sessions don't use tools." }),
    };
  }

  #release(pooled: Pooled): void {
    const pool = pooled.pool;
    if (pool.closed) return this.#delete(pooled.session);
    if (pooled.uses >= USES_PER_SESSION) return this.#discard(pooled);
    pool.idle.push(pooled);
    pool.waiting.shift()?.();
  }

  #discard(pooled: Pooled): void {
    const pool = pooled.pool;
    if (!pool.closed) pool.size--;
    pool.waiting.shift()?.();
    this.#delete(pooled.session);
  }

  /** Deletes a pool's idle sessions; the busy ones are deleted when they come back. */
  #close(pool: Pool): void {
    pool.closed = true;
    for (const pooled of pool.idle.splice(0)) this.#delete(pooled.session);
    for (const wake of pool.waiting.splice(0)) wake();
  }

  #delete(session: ClassifierSession): void {
    void session
      .disconnect()
      .catch(() => undefined)
      .then(() => this.#platform?.deleteSession(session.sessionId))
      .then(() => this.#mine.delete(session.sessionId))
      .catch((error: unknown) => log.warn("Couldn't delete a classification session", { session: session.sessionId, error: (error as Error).message }));
  }

  async #deleteLeftovers(): Promise<void> {
    const platform = this.#platform;
    if (!platform) return;
    try {
      const sessions = await platform.listSessions();
      await Promise.all(sessions.filter((session) => session.id.startsWith(this.#prefix) && !this.#mine.has(session.id)).map((session) => platform.deleteSession(session.id).catch(() => undefined)));
    } catch (error) {
      log.warn("Couldn't list leftover classification sessions", { error: (error as Error).message });
    }
  }

  #setFailure(message: string | undefined): void {
    if (message === this.#failure) return;
    this.#failure = message;
    this.#changed();
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}
