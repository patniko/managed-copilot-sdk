import { describe, expect, it } from "vitest";
import { hostMatches, isHostAllowed, narrowNetwork, NETWORK_DISABLED, NETWORK_ENABLED, normalizeNetwork } from "../src/network.js";
import { EnvironmentRequestSchema, parseConfig } from "../src/config.js";
import { appUserLogin, decodeHeaderValue, encodeHeaderValue, parseAppUser } from "../src/apps.js";

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

  it("rejects URLs, ports, and single-label hosts as patterns", () => {
    expect(() => normalizeNetwork(["https://github.com"])).toThrow(/Invalid network host pattern/);
    expect(() => normalizeNetwork(["github.com:443"])).toThrow(/Invalid network host pattern/);
    expect(() => normalizeNetwork(["localhost"])).toThrow(/Invalid network host pattern/);
    expect(() => normalizeNetwork(["*.com"])).toThrow(/Invalid network host pattern/);
  });

  it("matches wildcards against subdomains but not the apex", () => {
    expect(hostMatches("*.example.com", "api.example.com")).toBe(true);
    expect(hostMatches("*.example.com", "example.com")).toBe(false);
    expect(hostMatches("*.example.com", "evil-example.com")).toBe(false);
    expect(isHostAllowed(normalizeNetwork(["pypi.org"]), "PyPI.org.")).toBe(true);
  });

  it("ignores ports and rejects IP literals when matching request hosts", () => {
    expect(hostMatches("pypi.org", "pypi.org:443")).toBe(true);
    expect(hostMatches("*.example.com", "api.example.com..")).toBe(true);
    expect(isHostAllowed(normalizeNetwork(["example.com"]), "[::1]:443")).toBe(false);
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

  it("keeps the narrower pattern when a wildcard request overlaps a narrower ceiling", () => {
    expect(narrowNetwork(normalizeNetwork(["api.example.com"]), ["*.example.com"])).toEqual(normalizeNetwork(["api.example.com"]));
    expect(narrowNetwork(normalizeNetwork(["*.x.github.com"]), ["*.github.com"])).toEqual(normalizeNetwork(["*.x.github.com"]));
    expect(narrowNetwork(normalizeNetwork(["example.com"]), ["*.example.com"])).toEqual(NETWORK_DISABLED);
  });
});

describe("AppHost configuration", () => {
  it("accepts the spec's example deployment", () => {
    const config = parseConfig({
      access: { githubOrgs: ["contoso"] },
      environments: {
        chat: { type: "shared", customizations: "./customizations/chat", models: ["claude-sonnet-5"], network: ["learn.microsoft.com"] },
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
    expect(() => parseConfig({ environments: { helper: { type: "promotable" } } })).toThrow(/must name an isolated environment in promoteTo/);
    expect(() => parseConfig({ environments: { chat: { type: "shared", vaults: ["nope"] } } })).toThrow(/Unknown vault/);
    expect(() => parseConfig({ environments: { chat: { type: "shared", size: "small" } } })).toThrow(/shared environments have no sandbox/);
    expect(() => parseConfig({ environments: { chat: { type: "shared", env: { A: "1" } } } })).toThrow(/shared environments have no sandbox/);
  });

  it("keeps sandbox credentials out of shared environments and requires exact vault hosts", () => {
    const stripe = { env: "STRIPE_API_KEY", value: { secretEnv: "STRIPE" }, hosts: ["api.stripe.com"] };
    expect(() => parseConfig({ vaults: { payments: [stripe] }, environments: { chat: { type: "shared", vaults: ["payments"] } } })).toThrow(
      /shared environments cannot use/,
    );
    expect(() => parseConfig({ vaults: { payments: [{ ...stripe, hosts: ["*.stripe.com"] }] }, environments: {} })).toThrow(/exact host name/);
    expect(parseConfig({ vaults: { payments: [stripe] }, environments: { coder: { type: "isolated", vaults: ["payments"] } } }).vaults?.payments).toHaveLength(1);
  });

  it("accepts orchestrator environments whose workers are isolated environments", () => {
    const config = parseConfig({
      environments: {
        coder: { type: "isolated", size: "medium" },
        reviewer: { type: "isolated", network: false },
        team: { type: "orchestrator", workers: ["coder", "reviewer"], maxWorkers: 3, models: ["claude-sonnet-5"] },
      },
    });
    expect(config.environments["team"]).toMatchObject({ type: "orchestrator", workers: ["coder", "reviewer"], maxWorkers: 3 });
  });

  it("rejects orchestrator environments without isolated workers, with sandbox settings, or inline", () => {
    const coder = { type: "isolated" } as const;
    expect(() => parseConfig({ environments: { team: { type: "orchestrator" } } })).toThrow(/must name the isolated environments their workers run in/);
    expect(() => parseConfig({ environments: { team: { type: "orchestrator", workers: [] } } })).toThrow();
    expect(() => parseConfig({ environments: { team: { type: "orchestrator", workers: ["missing"] } } })).toThrow(/Worker environment \W*missing\W* must be an isolated environment/);
    expect(() => parseConfig({ environments: { chat: { type: "shared" }, team: { type: "orchestrator", workers: ["chat"] } } })).toThrow(/must be an isolated environment/);
    expect(() => parseConfig({ environments: { coder, team: { type: "orchestrator", workers: ["coder", "coder"] } } })).toThrow(/listed twice/);
    expect(() => parseConfig({ environments: { coder, team: { type: "orchestrator", workers: ["coder"], size: "small" } } })).toThrow(/orchestrator environments have no sandbox/);
    expect(() => parseConfig({ environments: { coder, team: { type: "orchestrator", workers: ["coder"], maxWorkers: 17 } } })).toThrow();
    expect(() => parseConfig({ environments: { coder: { type: "isolated", workers: ["coder"] } } })).toThrow(/only valid on orchestrator environments/);
    expect(() => parseConfig({ environments: { coder: { type: "isolated", maxWorkers: 2 } } })).toThrow(/only valid on orchestrator environments/);
    expect(() => parseConfig({ environments: { coder }, inline: { types: ["orchestrator"] } })).toThrow(/cannot be inline/);
    const stripe = { env: "STRIPE_API_KEY", value: { secretEnv: "STRIPE" }, hosts: ["api.stripe.com"] };
    expect(() => parseConfig({ vaults: { payments: [stripe] }, environments: { coder, team: { type: "orchestrator", workers: ["coder"], vaults: ["payments"] } } })).toThrow(
      /orchestrator environments cannot use/,
    );
  });

  it("routes an environment's model calls to a declared Foundry account's deployments", () => {
    const foundry = { contoso: { resourceGroup: "ai", deployments: ["gpt-5-mini", "grok-4.7"] } };
    const config = parseConfig({
      foundry,
      environments: {
        support: { type: "shared", inference: { foundry: "contoso" }, models: ["grok-4.7"] },
        coder: { type: "isolated", inference: { foundry: "contoso" } },
        helper: { type: "promotable", inference: { foundry: "contoso" }, promoteTo: "coder" },
      },
      apps: { "support-site": { environments: ["support", "helper"], anyGitHubUser: true, key: { secretEnv: "SUPPORT_SITE_KEY" } } },
    });
    expect(config.environments["support"]!.inference).toEqual({ foundry: "contoso" });
    expect(config.apps?.["support-site"]).toMatchObject({ environments: ["support", "helper"], anyGitHubUser: true });
    expect(() => parseConfig({ environments: { support: { type: "shared", inference: { foundry: "missing" } } } })).toThrow(/Unknown Foundry account \W*missing\W*/);
    expect(() => parseConfig({ foundry, environments: { support: { type: "shared", inference: { foundry: "contoso" }, models: ["claude-sonnet-5"] } } })).toThrow(
      /claude-sonnet-5\W* is not a deployment of Foundry account \W*contoso/,
    );
    expect(() => parseConfig({ foundry: { contoso: { resourceGroup: "ai", deployments: [] } }, environments: {} })).toThrow();
    // Promotion keeps a session's billing route.
    expect(() => parseConfig({ foundry, environments: { coder: { type: "isolated" }, helper: { type: "promotable", inference: { foundry: "contoso" }, promoteTo: "coder" } } })).toThrow(
      /promotion keeps a session's billing route/,
    );
  });

  it("rejects apps that name unknown or repeated environments", () => {
    const environments = { support: { type: "shared" } } as const;
    const key = { secretEnv: "SITE_KEY" };
    expect(() => parseConfig({ environments, apps: { site: { environments: ["missing"], key } } })).toThrow(/Unknown environment \W*missing\W*/);
    expect(() => parseConfig({ environments, apps: { site: { environments: ["support", "support"], key } } })).toThrow(/listed twice/);
    expect(() => parseConfig({ environments, apps: { site: { environments: [], key } } })).toThrow();
    expect(() => parseConfig({ environments, apps: { "Bad Name": { environments: ["support"], key } } })).toThrow();
    expect(() => parseConfig({ environments, apps: { site: { environments: ["support"] } } })).toThrow();
  });
});

describe("environment requests", () => {
  it("needs a name or type and rejects sandbox inputs on shared placement", () => {
    expect(EnvironmentRequestSchema.safeParse({}).success).toBe(false);
    expect(EnvironmentRequestSchema.safeParse({ name: "chat" }).success).toBe(true);
    expect(EnvironmentRequestSchema.safeParse({ type: "shared", files: { "a.txt": "aGk=" } }).success).toBe(false);
    expect(EnvironmentRequestSchema.safeParse({ type: "orchestrator", size: "small" }).success).toBe(false);
    expect(EnvironmentRequestSchema.safeParse({ type: "isolated", size: "small", files: { "a.txt": "aGk=" } }).success).toBe(true);
  });
});

describe("app users", () => {
  it("accepts any printable ID and name, and travels as ASCII header values", () => {
    expect(parseAppUser({ id: "auth0|5f2c", name: "Zoë Ångström" })).toEqual({ id: "auth0|5f2c", name: "Zoë Ångström" });
    const encoded = encodeHeaderValue("Zoë Ångström");
    expect(encoded).toMatch(/^[\x21-\x7e]+$/);
    expect(decodeHeaderValue(encoded)).toBe("Zoë Ångström");
    expect(decodeHeaderValue("%E0%A4%A")).toBeUndefined();
    expect(appUserLogin("support-site", "auth0|5f2c")).toBe("support-site/auth0|5f2c");
  });

  it("rejects empty, padded, control-character, oversized, and unknown fields", () => {
    expect(() => parseAppUser({ id: "" })).toThrow(/must not be empty/);
    expect(() => parseAppUser({ id: " alice" })).toThrow(/whitespace/);
    expect(() => parseAppUser({ id: "a\nb" })).toThrow(/control characters/);
    expect(() => parseAppUser({ id: "x".repeat(257) })).toThrow(/at most 256/);
    expect(() => parseAppUser({ id: "alice", email: "a@example.com" })).toThrow();
  });
});
