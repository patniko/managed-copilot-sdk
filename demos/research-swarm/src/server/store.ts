// Research Swarm's own records, in one JSON file: each question and what came of it (its researchers, the pages they
// read, and the report). Sessions and sandboxes live in Managed Copilot and are deleted when a run ends.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "../shared/types.js";
import { log } from "./log.js";

interface StoreFile {
  version: 1;
  runs: Run[];
}

/** Runs kept; older ones are dropped. */
const KEEP = 50;

export class Store {
  readonly #path: string;
  #runs: Map<string, Run>;
  #timer: NodeJS.Timeout | undefined;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.#path = join(dataDir, "research-swarm.json");
    this.#runs = new Map(Store.#read(this.#path).map((run) => [run.id, run]));
  }

  static #read(path: string): Run[] {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreFile>;
      if (parsed.version === 1 && Array.isArray(parsed.runs)) return parsed.runs;
      log.warn("Ignoring Research Swarm's records: unknown format", { path });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("Couldn't read Research Swarm's records; starting fresh", { error: (error as Error).message });
    }
    return [];
  }

  /** Most recent first. */
  list(): Run[] {
    return [...this.#runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Run | undefined {
    return this.#runs.get(id);
  }

  put(run: Run): void {
    this.#runs.set(run.id, run);
    if (this.#runs.size > KEEP) for (const old of this.list().slice(KEEP)) this.#runs.delete(old.id);
    this.#save();
  }

  remove(id: string): void {
    if (this.#runs.delete(id)) this.#save();
  }

  /** Writes soon, coalescing bursts of changes. */
  #save(): void {
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
      const data: StoreFile = { version: 1, runs: this.list() };
      writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
      renameSync(temp, this.#path);
    } catch (error) {
      log.warn("Couldn't save Research Swarm's records", { error: (error as Error).message });
    }
  }
}
