// Sandbox image preparation (spec section 1): the base image built from services/sandbox, environment images built
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
import type { Logger } from "../../../../log.js";
import type { DockerClient } from "./docker.js";

const execAsync = promisify(exec);

/** The tag customer Dockerfiles use in `FROM` (spec section 1); kept pointing at the base image this gateway built. */
export const CANONICAL_BASE_IMAGE = "ghcr.io/patniko/managed-copilot-sandbox:0.1.0";
/** Label present on every image derived from the base (inherited by `FROM`). */
export const BASE_LABEL = "managed-copilot.copilot-sdk";
const COPILOT_SDK_VERSION = "1.0.31";
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
  /** Override for the base image build context (defaults to services/sandbox next to the gateway). */
  readonly contextDir?: string;
  /** Reads host tool configuration (`npm config get registry`, `pip config list`); replaceable in tests. */
  readonly hostConfig?: (command: string) => Promise<string | undefined>;
}

function defaultContextDir(): string {
  // dist/modules/sandbox (or src/modules/sandbox under tsx) → services/sandbox
  return fileURLToPath(new URL("../../../../../../sandbox/", import.meta.url));
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

/**
 * Validates a registry or package-index URL before it is baked into sandbox images. The URL becomes a Docker build
 * argument (on the build's command line and in the image history) and is written to every sandbox's npm or pip
 * configuration, which workloads can read, so it must never carry credentials: user info (`user:password@`,
 * `token@`), extra slashes before the host (which hide user info from the image's guard), query strings, and
 * fragments are refused, and so are spaces, backslashes, and control characters (a line break, or an escape a shell's
 * `echo` expands, would add a configuration line of its own, such as an `_authToken`).
 * Authenticated registries need their own mechanism (build secrets for image preparation, vaults for session-time
 * installs), which is not available yet. Returns the trimmed URL. Messages show only the scheme and host, never the
 * credential or the path (which some registries use for tokens). Mirrors the image's guard
 * (services/sandbox/image/check-registry-url.sh), so a URL accepted here also passes there.
 */
export function checkRegistryUrl(value: string, source: { readonly setting: string; readonly fix: string }): string {
  const candidate = value.trim();
  const refuse = (problem: string): never => {
    throw new ManagedCopilotError("capability_unavailable", `${source.setting} ${problem} ${source.fix}`);
  };
  if (/[\s\p{Cc}\\]/u.test(candidate)) refuse("must be a single URL without spaces, line breaks, backslashes, or control characters.");
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return refuse("is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") refuse(`must be an http(s) URL, not ${url.protocol}.`);
  // Also judged as written: URL parsing drops an empty `@`, but the image's guard (and npm or pip) see the raw value.
  const written = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)/i.exec(candidate)?.[1] ?? "";
  if (url.username || url.password || written.includes("@")) {
    refuse(
      `contains credentials (${url.protocol}//<credentials>@${url.host}). Sandbox images never receive registry credentials: they would reach every sandbox's package configuration and the image history. Authenticated registries are not supported yet.`,
    );
  }
  if (!/^https?:\/\//i.test(candidate)) refuse("must start with http:// or https://.");
  // URL parsing skips extra slashes before the host; the image's guard (which judges the authority as written) does not.
  if (!written) refuse(`must name the registry host right after the scheme (${url.protocol}//${url.host}/...), without extra slashes.`);
  if (url.search || url.hash || /[?#]/.test(candidate)) {
    refuse(`has a query string or fragment (${url.protocol}//${url.host}), which can carry credentials; use the registry's plain URL.`);
  }
  return candidate;
}

export interface ImageRegistries {
  readonly npm: string;
  readonly pip: string | undefined;
}

const NPM_FIX = "Set MANAGED_COPILOT_NPM_REGISTRY to a registry URL without credentials (for example a proxy that the sandboxes' network policy allows).";
const PIP_FIX = "Set MANAGED_COPILOT_PIP_INDEX_URL to an index URL without credentials, or to an empty value to use pip's default index.";

/**
 * Explicitly configured registry settings that would be refused at the first image build, so the gateway can warn at
 * startup. Returns the problem messages (never the credentials).
 */
export function registrySettingProblems(env: Readonly<Record<string, string | undefined>>): string[] {
  const problems: string[] = [];
  const settings: [string | undefined, { setting: string; fix: string }][] = [
    [env.MANAGED_COPILOT_NPM_REGISTRY, { setting: "MANAGED_COPILOT_NPM_REGISTRY", fix: NPM_FIX }],
    [env.MANAGED_COPILOT_PIP_INDEX_URL || undefined, { setting: "MANAGED_COPILOT_PIP_INDEX_URL", fix: PIP_FIX }],
  ];
  for (const [value, source] of settings) {
    if (value === undefined) continue;
    try {
      checkRegistryUrl(value, source);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  return problems;
}

export class SandboxImages {
  readonly #options: ImageOptions;
  readonly #inflight = new Map<string, Promise<ImageRef>>();
  #registry: Promise<ImageRegistries> | undefined;
  #base: ImageRef | undefined;

  constructor(options: ImageOptions) {
    this.#options = options;
  }

  /** The base image once this process resolved it (operator console). */
  get base(): ImageRef | undefined {
    return this.#base;
  }

  /**
   * The npm registry (and optional pip index) baked into images as session-time defaults. Credential-bearing URLs are
   * refused (see `checkRegistryUrl`), whether configured explicitly or found in the host's npm or pip configuration.
   */
  registries(): Promise<ImageRegistries> {
    if (this.#registry) return this.#registry;
    const resolving = (async () => {
      const env = this.#options.env;
      const read = this.#options.hostConfig ?? hostConfig;
      const explicitNpm = env.MANAGED_COPILOT_NPM_REGISTRY;
      const configuredNpm = explicitNpm ?? (await read("npm config get registry"));
      if (!configuredNpm) {
        throw new ManagedCopilotError("capability_unavailable", "Set MANAGED_COPILOT_NPM_REGISTRY (or configure `npm config get registry`) so the sandbox image can install the Copilot runtime.");
      }
      const npm = checkRegistryUrl(configuredNpm, { setting: explicitNpm !== undefined ? "MANAGED_COPILOT_NPM_REGISTRY" : "The host's npm registry (`npm config get registry`)", fix: NPM_FIX });
      let pip = env.MANAGED_COPILOT_PIP_INDEX_URL;
      const explicitPip = pip !== undefined;
      if (pip === undefined) {
        const listed = await read("python -m pip config list");
        pip = listed?.split(/\r?\n/).map((line) => /^global\.index-url='(.*)'$/.exec(line.trim())?.[1]).find(Boolean);
      }
      if (pip) pip = checkRegistryUrl(pip, { setting: explicitPip ? "MANAGED_COPILOT_PIP_INDEX_URL" : "The host's pip index (`pip config` global.index-url)", fix: PIP_FIX });
      return { npm, pip: pip || undefined };
    })();
    this.#registry = resolving;
    // A refused configuration is read again on the next attempt, after the operator fixed it.
    resolving.catch(() => {
      if (this.#registry === resolving) this.#registry = undefined;
    });
    return resolving;
  }

  /** Ensures the base sandbox image exists (building it from services/sandbox when needed). */
  ensureBase(): Promise<ImageRef> {
    return this.#once("base", async () => {
      const { docker, log, env } = this.#options;
      const prebuilt = env.MANAGED_COPILOT_SANDBOX_IMAGE;
      if (prebuilt) {
        const image = await docker.inspectImage(prebuilt);
        if (!image) throw new ManagedCopilotError("capability_unavailable", `MANAGED_COPILOT_SANDBOX_IMAGE "${prebuilt}" is not available locally; build or pull it first.`);
        if (!image.Config?.Labels?.[BASE_LABEL]) throw new ManagedCopilotError("capability_unavailable", `"${prebuilt}" is not a Managed Copilot sandbox base image.`);
        await this.#tagCanonical(image.Id);
        this.#base = { tag: prebuilt, id: image.Id };
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
      this.#base = { tag, id: image.Id };
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
              // By tag: BuildKit resolves a bare image ID as a registry reference (docker.io/library/sha256:...) and
              // fails. The tag is content-addressed, and this layer's own tag hashes the exact image ID above.
              `FROM ${current.tag}`,
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
