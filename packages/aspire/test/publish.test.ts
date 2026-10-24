import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManagedCopilotConfig } from "@managed-copilot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { APPHOST_DIR_IN_IMAGE, AzurePublishError, applyAccessRules, listSetting, prepareAzureConfig, rewriteWebhooks } from "../src/publish/config.js";
import { expr } from "../src/publish/expressions.js";
import { writeGatewayBuildFiles } from "../src/publish/gateway-image.js";
import { EGRESS_BICEP } from "../src/publish/egress.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const appHost = repoRoot;

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
      chat: { type: "shared", customizations: join(appHost, "copilot", "chat") },
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
    expect(prepared.config.environments.chat?.customizations).toBe(`${APPHOST_DIR_IN_IMAGE}/copilot/chat`);
    expect(prepared.config.environments.coder?.customizations).toBe(`${APPHOST_DIR_IN_IMAGE}/demos/software-factory/customizations/workshop`);
    expect(prepared.config.environments.coder?.image).toBeUndefined();
    expect(prepared.customizations).toEqual(["copilot/chat", "demos/software-factory/customizations/workshop"]);
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
  it("requires GitHub users or organizations for a public deployment unless explicitly opened", () => {
    expect(() => applyAccessRules(config({ access: undefined }), {})).toThrow(/no access rules/);
    expect(() => applyAccessRules(config({ access: { githubOrgs: [] } }), { githubUsers: [] })).toThrow(AzurePublishError);
    expect(applyAccessRules(config({ access: undefined }), { allowAnyAccount: true }).access).toBeUndefined();
    expect(applyAccessRules(config({ access: { githubOrgs: ["contoso"] } }), {}).access).toEqual({ githubOrgs: ["contoso"] });
  });

  it("adds deploy-time users and organizations to the AppHost's rules", () => {
    const merged = applyAccessRules(config({ access: { githubUsers: ["octocat"] } }), { githubUsers: listSetting(" octocat, hubot\nmona "), githubOrgs: listSetting("contoso") });
    expect(merged.access).toEqual({ githubUsers: ["octocat", "hubot", "mona"], githubOrgs: ["contoso"] });
    expect(applyAccessRules(config({ access: undefined }), { githubUsers: ["patniko"] }).access).toEqual({ githubUsers: ["patniko"] });
  });
});

describe("rewriteWebhooks", () => {
  it("points loopback webhooks at the deployed app's HTTPS address and leaves others alone", () => {
    const rewritten = rewriteWebhooks(config(), new Map([[7490, "assistant"]]));
    expect(rewritten.webhooks?.assistant?.url).toBe("https://assistant.{{CONTAINER_APP_ENV_DNS_SUFFIX}}/api/copilot-events?v=1");
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
    const files = writeGatewayBuildFiles({ appHostDirectory: appHost, name: "publish-test", customizations: ["copilot/chat"] });
    expect(files.context).toBe(repoRoot);
    expect(files.dockerfile).toBe(".managed-copilot/publish/publish-test/gateway.Dockerfile");
    const dockerfile = readFileSync(join(repoRoot, files.dockerfile), "utf8");
    expect(dockerfile).toMatch(/^FROM gateway AS azure$/m);
    expect(dockerfile).toMatch(/FROM azure AS deployment\nCOPY \["copilot\/chat","\/opt\/managed-copilot\/apphost\/copilot\/chat"\]\nENV MANAGED_COPILOT_APPHOST_DIR=\/opt\/managed-copilot\/apphost\n$/);
    const ignore = readFileSync(join(repoRoot, `${files.dockerfile}.dockerignore`), "utf8");
    expect(ignore.split("\n")).toContain("!copilot/chat/**");
    expect(ignore.split("\n")).toContain("!deploy/azure/**");
    expect(existsSync(join(repoRoot, "platform", "gateway", "Dockerfile"))).toBe(true);
  });
});
