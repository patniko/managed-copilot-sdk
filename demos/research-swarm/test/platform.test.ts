import { ManagedCopilotError, type DeploymentInfo } from "@managed-copilot/sdk";
import { describe, expect, it } from "vitest";
import { describeConnectError, describeSwarm, reconnectDelay } from "../src/server/platform.js";

describe("the platform connection", () => {
  it("backs off exponentially to 30 seconds, with jitter", () => {
    expect([1, 2, 3, 6].map((attempt) => reconnectDelay(attempt, () => 1))).toEqual([1_000, 2_000, 4_000, 30_000]);
    expect(reconnectDelay(20, () => 0)).toBe(15_000);
  });

  it("says why it couldn't connect in plain words", () => {
    expect(describeConnectError(new ManagedCopilotError("authentication_required", "No token"))).toContain("gh auth login");
    expect(describeConnectError(new ManagedCopilotError("forbidden", "Not allowed"))).toBe("This GitHub account can't use this Managed Copilot deployment.");
    expect(describeConnectError(new Error("fetch failed"))).toContain("aspire run");
    expect(describeConnectError(new Error("Something else"))).toBe("Something else");
  });
});

describe("the deployment", () => {
  const settings = { environment: "research-swarm", model: "claude-sonnet-5", researcherModel: "claude-haiku-5.5" };
  const info = (environments: unknown[], capabilities = ["orchestrator"]) => ({ name: "copilot", version: "0.1.0", mode: "local", environments, capabilities, sdk: { copilotSdk: "1", copilotRuntime: "1" } }) as unknown as DeploymentInfo;
  const lead = { name: "research-swarm", type: "orchestrator", network: { access: "disabled", allowedDomains: [] }, workers: ["research-swarm-web"], maxWorkers: 4, scheduling: false, agents: [] };
  const web = { name: "research-swarm-web", type: "isolated", size: "small", network: { access: "restricted", allowedDomains: ["en.wikipedia.org"] }, scheduling: false, agents: [] };

  it("reads where the lead and its researchers run", () => {
    expect(describeSwarm(info([lead, web]), settings)).toEqual({
      swarm: {
        lead: { environment: "research-swarm", model: "claude-sonnet-5" },
        researchers: { environment: "research-swarm-web", model: "claude-haiku-5.5", max: 4, size: "small", hosts: ["en.wikipedia.org"] },
      },
    });
  });

  it("says what's missing", () => {
    expect(describeSwarm(info([web]), settings).problem).toContain('no "research-swarm" environment');
    expect(describeSwarm(info([{ ...lead, type: "shared" }, web]), settings).problem).toContain("needs an orchestrator");
    expect(describeSwarm(info([{ ...lead, execution: "direct" }, web]), settings).problem).toContain('execution "direct"');
    expect(describeSwarm(info([lead]), settings).problem).toContain("names no researcher environment");
    expect(describeSwarm(info([lead, web], []), settings).problem).toContain("Sandboxes aren't ready");
  });
});
