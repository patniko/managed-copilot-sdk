import { connect, createServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeSupervisor } from "../src/sandboxd/runtime.js";
import { createLog } from "../src/shared/log.js";

// Stands in for the stock runtime: listens on the port it is given, exits at once when told to fail, stays up without
// listening when told to be silent, and exits by itself after FAKE_RUNTIME_EXIT_MS when set (a crash).
const FAKE_RUNTIME = `
if (process.env.FAKE_RUNTIME_FAIL === "1") process.exit(3);
process.on("SIGTERM", () => process.exit(0));
if (process.env.FAKE_RUNTIME_SILENT === "1") setInterval(() => {}, 1000);
else {
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
  require("node:net").createServer((socket) => socket.on("error", () => {})).listen(port, "127.0.0.1");
}
if (process.env.FAKE_RUNTIME_EXIT_MS) setTimeout(() => process.exit(9), Number(process.env.FAKE_RUNTIME_EXIT_MS));
`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

const supervisors: RuntimeSupervisor[] = [];

async function supervised(options: { failFirst?: boolean; silentFirst?: boolean; crashLaunch?: number } = {}) {
  const port = await freePort();
  const launches: number[] = [];
  const exits: number[] = [];
  const runtime = new RuntimeSupervisor({
    binary: "unused",
    port,
    identity: { uid: 0, gid: 0 },
    cwd: process.cwd(),
    log: createLog("test", "error"),
    secrets: () => [],
    readyTimeoutMs: 1_000,
    launch: (args, env) => {
      launches.push(Date.now());
      const first = launches.length === 1;
      const crash = options.crashLaunch === launches.length;
      return {
        command: process.execPath,
        args: ["-e", FAKE_RUNTIME, "--", ...args],
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...env,
          FAKE_RUNTIME_FAIL: options.failFirst === true && first ? "1" : "0",
          FAKE_RUNTIME_SILENT: options.silentFirst === true && first ? "1" : "0",
          ...(crash ? { FAKE_RUNTIME_EXIT_MS: "300" } : {}),
        } as Record<string, string>,
      };
    },
  });
  runtime.onExit(() => void exits.push(Date.now()));
  supervisors.push(runtime);
  return { runtime, port, launches, exits };
}

describe("RuntimeSupervisor restarts", () => {
  afterEach(async () => {
    for (const runtime of supervisors.splice(0)) await runtime.stop(2_000);
  });

  it("replaces the runtime process with a fresh one, without treating it as a crash", async () => {
    const { runtime, port, launches, exits } = await supervised();
    await runtime.start({});
    const first = runtime.instance;
    expect(runtime.state).toBe("running");
    expect(first).toMatch(/^[0-9a-f]{16}$/);

    await runtime.restart(2_000);
    expect(runtime.state).toBe("running");
    expect(runtime.instance).toMatch(/^[0-9a-f]{16}$/);
    expect(runtime.instance).not.toBe(first);
    expect(runtime.restarts).toBe(1);
    expect(exits).toHaveLength(1);
    expect(await accepts(port)).toBe(true);
    // Crash recovery would start another process a second after an unexpected exit.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(launches).toHaveLength(2);
    expect(runtime.state).toBe("running");
  });

  it("shares one restart between concurrent callers, and a start waits for it instead of launching a second process", async () => {
    const { runtime, launches } = await supervised();
    await runtime.start({});
    // A start can arrive in the moment between the old process's exit and the new one's launch.
    const starts: Promise<void>[] = [];
    runtime.onExit(() => void starts.push(runtime.start({})));
    const restarting = runtime.restart(2_000);
    expect(runtime.restart(2_000)).toBe(restarting);
    await restarting;
    await Promise.all(starts);
    expect(starts).toHaveLength(1);
    expect(launches).toHaveLength(2);
    expect(runtime.state).toBe("running");
  });

  it("lets a stop that arrives during a restart win", async () => {
    const { runtime, port, launches } = await supervised();
    await runtime.start({});
    const restarting = runtime.restart(2_000);
    await runtime.stop(2_000);
    await expect(restarting).rejects.toThrow(/stopping/);
    expect(runtime.state).toBe("stopped");
    expect(launches).toHaveLength(1);
    expect(await accepts(port)).toBe(false);
  });

  it("cancels a start that waited for a restart when a stop arrives meanwhile", async () => {
    const { runtime, port, launches } = await supervised();
    await runtime.start({});
    const restarting = runtime.restart(2_000);
    const starting = runtime.start({});
    await runtime.stop(2_000);
    await expect(restarting).rejects.toThrow(/stopping/);
    await expect(starting).rejects.toThrow(/was stopped/);
    expect(runtime.state).toBe("stopped");
    expect(launches).toHaveLength(1);
    expect(await accepts(port)).toBe(false);
  });

  it("starts the runtime again after a start that failed, with crash recovery back on", async () => {
    // The first process never listens, so its start times out and the supervisor stops it.
    const { runtime, launches } = await supervised({ silentFirst: true, crashLaunch: 2 });
    await expect(runtime.start({})).rejects.toThrow(/did not listen/);
    await runtime.restart(2_000);
    expect(runtime.state).toBe("running");
    expect(launches).toHaveLength(2);
    // The restarted process crashes; crash recovery starts another one about a second later.
    const deadline = Date.now() + 5_000;
    while (launches.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(launches).toHaveLength(3);
  });

  it("reports a runtime that exits during startup", async () => {
    const { runtime } = await supervised({ failFirst: true });
    await expect(runtime.start({})).rejects.toThrow(/exited during startup/);
  });

  it("refuses to restart a runtime that was never started", async () => {
    const { runtime } = await supervised();
    await expect(runtime.restart()).rejects.toThrow(/has not been started/);
  });
});
