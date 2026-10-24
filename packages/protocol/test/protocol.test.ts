import { describe, expect, it } from "vitest";
import { hostMatches, isHostAllowed, narrowNetwork, NETWORK_DISABLED, NETWORK_ENABLED, normalizeNetwork } from "../src/network.js";
import { parseConfig } from "../src/config.js";

describe("network policy", () => {
  it("normalizes the shorthand forms", () => {
    expect(normalizeNetwork(undefined)).toEqual(NETWORK_ENABLED);
    expect(normalizeNetwork(undefined, NETWORK_DISABLED)).toEqual(NETWORK_DISABLED);
    expect(normalizeNetwork(true)).toEqual(NETWORK_ENABLED);
    expect(normalizeNetwork(false)).toEqual(NETWORK_DISABLED);
    expect(normalizeNetwork([])).toEqual(NETWORK_DISABLED);
    expect(normalizeNetwork(["GitHub.com", "*.githubusercontent.com"])).toEqual({
      access: "restricted",
      allowedDomains: ["*.githubusercontent.com", "github.com"],
    });
    expect(normalizeNetwork({ access: "restricted", allowedDomains: [] })).toEqual(NETWORK_DISABLED);
  });

  it("rejects URLs and ports as host patterns", () => {
    expect(() => normalizeNetwork(["https://github.com"])).toThrow(/Invalid network host pattern/);
    expect(() => normalizeNetwork(["github.com:443"])).toThrow(/Invalid network host pattern/);
  });

  it("matches wildcards against subdomains but not the apex", () => {
    expect(hostMatches("*.example.com", "api.example.com")).toBe(true);
    expect(hostMatches("*.example.com", "example.com")).toBe(false);
    expect(hostMatches("*.example.com", "evil-example.com")).toBe(false);
    expect(isHostAllowed(normalizeNetwork(["pypi.org"]), "PyPI.org.")).toBe(true);
  });

  it("only lets callers narrow the environment ceiling", () => {
    expect(narrowNetwork(NETWORK_DISABLED, true)).toEqual(NETWORK_DISABLED);
    expect(narrowNetwork(normalizeNetwork(["github.com"]), true)).toEqual(normalizeNetwork(["github.com"]));
    expect(narrowNetwork(NETWORK_ENABLED, false)).toEqual(NETWORK_DISABLED);
    expect(narrowNetwork(NETWORK_ENABLED, ["pypi.org"])).toEqual(normalizeNetwork(["pypi.org"]));
    expect(narrowNetwork(normalizeNetwork(["*.github.com", "pypi.org"]), ["api.github.com", "npmjs.org", "*.x.github.com"])).toEqual(
      normalizeNetwork(["api.github.com", "*.x.github.com"]),
    );
    expect(narrowNetwork(normalizeNetwork(["pypi.org"]), ["npmjs.org"])).toEqual(NETWORK_DISABLED);
  });
});

describe("AppHost configuration", () => {
  it("accepts the spec's example deployment", () => {
    const config = parseConfig({
      access: { githubOrgs: ["contoso"] },
      environments: {
        chat: { type: "shared", customizations: "./copilot/chat", models: ["claude-sonnet-5"], network: ["learn.microsoft.com"] },
        coder: { type: "isolated", image: "./sandboxes/coder", size: "medium", warm: 2 },
        helper: { type: "promotable", promoteTo: "coder" },
      },
      inline: { types: ["shared", "isolated"], sizes: ["small"] },
    });
    expect(config.name).toBe("copilot");
    expect(Object.keys(config.environments)).toEqual(["chat", "coder", "helper"]);
  });

  it("rejects broken cross-references", () => {
    expect(() =>
      parseConfig({ environments: { helper: { type: "promotable", promoteTo: "missing" } } }),
    ).toThrow(/promoteTo must name an isolated environment/);
    expect(() => parseConfig({ environments: { chat: { type: "shared", vaults: ["nope"] } } })).toThrow(/Unknown vault/);
    expect(() => parseConfig({ environments: { chat: { type: "shared", size: "small" } } })).toThrow(/shared environments have no sandbox/);
  });
});
