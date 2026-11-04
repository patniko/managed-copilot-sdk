import { describe, expect, it } from "vitest";
import { ManagedCopilotConfigSchema } from "@managed-copilot/protocol";
import { INCIDENT_ENVIRONMENT, INCIDENT_SANDBOXES, INCIDENT_WEBHOOK, incidentCommander } from "../apphost.mts";

describe("the AppHost fragment", () => {
  const fragment = incidentCommander({ webhookSecret: { secretEnv: "INCIDENT_WEBHOOK_SECRET" }, port: 9345, npmRegistry: "https://registry.example.test/npm/" });

  it("declares a mixed orchestrator whose own sandbox triages and whose workers fix", () => {
    expect(fragment.environments[INCIDENT_ENVIRONMENT]).toMatchObject({
      type: "orchestrator",
      execution: "mixed",
      workers: [INCIDENT_SANDBOXES.triage, INCIDENT_SANDBOXES.node],
      network: false,
    });
    expect(fragment.environments[INCIDENT_SANDBOXES.triage]).toMatchObject({ type: "isolated", network: false });
    expect(fragment.environments[INCIDENT_SANDBOXES.node]).toMatchObject({ type: "isolated", network: ["registry.example.test"] });
  });

  it("names everything after the demo and validates as platform configuration", () => {
    for (const name of [...Object.keys(fragment.environments), ...Object.keys(fragment.webhooks)]) expect(name.startsWith("incident-commander")).toBe(true);
    const parsed = ManagedCopilotConfigSchema.safeParse({ environments: fragment.environments, webhooks: fragment.webhooks });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("subscribes the app's port to the coordinator's events", () => {
    expect(fragment.webhooks[INCIDENT_WEBHOOK]).toEqual({
      url: "http://localhost:9345/api/copilot-events",
      environments: [INCIDENT_ENVIRONMENT],
      events: ["session.action_required", "session.idle", "session.failed", "worker.started", "worker.idle", "worker.failed", "worker.stopped"],
      secret: { secretEnv: "INCIDENT_WEBHOOK_SECRET" },
    });
    expect(fragment.app).toMatchObject({ name: "incident-commander", port: 9345, script: "dist/server/main.js", healthPath: "/api/health" });
  });
});
