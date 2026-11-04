import { parseConfig } from "@managed-copilot/protocol";
import { describe, expect, it } from "vitest";
import { DATA_DESK_DEFAULT_PORT, DATA_DESK_ENVIRONMENT, DATA_DESK_SANDBOX, dataDesk } from "../apphost.mts";
import { describeDeployment, reconnectDelay } from "../src/server/platform.js";

describe("AppHost fragment", () => {
  const fragment = dataDesk();

  it("declares a promotable environment that moves into an isolated Python sandbox, both without network", () => {
    const config = parseConfig({ environments: fragment.environments });
    expect(Object.keys(config.environments).sort()).toEqual([DATA_DESK_ENVIRONMENT, DATA_DESK_SANDBOX]);
    expect(config.environments[DATA_DESK_ENVIRONMENT]).toMatchObject({ type: "promotable", promoteTo: DATA_DESK_SANDBOX, network: false });
    expect(config.environments[DATA_DESK_SANDBOX]).toMatchObject({ type: "isolated", size: "small", network: false });
    // Every environment Data Desk declares carries its id, so they never collide with another app's.
    for (const name of Object.keys(config.environments)) expect(name.startsWith("data-desk")).toBe(true);
  });

  it("describes the app the way the root AppHost expects", () => {
    expect(fragment.app).toEqual({ name: "data-desk", workingDirectory: expect.stringMatching(/data-desk$/), script: "dist/server/main.js", port: DATA_DESK_DEFAULT_PORT, healthPath: "/api/health" });
    expect(dataDesk({ port: 9030 }).app.port).toBe(9030);
  });
});

describe("the deployment", () => {
  const environment = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, type, network: { access: "disabled", allowedDomains: [] }, scheduling: false, agents: [], ...extra });
  const info = (environments: unknown[], capabilities = ["isolated", "promotion"]) =>
    ({ name: "copilot", version: "0.1.0", mode: "local", environments, capabilities, sdk: { copilotSdk: "1.0.26", copilotRuntime: "1.0.103" } }) as never;

  it("lists Data Desk's environments when the deployment has them", () => {
    const described = describeDeployment(info([environment("data-desk", "promotable", { promoteTo: "data-desk-python" }), environment("data-desk-python", "isolated", { size: "small" })]), "data-desk");
    expect(described).toEqual({
      environments: [
        { name: "data-desk", type: "promotable", network: "disabled" },
        { name: "data-desk-python", type: "isolated", network: "disabled", size: "small" },
      ],
    });
  });

  it("says what's missing in plain words", () => {
    expect(describeDeployment(info([]), "data-desk").problem).toMatch(/no "data-desk" environment/);
    expect(describeDeployment(info([environment("data-desk", "shared")]), "data-desk").problem).toMatch(/needs a promotable one/);
    expect(describeDeployment(info([environment("data-desk", "promotable", { promoteTo: "data-desk-python" })], ["isolated"]), "data-desk").warning).toMatch(/can't move/);
  });

  it("backs off between reconnection attempts", () => {
    expect(reconnectDelay(1, () => 1)).toBe(1_000);
    expect(reconnectDelay(4, () => 0)).toBe(4_000);
    expect(reconnectDelay(20, () => 1)).toBe(30_000);
  });
});
