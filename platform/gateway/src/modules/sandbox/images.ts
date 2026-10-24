// Sandbox image preparation (spec section 1): the base image built from platform/sandbox, environment images built
// FROM it, and derived layers for operator-declared system packages. Images are cached by content hash and every
// sandbox pins the resolved image ID so a resume never silently changes its runtime or toolchain.
import { spawn, exec } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ManagedCopilotError } from "@managed-copilot/protocol";
import type { Logger } from "../../log.js";
import type { DockerClient } from "./docker.js";

const execAsync = promisify(exec);

/** The tag customer Dockerfiles use in `FROM` (spec section 1); kept pointing at the base image this gateway built. */
export const CANONICAL_BASE_IMAGE = "ghcr.io/patniko/managed-copilot-sandbox:0.1.0";
/** Label present on every image derived from the base (inherited by `FROM`). */
export const BASE_LABEL = "managed-copilot.copilot-sdk";
const COPILOT_SDK_VERSION = "1.0.26";
const SYSTEM_PACKAGE = /^[a-z0-9][a-z0-9+.-]*(=[A-Za-z0-9.+:~-]+)?$/;

export interface ImageRef {
  /** Human-readable tag. */
  readonly tag: string;
  /** Pinned image ID (`sha256:…`). */
  readonly id: string;
}

export interface ImageOptions {
  readonly docker: DockerClient;
  readonly log: Logger;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly appHostDir: string;
  /** Override for the base image build context (defaults to platform/sandbox next to the gateway). */
  readonly contextDir?: string;
}

function defaultContextDir(): string {
  // dist/modules/sandbox (or src/modules/sandbox under tsx) → platform/sandbox
  return fileURLToPath(new URL("../../../../sandbox/", import.meta.url));
}

function hashTree(root: string, include: (relativePath: string) => boolean, hash = createHash("sha256")): ReturnType<typeof createHash> {
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

async function hostConfig(command: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(command, { windowsHide: true, timeout: 20_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export class SandboxImages {
  readonly #options: ImageOptions;
  readonly #inflight = new Map<string, Promise<ImageRef>>();
  #registry: Promise<{ npm: string; pip: string | undefined }> | undefined;

  constructor(options: ImageOptions) {
    this.#options = options;
  }

  /** The npm registry (and optional pip index) baked into images as session-time defaults. */
  registries(): Promise<{ npm: string; pip: string | undefined }> {
    this.#registry ??= (async () => {
      const env = this.#options.env;
      const npm = env.MANAGED_COPILOT_NPM_REGISTRY ?? (await hostConfig("npm config get registry"));
      if (!npm || !/^https?:\/\//.test(npm)) {
        throw new ManagedCopilotError("capability_unavailable", "Set MANAGED_COPILOT_NPM_REGISTRY (or configure `npm config get registry`) so the sandbox image can install the Copilot runtime.");
      }
      let pip = env.MANAGED_COPILOT_PIP_INDEX_URL;
      if (pip === undefined) {
        const listed = await hostConfig("python -m pip config list");
        pip = listed?.split(/\r?\n/).map((line) => /^global\.index-url='(.*)'$/.exec(line.trim())?.[1]).find(Boolean);
      }
      return { npm, pip: pip || undefined };
    })();
    return this.#registry;
  }

  /** Ensures the base sandbox image exists (building it from platform/sandbox when needed). */
  ensureBase(): Promise<ImageRef> {
    return this.#once("base", async () => {
      const { docker, log, env } = this.#options;
      const prebuilt = env.MANAGED_COPILOT_SANDBOX_IMAGE;
      if (prebuilt) {
        const image = await docker.inspectImage(prebuilt);
        if (!image) throw new ManagedCopilotError("capability_unavailable", `MANAGED_COPILOT_SANDBOX_IMAGE "${prebuilt}" is not available locally; build or pull it first.`);
        if (!image.Config?.Labels?.[BASE_LABEL]) throw new ManagedCopilotError("capability_unavailable", `"${prebuilt}" is not a Managed Copilot sandbox base image.`);
        await this.#tagCanonical(image.Id);
        return { tag: prebuilt, id: image.Id };
      }
      const context = resolve(this.#options.contextDir ?? defaultContextDir());
      const dockerfile = join(context, "image", "Dockerfile");
      if (!existsSync(dockerfile)) throw new ManagedCopilotError("capability_unavailable", `The sandbox image definition was not found at ${dockerfile}.`);
      if (!existsSync(join(context, "dist", "sandboxd", "main.js"))) {
        throw new ManagedCopilotError("capability_unavailable", "The sandbox agent is not built yet. Run `pnpm build` at the repository root, then retry.");
      }
      const registries = await this.registries();
      const hash = hashTree(context, (rel) => rel.startsWith("image/") || (rel.startsWith("dist/") && rel.endsWith(".js")))
        .update(`npm=${registries.npm}\0pip=${registries.pip ?? ""}\0sdk=${COPILOT_SDK_VERSION}`)
        .digest("hex")
        .slice(0, 16);
      const tag = `managed-copilot-sandbox:${hash}`;
      let image = await docker.inspectImage(tag);
      if (!image) {
        log.info("Building the sandbox base image (the first build downloads the toolchain and Copilot runtime; this can take a few minutes)", { tag });
        await this.#build(["-f", dockerfile, "--build-arg", `NPM_REGISTRY=${registries.npm}`, "--build-arg", `PIP_INDEX_URL=${registries.pip ?? ""}`, "--build-arg", `COPILOT_SDK_VERSION=${COPILOT_SDK_VERSION}`, "--label", `managed-copilot.content-hash=${hash}`, "-t", tag, context], "base image");
        image = await docker.inspectImage(tag);
        if (!image) throw new ManagedCopilotError("internal", "The sandbox base image build finished but the image is missing.");
        log.info("Built the sandbox base image", { tag });
      }
      await this.#tagCanonical(image.Id);
      return { tag, id: image.Id };
    });
  }

  /**
   * Ensures the image for an environment: the base image, the environment's own Dockerfile built FROM it, and a
   * derived layer for operator-declared system packages. Returns the pinned image.
   */
  ensureEnvironment(name: string, config: { readonly image?: string | undefined; readonly packages?: { readonly system?: readonly string[] | undefined } | undefined }): Promise<ImageRef> {
    const system = [...(config.packages?.system ?? [])].sort();
    return this.#once(`env:${name}:${config.image ?? ""}:${system.join(",")}`, async () => {
      const base = await this.ensureBase();
      let current = base;
      if (config.image) {
        const dir = isAbsolute(config.image) ? config.image : resolve(this.#options.appHostDir, config.image);
        if (!existsSync(join(dir, "Dockerfile")) || !statSync(dir).isDirectory()) {
          throw new ManagedCopilotError("capability_unavailable", `Environment "${name}" names image "${config.image}", but ${join(dir, "Dockerfile")} does not exist.`);
        }
        const hash = hashTree(dir, () => true).update(`base=${base.id}`).digest("hex").slice(0, 16);
        current = await this.#buildIfMissing(`managed-copilot-env-${name}:${hash}`, ["--label", `managed-copilot.content-hash=${hash}`, dir], `environment "${name}" image`);
        const inspected = await this.#options.docker.inspectImage(current.id);
        if (!inspected?.Config?.Labels?.[BASE_LABEL]) {
          throw new ManagedCopilotError("policy_violation", `Environment "${name}" image must be built FROM ${CANONICAL_BASE_IMAGE}, so it keeps the platform's non-root execution, transport, and certificate-trust contract.`);
        }
      }
      if (system.length > 0) {
        for (const pkg of system) {
          if (!SYSTEM_PACKAGE.test(pkg)) throw new ManagedCopilotError("policy_violation", `Environment "${name}" declares an invalid system package "${pkg}".`);
        }
        const hash = createHash("sha256").update(`${current.id}\0${system.join("\0")}`).digest("hex").slice(0, 16);
        const tag = `managed-copilot-env-${name}-system:${hash}`;
        const existing = await this.#options.docker.inspectImage(tag);
        if (existing) return { tag, id: existing.Id };
        const dir = mkdtempSync(join(tmpdir(), "mc-sandbox-system-"));
        try {
          writeFileSync(
            join(dir, "Dockerfile"),
            [
              `FROM ${current.id}`,
              "USER root",
              `RUN apt-get update && apt-get install -y --no-install-recommends ${system.join(" ")} && rm -rf /var/lib/apt/lists/*`,
              "USER 10001:10001",
              "",
            ].join("\n"),
          );
          current = await this.#buildIfMissing(tag, ["--label", `managed-copilot.content-hash=${hash}`, dir], `environment "${name}" system packages`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      return current;
    });
  }

  async #buildIfMissing(tag: string, args: readonly string[], label: string): Promise<ImageRef> {
    const existing = await this.#options.docker.inspectImage(tag);
    if (existing) return { tag, id: existing.Id };
    this.#options.log.info(`Building the ${label}`, { tag });
    await this.#build(["-t", tag, ...args], label);
    const image = await this.#options.docker.inspectImage(tag);
    if (!image) throw new ManagedCopilotError("internal", `The ${label} build finished but ${tag} is missing.`);
    return { tag, id: image.Id };
  }

  async #tagCanonical(id: string): Promise<void> {
    const [repository, tag] = [CANONICAL_BASE_IMAGE.slice(0, CANONICAL_BASE_IMAGE.lastIndexOf(":")), CANONICAL_BASE_IMAGE.slice(CANONICAL_BASE_IMAGE.lastIndexOf(":") + 1)];
    const current = await this.#options.docker.inspectImage(CANONICAL_BASE_IMAGE);
    if (current?.Id !== id) await this.#options.docker.tagImage(id, repository, tag);
  }

  #once(key: string, build: () => Promise<ImageRef>): Promise<ImageRef> {
    let pending = this.#inflight.get(key);
    if (!pending) {
      pending = build();
      this.#inflight.set(key, pending);
      // Cache successes for the gateway's lifetime; retry failures on the next request.
      pending.catch(() => this.#inflight.delete(key));
    }
    return pending;
  }

  #build(args: readonly string[], label: string): Promise<void> {
    const { log } = this.#options;
    return new Promise((resolvePromise, reject) => {
      const child = spawn("docker", ["build", "--progress=plain", ...args], { windowsHide: true, env: { ...process.env, DOCKER_BUILDKIT: "1" } });
      const tail: string[] = [];
      const onData = (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          tail.push(line);
          if (tail.length > 40) tail.shift();
          log.debug("docker build", { line: line.slice(0, 300) });
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (error) => reject(new ManagedCopilotError("capability_unavailable", `The Docker CLI is required to build sandbox images: ${error.message}`)));
      child.on("close", (code) => {
        if (code === 0) return resolvePromise();
        reject(new ManagedCopilotError("capability_unavailable", `Building the ${label} failed (docker build exit ${code}).`, { output: tail.slice(-15).join("\n") }));
      });
    });
  }
}
