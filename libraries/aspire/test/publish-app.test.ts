import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManagedCopilotConfig } from "@managed-copilot/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appAccessSummary, publishApp, publishManagedCopilot, type PublishAppOptions } from "../src/publish/index.js";
import type { PublishBuilder } from "../src/publish/types.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NAME = "publish-app-test";
const DOMAIN = "bravedesert-123.westus2.azurecontainerapps.io";

type Call = readonly [method: string, args: readonly unknown[]];

/** A container builder that records every call; awaiting it gives the resource, as Aspire's generated SDK does. */
class FakeContainer {
  readonly calls: Call[] = [];
  readonly resource = {
    getEndpoint: async (name: string) => ({ endpoint: `${this.name}:${name}` }),
    withEnvironment: (name: string, value: unknown) => this.record("withEnvironment", [name, value]),
  };
  constructor(readonly name: string) {
    for (const method of [
      "withBuildArg",
      "withContainerBuildOptions",
      "withHttpEndpoint",
      "withExternalHttpEndpoints",
      "withEnvironment",
      "withEnvironmentCallback",
      "withComputeEnvironment",
      "withAzureUserAssignedIdentity",
      "waitFor",
      "publishAsManagedCopilotGateway",
      "publishAsManagedCopilotApp",
      "publishAsManagedCopilotPublicApp",
    ]) {
      (this as unknown as Record<string, (...args: unknown[]) => FakeContainer>)[method] = (...args: unknown[]) => this.record(method, args);
    }
  }
  private record(method: string, args: readonly unknown[]): this {
    this.calls.push([method, args]);
    return this;
  }
  then<T>(onFulfilled: (resource: FakeContainer["resource"]) => T) {
    return Promise.resolve(this.resource).then(onFulfilled);
  }
  called(method: string): readonly unknown[][] {
    return this.calls.filter(([name]) => name === method).map(([, args]) => [...args]);
  }
  env(): Record<string, unknown> {
    return Object.fromEntries(this.called("withEnvironment").map(([name, value]) => [name as string, value]));
  }
}

interface Step {
  readonly name: string;
  readonly run: (context: unknown) => Promise<void>;
}

/** The members of the generated AppHost builder that publish mode uses, recording what it declares. */
function fakeBuilder(settings: Record<string, string> = {}) {
  const containers = new Map<string, FakeContainer>();
  const parameters: string[] = [];
  const steps: Step[] = [];
  const environment = {
    getOutput: async (output: string) => ({ output, value: async () => (output === "AZURE_CONTAINER_APPS_ENVIRONMENT_DEFAULT_DOMAIN" ? DOMAIN : null) }),
  };
  const builder = {
    appHostDirectory: async () => repoRoot,
    getConfiguration: async () => ({
      exists: async (key: string) => key in settings,
      getConfigValue: async (key: string) => settings[key]!,
    }),
    addAzureContainerAppEnvironment: () => {
      const declared = { withManagedCopilotNetworkAndStorage: () => declared, then: <T>(done: (value: typeof environment) => T) => Promise.resolve(environment).then(done) };
      return declared;
    },
    addDockerfile: (name: string) => {
      const container = new FakeContainer(name);
      containers.set(name, container);
      return container;
    },
    addParameter: async (name: string) => {
      parameters.push(name);
      return { parameter: name };
    },
    addParameterWithGeneratedValue: async (name: string) => ({ parameter: name }),
    pipeline: () => ({
      addStep: async (name: string, run: Step["run"]) => {
        steps.push({ name, run });
      },
    }),
  };
  return { builder: builder as unknown as PublishBuilder, containers, parameters, steps };
}

const config = { name: NAME, access: { githubUsers: ["octocat"] }, environments: { chat: { type: "shared" } } } as unknown as ManagedCopilotConfig;

async function deploy(settings: Record<string, string> = { "Parameters:app-allowed-ips": "203.0.113.7/32" }) {
  const fake = fakeBuilder(settings);
  const copilot = await publishManagedCopilot(fake.builder, NAME, { config, secrets: [], options: { environments: {} } as never, appHostDirectory: repoRoot });
  const publish = (app: PublishAppOptions) => publishApp(fake.builder as never, copilot as never, app);
  /** Runs the deploy step that prints the platform URL and who can open the apps. */
  const summary = async () => {
    const lines: [string, string][] = [];
    const step = fake.steps.find((candidate) => candidate.name === `print-${NAME}-url`)!;
    await step.run({ summary: async () => ({ add: async (key: string, value: string) => void lines.push([key, value]) }) });
    return lines;
  };
  return { ...fake, publish, summary };
}

const app = (name: string, port: number, options: Partial<PublishAppOptions> = {}): PublishAppOptions => ({
  name,
  dockerfile: `demos/${name}/Dockerfile`,
  port,
  healthPath: "/api/health",
  ...options,
});

// Deploy-time settings also come from the environment (`npx managed-copilot deploy` passes them there).
beforeEach(() => {
  vi.stubEnv("Parameters__app-allowed-ips", undefined);
  vi.stubEnv("Parameters__app-github-token", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(join(repoRoot, ".managed-copilot", "publish", NAME), { recursive: true, force: true });
});

describe("publishApp access", () => {
  it("keeps an app behind Parameters:app-allowed-ips, acting as the deployment's GitHub account, by default", async () => {
    const { publish, containers, parameters } = await deploy();
    await publish(app("dispatch", 7470));
    const dispatch = containers.get("dispatch")!;
    expect(dispatch.called("publishAsManagedCopilotApp")).toEqual([[expect.anything(), "apps/dispatch", "/data", 7470, "/api/health", "203.0.113.7/32"]]);
    expect(dispatch.called("publishAsManagedCopilotPublicApp")).toEqual([]);
    expect(dispatch.env().MANAGED_COPILOT_GITHUB_TOKEN).toEqual({ parameter: "app-github-token" });
    expect(parameters).toEqual(["app-github-token"]);
  });

  it("opens a public app to any address, without the deployment's GitHub token", async () => {
    const { publish, containers, parameters } = await deploy();
    await publish(app("front-desk", 7450, { public: true, env: { MANAGED_COPILOT_GITHUB_TOKEN: "local value", FRONT_DESK_MODE: "demo" } }));
    const frontDesk = containers.get("front-desk")!;
    expect(frontDesk.called("publishAsManagedCopilotPublicApp")).toEqual([[expect.anything(), "apps/front-desk", "/data", 7450, "/api/health"]]);
    expect(frontDesk.called("publishAsManagedCopilotApp")).toEqual([]);
    expect(frontDesk.env()).not.toHaveProperty("MANAGED_COPILOT_GITHUB_TOKEN");
    expect(frontDesk.env()).toMatchObject({ MANAGED_COPILOT_URL: expect.anything(), MANAGED_COPILOT_DATA_DIR: "/data", FRONT_DESK_MODE: "demo" });
    expect(parameters).toEqual([]);
  });

  it("refuses a public app that would act as the deployment's GitHub account, before declaring it", async () => {
    const { publish, containers, parameters } = await deploy();
    await expect(publish(app("front-desk", 7450, { public: true, githubToken: true }))).rejects.toThrow(/"front-desk" is public, so it can't act as your GitHub account/);
    expect(containers.has("front-desk")).toBe(false);
    expect(parameters).toEqual([]);
    // Its port stays free: the AppHost can publish it again without the token.
    await publish(app("front-desk", 7450, { public: true }));
    expect(containers.get("front-desk")!.called("publishAsManagedCopilotPublicApp")).toHaveLength(1);
  });

  it("opens an app only for public: true", async () => {
    const { publish, containers } = await deploy();
    await publish(app("dispatch", 7470, { public: "yes" as never }));
    expect(containers.get("dispatch")!.called("publishAsManagedCopilotApp")).toHaveLength(1);
    expect(containers.get("dispatch")!.called("publishAsManagedCopilotPublicApp")).toEqual([]);
  });

  it('keeps "*" an explicit deploy-time choice for apps that aren\'t public', async () => {
    const { publish, containers } = await deploy({ "Parameters:app-allowed-ips": "*" });
    await publish(app("dispatch", 7470));
    expect(containers.get("dispatch")!.called("publishAsManagedCopilotApp")[0]![5]).toBe("");
  });

  it("doesn't look up this machine's address when every app is public", async () => {
    const lookups = vi.fn(async () => {
      throw new Error("no network in tests");
    });
    vi.stubGlobal("fetch", lookups);
    const { publish, summary } = await deploy({});
    await publish(app("front-desk", 7450, { public: true }));
    expect(lookups).not.toHaveBeenCalled();
    expect(await summary()).toEqual([
      ["Managed Copilot", expect.stringContaining(`https://${NAME}.${DOMAIN}`)],
      ["Public apps", `https://front-desk.${DOMAIN} (any address; they sign in their own users)`],
    ]);
  });

  it("says why an allowlisted app can't be published when this machine's address is unknown", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    const { publish } = await deploy({});
    await expect(publish(app("dispatch", 7470))).rejects.toThrow(/Parameters:app-allowed-ips.*public: true instead/s);
  });

  it("prints who can open each app after deploying", async () => {
    const { publish, summary } = await deploy();
    await publish(app("dispatch", 7470));
    await publish(app("gallery", 7460, { githubToken: false }));
    await publish(app("front-desk", 7450, { public: true }));
    expect(await summary()).toEqual([
      ["Managed Copilot", expect.stringContaining(`https://${NAME}.${DOMAIN}`)],
      ["Apps open to", "203.0.113.7/32: dispatch, gallery (change with Parameters:app-allowed-ips)"],
      ["Public apps", `https://front-desk.${DOMAIN} (any address; they sign in their own users)`],
    ]);
  });
});

describe("appAccessSummary", () => {
  it('names the apps that act as the GitHub account for anyone when the allowlist is "*"', () => {
    const restrictedApps = [
      { name: "dispatch", actsAsAccount: true },
      { name: "gallery", actsAsAccount: false },
    ];
    expect(appAccessSummary({ allowedSources: "*", restrictedApps, publicApps: [] }, DOMAIN)).toEqual([
      ["Apps open to", "any address: dispatch, gallery (dispatch acts as your GitHub account for anyone; change with Parameters:app-allowed-ips)"],
    ]);
    expect(appAccessSummary({ allowedSources: "*", restrictedApps: [{ name: "gallery", actsAsAccount: false }], publicApps: [] }, DOMAIN)).toEqual([
      ["Apps open to", "any address: gallery (change with Parameters:app-allowed-ips)"],
    ]);
  });

  it("says nothing about apps when the AppHost publishes none", () => {
    expect(appAccessSummary({ restrictedApps: [], publicApps: [] }, DOMAIN)).toEqual([]);
  });
});
