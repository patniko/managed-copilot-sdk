import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Server as HttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Lease, LeaseLostError } from "../src/lease/lease.js";
import { compareStamps, EXIT, Supervisor, type LogLevel, type SupervisorTimings } from "../src/lease/supervisor.js";

const fakeGateway = fileURLToPath(new URL("./fixtures/fake-gateway.mjs", import.meta.url));
const fast: SupervisorTimings = { pollMs: 50, heartbeatMs: 100, requestTtlMs: 5_000, stopGraceMs: 2_000, reclaimAfterMs: 800, refuseAfterReclaimMs: 60_000, handoverSettleMs: 60_000 };
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-supervisor-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function probe(port: number): Promise<{ status: number; body: Record<string, unknown> } | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const serving = (port: number) => until(async () => {
  const result = await probe(port);
  return result?.status === 200 && result.body.status === "gateway" ? result.body : undefined;
}, `a gateway on ${port}`);

const standby = (port: number) => until(async () => {
  const result = await probe(port);
  return result?.status === 503 && result.body.status === "standby" ? result.body : undefined;
}, `a standby answer on ${port}`);

/** Whether a process runs (on Linux a zombie, exited but not yet reaped by its new parent, does not). */
function running(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      return !/^\S+ \(.*\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Started {
  readonly supervisor: Supervisor;
  readonly port: number;
  readonly exit: Promise<number>;
  readonly logs: { level: LogLevel; message: string }[];
}

async function start(dataDir: string, stamp: string, options: { env?: Record<string, string>; timings?: Partial<SupervisorTimings> } = {}): Promise<Started> {
  const port = await freePort();
  const logs: { level: LogLevel; message: string }[] = [];
  const supervisor = new Supervisor({
    dataDir,
    identity: { holder: `replica-${stamp}-${port}`, stamp },
    command: [process.execPath, fakeGateway],
    port,
    host: "127.0.0.1",
    env: { ...process.env, PORT: String(port), ...options.env },
    timings: { ...fast, ...options.timings },
    log: (level, message) => logs.push({ level, message }),
  });
  const exit = supervisor.run();
  cleanups.push(async () => {
    await supervisor.stop("test cleanup");
    await exit;
  });
  return { supervisor, port, exit, logs };
}

describe("compareStamps", () => {
  it("orders numeric stamps numerically and others lexicographically", () => {
    expect(compareStamps("900", "1000")).toBe(-1);
    expect(compareStamps("1000", "1000")).toBe(0);
    expect(compareStamps("2026-10-24T08:00:00Z", "2026-10-23T08:00:00Z")).toBe(1);
  });
});

describe("Supervisor", () => {
  it("survives a late reset of a rejected WebSocket after taking the lease", async () => {
    const listen = vi.spyOn(HttpServer.prototype, "listen");
    const dataDir = tempDir();
    const holder = await start(dataDir, "100");
    await serving(holder.port);
    const waiting = await start(dataDir, "100");
    await standby(waiting.port);
    const server = listen.mock.contexts.find((context): context is HttpServer => {
      if (!(context instanceof HttpServer)) return false;
      const address = context.address();
      return address !== null && typeof address === "object" && address.port === waiting.port;
    });
    expect(server).toBeDefined();
    const socket = new PassThrough();
    cleanups.push(() => { socket.destroy(); });
    server!.emit("upgrade", {}, socket, Buffer.alloc(0));
    expect(String(socket.read())).toContain("503 Service Unavailable");

    await holder.supervisor.stop();
    expect((await serving(waiting.port)).generation).toBe("2");
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(() => socket.emit("error", reset)).not.toThrow();
    expect((await probe(waiting.port))?.status).toBe(200);
    expect(waiting.logs.some((entry) => entry.level === "debug" && /Rejected WebSocket/.test(entry.message))).toBe(true);
  }, 30_000);

  it("runs the gateway while holding the lease, and another replica of the same deployment waits", async () => {
    const dataDir = tempDir();
    const a = await start(dataDir, "100");
    expect((await serving(a.port)).generation).toBe("1");
    expect(a.supervisor.state).toBe("serving");

    const b = await start(dataDir, "100");
    await standby(b.port);
    await new Promise((resolve) => setTimeout(resolve, 600)); // several heartbeats: no handover between equals
    expect((await probe(a.port))?.status).toBe(200);
    expect((await probe(b.port))?.status).toBe(503);

    await b.supervisor.stop();
    expect(await b.exit).toBe(EXIT.ok);
    await a.supervisor.stop();
    expect(await a.exit).toBe(EXIT.ok);
    expect(await probe(a.port)).toBeUndefined();
  }, 30_000);

  it("hands over to a newer deployment, reclaims when it goes away, and then refuses that deployment", async () => {
    const dataDir = tempDir();
    const old = await start(dataDir, "100");
    await serving(old.port);

    const newer = await start(dataDir, "200");
    expect((await serving(newer.port)).generation).toBe("2");
    await standby(old.port);
    expect(old.logs.some((entry) => /handing the gateway over/.test(entry.message))).toBe(true);

    await newer.supervisor.stop();
    expect((await serving(old.port)).generation).toBe("3");
    expect(old.logs.some((entry) => entry.level === "warn" && /reclaiming/.test(entry.message))).toBe(true);

    const retry = await start(dataDir, "200");
    await standby(retry.port);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await probe(old.port))?.status).toBe(200);
    expect((await probe(retry.port))?.status).toBe(503);
  }, 45_000);

  it("lets the newest waiting deployment take over without starting an older one in between", async () => {
    const dataDir = tempDir();
    const current = await start(dataDir, "200");
    await serving(current.port);
    // The older replica polls far more often, so without deferring it would win the lock the moment it is released.
    const older = await start(dataDir, "100", { timings: { pollMs: 5 } });
    await standby(older.port);

    const newest = await start(dataDir, "300", { timings: { pollMs: 300 } });
    expect((await serving(newest.port)).generation).toBe("2");
    await standby(current.port);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await probe(older.port))?.status).toBe(503);
    expect(older.logs.some((entry) => /Took the single-writer lease/.test(entry.message))).toBe(false);
  }, 45_000);

  it("after a handover, defers to an even newer deployment instead of reclaiming ahead of it", async () => {
    const dataDir = tempDir();
    // The original holder polls far more often than the newest deployment, so it would win a free lease if it raced.
    const original = await start(dataDir, "100", { timings: { pollMs: 5 } });
    await serving(original.port);
    const second = await start(dataDir, "200");
    expect((await serving(second.port)).generation).toBe("2");
    await sleep(1_200); // past the original's reclaim window: it would now take a free lease
    const newest = await start(dataDir, "300", { timings: { pollMs: 300 } });
    expect((await serving(newest.port)).generation).toBe("3");
    await standby(second.port);
    expect((await probe(original.port))?.status).toBe(503);
    expect(original.logs.filter((entry) => /Took the single-writer lease/.test(entry.message))).toHaveLength(1);
    expect(original.logs.some((entry) => /reclaiming/.test(entry.message))).toBe(false);
  }, 45_000);

  it("treats a settled handover as history: a later restart of the newer deployment is not refused", async () => {
    const dataDir = tempDir();
    const original = await start(dataDir, "100", { timings: { handoverSettleMs: 1_500 } });
    await serving(original.port);
    const newer = await start(dataDir, "200");
    await serving(newer.port);
    await sleep(2_000); // past the settle window
    await newer.supervisor.stop("replica restart");
    expect(await newer.exit).toBe(EXIT.ok);
    // Nothing newer waits, so the original takes the free lease: as a waiting replica, not as a reclaim that refuses 200.
    await serving(original.port);
    const restarted = await start(dataDir, "200");
    await serving(restarted.port);
    await standby(original.port);
    expect(original.logs.some((entry) => /reclaiming/.test(entry.message))).toBe(false);
  }, 45_000);

  it.skipIf(process.platform === "win32")("a stop during a handover waits for the old process and its descendants, then stays stopped", async () => {
    const dataDir = tempDir();
    const holder = await start(dataDir, "100", { env: { FAKE_GATEWAY_STOP_DELAY_MS: "1000", FAKE_GATEWAY_SPAWN_CHILD: "1" } });
    const body = await serving(holder.port);
    const [pid, descendant] = [Number(body.pid), Number(body.descendant)];
    expect(running(descendant)).toBe(true);
    const newer = await start(dataDir, "200");
    await until(async () => holder.logs.some((entry) => /handing the gateway over/.test(entry.message)) || undefined, "the handover to start");
    await holder.supervisor.stop("SIGTERM during the handover");
    // Released only now: the old gateway and the process it started are both gone.
    expect(running(pid)).toBe(false);
    expect(running(descendant)).toBe(false);
    expect(await holder.exit).toBe(EXIT.ok);
    expect((await serving(newer.port)).generation).toBe("2");
    await sleep(300);
    expect(holder.supervisor.state).toBe("stopped");
    expect(await probe(holder.port)).toBeUndefined();
  }, 45_000);

  it.skipIf(process.platform === "win32")("kills processes the gateway left behind before releasing the lease", async () => {
    const dataDir = tempDir();
    const holder = await start(dataDir, "100", { env: { FAKE_GATEWAY_SPAWN_CHILD: "1", FAKE_GATEWAY_EXIT_AFTER_MS: "1500", FAKE_GATEWAY_EXIT_CODE: "4" } });
    const descendant = Number((await serving(holder.port)).descendant);
    expect(await holder.exit).toBe(4);
    expect(running(descendant)).toBe(false);
  }, 30_000);

  it("kills the gateway at once and exits when the lease cannot be renewed", async () => {
    const dataDir = tempDir();
    const holder = await start(dataDir, "100");
    await serving(holder.port);
    vi.spyOn(Lease.prototype, "heartbeat").mockImplementation(() => {
      throw new LeaseLostError("simulated lost lock");
    });
    expect(await holder.exit).toBe(EXIT.fenced);
    expect(await probe(holder.port)).toBeUndefined();
    expect(holder.logs.some((entry) => entry.level === "error" && /Lost the single-writer lease/.test(entry.message))).toBe(true);
  }, 30_000);

  it("exits with the gateway's own exit code and frees the lease", async () => {
    const dataDir = tempDir();
    const holder = await start(dataDir, "100", { env: { FAKE_GATEWAY_EXIT_AFTER_MS: "400", FAKE_GATEWAY_EXIT_CODE: "3" } });
    expect(await holder.exit).toBe(3);
    const lease = Lease.tryAcquire(join(dataDir, ".lease", "gateway.lease"), { holder: "test", stamp: "1" });
    expect(lease?.generation).toBe(2);
    lease!.release();
  }, 30_000);

  it.skipIf(process.platform === "win32")("escalates to SIGKILL when the gateway ignores SIGTERM", async () => {
    const dataDir = tempDir();
    const holder = await start(dataDir, "100", { env: { FAKE_GATEWAY_IGNORE_SIGTERM: "1" }, timings: { stopGraceMs: 300 } });
    await serving(holder.port);
    const started = Date.now();
    await holder.supervisor.stop();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await probe(holder.port)).toBeUndefined();
    expect(holder.logs.some((entry) => /did not stop in time/.test(entry.message))).toBe(true);
  }, 30_000);

  it("stops with an explicit error when the data volume cannot hold the lease", async () => {
    const dataDir = tempDir();
    mkdirSync(join(dataDir, ".lease", "gateway.lease"), { recursive: true });
    const holder = await start(dataDir, "100");
    expect(await holder.exit).toBe(EXIT.storage);
    expect(holder.logs.some((entry) => entry.level === "error" && /POSIX byte-range locks/.test(entry.message))).toBe(true);
  }, 30_000);
});
