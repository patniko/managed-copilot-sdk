/**
 * Sandbox images for Azure Container Apps Sandboxes. `aspire deploy` builds them on the deploying machine for
 * linux/amd64 (the base image from platform/sandbox, each isolated environment's own `image` folder FROM it, a layer
 * with its `packages.system` as `aspire run` builds it, and the Azure layer from deploy/azure/sandbox on top) and pushes
 * them to the Container Apps environment's registry.
 *
 * Tags are content hashes computed at publish time, so the gateway's image map is known before anything is built, and
 * redeploys skip images the registry already has. The base image is never tagged with its canonical name locally (that
 * tag belongs to `aspire run`'s native-architecture image); environment images reach it through a named build context.
 */
import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { AzurePublishError, type SandboxImageSource } from "./config.js";

/** The image every environment image must be built FROM (the platform's contract). */
export const CANONICAL_BASE_IMAGE = "ghcr.io/patniko/managed-copilot-sandbox:0.1.0";
/** Set by the base image (and inherited by images built FROM it). */
const BASE_LABEL = "managed-copilot.copilot-sdk";
const PLATFORM = "linux/amd64";
/** Debian package names (optionally `=version`), as the local Docker provider accepts them. */
const SYSTEM_PACKAGE = /^[a-z0-9][a-z0-9+.-]*(=[A-Za-z0-9.+:~-]+)?$/;

export interface SandboxImageInputs {
  /** The platform's resource name; prefixes the registry repositories. */
  readonly name: string;
  /** platform/sandbox, built (`dist/sandboxd/main.js` exists). */
  readonly sandboxContext: string;
  /** deploy/azure/sandbox. */
  readonly azureLayerContext: string;
  readonly appHostDirectory: string;
  /** Environment → what its image is built from; `*` is the base image (see prepareAzureConfig). */
  readonly environments: Readonly<Record<string, SandboxImageSource>>;
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
  /** The environment's own image folder (absolute), if it has one. */
  readonly imageDirectory?: string;
  /** System packages installed in a layer of their own (sorted). */
  readonly system?: readonly string[];
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
  for (const [environment, source] of Object.entries(inputs.environments).sort(([a], [b]) => a.localeCompare(b))) {
    let imageDirectory: string | undefined;
    let environmentHash = "";
    if (environment !== "*" && source.folder) {
      imageDirectory = join(inputs.appHostDirectory, ...source.folder.split("/"));
      if (!existsSync(join(imageDirectory, "Dockerfile")) || !statSync(imageDirectory).isDirectory()) {
        throw new AzurePublishError(`Environment "${environment}" names image "${source.folder}", but ${join(imageDirectory, "Dockerfile")} does not exist.`);
      }
      environmentHash = short(hashTree(imageDirectory, () => true));
    }
    const system = environment === "*" ? [] : [...new Set(source.system ?? [])].sort();
    for (const pkg of system) {
      if (!SYSTEM_PACKAGE.test(pkg)) throw new AzurePublishError(`Environment "${environment}" declares an invalid system package "${pkg}".`);
    }
    const tag = createHash("sha256").update(`${baseHash}\0${environmentHash}\0system=${system.join(",")}\0${layerHash}`).digest("hex").slice(0, 16);
    builds.push({
      environment,
      repository: repositoryName(inputs.name, environment),
      tag,
      ...(imageDirectory ? { imageDirectory } : {}),
      ...(system.length > 0 ? { system } : {}),
    });
  }
  return { inputs, baseHash, builds };
}

/** The egress proxy image (platform/egress), built from its bundled dist/egress.mjs. */
export interface EgressImagePlan {
  readonly context: string;
  readonly repository: string;
  readonly tag: string;
}

export function planEgressImage(name: string, context: string): EgressImagePlan {
  if (!existsSync(join(context, "Dockerfile"))) throw new AzurePublishError(`The egress proxy definition was not found at ${join(context, "Dockerfile")}.`);
  if (!existsSync(join(context, "dist", "egress.mjs"))) throw new AzurePublishError("The egress proxy is not built yet. Run `pnpm build` at the repository root, then deploy again.");
  const tag = short(hashTree(context, (rel) => rel === "Dockerfile" || rel === ".dockerignore" || rel === "dist/egress.mjs"));
  return { context, repository: `${name}-egress`, tag };
}

/** Builds and pushes the egress proxy image unless the registry has it (after pushSandboxImages signed Docker in). */
export async function pushEgressImage(plan: EgressImagePlan, context: PushContext): Promise<"pushed" | "present"> {
  const run = context.run ?? runCommand;
  const ref = `${context.loginServer}/${plan.repository}:${plan.tag}`;
  if ((await run("docker", ["buildx", "imagetools", "inspect", ref])).code === 0) return "present";
  await context.report(`Building and pushing ${plan.repository}:${plan.tag}`);
  const build = await run("docker", ["build", "--progress=plain", "--platform", PLATFORM, "-t", ref, plan.context], context.debug);
  if (build.code !== 0) throw failure("Building the egress proxy image", build);
  const push = await run("docker", ["push", ref], context.debug);
  if (push.code !== 0) throw failure(`Pushing ${ref}`, push);
  return "pushed";
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
    // The Azure CLI is a .cmd on Windows and runs only through a shell; its arguments here are fixed words and Azure
    // resource names, checked so nothing is interpreted by the shell.
    const viaShell = process.platform === "win32" && command === "az";
    if (viaShell && args.some((arg) => !/^[A-Za-z0-9._:/=-]+$/.test(arg))) {
      reject(new AzurePublishError(`Refusing to run the Azure CLI with an unexpected argument: ${args.join(" ")}`));
      return;
    }
    const child = viaShell
      ? spawn([command, ...args].join(" "), { windowsHide: true, shell: true, env: { ...process.env, DOCKER_BUILDKIT: "1" } })
      : spawn(command, [...args], { windowsHide: true, env: { ...process.env, DOCKER_BUILDKIT: "1" } });
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
    if (build.system) {
      await context.report(`Installing the "${build.environment}" environment's system packages`);
      const systemTag = `managed-copilot-azure-system-${build.repository}:${build.tag}`;
      const directory = mkdtempSync(join(tmpdir(), "mc-azure-system-"));
      try {
        // The same layer the local Docker provider builds for packages.system.
        writeFileSync(
          join(directory, "Dockerfile"),
          [
            `FROM ${from}`,
            "USER root",
            `RUN apt-get update && apt-get install -y --no-install-recommends ${build.system.join(" ")} && rm -rf /var/lib/apt/lists/*`,
            "USER 10001:10001",
            "",
          ].join("\n"),
        );
        const layer = await run("docker", ["build", "--progress=plain", "--platform", PLATFORM, "-t", systemTag, directory], context.debug);
        if (layer.code !== 0) throw failure(`Installing the "${build.environment}" environment's system packages (${build.system.join(", ")})`, layer);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      from = systemTag;
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
