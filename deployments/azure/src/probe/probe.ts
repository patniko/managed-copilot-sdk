// Storage qualification probe for the gateway's data volume (Azure Files NFS in Azure).
//
// Proves, on the actual mount, the properties the gateway and the stock runtime rely on: POSIX metadata, atomic
// rename, fsync, byte-range locks that exclude another process and are released when it dies, SQLite in WAL and
// rollback-journal modes (including concurrent writers and recovery after a writer is killed mid-transaction), and
// the single-writer lease. Prints one JSON report; the exit code is 0 only when every check passed.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { Lease } from "../lease/lease.js";

export interface CheckResult {
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly detail: string;
  readonly ms: number;
}

export interface ProbeReport {
  readonly result: "passed" | "failed";
  readonly host: string;
  readonly directory: string;
  readonly filesystem?: { readonly mountPoint: string; readonly type: string; readonly options: string };
  readonly checks: readonly CheckResult[];
}

class Skip extends Error {}

/** Command line for re-running this probe's own entry point as a helper process. */
export interface ProbeOptions {
  /** Directory to test in (created; removed afterwards unless keep is set). */
  readonly directory: string;
  /** How to start a helper process: argv for `node <entry> --child ...`. */
  readonly childCommand: readonly string[];
  readonly keep?: boolean;
}

function mountFor(directory: string): ProbeReport["filesystem"] {
  try {
    let best: { mountPoint: string; type: string; options: string } | undefined;
    for (const line of readFileSync("/proc/mounts", "utf8").split("\n")) {
      const [, mountPoint, type, options] = line.split(" ");
      if (!mountPoint || !type) continue;
      const point = mountPoint.replace(/\\040/g, " ");
      if ((directory === point || directory.startsWith(point.endsWith("/") ? point : `${point}/`)) && (!best || point.length > best.mountPoint.length)) {
        best = { mountPoint: point, type, options: options ?? "" };
      }
    }
    return best;
  } catch {
    return undefined;
  }
}

async function check(results: CheckResult[], name: string, run: () => Promise<string> | string): Promise<void> {
  const started = performance.now();
  try {
    const detail = await run();
    results.push({ name, status: "passed", detail, ms: Math.round(performance.now() - started) });
  } catch (error) {
    const skipped = error instanceof Skip;
    results.push({ name, status: skipped ? "skipped" : "failed", detail: (error as Error).message, ms: Math.round(performance.now() - started) });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Helper {
  readonly lines: AsyncIterator<string>;
  kill(): Promise<void>;
  exited: Promise<number | null>;
}

function startHelper(command: readonly string[], args: readonly string[]): Helper {
  const [executable, ...rest] = command;
  const child = spawn(executable!, [...rest, "--child", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
  return {
    lines: {
      async next() {
        const next = await Promise.race([lines.next(), exited.then(() => ({ done: true as const, value: undefined }))]);
        if (next.done) throw new Error(`The helper process exited unexpectedly${stderr ? `: ${stderr.trim()}` : ""}`);
        return next;
      },
    },
    exited,
    async kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}

async function expectLine(helper: Helper, expected: string): Promise<void> {
  const { value } = await helper.lines.next();
  assert(value === expected, `The helper process reported "${String(value)}" instead of "${expected}".`);
}

function openWal(file: string, extra = ""): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = 10000; ${extra} PRAGMA journal_mode = WAL;`);
  return db;
}

function integrity(db: DatabaseSync): string {
  return (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
}

function insertRows(db: DatabaseSync, count: number, perTransaction: number, tag: string): void {
  const insert = db.prepare("INSERT INTO rows (tag, payload) VALUES (?, ?)");
  for (let done = 0; done < count; done += perTransaction) {
    db.exec("BEGIN IMMEDIATE");
    for (let i = done; i < Math.min(count, done + perTransaction); i++) insert.run(tag, `${tag}-${i}-${"x".repeat(200)}`);
    db.exec("COMMIT");
  }
}

export async function runProbe(options: ProbeOptions): Promise<ProbeReport> {
  const directory = resolve(options.directory);
  mkdirSync(directory, { recursive: true });
  const results: CheckResult[] = [];
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const posix = process.platform !== "win32";

  try {
    await check(results, "posix-metadata", () => {
      if (!posix) throw new Skip("POSIX metadata checks run on Linux only.");
      const file = join(directory, "meta.txt");
      writeFileSync(file, "meta");
      chmodSync(file, 0o640);
      assert((statSync(file).mode & 0o777) === 0o640, `chmod 0640 was not kept (mode ${(statSync(file).mode & 0o777).toString(8)}).`);
      let owner = "chown skipped (not root)";
      if (isRoot) {
        chownSync(file, 10001, 10001);
        const stat = statSync(file);
        assert(stat.uid === 10001 && stat.gid === 10001, `chown to 10001:10001 was not kept (uid ${stat.uid}, gid ${stat.gid}).`);
        owner = "chown kept";
      }
      symlinkSync("meta.txt", join(directory, "meta.link"));
      assert(readlinkSync(join(directory, "meta.link")) === "meta.txt", "The symbolic link does not point at its target.");
      linkSync(file, join(directory, "meta.hard"));
      assert(statSync(file).nlink === 2, "The hard link was not counted.");
      return `chmod kept, ${owner}, symlink and hard link work`;
    });

    await check(results, "atomic-rename", () => {
      const target = join(directory, "config.json");
      writeFileSync(target, "old");
      const temporary = join(directory, `config.json.${randomUUID()}.tmp`);
      writeFileSync(temporary, "new");
      renameSync(temporary, target);
      assert(readFileSync(target, "utf8") === "new", "Renaming over an existing file did not replace it.");
      return "rename replaces the target";
    });

    await check(results, "fsync", () => {
      const file = join(directory, "fsync.bin");
      const fd = openSync(file, "w");
      const block = Buffer.alloc(4096, 7);
      const timings: number[] = [];
      try {
        for (let i = 0; i < 20; i++) {
          const started = performance.now();
          writeSync(fd, block);
          fsyncSync(fd);
          timings.push(performance.now() - started);
        }
      } finally {
        closeSync(fd);
      }
      timings.sort((a, b) => a - b);
      return `4 KiB write+fsync median ${timings[10]!.toFixed(1)} ms, p95 ${timings[18]!.toFixed(1)} ms`;
    });

    if (process.platform !== "win32") {
      // The Azure sandbox provider makes its record of in-flight creates durable this way (write, rename, sync the directory).
      await check(results, "directory-fsync", () => {
        const fd = openSync(directory, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        return "a directory can be synced after a rename";
      });
    }

    await check(results, "lock-exclusion", async () => {
      const file = join(directory, "probe.lease");
      const holder = startHelper(options.childCommand, ["hold-lease", file]);
      try {
        await expectLine(holder, "held");
        assert(Lease.tryAcquire(file, { holder: "probe", stamp: "0" }) === undefined, "Another process took the lease while the helper held it: locks are not enforced.");
        await holder.kill();
        const deadline = Date.now() + 60_000;
        let lease: Lease | undefined;
        while (!(lease = Lease.tryAcquire(file, { holder: "probe", stamp: "0" })) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
        assert(lease, "The lock was not released within 60 s after its holder was killed.");
        const generation = lease.generation;
        lease.release();
        return `excluded while held; released after the holder was killed (generation ${generation})`;
      } finally {
        await holder.kill();
      }
    });

    for (const mode of ["wal", "rollback"] as const) {
      await check(results, `sqlite-${mode}`, () => {
        const file = join(directory, `${mode}.db`);
        const db = new DatabaseSync(file);
        try {
          db.exec(`PRAGMA busy_timeout = 10000; PRAGMA journal_mode = ${mode === "wal" ? "WAL" : "DELETE"};`);
          const journal = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
          assert(journal === (mode === "wal" ? "wal" : "delete"), `journal_mode is ${journal}.`);
          db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, tag TEXT NOT NULL, payload TEXT NOT NULL)");
          insertRows(db, 2000, 100, mode);
          if (mode === "wal") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          const count = (db.prepare("SELECT COUNT(*) AS n FROM rows").get() as { n: number }).n;
          assert(count === 2000, `Expected 2000 rows, found ${count}.`);
          const verdict = integrity(db);
          assert(verdict === "ok", `integrity_check: ${verdict}`);
          return `2000 rows in 20 transactions${mode === "wal" ? ", checkpointed" : ""}; integrity ok`;
        } finally {
          db.close();
        }
      });
    }

    await check(results, "sqlite-wal-concurrent-writers", async () => {
      const file = join(directory, "concurrent.db");
      const db = openWal(file);
      db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, tag TEXT NOT NULL, payload TEXT NOT NULL)");
      const writers = [startHelper(options.childCommand, ["wal-writer", file, "a", "500"]), startHelper(options.childCommand, ["wal-writer", file, "b", "500"])];
      try {
        for (const writer of writers) await expectLine(writer, "done");
        const count = (db.prepare("SELECT COUNT(*) AS n FROM rows").get() as { n: number }).n;
        assert(count === 1000, `Expected 1000 rows from two writers, found ${count}.`);
        const verdict = integrity(db);
        assert(verdict === "ok", `integrity_check: ${verdict}`);
        return "two processes wrote 500 rows each through the shared WAL index; integrity ok";
      } finally {
        for (const writer of writers) await writer.kill();
        db.close();
      }
    });

    for (const mode of ["wal", "rollback"] as const) {
      await check(results, `sqlite-${mode}-crash-recovery`, async () => {
        const file = join(directory, `crash-${mode}.db`);
        const writer = startHelper(options.childCommand, ["crash-writer", file, mode]);
        try {
          await expectLine(writer, "uncommitted");
          await writer.kill();
        } finally {
          await writer.kill();
        }
        const db = new DatabaseSync(file);
        try {
          db.exec("PRAGMA busy_timeout = 10000");
          const count = (db.prepare("SELECT COUNT(*) AS n FROM rows").get() as { n: number }).n;
          assert(count === 100, `Expected the 100 committed rows after the crash, found ${count}.`);
          const verdict = integrity(db);
          assert(verdict === "ok", `integrity_check: ${verdict}`);
          return "committed rows kept, the transaction in flight when the writer was killed was rolled back; integrity ok";
        } finally {
          db.close();
        }
      });
    }
  } finally {
    if (!options.keep) rmSync(directory, { recursive: true, force: true });
  }

  const failed = results.some((result) => result.status === "failed");
  return {
    result: failed ? "failed" : "passed",
    host: hostname(),
    directory,
    ...(posix ? { filesystem: mountFor(directory) } : {}),
    checks: results,
  };
}

/** Helper process roles started by the probe itself (`--child <role> ...`). */
export async function runChild(args: readonly string[]): Promise<void> {
  const [role, file, ...rest] = args;
  if (!file) throw new Error("A helper role needs a file.");
  if (role === "hold-lease") {
    const lease = Lease.tryAcquire(file, { holder: `probe-helper-${process.pid}`, stamp: "0" });
    if (!lease) throw new Error("The helper could not take the lease.");
    process.stdout.write("held\n");
    setInterval(() => lease.heartbeat(), 200);
    return new Promise(() => {}); // held until killed
  }
  if (role === "wal-writer") {
    const [tag, count] = rest;
    const db = openWal(file);
    insertRows(db, Number(count), 10, tag ?? "w");
    db.close();
    process.stdout.write("done\n");
    return;
  }
  if (role === "crash-writer") {
    const mode = rest[0] === "wal" ? "WAL" : "DELETE";
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA busy_timeout = 10000; PRAGMA journal_mode = ${mode};`);
    db.exec("CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, tag TEXT NOT NULL, payload TEXT NOT NULL)");
    insertRows(db, 100, 100, "committed");
    db.exec("BEGIN IMMEDIATE");
    const insert = db.prepare("INSERT INTO rows (tag, payload) VALUES (?, ?)");
    for (let i = 0; i < 5000; i++) insert.run("uncommitted", `${i}-${"y".repeat(500)}`);
    process.stdout.write("uncommitted\n");
    return new Promise(() => {}); // killed with the transaction open
  }
  throw new Error(`Unknown helper role "${role}".`);
}

export function defaultProbeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.MANAGED_COPILOT_DATA_DIR ?? `${sep}data`, ".probe", randomUUID());
}
