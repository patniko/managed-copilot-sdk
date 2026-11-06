import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManagedCopilotConfig } from "@managed-copilot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { APPHOST_DIR_IN_IMAGE, AzurePublishError, applyAccessRules, applyOperators, listSetting, prepareAzureConfig, rewriteWebhooks } from "../src/publish/config.js";
import { expr } from "../src/publish/expressions.js";
import { writeGatewayBuildFiles } from "../src/publish/gateway-image.js";
import { EGRESS_BICEP } from "../src/publish/egress.js";
import { FOUNDRY_ACCESS_BICEP } from "../src/publish/foundry.js";
import { appTokenParameterOptions } from "../src/publish/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const appHost = repoRoot;

describe("published app credentials", () => {
  it("keeps explicit replacement credentials secret and overrides saved parameter values", () => {
    expect(appTokenParameterOptions({ "Parameters__app-github-token": " replacement-test-credential\n" })).toEqual({
      secret: true,
      value: "replacement-test-credential",
    });
    expect(appTokenParameterOptions({})).toEqual({ secret: true });
  });

  it("does not silently reuse a saved credential after an explicitly empty replacement", () => {
    expect(() => appTokenParameterOptions({ "Parameters__app-github-token": " " })).toThrow(/is empty/);
  });
});

describe("Azure egress persistence", () => {
  it("mounts the same restricted NFS CA directory for initialization and the non-root proxy", () => {
    expect(EGRESS_BICEP).toContain("storageType: 'NfsAzureFile'");
    expect(EGRESS_BICEP.match(/subPath: 'egress'/g)).toHaveLength(2);
    expect(EGRESS_BICEP.match(/mountPath: '\/var\/lib\/managed-copilot-egress'/g)).toHaveLength(2);
    expect(EGRESS_BICEP).toContain("chown 1000:1000 /var/lib/managed-copilot-egress && chmod 700");
    expect(EGRESS_BICEP).toContain("name: 'EGRESS_DATA_DIR'");
  });
});

function config(overrides: Partial<ManagedCopilotConfig> = {}): ManagedCopilotConfig {
  return {
    name: "copilot",
    access: { githubUsers: ["octocat"] },
    environments: {
      chat: { type: "shared", customizations: join(appHost, "customizations", "chat") },
      coder: { type: "isolated", size: "medium", image: join(appHost, "sandboxes", "coder"), customizations: join(appHost, "demos", "software-factory", "customizations", "workshop") },
      helper: { type: "promotable", promoteTo: "coder" },
    },
    webhooks: {
      assistant: { url: "http://localhost:7490/api/copilot-events?v=1", environments: ["chat"], events: ["session.idle"], secret: { secretEnv: "HOOK" } },
      partner: { url: "https://hooks.example.com/copilot", environments: ["chat"], events: ["session.idle"], secret: { secretEnv: "PARTNER" } },
    },
    ...overrides,
  } as ManagedCopilotConfig;
}

describe("prepareAzureConfig", () => {
  it("moves customizations into the image and hands image folders to the deploy step", () => {
    const prepared = prepareAzureConfig(config(), appHost);
    expect(prepared.config.environments.chat?.customizations).toBe(`${APPHOST_DIR_IN_IMAGE}/customizations/chat`);
    expect(prepared.config.environments.coder?.customizations).toBe(`${APPHOST_DIR_IN_IMAGE}/demos/software-factory/customizations/workshop`);
    expect(prepared.config.environments.coder?.image).toBeUndefined();
    expect(prepared.customizations).toEqual(["customizations/chat", "demos/software-factory/customizations/workshop"]);
    expect(prepared.sandboxImages).toEqual({ coder: { folder: "sandboxes/coder" }, "*": {} });
  });

  it("builds system packages into the environment's image", () => {
    const withPackages = config({
      environments: { tools: { type: "isolated", packages: { system: ["jq", "ffmpeg", "jq"], npm: ["typescript"] } }, chat: { type: "shared" } },
    });
    const prepared = prepareAzureConfig(withPackages, appHost);
    expect(prepared.sandboxImages).toEqual({ tools: { system: ["ffmpeg", "jq"] }, "*": {} });
    expect(prepared.config.environments.tools?.packages).toEqual({ system: ["jq", "ffmpeg", "jq"], npm: ["typescript"] });
  });

  it("needs no sandbox images for a shared-only deployment", () => {
    const prepared = prepareAzureConfig(config({ environments: { chat: { type: "shared" } } }), appHost);
    expect(prepared.sandboxImages).toEqual({});
  });

  it("refuses folders outside the AppHost directory", () => {
    const outside = config({ environments: { chat: { type: "shared", customizations: resolve(appHost, "..", "elsewhere") } } });
    expect(() => prepareAzureConfig(outside, appHost)).toThrow(AzurePublishError);
    expect(() => prepareAzureConfig(outside, appHost)).toThrow(/must be inside the AppHost directory/);
  });
});

describe("applyAccessRules", () => {
  it("requires GitHub users or organizations for every public deployment", () => {
    expect(() => applyAccessRules(config({ access: undefined }), {})).toThrow(/no access rules/);
    expect(() => applyAccessRules(config({ access: { githubOrgs: [] } }), { githubUsers: [] })).toThrow(AzurePublishError);
    expect(applyAccessRules(config({ access: { githubOrgs: ["contoso"] } }), {}).access).toEqual({ githubOrgs: ["contoso"] });
  });

  it("adds deploy-time users and organizations to the AppHost's rules", () => {
    const merged = applyAccessRules(config({ access: { githubUsers: ["octocat"] } }), { githubUsers: listSetting(" octocat, hubot\nmona "), githubOrgs: listSetting("contoso") });
    expect(merged.access).toEqual({ githubUsers: ["octocat", "hubot", "mona"], githubOrgs: ["contoso"] });
    expect(applyAccessRules(config({ access: undefined }), { githubUsers: ["patniko"] }).access).toEqual({ githubUsers: ["patniko"] });
  });
});

describe("applyOperators", () => {
  it("adds deploy-time operators to the AppHost's and leaves the console off when none are named", () => {
    const merged = applyOperators(config({ operators: { githubUsers: ["octocat"] } }), { githubUsers: listSetting("octocat, hubot"), githubOrgs: listSetting("contoso") });
    expect(merged.operators).toEqual({ githubUsers: ["octocat", "hubot"], githubOrgs: ["contoso"] });
    expect(applyOperators(config({ operators: undefined }), { githubOrgs: ["contoso"] }).operators).toEqual({ githubOrgs: ["contoso"] });
    const none = applyOperators(config({ operators: { githubUsers: [] } }), {});
    expect(none).not.toHaveProperty("operators");
    expect(none.access).toEqual(config({}).access);
  });
});

describe("rewriteWebhooks", () => {
  it("points loopback webhooks at the deployed app's HTTPS address and leaves others alone", () => {
    const rewritten = rewriteWebhooks(config(), new Map([[7490, "assistant"]]));
    expect(rewritten.webhooks?.assistant?.url).toBe("http://assistant/api/copilot-events?v=1");
    expect(rewritten.webhooks?.partner?.url).toBe("https://hooks.example.com/copilot");
  });

  it("fails with the fix when no deployed app serves a loopback webhook", () => {
    expect(() => rewriteWebhooks(config(), new Map())).toThrow(/Webhook "assistant" calls http:\/\/localhost:7490/);
  });
});

describe("expr", () => {
  it("serializes literals and deploy-time values in the reference-expression wire format", () => {
    const output = { toJSON: () => ({ $handle: "output:1" }) };
    expect(expr`assistant.${output},{literal}`.toJSON()).toEqual({ $expr: { format: "assistant.{0},{{literal}}", valueProviders: [{ $handle: "output:1" }] } });
    expect(expr`plain ${"text"} ${42}`.toJSON()).toEqual({ $expr: { format: "plain text 42" } });
  });

  it("hands the transport the raw value providers and is not a plain object (whose members it would send one by one)", () => {
    const output = { toJSON: () => ({ $handle: "output:1" }) };
    const value = expr`assistant.${output}`;
    expect(value.toTransportValue()).toEqual({ $expr: { format: "assistant.{0}", valueProviders: [output] } });
    expect(Object.getPrototypeOf(value)).not.toBe(Object.prototype);
  });
});

describe("writeGatewayBuildFiles", () => {
  const written = join(repoRoot, ".managed-copilot", "publish", "publish-test");
  afterEach(() => rmSync(written, { recursive: true, force: true }));

  it("adds a deployment stage with the customization folders and allows only them into the context", () => {
    const files = writeGatewayBuildFiles({ appHostDirectory: appHost, name: "publish-test", customizations: ["customizations/chat"] });
    expect(files.context).toBe(repoRoot);
    expect(files.dockerfile).toBe(".managed-copilot/publish/publish-test/gateway.Dockerfile");
    const dockerfile = readFileSync(join(repoRoot, files.dockerfile), "utf8");
    expect(dockerfile).toMatch(/^FROM gateway AS azure$/m);
    expect(dockerfile).toMatch(/FROM azure AS deployment\nCOPY \["customizations\/chat","\/opt\/managed-copilot\/apphost\/customizations\/chat"\]\nENV MANAGED_COPILOT_APPHOST_DIR=\/opt\/managed-copilot\/apphost\n$/);
    const ignore = readFileSync(join(repoRoot, `${files.dockerfile}.dockerignore`), "utf8");
    expect(ignore.split("\n")).toContain("!customizations/chat/**");
    expect(ignore.split("\n")).toContain("!deployments/azure/**");
    expect(existsSync(join(repoRoot, "services", "gateway", "Dockerfile"))).toBe(true);
  });
});

describe("Foundry access", () => {
  it("grants the gateway identity only Cognitive Services OpenAI User, on the declared account in its own resource group", () => {
    expect(FOUNDRY_ACCESS_BICEP).toContain("var openAiUser = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'");
    expect(FOUNDRY_ACCESS_BICEP).toContain("resourceGroup: accountResourceGroup");
    expect(FOUNDRY_ACCESS_BICEP).toContain("subscriptionId: subscriptionId");
    expect(FOUNDRY_ACCESS_BICEP).toContain("scope: 'Microsoft.CognitiveServices/accounts/${accountName}'");
    expect(FOUNDRY_ACCESS_BICEP).toContain("name: guid(accountId, gatewayPrincipalId, openAiUser)");
    expect(FOUNDRY_ACCESS_BICEP).toContain("principalType: 'ServicePrincipal'");
    expect(FOUNDRY_ACCESS_BICEP.match(/Microsoft\.Authorization\/roleAssignments/g)).toHaveLength(1);
    // Bicep writes a nested template's strings literally: an ARM expression there would never be evaluated.
    expect(FOUNDRY_ACCESS_BICEP).not.toMatch(/'\[/);
  });
});
