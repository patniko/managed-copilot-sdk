import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "@managed-copilot/protocol";
import { describe, expect, it } from "vitest";
import { RESEARCH_SWARM_DEFAULT_PORT, RESEARCH_SWARM_ENVIRONMENT, RESEARCH_SWARM_HOSTS, RESEARCH_SWARM_MAX_RESEARCHERS, RESEARCH_SWARM_RESEARCHERS, researchSwarm } from "../apphost.mts";
import { DEFAULT_PORT } from "../src/shared/types.js";

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
    // The server and the happy-path script default to the same port.
    expect(RESEARCH_SWARM_DEFAULT_PORT).toBe(DEFAULT_PORT);
    expect(researchSwarm({ port: 9100 }).app.port).toBe(9100);
  });
});
