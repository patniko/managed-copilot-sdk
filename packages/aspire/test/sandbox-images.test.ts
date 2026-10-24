import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AzurePublishError } from "../src/publish/config.js";
import { CANONICAL_BASE_IMAGE, imageMap, planSandboxImages, pushSandboxImages, repositoryName, type CommandRunner, type SandboxImageInputs } from "../src/publish/sandbox-images.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function inputs(environments: Record<string, string> = { "*": "", coder: "sandboxes/coder" }): SandboxImageInputs {
  const root = mkdtempSync(join(tmpdir(), "mc-sandbox-images-"));
  roots.push(root);
  write(join(root, "sandbox", "image", "Dockerfile"), "FROM node:24\n");
  write(join(root, "sandbox", "dist", "sandboxd", "main.js"), "// sandboxd\n");
  write(join(root, "layer", "Dockerfile"), "ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n");
  write(join(root, "apphost", "sandboxes", "coder", "Dockerfile"), `FROM ${CANONICAL_BASE_IMAGE}\n`);
  return {
    name: "copilot",
    sandboxContext: join(root, "sandbox"),
    azureLayerContext: join(root, "layer"),
    appHostDirectory: join(root, "apphost"),
    environments,
    npmRegistry: "https://registry.example/npm/",
    sdkVersion: "1.0.26",
  };
}

/** Records commands; `present` refs exist in the registry, and the base label is set unless `unlabeled`. */
function fakeRunner(options: { present?: string[]; failLogin?: boolean; unlabeled?: boolean } = {}) {
  const commands: string[] = [];
  const run: CommandRunner = async (command, args) => {
    const line = `${command} ${args.join(" ")}`;
    commands.push(line);
    if (command === "az") return { code: options.failLogin ? 1 : 0, output: options.failLogin ? "Please run 'az login' to setup account." : "Login Succeeded" };
    if (args[0] === "buildx" && args[1] === "imagetools") return { code: options.present?.includes(args[3]!) ? 0 : 1, output: "" };
    if (args[0] === "image" && args[1] === "inspect") return { code: 0, output: options.unlabeled ? "<no value>" : "1.0.26" };
    return { code: 0, output: "" };
  };
  return { run, commands };
}

describe("planSandboxImages", () => {
  it("tags each image by content and changes the tag only when its inputs change", () => {
    const first = inputs();
    const plan = planSandboxImages(first);
    expect(plan.builds.map((build) => build.repository)).toEqual(["copilot-sandbox", "copilot-sandbox-coder"]);
    expect(plan.builds.every((build) => /^[0-9a-f]{16}$/.test(build.tag))).toBe(true);
    expect(planSandboxImages(first).builds).toEqual(plan.builds);

    write(join(first.appHostDirectory, "sandboxes", "coder", "Dockerfile"), `FROM ${CANONICAL_BASE_IMAGE}\nRUN true\n`);
    const changed = planSandboxImages(first).builds;
    expect(changed[0]!.tag).toBe(plan.builds[0]!.tag);
    expect(changed[1]!.tag).not.toBe(plan.builds[1]!.tag);

    expect(planSandboxImages({ ...first, npmRegistry: "https://other.example/" }).builds[0]!.tag).not.toBe(plan.builds[0]!.tag);
    expect(JSON.parse(imageMap(plan))).toEqual({ "*": `copilot-sandbox:${plan.builds[0]!.tag}`, coder: `copilot-sandbox-coder:${plan.builds[1]!.tag}` });
  });

  it("names registry repositories safely and explains missing inputs", () => {
    expect(repositoryName("copilot", "Factory_Builder")).toBe("copilot-sandbox-factory-builder");
    const missing = inputs({ "*": "", coder: "sandboxes/missing" });
    expect(() => planSandboxImages(missing)).toThrow(/names image "sandboxes\/missing", but .* does not exist/);
    const unbuilt = inputs();
    rmSync(join(unbuilt.sandboxContext, "dist"), { recursive: true });
    expect(() => planSandboxImages(unbuilt)).toThrow(/Run `pnpm build`/);
  });
});

describe("pushSandboxImages", () => {
  const context = (run: CommandRunner) => ({ registryName: "myacr", loginServer: "myacr.azurecr.io", report: () => {}, run });

  it("builds nothing when the registry has every image", async () => {
    const plan = planSandboxImages(inputs());
    const fake = fakeRunner({ present: plan.builds.map((build) => `myacr.azurecr.io/${build.repository}:${build.tag}`) });
    expect(await pushSandboxImages(plan, context(fake.run))).toEqual({ pushed: [], present: plan.builds.map((build) => `myacr.azurecr.io/${build.repository}:${build.tag}`) });
    expect(fake.commands.some((command) => command.startsWith("docker build "))).toBe(false);
  });

  it("builds the base once, the environment image FROM it through a named context, and the Azure layer on top", async () => {
    const plan = planSandboxImages(inputs());
    const fake = fakeRunner();
    const result = await pushSandboxImages(plan, context(fake.run));
    expect(result.pushed).toEqual(plan.builds.map((build) => `myacr.azurecr.io/${build.repository}:${build.tag}`));
    const builds = fake.commands.filter((command) => command.startsWith("docker build "));
    expect(builds).toHaveLength(4);
    expect(builds.every((command) => command.includes("--platform linux/amd64"))).toBe(true);
    expect(builds[0]).toContain("NPM_REGISTRY=https://registry.example/npm/");
    expect(builds[0]).toContain("COPILOT_SDK_VERSION=1.0.26");
    const base = `managed-copilot-azure-sandbox-base:${plan.baseHash}`;
    expect(builds[0]).toContain(`-t ${base}`);
    expect(builds[1]).toContain(`BASE_IMAGE=${base}`);
    expect(builds[2]).toContain(`--build-context ${CANONICAL_BASE_IMAGE}=docker-image://${base}`);
    expect(builds[3]).toMatch(/BASE_IMAGE=managed-copilot-azure-env-copilot-sandbox-coder:/);
    expect(fake.commands.filter((command) => command.startsWith("docker push"))).toHaveLength(2);
    expect(fake.commands[0]).toBe("az acr login --name myacr");
  });

  it("refuses an environment image that is not built FROM the platform base", async () => {
    const fake = fakeRunner({ unlabeled: true });
    await expect(pushSandboxImages(planSandboxImages(inputs()), context(fake.run))).rejects.toThrow(/must be built FROM ghcr\.io\/patniko\/managed-copilot-sandbox/);
  });

  it("explains a registry sign-in failure", async () => {
    const error = await pushSandboxImages(planSandboxImages(inputs()), context(fakeRunner({ failLogin: true }).run)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AzurePublishError);
    expect((error as Error).message).toMatch(/az acr login.*Azure CLI must be installed and signed in[\s\S]*az login/);
  });
});
