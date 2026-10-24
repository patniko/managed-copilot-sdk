// Creates whose outcome is not known yet. A record is written (and flushed) before a create is submitted and removed
// once Azure's answer is definite, so neither a lost answer nor a gateway crash mid-request can lead to a second
// create while Azure may still carry out the first. Records expire after the horizon (by then Azure has finished or
// dropped the request). Kept in the gateway's data directory, so a restarted gateway honors them.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { ManagedCopilotError } from "@managed-copilot/protocol";

export class UnconfirmedCreates {
  readonly #file: string;
  readonly #horizonMs: number;
  /** Loaded lazily, so a transient read error is retried on the next operation rather than fixed at start. */
  #records: Record<string, number> | undefined;

  constructor(file: string, horizonMs: number) {
    this.#file = file;
    this.#horizonMs = horizonMs;
  }

  /**
   * When the outstanding create for this key was first submitted, or undefined if there is none (any more). Throws
   * capability_unavailable when the records cannot be read: without them a second create could duplicate a resource.
   */
  outstanding(key: string, now = Date.now()): number | undefined {
    const records = this.#load();
    const since = records[key];
    if (since === undefined) return undefined;
    if (now - since < this.#horizonMs) return since;
    this.clear(key);
    return undefined;
  }

  /** Records a create about to be submitted; durable before it returns (throws if it cannot be made durable). */
  record(key: string, now = Date.now()): void {
    const records = this.#load();
    records[key] = now;
    this.#save(records);
  }

  /** Forgets a create whose outcome is now definite. Best effort: a record left behind only makes a later call look first. */
  clear(key: string): void {
    let records: Record<string, number>;
    try {
      records = this.#load();
    } catch {
      return;
    }
    if (records[key] === undefined) return;
    delete records[key];
    try {
      this.#save(records);
    } catch {
      // Kept in memory; the next successful save writes it.
    }
  }

  #load(): Record<string, number> {
    if (this.#records) return this.#records;
    let text: string;
    try {
      text = readFileSync(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return (this.#records = {});
      throw this.#unreadable((error as Error).message);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw this.#unreadable((error as Error).message);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((since) => typeof since !== "number")) {
      throw this.#unreadable("it is not a record of creates");
    }
    return (this.#records = { ...(parsed as Record<string, number>) });
  }

  #unreadable(reason: string): ManagedCopilotError {
    return new ManagedCopilotError(
      "capability_unavailable",
      `The record of Azure creates that may still take effect (${this.#file}) cannot be read (${reason}), so no sandbox or disk image is created until it can: ` +
        "a second create could duplicate one Azure is still making. If the file is damaged, check the sandbox group for duplicates, then remove it.",
    );
  }

  #save(records: Record<string, number>): void {
    const directory = dirname(this.#file);
    mkdirSync(directory, { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    const fd = openSync(temporary, "w");
    try {
      writeSync(fd, JSON.stringify(records));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.#file);
    syncDirectory(directory);
  }
}

/** Makes a rename durable where directories can be synced (Linux); elsewhere best effort. */
function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch {
    // Windows cannot open a directory for syncing.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
