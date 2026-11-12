// Ticket classification: each customer message is classified by a stock Copilot session in the triage environment,
// which the AppHost routes to the decision model (Microsoft-Decision-1) through Help Desk's OpenAI-compatible endpoint.
// The session asks for structured output, so the reply is the schema's values: a category and whether it's urgent.
// Classification is fast and cheap, so it runs on every message before the support sessions answer.
// The same classifier also runs on an ordinary LLM (`method: "llm"`: sessions in Help Desk's own environment, on the
// support sessions' model), so Classify can show the two side by side: their time and tokens.
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

export class Triage {
  readonly #platform: TriagePlatform | undefined;
  readonly #environment: string | undefined;
  readonly #method: ClassificationMethod;
  readonly #prefix: string;
  #idle: Pooled[] = [];
  #size = 0;
  /** Sessions this process created, which aren't leftovers. */
  readonly #mine = new Set<string>();
  readonly #waiting: Array<() => void> = [];
  #failure: string | undefined;
  #generation = 0;
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
    platform?.onStatus(() => this.#changed());
    platform?.onConnected(() => {
      // Sessions belong to the client that created them: start a new pool on the new one.
      const stale = this.#idle;
      this.#generation++;
      this.#idle = [];
      this.#size = 0;
      for (const pooled of stale) this.#delete(pooled.session);
      void this.#deleteLeftovers();
      this.#changed();
    });
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
    const platform = this.#platform;
    if (!platform) throw new Error("Ticket classification isn't set up.");
    if (platform.status.state !== "connected") throw new Error(platform.status.message ?? "The triage environment isn't connected yet.");
    const pooled = await this.#acquire(platform);
    const generation = this.#generation;
    try {
      const result = await pooled.session.sendAndWait(text, CLASSIFICATION, TIMEOUT_MS);
      pooled.uses++;
      let usage: ClassificationUsage | undefined;
      try {
        const metrics = await pooled.session.rpc.usage.getMetrics();
        usage = usageBetween(pooled.metrics, metrics);
        pooled.metrics = metrics;
      } catch (error) {
        log.debug("Couldn't read a classification session's usage", { session: pooled.session.sessionId, error: (error as Error)?.message });
      }
      this.#release(pooled, generation);
      this.#setFailure(undefined);
      return { category: result.category, urgent: result.urgent, ...(usage ? { usage } : {}) };
    } catch (error) {
      // A session whose turn failed may be mid-turn: replace it rather than reuse it.
      this.#discard(pooled, generation);
      const message = `Classification failed: ${(error as Error)?.message ?? String(error)}`;
      this.#setFailure(message);
      throw new Error(message, { cause: error });
    }
  }

  async #acquire(platform: TriagePlatform): Promise<Pooled> {
    for (;;) {
      const idle = this.#idle.pop();
      if (idle) return idle;
      if (this.#size < POOL_SIZE) {
        this.#size++;
        const generation = this.#generation;
        const config = this.#sessionConfig(platform);
        this.#mine.add(config.sessionId!);
        try {
          return { session: await platform.createSession(config), uses: 0, metrics: undefined };
        } catch (error) {
          if (generation === this.#generation) this.#size--;
          this.#mine.delete(config.sessionId!);
          this.#wake();
          const message = `Couldn't start a classification session: ${(error as Error)?.message ?? String(error)}`;
          this.#setFailure(message);
          throw new Error(message, { cause: error });
        }
      }
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
  }

  #sessionConfig(platform: TriagePlatform): SessionConfig {
    return {
      sessionId: `${this.#prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      ...(platform.model ? { model: platform.model } : {}),
      streaming: false,
      availableTools: [],
      systemMessage: { mode: "replace", content: this.#method === "llm" ? LLM_TRIAGE_INSTRUCTIONS : JSON.stringify(TRIAGE_QUESTIONS) },
      onPermissionRequest: () => ({ kind: "reject", feedback: "Classification sessions don't use tools." }),
    };
  }

  #release(pooled: Pooled, generation: number): void {
    if (generation !== this.#generation) return this.#delete(pooled.session);
    if (pooled.uses >= USES_PER_SESSION) return this.#discard(pooled, generation);
    this.#idle.push(pooled);
    this.#wake();
  }

  #discard(pooled: Pooled, generation: number): void {
    if (generation === this.#generation) this.#size--;
    this.#wake();
    this.#delete(pooled.session);
  }

  #delete(session: ClassifierSession): void {
    void session
      .disconnect()
      .catch(() => undefined)
      .then(() => this.#platform?.deleteSession(session.sessionId))
      .then(() => this.#mine.delete(session.sessionId))
      .catch((error: unknown) => log.warn("Couldn't delete a classification session", { session: session.sessionId, error: (error as Error).message }));
  }

  #wake(): void {
    this.#waiting.shift()?.();
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
