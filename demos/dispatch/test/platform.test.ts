import type { DeploymentInfo, EnvironmentInfo } from "@managed-copilot/sdk";
import { describe, expect, it } from "vitest";
import { describeConnectError, describeDeployment, reconnectDelay } from "../src/server/platform.js";

const env = (name: string, overrides: Partial<EnvironmentInfo> = {}): EnvironmentInfo => ({
  name,
  type: "isolated",
  network: { access: "disabled", allowedDomains: [] },
  scheduling: false,
  agents: [],
  ...overrides,
});

const deployment = (environments: EnvironmentInfo[], capabilities = ["orchestrator", "isolated"]): DeploymentInfo => ({
  name: "copilot",
  version: "1",
  mode: "local",
  environments,
  capabilities,
  sdk: { copilotSdk: "1.0.26", copilotRuntime: "1.0.103" },
});

describe("describeDeployment", () => {
  it("reads the coordinator and its blueprints, in the order the coordinator is told about them", () => {
    const info = deployment([
      env("dispatch", { type: "orchestrator", workers: ["dispatch-node", "dispatch-python"], maxWorkers: 6, description: "Coordinator" }),
      env("dispatch-python", { size: "medium", description: "Python lab" }),
      env("dispatch-node", { size: "small", network: { access: "restricted", allowedDomains: ["registry.npmjs.org"] } }),
    ]);
    const described = describeDeployment(info, "dispatch", "claude-sonnet-5");
    expect(described.problem).toBeUndefined();
    expect(described.coordinator).toEqual({ environment: "dispatch", model: "claude-sonnet-5", maxWorkers: 6, description: "Coordinator" });
    expect(described.blueprints).toEqual([
      { name: "dispatch-node", kind: "node", label: "Node workshop", size: "small", cpus: 1, memoryGiB: 2, network: { access: "restricted", hosts: ["registry.npmjs.org"] }, agents: [], isDefault: true },
      { name: "dispatch-python", kind: "python", label: "Python lab", description: "Python lab", size: "medium", cpus: 2, memoryGiB: 4, network: { access: "disabled", hosts: [] }, agents: [], isDefault: false },
    ]);
  });

  it("says what to fix when the environment is missing, isn't an orchestrator, or sandboxes aren't ready", () => {
    expect(describeDeployment(deployment([]), "dispatch", "m").problem).toMatch(/no "dispatch" environment/);
    expect(describeDeployment(deployment([env("dispatch", { type: "shared" })]), "dispatch", "m").problem).toMatch(/shared environment/);
    const notReady = describeDeployment(deployment([env("dispatch", { type: "orchestrator", workers: [] })], ["shared"]), "dispatch", "m");
    expect(notReady.problem).toMatch(/aren't available/);
    expect(notReady.coordinator?.maxWorkers).toBe(4);
  });
});

describe("connection helpers", () => {
  it("backs off exponentially to 30 seconds, with jitter", () => {
    expect(reconnectDelay(1, () => 1)).toBe(1000);
    expect(reconnectDelay(3, () => 0)).toBe(2000);
    expect(reconnectDelay(10, () => 1)).toBe(30_000);
  });

  it("explains connection failures in plain words", () => {
    expect(describeConnectError(new Error("fetch failed"))).toMatch(/isn't reachable yet/);
    expect(describeConnectError(new Error("Something else"))).toBe("Something else");
  });
});
