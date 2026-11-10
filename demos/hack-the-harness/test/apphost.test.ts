import { parseConfig } from "@managed-copilot/protocol";
import { describe, expect, it } from "vitest";
import { HACK_THE_HARNESS_ENVIRONMENT, HACK_THE_HARNESS_PORT, HACK_THE_HARNESS_WORKER_ENVIRONMENT, hackTheHarness } from "../apphost.mts";

describe("AppHost fragment", () => {
  const fragment = hackTheHarness();

  it("declares a shared environment without host tools, and an isolated one for later steps, with no network", () => {
    const config = parseConfig({ environments: fragment.environments });
    expect(config.environments[HACK_THE_HARNESS_ENVIRONMENT]).toMatchObject({ type: "shared", unsafeHostTools: false, network: false });
    expect(config.environments[HACK_THE_HARNESS_WORKER_ENVIRONMENT]).toMatchObject({ type: "isolated", network: false });
  });

  it("describes the app the way the root AppHost expects", () => {
    expect(fragment.app).toEqual({ name: "hack-the-harness", workingDirectory: expect.stringMatching(/hack-the-harness$/), script: "dist/server/main.js", port: HACK_THE_HARNESS_PORT, healthPath: "/api/health" });
    expect(hackTheHarness({ port: 9240 }).app.port).toBe(9240);
  });
});
