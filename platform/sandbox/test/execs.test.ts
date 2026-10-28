import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecManager, STOPPED_BY_RESTART, utf8Complete } from "../src/sandboxd/execs.js";
import type { Log } from "../src/shared/log.js";

const log: Log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Log;
const posix = process.platform !== "win32";

/** Runs commands as Node scripts (`node -e <command>`), so the journal is tested without bash or setpriv. */
function manager(dir: string, options: { ready?: boolean; limits?: ConstructorParameters<typeof ExecManager>[0]["limits"] } = {}): ExecManager {
  return new ExecManager({
    dir,
    log,
    launch: (command, env) => ({ command: process.execPath, args: ["-e", command], cwd: dir, env: { ...env, PATH: process.env.PATH ?? "" } }),
    env: () => (options.ready === false ? undefined : { GREETING: "hello" }),
    processGroups: posix,
    ...(options.limits ? { limits: options.limits } : {}),
  });
}

async function finished(execs: ExecManager, id: string) {
  for (let i = 0; i < 100; i++) {
    const record = await execs.wait(id, { waitMs: 5000 });
    if (record.state !== "running") return record;
  }
  throw new Error("never finished");
}

describe("sandboxd command journal", () => {
  let dir: string;
  let execs: ExecManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mc-execs-"));
    execs = manager(dir);
    await execs.load();
  });

  afterEach(async () => {
    await execs.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a command with the workload environment and records its exit and output", async () => {
    const started = await execs.start({ id: "one", command: "process.stdout.write(process.env.GREETING + ' world\\n'); process.stderr.write('warn\\n'); process.exit(3)" });
    expect(started).toMatchObject({ id: "one", state: "running", stdin: "closed", outputBytes: 0 });
    const record = await finished(execs, "one");
    expect(record).toMatchObject({ state: "completed", exitCode: 3 });
    const read = await execs.read("one", 0);
    expect(read.output).toContain("hello world\n");
    expect(read.output).toContain("warn\n");
    expect(read.offset).toBe(record.outputBytes);
    expect((await execs.read("one", read.offset)).output).toBe("");
  });

  it("answers a start with a known ID with that command and never runs it twice", async () => {
    await execs.start({ id: "once", command: "console.log('ran')" });
    await finished(execs, "once");
    const again = await execs.start({ id: "once", command: "console.log('ran again')" });
    expect(again.command).toBe("console.log('ran')");
    expect((await execs.read("once", 0)).output).toBe("ran\n");
  });

  it("reads new output from an offset, waiting for it", async () => {
    await execs.start({ id: "ticks", command: "let n = 0; const t = setInterval(() => { console.log('tick ' + ++n); if (n === 3) clearInterval(t); }, 150)" });
    let offset = 0;
    let text = "";
    for (;;) {
      const read = await execs.read("ticks", offset, { waitMs: 5000 });
      text += read.output;
      offset = read.offset;
      if (read.exec.state !== "running" && read.output === "") break;
    }
    expect(text).toBe("tick 1\ntick 2\ntick 3\n");
  });

  it("writes stdin to an open command and closes it", async () => {
    await execs.start({ id: "cat", command: "process.stdin.pipe(process.stdout)", stdin: "open" });
    await execs.input("cat", "first line\n", false);
    await execs.input("cat", "second line\n", true);
    const record = await finished(execs, "cat");
    expect(record).toMatchObject({ state: "completed", exitCode: 0 });
    expect((await execs.read("cat", 0)).output).toBe("first line\nsecond line\n");
    await expect(execs.input("cat", "late", false)).rejects.toMatchObject({ code: "conflict" });
  });

  it("closes stdin by default, so a command that reads it ends", async () => {
    await execs.start({ id: "eof", command: "let n = 0; process.stdin.on('data', (d) => (n += d.length)); process.stdin.on('end', () => console.log('bytes', n))" });
    expect(await finished(execs, "eof")).toMatchObject({ state: "completed", exitCode: 0 });
    expect((await execs.read("eof", 0)).output).toBe("bytes 0\n");
    await expect(execs.input("eof", "x", false)).rejects.toMatchObject({ code: "conflict" });
  });

  it("times out a command and stops it with a reason", async () => {
    await execs.start({ id: "slow", command: "setTimeout(() => {}, 60000)", timeoutMs: 300 });
    const record = await finished(execs, "slow");
    expect(record.state).toBe("timed_out");
    expect(record.reason).toMatch(/timeout/);
  });

  it("stops a running command with the caller's reason", async () => {
    await execs.start({ id: "forever", command: "console.log('up'); setInterval(() => {}, 1000)" });
    await execs.read("forever", 0, { waitMs: 5000 });
    const record = await execs.stop("forever", "Stopped by the test.");
    expect(record).toMatchObject({ state: "stopped", reason: "Stopped by the test." });
    expect(execs.running()).toEqual([]);
  });

  it("keeps only the newest output and reports what a read skipped", async () => {
    const small = manager(dir, { limits: { outputBytes: 64, readBytes: 16 } });
    await small.load();
    await small.start({ id: "loud", command: "process.stdout.write('a'.repeat(100) + 'b'.repeat(20))" });
    await finished(small, "loud");
    const read = await small.read("loud", 0);
    expect(read.skippedBytes).toBe(120 - 64);
    expect(read.output).toBe("a".repeat(16));
    expect(read.offset).toBe(56 + 16);
    let text = read.output;
    let offset = read.offset;
    for (;;) {
      const next = await small.read("loud", offset);
      if (next.output === "") break;
      text += next.output;
      offset = next.offset;
    }
    expect(text).toBe("a".repeat(44) + "b".repeat(20));
    await small.shutdown();
  });

  it("never splits a UTF-8 character between reads", () => {
    const euro = Buffer.from("x€", "utf8");
    expect(utf8Complete(euro)).toBe(4);
    expect(utf8Complete(euro.subarray(0, 3))).toBe(1);
    expect(utf8Complete(euro.subarray(0, 2))).toBe(1);
    expect(utf8Complete(Buffer.from("plain"))).toBe(5);
  });

  it("journals commands, so a restarted sandboxd reports them and marks cut-off ones stopped", async () => {
    await execs.start({ id: "done", command: "console.log('kept')" });
    await finished(execs, "done");
    await execs.start({ id: "cut", command: "console.log('working'); setInterval(() => {}, 1000)" });
    await execs.read("cut", 0, { waitMs: 5000 });
    // A crash: nothing stops it gracefully. Its last journal entry says it is running.
    const journal = JSON.parse(readFileSync(join(dir, "cut.json"), "utf8")) as { record: { state: string } };
    expect(journal.record.state).toBe("running");

    const restarted = manager(dir);
    await restarted.load();
    expect(restarted.get("done")).toMatchObject({ state: "completed", exitCode: 0 });
    expect((await restarted.read("done", 0)).output).toBe("kept\n");
    expect(restarted.get("cut")).toMatchObject({ state: "stopped", reason: STOPPED_BY_RESTART });
    await restarted.shutdown();
  });

  it("refuses commands until the sandbox is ready, invalid IDs, and unknown commands", async () => {
    const notReady = manager(dir, { ready: false });
    await expect(notReady.start({ id: "x", command: "1" })).rejects.toMatchObject({ code: "unavailable" });
    await expect(execs.start({ id: "bad id", command: "1" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(execs.start({ id: "empty", command: "  " })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(execs.read("missing", 0)).rejects.toMatchObject({ code: "not_found" });
  });

  it("bounds how many commands run at once and how many ended ones it keeps", async () => {
    const bounded = manager(dir, { limits: { running: 1, retained: 2 } });
    await bounded.load();
    await bounded.start({ id: "r1", command: "setInterval(() => {}, 1000)" });
    await expect(bounded.start({ id: "r2", command: "1" })).rejects.toMatchObject({ code: "conflict" });
    await bounded.stop("r1");
    for (const id of ["a", "b", "c"]) {
      await bounded.start({ id, command: "1" });
      await finished(bounded, id);
    }
    await bounded.start({ id: "d", command: "1" });
    await finished(bounded, "d");
    expect(bounded.list().map((record) => record.id)).not.toContain("r1");
    expect(bounded.list().length).toBeLessThanOrEqual(3);
    await bounded.shutdown();
  });

  it.runIf(posix)("kills the command's whole process group when it is stopped", async () => {
    await execs.start({
      id: "group",
      command: "const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000)",
    });
    const read = await execs.read("group", 0, { waitMs: 5000 });
    const pid = Number(read.output.trim());
    await execs.stop("group");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
