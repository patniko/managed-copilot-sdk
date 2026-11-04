import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STEP_IDS, type RunView, type StepLogs } from "../shared/types.js";
import { log } from "./log.js";

export interface StoredRun {
  readonly run: RunView;
  readonly logs: StepLogs;
}

const ID = /^r-[a-z0-9]{6,24}$/;

/** Repo Doctor's own records: one JSON file per run, and the run counter. Written atomically (temp file, rename). */
export class RunStore {
  readonly #dir: string;
  readonly #counterFile: string;

  constructor(dataDir: string) {
    this.#dir = join(dataDir, "runs");
    this.#counterFile = join(dataDir, "counter.json");
    mkdirSync(this.#dir, { recursive: true });
  }

  /** The last run number handed out, so numbers aren't reused after runs are deleted. */
  counter(): number {
    try {
      const value = (JSON.parse(readFileSync(this.#counterFile, "utf8")) as { last?: unknown }).last;
      return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  saveCounter(last: number): void {
    writeAtomically(this.#counterFile, JSON.stringify({ last }));
  }

  load(): StoredRun[] {
    const runs: StoredRun[] = [];
    for (const name of readdirSync(this.#dir)) {
      const id = name.replace(/\.json$/, "");
      if (!name.endsWith(".json") || !ID.test(id)) continue;
      try {
        const stored = JSON.parse(readFileSync(join(this.#dir, name), "utf8")) as StoredRun;
        if (stored?.run?.id !== id || !Array.isArray(stored.run.steps)) throw new Error("unexpected contents");
        const logs = Object.fromEntries(STEP_IDS.map((step) => [step, Array.isArray(stored.logs?.[step]) ? stored.logs[step] : []])) as unknown as StepLogs;
        runs.push({ run: stored.run, logs });
      } catch (error) {
        log.warn("Skipping a run record that can't be read", { file: name, error: (error as Error).message });
      }
    }
    return runs.sort((a, b) => b.run.number - a.run.number);
  }

  save(stored: StoredRun): void {
    writeAtomically(join(this.#dir, `${stored.run.id}.json`), JSON.stringify(stored));
  }

  remove(id: string): void {
    if (ID.test(id)) rmSync(join(this.#dir, `${id}.json`), { force: true });
  }
}

function writeAtomically(file: string, content: string): void {
  const temp = `${file}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, file);
}
