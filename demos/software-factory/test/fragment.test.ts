import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "@managed-copilot/protocol";
import { describe, expect, it } from "vitest";
import { FACTORY_DEFAULT_PORT, FACTORY_ENVIRONMENTS as FRAGMENT_ENVIRONMENTS, softwareFactory } from "../apphost.mts";
import { FACTORY_ENVIRONMENTS, ROLE_AGENTS } from "../src/shared/environments.js";

describe("AppHost fragment", () => {
  const fragment = softwareFactory({ npmRegistry: "https://packages.example.com/npm/" });

  it("declares environments the protocol schema accepts", () => {
    const config = parseConfig({ environments: fragment.environments });
    expect(Object.keys(config.environments).sort()).toEqual(["factory-builder", "factory-planner", "factory-release", "factory-reviewer"]);
    expect(config.environments["factory-planner"]).toMatchObject({ type: "shared", network: false });
    expect(config.environments["factory-builder"]).toMatchObject({ type: "isolated", size: "small" });
  });

  it("matches the environment names the server uses", () => {
    expect(FRAGMENT_ENVIRONMENTS).toEqual(FACTORY_ENVIRONMENTS);
  });

  it("restricts sandboxes to GitHub and the package registry's host, and keeps reserved variables out", () => {
    const builder = fragment.environments["factory-builder"]!;
    expect(builder.network).toEqual(["github.com", "*.github.com", "*.githubusercontent.com", "packages.example.com"]);
    expect(Object.keys(builder.env ?? {})).not.toEqual(expect.arrayContaining(["HTTPS_PROXY", "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS"]));
    for (const name of ["factory-planner", "factory-reviewer"]) {
      expect(fragment.environments[name]).not.toHaveProperty("env");
      expect(fragment.environments[name]).not.toHaveProperty("size");
    }
  });

  it("describes the app the way the devloop AppHost expects", () => {
    expect(fragment.app).toEqual({
      name: "software-factory",
      workingDirectory: expect.stringMatching(/software-factory$/),
      script: "dist/server/main.js",
      port: FACTORY_DEFAULT_PORT,
      healthPath: "/api/health",
    });
    expect(softwareFactory({ port: 9000, npmRegistry: "https://r.example/" }).app.port).toBe(9000);
  });

  it("ships each role's custom agent, skills, and instructions in its customizations bundle", () => {
    for (const [role, environment] of Object.entries(FACTORY_ENVIRONMENTS)) {
      const folder = fragment.environments[environment]!.customizations!;
      expect(existsSync(folder), folder).toBe(true);
      const agent = readFileSync(join(folder, "agents", `${ROLE_AGENTS[role as keyof typeof ROLE_AGENTS]}.agent.md`), "utf8");
      expect(agent).toMatch(new RegExp(`^---\\r?\\nname: ${ROLE_AGENTS[role as keyof typeof ROLE_AGENTS]}\\r?\\n`));
      expect(readdirSync(join(folder, "instructions")).some((file) => file.endsWith(".instructions.md"))).toBe(true);
      for (const skill of readdirSync(join(folder, "skills"))) {
        expect(readFileSync(join(folder, "skills", skill, "SKILL.md"), "utf8")).toMatch(new RegExp(`^---\\r?\\nname: ${skill}\\r?\\n`));
      }
    }
  });

  it("limits office agents to the factory's own tools and the skill tool", () => {
    const office = fragment.environments["factory-planner"]!.customizations!;
    expect(readFileSync(join(office, "agents", "planner.agent.md"), "utf8")).toContain('tools: ["submit_plan", "skill"]');
    expect(readFileSync(join(office, "agents", "reviewer.agent.md"), "utf8")).toContain('tools: ["submit_review", "skill"]');
  });
});
