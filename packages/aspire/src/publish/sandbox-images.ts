/**
 * Sandbox images for Azure Container Apps Sandboxes. `aspire deploy` builds them on the deploying machine for
 * linux/amd64 (the base image from platform/sandbox, each isolated environment's own `image` folder FROM it, and the
 * Azure layer from deploy/azure/sandbox on top) and pushes them to the Container Apps environment's registry.
 *
 * Tags are content hashes computed at publish time, so the gateway's image map is known before anything is built, and
 * redeploys skip images the registry already has. The base image is never tagged with its canonical name locally (that
 * tag belongs to `aspire run`'s native-architecture image); environment images reach it through a named build context.
 */
import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { AzurePublishError } from "./config.js";

/** The image every environment image must be built FROM (the platform's contract). */
export const CANONICAL_BASE_IMAGE = "ghcr.io/patniko/managed-copilot-sandbox:0.1.0";
/** Set by the base image (and inherited by images built FROM it). */
const BASE_LABEL = "managed-copilot.copilot-sdk";
const PLATFORM = "linux/amd64";

export interface SandboxImageInputs {
  /** The platform's resource name; prefixes the registry repositories. */
  readonly name: string;
  /** platform/sandbox, built (`dist/sandboxd/main.js` exists). */
  readonly sandboxContext: string;
  /** deploy/azure/sandbox. */
  readonly azureLayerContext: string;
  readonly appHostDirectory: string;
  /** Isolated environment → AppHost-relative image folder; `*` is the base image (see prepareAzureConfig). */
  readonly environments: Readonly<Record<string, string>>;
  readonly npmRegistry: string;
  readonly pipIndexUrl?: string | undefined;
  /** The stock runtime version installed in the image (the gateway's @github/copilot-sdk version). */
  readonly sdkVersion: string;
}

export interface SandboxImageBuild {
  /** Environment name, or `*` for the base image. */
  readonly environment: string;
  readonly repository: string;
  readonly tag: string;
  /** The environment's own image folder (absolute); absent for the base image. */
  readonly imageDirectory?: string;
}

export interface SandboxImagePlan {
  readonly inputs: SandboxImageInputs;
  readonly baseHash: string;
  readonly builds: readonly SandboxImageBuild[];
}

function hashTree(root: string, include: (relativePath: string) => boolean, hash: Hash = createHash("sha256")): Hash {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(full);
      } else if (entry.isFile() && include(rel)) {
        files.push(rel);
      }
    }
  };
  walk(root);
  for (const file of files.sort()) {
    hash.update(file).update("\0");
    hash.update(readFileSync(join(root, file))).update("\0");
  }
  return hash;
}

const short = (hash: Hash) => hash.digest("hex").slice(0, 16);

/** A registry repository name for an environment (lowercase letters, digits, and single hyphens). */
export function repositoryName(name: string, environment: string): string {
  const suffix = environment === "*" ? "" : `-${environment.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
  return `${name}-sandbox${suffix}`;
}

/** Computes every image's repository and content tag without building anything. */
export function planSandboxImages(inputs: SandboxImageInputs): SandboxImagePlan {
  const dockerfile = join(inputs.sandboxContext, "image", "Dockerfile");
  if (!existsSync(dockerfile)) throw new AzurePublishError(`The sandbox image definition was not found at ${dockerfile}.`);
  if (!existsSync(join(inputs.sandboxContext, "dist", "sandboxd", "main.js"))) {
    throw new AzurePublishError("The sandbox agent is not built yet. Run `pnpm build` at the repository root, then deploy again.");
  }
  if (!existsSync(join(inputs.azureLayerContext, "Dockerfile"))) throw new AzurePublishError(`The Azure sandbox layer was not found at ${inputs.azureLayerContext}.`);
  const baseHash = short(
    hashTree(inputs.sandboxContext, (rel) => rel.startsWith("image/") || (rel.startsWith("dist/") && rel.endsWith(".js"))).update(
      `npm=${inputs.npmRegistry}\0pip=${inputs.pipIndexUrl ?? ""}\0sdk=${inputs.sdkVersion}`,
    ),
  );
  const layerHash = short(hashTree(inputs.azureLayerContext, () => true));
  const builds: SandboxImageBuild[] = [];
  for (const [environment, folder] of Object.entries(inputs.environments).sort(([a], [b]) => a.localeCompare(b))) {
    let imageDirectory: string | undefined;
    let environmentHash = "";
    if (environment !== "*") {
      imageDirectory = join(inputs.appHostDirectory, ...folder.split("/"));
      if (!existsSync(join(imageDirectory, "Dockerfile")) || !statSync(imageDirectory).isDirectory()) {
        throw new AzurePublishError(`Environment "${environment}" names image "${folder}", but ${join(imageDirectory, "Dockerfile")} does not exist.`);
      }
      environmentHash = short(hashTree(imageDirectory, () => true));
    }
    const tag = createHash("sha256").update(`${baseHash}\0${environmentHash}\0${layerHash}`).digest("hex").slice(0, 16);
    builds.push({ environment, repository: repositoryName(inputs.name, environment), tag, ...(imageDirectory ? { imageDirectory } : {}) });
  }
  return { inputs, baseHash, builds };
}

/** The gateway's `MANAGED_COPILOT_AZURE_SANDBOX_IMAGES`: environment → image, relative to `MANAGED_COPILOT_AZURE_REGISTRY`. */
export function imageMap(plan: SandboxImagePlan): string {
  return JSON.stringify(Object.fromEntries(plan.builds.map((build) => [build.environment, `${build.repository}:${build.tag}`])));
}

export interface RunResult {
  readonly code: number;
  readonly output: string;
}

/** Runs a command; `onLine` sees its output as it arrives. */
export type CommandRunner = (command: string, args: readonly string[], onLine?: (line: string) => void) => Promise<RunResult>;

export const runCommand: CommandRunner = (command, args, onLine) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { windowsHide: true, shell: process.platform === "win32" && command === "az", env: { ...process.env, DOCKER_BUILDKIT: "1" } });
    const lines: string[] = [];
    let pending = "";
    const take = (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? "";
      for (const line of parts) {
        lines.push(line);
        if (lines.length > 400) lines.shift();
        onLine?.(line);
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (pending) lines.push(pending);
      resolve({ code: code ?? 1, output: lines.join("\n") });
    });
  });

export interface PushContext {
  /** The registry's resource name (for `az acr login`). */
  readonly registryName: string;
  /** The registry's login server, for example `myregistry.azurecr.io`. */
  readonly loginServer: string;
  readonly report: (message: string) => Promise<void> | void;
  readonly debug?: (line: string) => void;
  readonly run?: CommandRunner;
}

function failure(what: string, result: RunResult): AzurePublishError {
  const tail = result.output.split("\n").filter(Boolean).slice(-15).join("\n");
  return new AzurePublishError(`${what} failed (exit ${result.code}).${tail ? `\n${tail}` : ""}`);
}

/** Builds and pushes every image the registry does not have yet. */
export async function pushSandboxImages(plan: SandboxImagePlan, context: PushContext): Promise<{ pushed: string[]; present: string[] }> {
  const run = context.run ?? runCommand;
  const { inputs } = plan;
  const login = await run("az", ["acr", "login", "--name", context.registryName]).catch((error: Error) => ({ code: 1, output: error.message }));
  if (login.code !== 0) throw failure(`Signing Docker in to the ${context.registryName} registry (\`az acr login\`; the Azure CLI must be installed and signed in)`, login);

  const missing: SandboxImageBuild[] = [];
  const present: string[] = [];
  for (const build of plan.builds) {
    const ref = `${context.loginServer}/${build.repository}:${build.tag}`;
    const inspect = await run("docker", ["buildx", "imagetools", "inspect", ref]);
    if (inspect.code === 0) present.push(ref);
    else missing.push(build);
  }
  if (missing.length === 0) return { pushed: [], present };

  const baseTag = `managed-copilot-azure-sandbox-base:${plan.baseHash}`;
  await context.report(`Building the sandbox base image for ${PLATFORM} (the first build installs the toolchain and the Copilot runtime and can take several minutes)`);
  const base = await run(
    "docker",
    [
      "build", "--progress=plain", "--platform", PLATFORM,
      "-f", join(inputs.sandboxContext, "image", "Dockerfile"),
      "--build-arg", `NPM_REGISTRY=${inputs.npmRegistry}`,
      "--build-arg", `PIP_INDEX_URL=${inputs.pipIndexUrl ?? ""}`,
      "--build-arg", `COPILOT_SDK_VERSION=${inputs.sdkVersion}`,
      "--label", `managed-copilot.content-hash=${plan.baseHash}`,
      "-t", baseTag, inputs.sandboxContext,
    ],
    context.debug,
  );
  if (base.code !== 0) throw failure("Building the sandbox base image", base);

  const pushed: string[] = [];
  for (const build of missing) {
    let from = baseTag;
    if (build.imageDirectory) {
      await context.report(`Building the "${build.environment}" environment image`);
      const environmentTag = `managed-copilot-azure-env-${build.repository}:${build.tag}`;
      const environment = await run(
        "docker",
        ["build", "--progress=plain", "--platform", PLATFORM, "--build-context", `${CANONICAL_BASE_IMAGE}=docker-image://${baseTag}`, "-t", environmentTag, build.imageDirectory],
        context.debug,
      );
      if (environment.code !== 0) throw failure(`Building the "${build.environment}" environment image`, environment);
      const labels = await run("docker", ["image", "inspect", "--format", `{{index .Config.Labels "${BASE_LABEL}"}}`, environmentTag]);
      if (labels.code !== 0 || !labels.output.trim() || labels.output.trim() === "<no value>") {
        throw new AzurePublishError(`Environment "${build.environment}" image must be built FROM ${CANONICAL_BASE_IMAGE}, so it keeps the platform's non-root execution, transport, and certificate-trust contract.`);
      }
      from = environmentTag;
    }
    const ref = `${context.loginServer}/${build.repository}:${build.tag}`;
    await context.report(`Building and pushing ${build.repository}:${build.tag}`);
    const layer = await run(
      "docker",
      ["build", "--progress=plain", "--platform", PLATFORM, "-f", join(inputs.azureLayerContext, "Dockerfile"), "--build-arg", `BASE_IMAGE=${from}`, "-t", ref, inputs.azureLayerContext],
      context.debug,
    );
    if (layer.code !== 0) throw failure(`Building the Azure layer for ${build.repository}`, layer);
    const push = await run("docker", ["push", ref], context.debug);
    if (push.code !== 0) throw failure(`Pushing ${ref}`, push);
    pushed.push(ref);
  }
  return { pushed, present };
}
