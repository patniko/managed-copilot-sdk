import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock("@managed-copilot/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@managed-copilot/sdk")>()),
  ManagedCopilot: { connect: sdk.connect },
}));

const { Platform } = await import("../src/server/platform.js");
const { testConfig } = await import("./fakes.js");

const deployment = {
  name: "copilot",
  version: "1",
  mode: "local" as const,
  capabilities: ["orchestrator", "isolated"],
  sdk: { copilotSdk: "1.0.26", copilotRuntime: "1.0.103" },
  environments: [
    { name: "dispatch", type: "orchestrator", workers: ["dispatch-python"], maxWorkers: 6, network: { access: "enabled", allowedDomains: [] }, scheduling: false, agents: [] },
    { name: "dispatch-python", type: "isolated", size: "medium", network: { access: "disabled", allowedDomains: [] }, scheduling: false, agents: [] },
  ],
};

function fakeManaged(client: () => Promise<unknown>) {
  return { url: "http://gateway.test", info: deployment, account: { login: "octocat" }, on: vi.fn(), close: vi.fn(async () => undefined), client: vi.fn(client) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("Platform connection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sdk.connect.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops a client that finishes starting after its deadline", async () => {
    const late = deferred<unknown>();
    sdk.connect.mockResolvedValue(fakeManaged(() => late.promise));
    const platform = new Platform(testConfig("unused"));
    platform.start();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(platform.status.state).not.toBe("connected");
    const client = { forceStop: vi.fn(async () => undefined), ping: vi.fn() };
    late.resolve(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.forceStop).toHaveBeenCalledTimes(1);
    await platform.stop();
  });

  it("stops a client that finishes starting after Dispatch stopped", async () => {
    const late = deferred<unknown>();
    const managed = fakeManaged(() => late.promise);
    sdk.connect.mockResolvedValue(managed);
    const platform = new Platform(testConfig("unused"));
    platform.start();
    await vi.advanceTimersByTimeAsync(10);
    await platform.stop();
    const client = { forceStop: vi.fn(async () => undefined), ping: vi.fn() };
    late.resolve(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.forceStop).toHaveBeenCalledTimes(1);
    expect(platform.status.state).not.toBe("connected");
  });

  it("connects afresh after a failed health check, re-reading the deployment", async () => {
    const first = { forceStop: vi.fn(async () => undefined), ping: vi.fn(async () => Promise.reject(new Error("socket closed"))) };
    const second = { forceStop: vi.fn(async () => undefined), ping: vi.fn(async () => undefined) };
    const managedOne = fakeManaged(async () => first);
    const managedTwo = fakeManaged(async () => second);
    sdk.connect.mockResolvedValueOnce(managedOne).mockResolvedValueOnce(managedTwo);
    const platform = new Platform(testConfig("unused", { healthIntervalMs: 1_000 }));
    platform.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(platform.status.state).toBe("connected");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.forceStop).toHaveBeenCalled();
    expect(managedOne.close).toHaveBeenCalled();
    expect(sdk.connect).toHaveBeenCalledTimes(2);
    expect(platform.status.state).toBe("connected");
    await platform.stop();
  });
});
