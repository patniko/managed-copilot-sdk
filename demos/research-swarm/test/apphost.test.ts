import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "@managed-copilot/protocol";
import { describe, expect, it } from "vitest";
import { RESEARCH_SWARM_DEFAULT_PORT, RESEARCH_SWARM_ENVIRONMENT, RESEARCH_SWARM_HOSTS, RESEARCH_SWARM_MAX_RESEARCHERS, RESEARCH_SWARM_RESEARCHERS, researchSwarm } from "../apphost.mts";
import { describeSwarm } from "../src/server/platform.js";
import type { DeploymentInfo } from "@managed-copilot/sdk";

describe("AppHost fragment", () => {
  const fragment = researchSwarm();

  it("declares a delegating lead and its researchers' environment, both named for the demo", () => {
    const config = parseConfig({ environments: fragment.environments });
    expect(Object.keys(config.environments).sort()).toEqual(["research-swarm", "research-swarm-web"]);
    for (const name of Object.keys(config.environments)) expect(name.startsWith("research-swarm")).toBe(true);
    expect(config.environments[RESEARCH_SWARM_ENVIRONMENT]).toMatchObject({ type: "orchestrator", network: false, workers: [RESEARCH_SWARM_RESEARCHERS], maxWorkers: RESEARCH_SWARM_MAX_RESEARCHERS });
    expect(config.environments[RESEARCH_SWARM_ENVIRONMENT]?.execution).toBeUndefined();
    expect(config.environments[RESEARCH_SWARM_RESEARCHERS]).toMatchObject({ type: "isolated", size: "small", network: RESEARCH_SWARM_HOSTS });
  });

  it("gives researchers the research command and its instructions", () => {
    const researchers = fragment.environments[RESEARCH_SWARM_RESEARCHERS]!;
    const root = researchers.customizations!;
    expect(existsSync(join(root, "instructions", "research.instructions.md"))).toBe(true);
    expect(existsSync(join(root, "skills", "web-research", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "skills", "web-research", "research.py"))).toBe(true);
    // The setup command points the command at the script where the sandbox mounts the customizations.
    expect(researchers.setupCommands?.[0]).toContain("/opt/managed-copilot/customizations/skills/web-research/research.py");
    expect(readFileSync(join(root, "skills", "web-research", "research.py"), "utf8")).toContain('LOG = os.path.join(ROOT, "sources.jsonl")');
  });

  it("describes the app the way the root AppHost expects", () => {
    expect(fragment.app).toEqual({ name: "research-swarm", workingDirectory: expect.stringMatching(/research-swarm$/), script: "dist/server/main.js", port: RESEARCH_SWARM_DEFAULT_PORT, healthPath: "/api/health" });
    expect(researchSwarm({ port: 9100 }).app.port).toBe(9100);
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
