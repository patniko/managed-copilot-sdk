import { ManagedCopilotError, type DeploymentInfo, type EnvironmentInfo } from "@managed-copilot/sdk";
import { describe, expect, it } from "vitest";
import type { SharedRuntimeStatus } from "@managed-copilot/protocol";
import { describeConnectError, describeLanes, parseUsage, reconnectDelay, resolveGitHubToken, runtimeReading } from "../src/server/platform.js";
import { withModel } from "../src/shared/lanes.js";

const network = { access: "all", allowedDomains: [] } as unknown as EnvironmentInfo["network"];
const env = (fields: Partial<EnvironmentInfo> & Pick<EnvironmentInfo, "name" | "type">): EnvironmentInfo => ({ network, scheduling: false, agents: [], ...fields });

/** The root AppHost's six pattern environments, as `/v1/info` describes them. */
function deployment(overrides: { environments?: EnvironmentInfo[]; capabilities?: string[] } = {}): DeploymentInfo {
  return {
    name: "copilot",
    version: "0.1.0",
    mode: "local",
    sdk: { copilotSdk: "1.0.26", copilotRuntime: "1.0.103" },
    capabilities: overrides.capabilities ?? ["events", "isolated", "orchestrator", "promotion", "shared"],
    environments: overrides.environments ?? [
      env({ name: "chat", type: "shared", models: ["claude-sonnet-5", "claude-haiku-5.5"] }),
      env({ name: "coder", type: "isolated", size: "medium" }),
      env({ name: "helper", type: "promotable", promoteTo: "coder" }),
      env({ name: "team", type: "orchestrator", workers: ["coder"], maxWorkers: 3 }),
      env({ name: "operator", type: "orchestrator", workers: ["coder"], execution: "direct" }),
      env({ name: "lead", type: "orchestrator", workers: ["coder"], execution: "mixed", maxWorkers: 3 }),
    ],
  };
}

describe("lanes on a deployment", () => {
  it("races all six on the root AppHost's environments, and knows where each lane's sandboxes come from", () => {
    expect(describeLanes(deployment())).toEqual([
      { lane: "shared", available: true, models: ["claude-sonnet-5", "claude-haiku-5.5"] },
      { lane: "isolated", available: true, sandboxEnvironment: "coder" },
      { lane: "promotable", available: true, sandboxEnvironment: "coder" },
      { lane: "direct", available: true, sandboxEnvironment: "coder" },
      { lane: "delegate", available: true, sandboxEnvironment: "coder" },
      { lane: "mixed", available: true, sandboxEnvironment: "coder" },
    ]);
  });

  it("says why a lane can't race", () => {
    const info = deployment({
      environments: [
        env({ name: "chat", type: "shared", models: ["claude-haiku-5.5"] }),
        env({ name: "coder", type: "shared" }),
        env({ name: "team", type: "orchestrator", workers: ["coder"], execution: "direct" }),
        env({ name: "operator", type: "orchestrator", workers: ["coder"], execution: "direct" }),
      ],
    });
    const reasons = Object.fromEntries(describeLanes(info).map((lane) => [lane.lane, lane.available ? "ok" : lane.reason]));
    expect(reasons).toEqual({
      shared: "ok",
      isolated: '"coder" is a shared environment, not isolated.',
      promotable: 'This deployment has no "helper" environment.',
      direct: "ok",
      delegate: '"team" works direct, not delegate.',
      mixed: 'This deployment has no "lead" environment.',
    });
  });

  it("sits a lane out of a race whose model its environment doesn't allow", () => {
    const shared = describeLanes(deployment()).find((lane) => lane.lane === "shared")!;
    expect(withModel(shared, { id: "claude-haiku-5.5", name: "Claude Haiku 5.5" })).toBe(shared);
    expect(withModel(shared, { id: "gpt-6-sol", name: "GPT-6 Sol" })).toEqual({ lane: "shared", available: false, reason: '"chat" doesn\'t allow GPT-6 Sol.' });
  });

  it("waits for sandboxes and the shared runtime where a lane needs them", () => {
    const lanes = describeLanes(deployment({ capabilities: ["events", "shared"] }));
    expect(lanes.filter((lane) => lane.available).map((lane) => lane.lane)).toEqual(["shared"]);
    expect(lanes.find((lane) => lane.lane === "delegate")?.reason).toBe("Sandboxes aren't ready on this deployment yet.");
    expect(describeLanes(deployment({ capabilities: ["events", "isolated"] })).find((lane) => lane.lane === "shared")?.reason).toBe(
      "The shared runtime isn't running on this deployment.",
    );
  });
});

describe("connecting", () => {
  it("explains failures in plain words", () => {
    expect(describeConnectError(new ManagedCopilotError("authentication_required", "x"))).toMatch(/gh auth login/);
    expect(describeConnectError(new Error("fetch failed"))).toMatch(/aspire run/);
    expect(describeConnectError(new ManagedCopilotError("upstream_unavailable", "Cannot reach the Managed Copilot deployment at http://localhost:8899: fetch failed"))).toBe(
      "Managed Copilot isn't reachable yet. Start it with `aspire run`, or set MANAGED_COPILOT_URL.",
    );
    expect(describeConnectError(new ManagedCopilotError("forbidden", "x"))).toBe("This GitHub account can't use this Managed Copilot deployment.");
  });

  it("backs off up to 30 seconds", () => {
    expect(reconnectDelay(1, () => 1)).toBe(1_000);
    expect(reconnectDelay(4, () => 0)).toBe(4_000);
    expect(reconnectDelay(20, () => 1)).toBe(30_000);
  });
});

describe("a sandbox's usage", () => {
  it("reads its cgroup counters: CPU time and the higher of its peak and current memory", () => {
    expect(parseUsage("cpu_us 1886519\npeak 71176192\nnow 52289536\n")).toEqual({ cpuMs: 1886.519, peakMemoryBytes: 71_176_192, memoryBytes: 52_289_536 });
    // cgroup v1 counts CPU in nanoseconds; a kernel without memory.peak still has the current reading.
    expect(parseUsage("cpu_ns 2500000000\npeak \nnow 1048576\n")).toEqual({ cpuMs: 2500, peakMemoryBytes: 1_048_576, memoryBytes: 1_048_576 });
    expect(parseUsage("cpu_ns \npeak \nnow \n")).toBeUndefined();
  });
});

describe("the shared runtime's usage", () => {
  const status = (fields: Partial<SharedRuntimeStatus>): { runtime: SharedRuntimeStatus } => ({ runtime: { state: "running", external: false, generation: 2, restarts: 0, sessions: 5, ...fields } });

  it("reads it from the operator API's infrastructure view", () => {
    expect(runtimeReading(status({ usage: { cpuMs: 4_200, memoryBytes: 300, peakMemoryBytes: 400 } }))).toEqual({ cpuMs: 4_200, memoryBytes: 300, peakMemoryBytes: 400, sessions: 5, generation: 2 });
  });

  it("says why it can't, in plain words", () => {
    expect(() => runtimeReading(status({ state: "disabled" }))).toThrow("This deployment has no shared runtime.");
    expect(() => runtimeReading(status({ external: true }))).toThrow("The shared runtime runs outside the gateway here, so the gateway can't read its usage.");
    expect(() => runtimeReading(status({}))).toThrow("The gateway doesn't report the shared runtime's usage right now.");
  });

  it("asks with the same GitHub sign-in the SDK would find", async () => {
    expect(await resolveGitHubToken({ GH_TOKEN: " gho_env " }, async () => "gho_gh")).toBe("gho_env");
    expect(await resolveGitHubToken({}, async () => "gho_gh")).toBe("gho_gh");
    await expect(resolveGitHubToken({}, async () => undefined)).rejects.toMatchObject({ code: "authentication_required" });
  });
});
