import { ManagedCopilotError, type DeploymentInfo } from "@managed-copilot/sdk";
import { describe, expect, it } from "vitest";
import { loadConfig, MODEL_PREFERENCES } from "../src/server/config.js";
import { chooseModel, describeConnectError, environmentProblem, reconnectDelay } from "../src/server/platform.js";

const deployment = (environments: DeploymentInfo["environments"]): DeploymentInfo => ({
  name: "copilot",
  version: "0.1.0",
  mode: "local",
  environments,
  capabilities: ["shared"],
  sdk: { copilotSdk: "1.0.26", copilotRuntime: "1.0.103" },
});
const network = { access: "disabled", allowedDomains: [] } as unknown as DeploymentInfo["environments"][number]["network"];

describe("platform", () => {
  it("picks the cheapest fast model the account offers, unless one is configured", () => {
    expect(chooseModel([{ id: "claude-sonnet-5" }, { id: "claude-haiku-4.5" }])).toBe("claude-haiku-4.5");
    expect(chooseModel([{ id: "claude-haiku-4.5", policy: { state: "disabled", terms: "" } }, { id: "claude-haiku-5.5" }])).toBe("claude-haiku-5.5");
    expect(chooseModel(undefined)).toBe(MODEL_PREFERENCES[0]);
    expect(chooseModel([{ id: "gpt-6-sol" }])).toBe(MODEL_PREFERENCES[0]);
    expect(chooseModel([{ id: "claude-haiku-4.5" }], "gpt-6-sol")).toBe("gpt-6-sol");
  });

  it("needs a shared help desk environment, and says how to add one", () => {
    expect(environmentProblem(deployment([]), "help-desk")).toContain("demos/help-desk/apphost.mts");
    expect(environmentProblem(deployment([{ name: "help-desk", type: "isolated", network, scheduling: false, agents: [] }]), "help-desk")).toBe('"help-desk" is a isolated environment; Help Desk needs a shared one.');
    expect(environmentProblem(deployment([{ name: "help-desk", type: "shared", network, scheduling: false, agents: [] }]), "help-desk")).toBeUndefined();
  });

  it("explains connection failures in plain words", () => {
    expect(describeConnectError(new ManagedCopilotError("authentication_required", "x"))).toContain("gh auth login");
    expect(describeConnectError(new Error("fetch failed"))).toContain("aspire run");
    expect(describeConnectError(new Error("Something else"))).toBe("Something else");
  });

  it("backs off between reconnections, up to 30 seconds", () => {
    expect(reconnectDelay(1, () => 1)).toBe(1_000);
    expect(reconnectDelay(3, () => 0)).toBe(2_000);
    expect(reconnectDelay(20, () => 1)).toBe(30_000);
  });

  it("reads its settings from the environment", () => {
    const config = loadConfig({ PORT: "9240", HELP_DESK_MODEL: " gpt-6-sol " });
    expect(config).toMatchObject({ port: 9240, host: "127.0.0.1", environment: "help-desk", model: "gpt-6-sol" });
    expect(loadConfig({}).model).toBeUndefined();
  });
});
