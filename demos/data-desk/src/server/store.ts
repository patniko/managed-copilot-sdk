// Data Desk's own records, in one JSON file. Sessions, sandboxes, and published charts live in Managed Copilot; this
// file only keeps what the platform doesn't: which dataset each analysis works on, which messages Data Desk sent (so
// messages from Copilot CLI can be told apart), what Data Desk saw of the move and the session's usage, and what the
// person sent to Software Factory.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkOrderStatus } from "../shared/types.js";
import { log } from "./log.js";

export interface StoredMove {
  readonly at: string;
  readonly sandboxId: string;
  readonly durationMs?: number;
}

/** Something the person sent to Software Factory, and the work order's last known status. */
export interface StoredRouting {
  workOrderId: string;
  number: number;
  title: string;
  /** The work order's page in Software Factory, for people. */
  url: string;
  status: WorkOrderStatus;
  sentAt: string;
  /** What was sent, in words. */
  items: string[];
  /** The work order's `origin.key`: `<analysis id>:<n>`, how Data Desk finds it again. */
  key: string;
  /** The conversation's last item when it was sent: the line showing it goes right after. */
  after?: string;
  /** Why the work order failed. */
  error?: string;
  /** Software Factory no longer lists it. */
  gone?: boolean;
}

export interface StoredAnalysis {
  id: string;
  datasetId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Digests of the messages sent from Data Desk. */
  own: string[];
  /** From the `session.promoted` event. */
  move?: StoredMove;
  /** When the dataset was copied into the sandbox. */
  uploadedAt?: string;
  /** Last known premium requests, and how many were counted when the session moved. */
  usage?: { premiumRequests: number; beforeMove?: number };
  /** What the person sent to Software Factory from this analysis, oldest first. */
  factory?: StoredRouting[];
}

interface StoreFile {
  version: 1;
  analyses: Record<string, StoredAnalysis>;
}

const OWN_LIMIT = 200;

export function digest(text: string): string {
  return createHash("sha256").update(text.trim()).digest("base64url").slice(0, 22);
}

export class Store {
  readonly #path: string;
  #data: StoreFile;
  #timer: NodeJS.Timeout | undefined;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.#path = join(dataDir, "data-desk.json");
    this.#data = Store.#read(this.#path);
  }

  static #read(path: string): StoreFile {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreFile>;
      if (parsed.version === 1 && parsed.analyses && typeof parsed.analyses === "object") return { version: 1, analyses: parsed.analyses };
      log.warn("Ignoring Data Desk's records: unknown format", { path });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("Couldn't read Data Desk's records; starting fresh", { error: (error as Error).message });
    }
    return { version: 1, analyses: {} };
  }

  list(): StoredAnalysis[] {
    return Object.values(this.#data.analyses);
  }

  get(id: string): StoredAnalysis | undefined {
    return this.#data.analyses[id];
  }

  add(analysis: Pick<StoredAnalysis, "id" | "datasetId" | "title">): StoredAnalysis {
    const at = new Date().toISOString();
    const stored: StoredAnalysis = { ...analysis, createdAt: at, updatedAt: at, own: [] };
    this.#data.analyses[analysis.id] = stored;
    this.save();
    return stored;
  }

  update(id: string, change: (analysis: StoredAnalysis) => void): void {
    const analysis = this.#data.analyses[id];
    if (!analysis) return;
    change(analysis);
    this.save();
  }

  remove(id: string): void {
    if (!this.#data.analyses[id]) return;
    delete this.#data.analyses[id];
    this.save();
  }

  addOwn(id: string, text: string): void {
    this.update(id, (analysis) => {
      analysis.own.push(digest(text));
      if (analysis.own.length > OWN_LIMIT) analysis.own.splice(0, analysis.own.length - OWN_LIMIT);
    });
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
      log.warn("Couldn't save Data Desk's records", { error: (error as Error).message });
    }
  }
}
