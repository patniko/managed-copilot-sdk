import { parseConfig } from "@managed-copilot/protocol";
import { describe, expect, it } from "vitest";
import { HELP_DESK_ENVIRONMENT, HELP_DESK_PORT, HELP_DESK_TRIAGE_ENVIRONMENT, helpDesk } from "../apphost.mts";

describe("AppHost fragment", () => {
  const fragment = helpDesk();

  it("declares one shared environment, named after the demo, with no network", () => {
    const config = parseConfig({ environments: fragment.environments });
    expect(Object.keys(config.environments)).toEqual(["help-desk"]);
    expect(config.environments[HELP_DESK_ENVIRONMENT]).toMatchObject({ type: "shared", network: false });
    expect(fragment.environments[HELP_DESK_ENVIRONMENT]?.description?.length).toBeGreaterThan(40);
  });

  it("describes the app the way the root AppHost expects", () => {
    expect(fragment.app).toEqual({ name: "help-desk", workingDirectory: expect.stringMatching(/help-desk$/), script: "dist/server/main.js", port: HELP_DESK_PORT, healthPath: "/api/health", env: {} });
    expect(helpDesk({ port: 9240 }).app.port).toBe(9240);
    expect(fragment.triage).toBeUndefined();
  });

  it("with triage, routes a second shared environment to Help Desk's OpenAI-compatible endpoint", () => {
    const triage = helpDesk({ port: 9240, triage: { endpoint: "https://contoso.services.ai.azure.com", deployment: "ms-decision-1" } });
    const config = parseConfig({ environments: triage.environments, openai: { [triage.triage!.endpoint]: triage.triage!.declaration } });
    expect(config.environments[HELP_DESK_TRIAGE_ENVIRONMENT]).toMatchObject({ type: "shared", network: false, models: ["ms-decision-1"], inference: { openai: HELP_DESK_TRIAGE_ENVIRONMENT } });
    expect(triage.triage!.declaration.url).toBe("http://localhost:9240/api/triage/v1");
    expect(triage.app.env).toMatchObject({ HELP_DESK_TRIAGE_ENVIRONMENT, HELP_DESK_TRIAGE_MODEL: "ms-decision-1", HELP_DESK_DECISION_DEPLOYMENT: "ms-decision-1" });
  });
});
