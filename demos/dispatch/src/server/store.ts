// Dispatch's own records, in one JSON file. Conversations, workers, and sandboxes live in Managed Copilot; this file
// only keeps what the platform doesn't: each conversation's settings, which messages Dispatch sent (so messages from
// Copilot CLI can be told apart), and what Dispatch saw of each worker (its state changes and published outputs).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationSettings, WorkerState } from "../shared/types.js";
import { log } from "./log.js";

export interface StoredWorker {
  timeline: { state: WorkerState; at: string }[];
  outputs?: string[];
  sandbox?: { id: string; state?: string; size?: string };
}

export interface StoredConversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  /** The orchestrator environment its coordinator session lives in (its execution style). */
  environment?: string;
  settings: ConversationSettings;
  /** Messages whose remaining commands the person approved at once. */
  approvedRest?: number[];
  /** Messages sent from Dispatch: the ID `session.send` returned and a digest of the text. */
  own: { id?: string; digest: string }[];
  workers: Record<string, StoredWorker>;
  /** Last known counts, for the list while the platform is unreachable. */
  messageCount?: number;
  sandboxCount?: number;
  liveSandboxes?: number;
}

interface StoreFile {
  version: 1;
  conversations: Record<string, StoredConversation>;
}

const OWN_LIMIT = 200;
const TIMELINE_LIMIT = 100;

export function digest(text: string): string {
  return createHash("sha256").update(text.trim()).digest("base64url").slice(0, 22);
}

export class Store {
  readonly #path: string;
  #data: StoreFile;
  #timer: NodeJS.Timeout | undefined;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.#path = join(dataDir, "dispatch.json");
    this.#data = Store.#read(this.#path);
  }

  static #read(path: string): StoreFile {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreFile>;
      if (parsed.version === 1 && parsed.conversations && typeof parsed.conversations === "object") return { version: 1, conversations: parsed.conversations };
      log.warn("Ignoring Dispatch's records: unknown format", { path });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("Couldn't read Dispatch's records; starting fresh", { error: (error as Error).message });
    }
    return { version: 1, conversations: {} };
  }

  list(): StoredConversation[] {
    return Object.values(this.#data.conversations);
  }

  get(id: string): StoredConversation | undefined {
    return this.#data.conversations[id];
  }

  /** The conversation's record, created with `defaults` if Dispatch hasn't seen it before. */
  ensure(id: string, defaults: { settings: ConversationSettings; createdAt?: string; title?: string; environment?: string }): StoredConversation {
    let conversation = this.#data.conversations[id];
    if (!conversation) {
      const at = defaults.createdAt ?? new Date().toISOString();
      conversation = {
        id,
        createdAt: at,
        updatedAt: at,
        settings: { ...defaults.settings },
        own: [],
        workers: {},
        ...(defaults.title ? { title: defaults.title } : {}),
        ...(defaults.environment ? { environment: defaults.environment } : {}),
      };
      this.#data.conversations[id] = conversation;
      this.save();
    } else if (defaults.environment && conversation.environment !== defaults.environment) {
      conversation.environment = defaults.environment;
      this.save();
    }
    return conversation;
  }

  update(id: string, change: (conversation: StoredConversation) => void): void {
    const conversation = this.#data.conversations[id];
    if (!conversation) return;
    change(conversation);
    this.save();
  }

  remove(id: string): void {
    if (!this.#data.conversations[id]) return;
    delete this.#data.conversations[id];
    this.save();
  }

  addOwn(id: string, entry: { id?: string; digest: string }): void {
    this.update(id, (conversation) => {
      conversation.own.push(entry);
      if (conversation.own.length > OWN_LIMIT) conversation.own.splice(0, conversation.own.length - OWN_LIMIT);
    });
  }

  /** Records a worker's state when it differs from the last one seen. Returns whether it changed. */
  recordWorkerState(id: string, workerId: string, state: WorkerState, at: string): boolean {
    const conversation = this.#data.conversations[id];
    if (!conversation) return false;
    const worker = (conversation.workers[workerId] ??= { timeline: [] });
    const last = worker.timeline.at(-1);
    if (last?.state === state) return false;
    // Events and polling can report the same change at slightly different times; keep the timeline in order.
    const when = last && Date.parse(at) < Date.parse(last.at) ? last.at : at;
    worker.timeline.push({ state, at: when });
    if (worker.timeline.length > TIMELINE_LIMIT) worker.timeline.splice(1, worker.timeline.length - TIMELINE_LIMIT);
    this.save();
    return true;
  }

  worker(id: string, workerId: string): StoredWorker | undefined {
    return this.#data.conversations[id]?.workers[workerId];
  }

  updateWorker(id: string, workerId: string, change: (worker: StoredWorker) => void): void {
    const conversation = this.#data.conversations[id];
    if (!conversation) return;
    change((conversation.workers[workerId] ??= { timeline: [] }));
    this.save();
  }

  /** Writes soon, coalescing bursts of changes. */
  save(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, 250);
    this.#timer.unref?.();
  }

  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    try {
      const temp = `${this.#path}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.#data, null, 2)}\n`);
      renameSync(temp, this.#path);
    } catch (error) {
      log.warn("Couldn't save Dispatch's records", { error: (error as Error).message });
    }
  }
}
