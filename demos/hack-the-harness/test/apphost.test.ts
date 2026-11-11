import { parseConfig } from "@managed-copilot/protocol";
import { describe, expect, it } from "vitest";
import {
  HACK_THE_HARNESS_ENVIRONMENT,
  HACK_THE_HARNESS_PORT,
  HACK_THE_HARNESS_STAGE_ENVIRONMENTS,
  HACK_THE_HARNESS_WORKER_ENVIRONMENT,
  hackTheHarness,
} from "../apphost.mts";
import { STAGES } from "../src/app/server/stages.ts";

describe("AppHost fragment", () => {
  const fragment = hackTheHarness();
  const config = parseConfig({ environments: fragment.environments });
  const environment = (stage: keyof typeof HACK_THE_HARNESS_STAGE_ENVIRONMENTS) => config.environments[HACK_THE_HARNESS_STAGE_ENVIRONMENTS[stage]];

  it("declares an environment for every stage the app offers, in the same order", () => {
    expect(STAGES.map(stage => [stage.id, stage.environment])).toEqual(Object.entries(HACK_THE_HARNESS_STAGE_ENVIRONMENTS));
    expect(HACK_THE_HARNESS_STAGE_ENVIRONMENTS.shared).toBe(HACK_THE_HARNESS_ENVIRONMENT);
  });

  it("gives each stage its architecture, with no network anywhere", () => {
    expect(environment("shared")).toMatchObject({ type: "shared", unsafeHostTools: false });
    expect(environment("isolated")).toMatchObject({ type: "isolated" });
    expect(environment("promotable")).toMatchObject({ type: "promotable", promoteTo: HACK_THE_HARNESS_WORKER_ENVIRONMENT });
    expect(environment("direct")).toMatchObject({ type: "orchestrator", execution: "direct", workers: [HACK_THE_HARNESS_WORKER_ENVIRONMENT] });
    expect(environment("workers")).toMatchObject({ type: "orchestrator", workers: [HACK_THE_HARNESS_WORKER_ENVIRONMENT], maxWorkers: 2 });
    expect(environment("workers")?.execution ?? "delegate").toBe("delegate");
    expect(environment("mixed")).toMatchObject({ type: "orchestrator", execution: "mixed", workers: [HACK_THE_HARNESS_WORKER_ENVIRONMENT], maxWorkers: 3 });
    expect(config.environments[HACK_THE_HARNESS_WORKER_ENVIRONMENT]).toMatchObject({ type: "isolated" });
    for (const declared of Object.values(config.environments)) {
      expect(declared.network).toBe(false);
    }
  });

  it("matches each stage's file tools to where its commands run", () => {
    const byId = Object.fromEntries(STAGES.map(stage => [stage.id, stage]));
    expect(byId.direct).toMatchObject({ workspace: "hands", workers: false });
    expect(byId.workers).toMatchObject({ workers: true });
    expect(byId.workers?.workspace).toBeUndefined();
    expect(byId.mixed).toMatchObject({ workspace: "hands", workers: true });
  });

  it("describes the app the way the root AppHost expects", () => {
    expect(fragment.app).toEqual({ name: "hack-the-harness", workingDirectory: expect.stringMatching(/hack-the-harness$/), script: "dist/server/main.js", port: HACK_THE_HARNESS_PORT, healthPath: "/api/health" });
    expect(hackTheHarness({ port: 9240 }).app.port).toBe(9240);
  });
});
