// Creates whose outcome Azure did not report (no answer, or a server error). Azure may still carry such a request
// out, so until the resource appears or the horizon passes (by then Azure has finished or dropped the request), no
// second create is submitted for the same key. Kept in the gateway's data directory, so a restart remembers them.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class UnconfirmedCreates {
  readonly #file: string;
  readonly #horizonMs: number;
  #records: Record<string, number>;

  constructor(file: string, horizonMs: number) {
    this.#file = file;
    this.#horizonMs = horizonMs;
    let records: Record<string, number> = {};
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object") {
        for (const [key, since] of Object.entries(parsed)) if (typeof since === "number") records[key] = since;
      }
    } catch {
      records = {};
    }
    this.#records = records;
  }

  /** When the outstanding create for this key was first attempted, or undefined if there is none (any more). */
  outstanding(key: string, now = Date.now()): number | undefined {
    const since = this.#records[key];
    if (since === undefined) return undefined;
    if (now - since < this.#horizonMs) return since;
    this.clear(key);
    return undefined;
  }

  record(key: string, now = Date.now()): void {
    if (this.#records[key] !== undefined) return;
    this.#records[key] = now;
    this.#save();
  }

  clear(key: string): void {
    if (this.#records[key] === undefined) return;
    delete this.#records[key];
    this.#save();
  }

  #save(): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.#records));
    renameSync(temporary, this.#file);
  }
}
