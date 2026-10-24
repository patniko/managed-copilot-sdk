// Creates whose outcome is not known yet. A record is written (and flushed) before a create is submitted and removed
// once Azure's answer is definite, so neither a lost answer nor a gateway crash mid-request can lead to a second
// create while Azure may still carry out the first. Time passing is not evidence of failure: records remain until a
// definite outcome is observed. Kept in the gateway's data directory, so a restarted gateway honors them.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ManagedCopilotError } from "@managed-copilot/protocol";

export class UnconfirmedCreates {
  readonly #file: string;
  /** Loaded lazily, so a transient read error is retried on the next operation rather than fixed at start. */
  #records: Record<string, number> | undefined;

  constructor(file: string) {
    this.#file = file;
  }

  /**
   * When the outstanding create for this key was first submitted, or undefined if there is none (any more). Throws
   * capability_unavailable when the records cannot be read: without them a second create could duplicate a resource.
   */
  outstanding(key: string): number | undefined {
    return this.#load()[key];
  }

  keys(): string[] {
    return Object.keys(this.#load());
  }

  /** Records a create about to be submitted; durable before it returns (throws if it cannot be made durable). */
  record(key: string, now = Date.now()): void {
    const next = { ...this.#load(), [key]: now };
    try {
      this.#save(next);
    } catch (error) {
      throw new ManagedCopilotError(
        "capability_unavailable",
        `The gateway cannot record an Azure create before submitting it (${this.#file}: ${(error as Error).message}), so it does not submit it: ` +
          "without the record, a restart could create a duplicate. Check the gateway's data volume.",
      );
    }
    this.#records = next; // only once durable: a failed save must not leave a record of a create never sent
  }

  /** Forgets a create whose outcome is now definite, without hiding a failed journal update. */
  clear(key: string): void {
    const records = this.#load();
    if (records[key] === undefined) return;
    const next = { ...records };
    delete next[key];
    try {
      this.#save(next);
    } catch (error) {
      throw new ManagedCopilotError("capability_unavailable", `The Azure creation journal (${this.#file}) could not be updated: ${(error as Error).message}. Check the gateway's data volume before retrying.`);
    }
    this.#records = next;
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((since) => typeof since !== "number" || !Number.isSafeInteger(since) || since < 0)) {
      throw this.#unreadable("it is not a record of creates");
    }
    return (this.#records = { ...(parsed as Record<string, number>) });
  }

  #unreadable(reason: string): ManagedCopilotError {
    return new ManagedCopilotError(
      "capability_unavailable",
      `The record of Azure creates that may still take effect (${this.#file}) cannot be read (${reason}), so no sandbox or disk image is created until it can: ` +
        "a second create could duplicate one Azure is still making. Restore the journal from backup or establish the outstanding operations' outcomes before repairing it.",
    );
  }

  #save(records: Record<string, number>): void {
    const directory = dirname(this.#file);
    mkdirSync(directory, { recursive: true });
    syncDirectory(dirname(directory));
    const temporary = `${this.#file}.${process.pid}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(records)); // writes every byte (a short write is retried, not ignored)
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.#file);
    syncDirectory(directory);
  }
}

/** Makes the rename durable. Windows cannot open a directory for syncing; everywhere else a failure is an error. */
function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
