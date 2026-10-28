import { parseConfig } from "@managed-copilot/protocol";
import { describe, expect, it } from "vitest";
import { DISPATCH_BLUEPRINTS, DISPATCH_DEFAULT_PORT, DISPATCH_ENVIRONMENT, DISPATCH_STYLES, DISPATCH_WEB_HOSTS, dispatch } from "../apphost.mts";
import { blueprintKind, TEMPLATES } from "../src/shared/catalog.js";

describe("AppHost fragment", () => {
  const fragment = dispatch({ npmRegistry: "https://packages.example.com/npm/" });

  it("declares an orchestrator and its worker environments that the protocol schema accepts", () => {
    const config = parseConfig({ environments: fragment.environments });
    expect(Object.keys(config.environments).sort()).toEqual(["dispatch", "dispatch-direct", "dispatch-mixed", "dispatch-node", "dispatch-python", "dispatch-web", "dispatch-writer"]);
    expect(config.environments[DISPATCH_ENVIRONMENT]).toMatchObject({
      type: "orchestrator",
      workers: ["dispatch-python", "dispatch-node", "dispatch-web", "dispatch-writer"],
      maxWorkers: 6,
    });
    for (const name of Object.values(DISPATCH_BLUEPRINTS)) expect(config.environments[name]).toMatchObject({ type: "isolated" });
  });

  it("declares one orchestrator per execution style over the same worker environments", () => {
    const config = parseConfig({ environments: fragment.environments });
    expect(DISPATCH_STYLES).toEqual({ delegate: "dispatch", direct: "dispatch-direct", mixed: "dispatch-mixed" });
    expect(config.environments[DISPATCH_STYLES.delegate]?.execution ?? "delegate").toBe("delegate");
    // Direct works in a sandbox of exactly one environment; mixed works in the first and can start workers in any.
    expect(config.environments[DISPATCH_STYLES.direct]).toMatchObject({ type: "orchestrator", execution: "direct", workers: [DISPATCH_BLUEPRINTS.python] });
    expect(config.environments[DISPATCH_STYLES.mixed]).toMatchObject({ type: "orchestrator", execution: "mixed", workers: config.environments[DISPATCH_STYLES.delegate]?.workers });
  });

  it("gives each blueprint the network its work needs, and no more", () => {
    const { environments } = fragment;
    expect(environments[DISPATCH_BLUEPRINTS.python]).toMatchObject({ network: false, size: "medium" });
    expect(environments[DISPATCH_BLUEPRINTS.node]).toMatchObject({ network: ["packages.example.com"], size: "small" });
    expect(environments[DISPATCH_BLUEPRINTS.web]).toMatchObject({ network: DISPATCH_WEB_HOSTS });
    expect(environments[DISPATCH_BLUEPRINTS.writer]).toMatchObject({ network: false });
    for (const name of Object.values(DISPATCH_BLUEPRINTS)) {
      // The coordinator picks blueprints by their descriptions; reserved proxy and registry variables stay out.
      expect(environments[name]?.description?.length).toBeGreaterThan(40);
      expect(Object.keys(environments[name]?.env ?? {})).not.toEqual(expect.arrayContaining(["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"]));
    }
  });

  it("names the blueprints so the UI recognizes their kind", () => {
    expect(Object.entries(DISPATCH_BLUEPRINTS).map(([kind, name]) => [kind, blueprintKind(name)])).toEqual([
      ["python", "python"],
      ["node", "node"],
      ["web", "web"],
      ["writer", "writer"],
    ]);
    expect(blueprintKind("team-coder")).toBe("other");
  });

  it("describes the app the way the root AppHost expects", () => {
    expect(fragment.app).toEqual({ name: "dispatch", workingDirectory: expect.stringMatching(/dispatch$/), script: "dist/server/main.js", port: DISPATCH_DEFAULT_PORT, healthPath: "/api/health" });
    expect(dispatch({ port: 9100, npmRegistry: "https://r.example/" }).app.port).toBe(9100);
  });

  it("offers templates whose follow-ups show sandboxes being reused", () => {
    for (const template of TEMPLATES) {
      expect(template.prompt.length).toBeGreaterThan(40);
      expect(template.followUps.length).toBeGreaterThan(0);
      expect(template.uses.length).toBeGreaterThan(0);
    }
    expect(new Set(TEMPLATES.map((template) => template.id)).size).toBe(TEMPLATES.length);
  });
});
