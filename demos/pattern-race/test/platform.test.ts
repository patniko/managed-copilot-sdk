import { ManagedCopilotError, type DeploymentInfo, type EnvironmentInfo } from "@managed-copilot/sdk";
import { describe, expect, it } from "vitest";
import { describeConnectError, describeLanes, reconnectDelay } from "../src/server/platform.js";

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
    expect(describeLanes(deployment(), "claude-sonnet-5")).toEqual([
      { lane: "shared", available: true },
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
    const reasons = Object.fromEntries(describeLanes(info, "claude-sonnet-5").map((lane) => [lane.lane, lane.available ? "ok" : lane.reason]));
    expect(reasons).toEqual({
      shared: '"chat" doesn\'t allow claude-sonnet-5, the model every lane uses.',
      isolated: '"coder" is a shared environment, not isolated.',
      promotable: 'This deployment has no "helper" environment.',
      direct: "ok",
      delegate: '"team" works direct, not delegate.',
      mixed: 'This deployment has no "lead" environment.',
    });
  });

  it("waits for sandboxes and the shared runtime where a lane needs them", () => {
    const lanes = describeLanes(deployment({ capabilities: ["events", "shared"] }), "claude-sonnet-5");
    expect(lanes.filter((lane) => lane.available).map((lane) => lane.lane)).toEqual(["shared"]);
    expect(lanes.find((lane) => lane.lane === "delegate")?.reason).toBe("Sandboxes aren't ready on this deployment yet.");
    expect(describeLanes(deployment({ capabilities: ["events", "isolated"] }), "claude-sonnet-5").find((lane) => lane.lane === "shared")?.reason).toBe(
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
