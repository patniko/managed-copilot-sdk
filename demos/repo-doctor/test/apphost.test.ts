import { parseConfig } from "@managed-copilot/protocol";
import { describe, expect, it } from "vitest";
import { PYPI_HOSTS, REPO_DOCTOR_ENVIRONMENT, REPO_DOCTOR_GITHUB_HOSTS, REPO_DOCTOR_PORT, repoDoctor } from "../apphost.mts";
import { GITHUB_HOSTS, PYPI_HOSTS as APP_PYPI_HOSTS } from "../src/server/inference.js";

describe("AppHost fragment", () => {
  it("declares one isolated environment the protocol schema accepts, named after the demo", () => {
    const fragment = repoDoctor({ npmRegistry: "https://packages.example.com/npm/", pipIndexUrl: "https://packages.example.com/pypi/simple/" });
    const config = parseConfig({ environments: fragment.environments });
    expect(Object.keys(config.environments)).toEqual([REPO_DOCTOR_ENVIRONMENT]);
    expect(REPO_DOCTOR_ENVIRONMENT.startsWith("repo-doctor")).toBe(true);
    expect(config.environments[REPO_DOCTOR_ENVIRONMENT]).toMatchObject({ type: "isolated", size: "medium" });
  });

  it("allows GitHub, the registries the sandboxes use, and extra hosts, and nothing else", () => {
    const shared = repoDoctor({ npmRegistry: "https://packages.example.com/npm/", pipIndexUrl: "https://packages.example.com/pypi/simple/", extraHosts: [] });
    expect(shared.environments[REPO_DOCTOR_ENVIRONMENT]?.network).toEqual(["github.com", "codeload.github.com", "objects.githubusercontent.com", "packages.example.com"]);
    const defaults = repoDoctor({ npmRegistry: "https://registry.npmjs.org/", pipIndexUrl: "", extraHosts: [] });
    expect(defaults.environments[REPO_DOCTOR_ENVIRONMENT]?.network).toEqual(["github.com", "codeload.github.com", "objects.githubusercontent.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]);
    const extra = repoDoctor({ npmRegistry: "https://packages.example.com/npm/", pipIndexUrl: "https://packages.example.com/pypi/simple/", extraHosts: [" *.CDN.example.com", ""] });
    expect(extra.environments[REPO_DOCTOR_ENVIRONMENT]?.network).toEqual(["github.com", "codeload.github.com", "objects.githubusercontent.com", "packages.example.com", "*.cdn.example.com"]);
    expect(parseConfig({ environments: extra.environments }).environments[REPO_DOCTOR_ENVIRONMENT]).toBeDefined();
  });

  it("keeps sandbox settings out of the platform's reserved names", () => {
    const env = repoDoctor({ npmRegistry: "https://r.example/", pipIndexUrl: "" }).environments[REPO_DOCTOR_ENVIRONMENT]?.env ?? {};
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "NPM_CONFIG_REGISTRY", "GITHUB_TOKEN"]));
    expect(env).toMatchObject({ CI: "1", PYTHONDONTWRITEBYTECODE: "1" });
  });

  it("agrees with the app on which hosts are GitHub's and pip's", () => {
    expect(REPO_DOCTOR_GITHUB_HOSTS).toEqual(GITHUB_HOSTS);
    expect(PYPI_HOSTS).toEqual(APP_PYPI_HOSTS);
  });

  it("describes the app the way the root AppHost expects", () => {
    const fragment = repoDoctor({ npmRegistry: "https://r.example/", pipIndexUrl: "" });
    expect(fragment.app).toEqual({ name: "repo-doctor", workingDirectory: expect.stringMatching(/repo-doctor$/), script: "dist/server/main.js", port: REPO_DOCTOR_PORT, healthPath: "/api/health" });
    expect(repoDoctor({ port: 9135, npmRegistry: "https://r.example/", pipIndexUrl: "" }).app.port).toBe(9135);
  });
});
