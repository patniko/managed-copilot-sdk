import { describe, expect, it } from "vitest";
import { describeAllowed, hostsReachedBy, isRuntimeHost, matchesAllowed, parseRegistries } from "../src/server/inference.js";

const registries = { npm: ["registry.example.com"], pip: ["pypi.org", "files.pythonhosted.org"] };

describe("hostsReachedBy", () => {
  it("names the registries installers fetched from", () => {
    expect(hostsReachedBy("npm install", "added 12 packages in 2s", registries)).toEqual(["registry.example.com"]);
    expect(hostsReachedBy("npm ci --no-audit && npm test", "added 1 package, and audited 2 packages in 1s", registries)).toEqual(["registry.example.com"]);
    expect(hostsReachedBy("cd repo && pnpm add -D vitest", "Progress: resolved 40, reused 2, downloaded 38, added 40, done", registries)).toEqual(["registry.example.com"]);
    expect(hostsReachedBy("npx --yes prettier --check .", "npm warn exec The following package was not found and will be installed: prettier@3.3.3", registries)).toEqual(["registry.example.com"]);
    expect(hostsReachedBy("python -m pip install -e .", "Downloading six-1.17.0-py2.py3-none-any.whl", registries)).toEqual(["pypi.org", "files.pythonhosted.org"]);
    expect(hostsReachedBy("pip3 install -r requirements.txt", "Successfully installed six-1.17.0", registries)).toEqual(["pypi.org", "files.pythonhosted.org"]);
  });

  it("doesn't count an install that had nothing to fetch, or commands that don't reach the network", () => {
    expect(hostsReachedBy("npm install", "up to date in 300ms", registries)).toEqual([]);
    expect(hostsReachedBy("pip install -e .", "Requirement already satisfied: six", registries)).toEqual([]);
    expect(hostsReachedBy("npm test", "added 1 package", registries)).toEqual([]);
    expect(hostsReachedBy("npm run build", "", registries)).toEqual([]);
    expect(hostsReachedBy("python -m pytest -q", "", registries)).toEqual([]);
    expect(hostsReachedBy("git status && git diff", "", registries, "github.com")).toEqual([]);
  });

  it("reads hosts from URLs, and git's remote for fetches without one", () => {
    expect(hostsReachedBy("curl -fsSL https://raw.githubusercontent.com/o/r/main/x.sh", "", registries)).toEqual(["raw.githubusercontent.com"]);
    expect(hostsReachedBy("git clone https://user@github.com/o/r.git", "", registries)).toEqual(["github.com"]);
    expect(hostsReachedBy("git clone git@github.com:o/r.git", "", registries)).toEqual(["github.com"]);
    expect(hostsReachedBy("git -C repo fetch --unshallow", "", registries, "github.com")).toEqual(["github.com"]);
    expect(hostsReachedBy("git fetch", "", registries)).toEqual([]);
  });
});

describe("allowlists", () => {
  it("matches exact names, and subdomains for wildcards", () => {
    expect(matchesAllowed("github.com", "github.com")).toBe(true);
    expect(matchesAllowed("GitHub.com", "github.com")).toBe(true);
    expect(matchesAllowed("api.github.com", "github.com")).toBe(false);
    expect(matchesAllowed("objects.githubusercontent.com", "*.githubusercontent.com")).toBe(true);
    expect(matchesAllowed("githubusercontent.com", "*.githubusercontent.com")).toBe(false);
  });

  it("labels each allowed host with what it serves", () => {
    const shared = { npm: ["packages.example.com"], pip: ["packages.example.com"] };
    expect(describeAllowed(["github.com", "*.githubusercontent.com", "packages.example.com", "docs.example.com"], shared)).toEqual([
      { host: "github.com", roles: ["github"] },
      { host: "*.githubusercontent.com", roles: ["github"] },
      { host: "packages.example.com", roles: ["npm", "pip"] },
      { host: "docs.example.com", roles: ["other"] },
    ]);
  });

  it("reads the sandbox's registries, with pip's defaults when it names no index", () => {
    expect(parseRegistries("npm=https://packages.example.com/npm/\npip=https://packages.example.com/pypi/simple/\n")).toEqual({ npm: ["packages.example.com"], pip: ["packages.example.com"] });
    expect(parseRegistries("npm=https://registry.npmjs.org/\npip=\n")).toEqual({ npm: ["registry.npmjs.org"], pip: ["pypi.org", "files.pythonhosted.org"] });
    expect(parseRegistries("")).toEqual({ npm: ["registry.npmjs.org"], pip: ["pypi.org", "files.pythonhosted.org"] });
  });

  it("recognizes the Copilot runtime's own hosts", () => {
    expect(isRuntimeHost("api.enterprise.githubcopilot.com")).toBe(true);
    expect(isRuntimeHost("telemetry.individual.githubcopilot.com")).toBe(true);
    expect(isRuntimeHost("githubcopilot.com.example.com")).toBe(false);
    expect(isRuntimeHost("telemetry.example.com")).toBe(false);
  });
});
