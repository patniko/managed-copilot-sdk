import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Lease, LeaseLostError, LeaseStorageError } from "../src/lease/lease.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const identity = { holder: "test", stamp: "1" };
const cleanups: (() => void)[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-lease-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Starts a separate process that holds the lease and resolves once it reports the generation it took. */
async function holdInChild(file: string): Promise<{ child: ChildProcess; generation: number | null }> {
  const child = spawn(process.execPath, ["--import", "tsx", join(fixtures, "hold-lease.ts"), file], { stdio: ["ignore", "pipe", "inherit"] });
  cleanups.push(() => child.kill("SIGKILL"));
  const line = await new Promise<string>((resolve, reject) => {
    createInterface({ input: child.stdout! }).once("line", resolve);
    child.once("exit", (code) => reject(new Error(`lease holder exited early (${code})`)));
  });
  return { child, generation: (JSON.parse(line) as { generation: number | null }).generation };
}

describe("Lease", () => {
  it("takes the lease once, increments the generation, and is free again after release", () => {
    const file = join(tempDir(), ".lease", "gateway.lease");
    const first = Lease.tryAcquire(file, identity);
    expect(first?.generation).toBe(1);
    expect(Lease.tryAcquire(file, { holder: "other", stamp: "2" })).toBeUndefined();
    first!.heartbeat();
    first!.release();
    first!.release();
    const second = Lease.tryAcquire(file, { holder: "other", stamp: "2" });
    expect(second?.generation).toBe(2);
    second!.release();
  });

  it("excludes another process until that process dies", async () => {
    const file = join(tempDir(), "gateway.lease");
    const { child, generation } = await holdInChild(file);
    expect(generation).toBe(1);
    expect(Lease.tryAcquire(file, identity)).toBeUndefined();

    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL"); // a crash releases the lock
    await exited;
    const lease = Lease.tryAcquire(file, identity);
    expect(lease?.generation).toBe(2);
    lease!.release();
  }, 30_000);

  it("refuses to renew a released lease", () => {
    const lease = Lease.tryAcquire(join(tempDir(), "gateway.lease"), identity)!;
    lease.release();
    expect(() => lease.heartbeat()).toThrow(LeaseLostError);
  });

  it("fails explicitly when the lease file cannot be opened as a database", () => {
    const dir = tempDir();
    const file = join(dir, "gateway.lease");
    mkdirSync(file); // a directory where the lease file should be
    expect(() => Lease.tryAcquire(file, identity)).toThrow(LeaseStorageError);
    expect(() => Lease.tryAcquire(file, identity)).toThrow(/POSIX byte-range locks/);
  });
});
