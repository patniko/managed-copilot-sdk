import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJobId } from "../shared/jobs.js";
import type { RaceSnapshot } from "../shared/types.js";
import { log } from "./log.js";

/** Keeps the last finished race, so the board and its scorecard come back after a restart. */
export class RaceStore {
  readonly #file: string;

  constructor(dataDir: string) {
    this.#file = join(dataDir, "last-race.json");
    mkdirSync(dataDir, { recursive: true });
  }

  load(): RaceSnapshot | undefined {
    let text: string;
    try {
      text = readFileSync(this.#file, "utf8");
    } catch {
      return undefined;
    }
    try {
      const race = JSON.parse(text) as RaceSnapshot;
      if (typeof race.id !== "string" || !isJobId(race.job) || !Array.isArray(race.lanes) || !Array.isArray(race.expected) || race.state === "running") return undefined;
      return race;
    } catch {
      log.warn("Ignoring an unreadable last race", { file: this.#file });
      return undefined;
    }
  }

  save(race: RaceSnapshot): void {
    const temporary = `${this.#file}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(race));
      renameSync(temporary, this.#file);
    } catch (error) {
      log.warn("Couldn't keep the last race", { error: (error as Error).message });
    }
  }
}
