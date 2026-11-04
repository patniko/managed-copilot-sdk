import { parseConfig } from "@managed-copilot/protocol";
import { describe, expect, it } from "vitest";
import { HELP_DESK_ENVIRONMENT, HELP_DESK_PORT, helpDesk } from "../apphost.mts";

describe("AppHost fragment", () => {
  const fragment = helpDesk();

  it("declares one shared environment, named after the demo, with no network", () => {
    const config = parseConfig({ environments: fragment.environments });
    expect(Object.keys(config.environments)).toEqual(["help-desk"]);
    expect(config.environments[HELP_DESK_ENVIRONMENT]).toMatchObject({ type: "shared", network: false });
    expect(fragment.environments[HELP_DESK_ENVIRONMENT]?.description?.length).toBeGreaterThan(40);
  });

  it("describes the app the way the root AppHost expects", () => {
    expect(fragment.app).toEqual({ name: "help-desk", workingDirectory: expect.stringMatching(/help-desk$/), script: "dist/server/main.js", port: HELP_DESK_PORT, healthPath: "/api/health" });
    expect(helpDesk({ port: 9240 }).app.port).toBe(9240);
  });
});
