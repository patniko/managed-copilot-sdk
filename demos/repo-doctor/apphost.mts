/**
 * AppHost fragment for Repo Doctor: one isolated environment, whose sandboxes reach GitHub and the package registries
 * and nothing else. Plain data: no Aspire imports.
 *
 * | Environment   | Type     | Size   | Network                                                                    | What it's for                       |
 * | ------------- | -------- | ------ | -------------------------------------------------------------------------- | ----------------------------------- |
 * | `repo-doctor` | isolated | medium | GitHub, the npm registry and pip index the sandboxes use, and extra hosts  | clone, install, test, fix, and diff |
 *
 * Each run is one session of `repo-doctor`: the agent's brain and its hands share one new sandbox, which Repo Doctor
 * deletes when the run ends. Every other host is blocked, and the platform reports each block as a `network.blocked`
 * event that the app shows live.
 *
 * Wire it into the root AppHost:
 *
 * ```ts
 * import { repoDoctor } from "./demos/repo-doctor/apphost.mts";
 *
 * const demo = repoDoctor();
 * await addManagedCopilot(builder, "copilot", { environments: { ...demo.environments, ...otherEnvironments } });
 * // Run `node <demo.app.script>` in demo.app.workingDirectory (after `pnpm build`) with PORT and MANAGED_COPILOT_URL.
 * ```
 *
 * Only erasable TypeScript syntax is used so this file loads under Node's type stripping as well as tsx.
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { EnvironmentConfig } from "@managed-copilot/protocol";

/** The isolated environment every run's session (and so its sandbox) is created in. */
export const REPO_DOCTOR_ENVIRONMENT = "repo-doctor";

export const REPO_DOCTOR_PORT = 7435;

/** What cloning a public repository, and GitHub's archive and release downloads, reach. */
export const REPO_DOCTOR_GITHUB_HOSTS = ["github.com", "codeload.github.com", "objects.githubusercontent.com"];

/** pip's default index and file hosts, used when the platform bakes no pip index into its sandboxes. */
export const PYPI_HOSTS = ["pypi.org", "files.pythonhosted.org"];

export interface RepoDoctorOptions {
  /**
   * npm registry the sandboxes install packages from. Defaults to `REPO_DOCTOR_NPM_REGISTRY`, then the platform's
   * `MANAGED_COPILOT_NPM_REGISTRY`, then the host's `npm config get registry`: the registry baked into sandbox images.
   */
  npmRegistry?: string;
  /**
   * pip index the sandboxes install packages from. Defaults to `REPO_DOCTOR_PIP_INDEX_URL`, then the platform's
   * `MANAGED_COPILOT_PIP_INDEX_URL`, then the host's pip configuration; none means pypi.org.
   */
  pipIndexUrl?: string;
  /**
   * More hosts the sandboxes may reach, for registries that serve downloads from other hosts (an Azure Artifacts
   * upstream, for example, hands out `*.pkgs.visualstudio.com` and `*.vsblob.vsassets.io` links). Defaults to the
   * comma-separated `REPO_DOCTOR_EXTRA_HOSTS`.
   */
  extraHosts?: readonly string[];
  /** Port for the UI and API. Defaults to 7435. */
  port?: number;
}

export interface RepoDoctorApp {
  /** Aspire resource name. */
  readonly name: "repo-doctor";
  /** Absolute path of the demo package. */
  readonly workingDirectory: string;
  /** Node entry point relative to `workingDirectory`, built by `pnpm build`. */
  readonly script: string;
  /** HTTP port for the UI and API; the server reads `PORT`, and the gateway URL from `MANAGED_COPILOT_URL`. */
  readonly port: number;
  readonly healthPath: string;
}

export interface RepoDoctorFragment {
  readonly environments: Readonly<Record<string, EnvironmentConfig>>;
  readonly app: RepoDoctorApp;
}

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url)).replace(/[\\/]+$/, "");

function hostConfig(command: string): string | undefined {
  try {
    return execSync(command, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The npm registry baked into sandbox images, as the platform resolves it. */
function detectNpmRegistry(): string | undefined {
  return process.env.REPO_DOCTOR_NPM_REGISTRY || process.env.MANAGED_COPILOT_NPM_REGISTRY || process.env.npm_config_registry || hostConfig("npm config get registry");
}

/** The pip index baked into sandbox images, as the platform resolves it (an empty setting means pip's default). */
function detectPipIndex(): string | undefined {
  const configured = process.env.REPO_DOCTOR_PIP_INDEX_URL ?? process.env.MANAGED_COPILOT_PIP_INDEX_URL;
  if (configured !== undefined) return configured || undefined;
  const listed = hostConfig("python -m pip config list");
  return listed?.split(/\r?\n/).map((line) => /^global\.index-url='(.*)'$/.exec(line.trim())?.[1]).find(Boolean) || undefined;
}

export function registryHost(registry: string | undefined): string | undefined {
  if (!registry) return undefined;
  try {
    return new URL(registry).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** Returns Repo Doctor's environment declaration and its app resource. */
export function repoDoctor(options: RepoDoctorOptions = {}): RepoDoctorFragment {
  const npmHost = registryHost(options.npmRegistry ?? detectNpmRegistry()) ?? "registry.npmjs.org";
  const pipHost = registryHost(options.pipIndexUrl ?? detectPipIndex());
  const extra = options.extraHosts ?? (process.env.REPO_DOCTOR_EXTRA_HOSTS ?? "").split(",");
  const network = [...new Set([...REPO_DOCTOR_GITHUB_HOSTS, npmHost, ...(pipHost ? [pipHost] : PYPI_HOSTS), ...extra.map((host) => host.trim().toLowerCase()).filter(Boolean)])];

  const environments: Record<string, EnvironmentConfig> = {
    [REPO_DOCTOR_ENVIRONMENT]: {
      type: "isolated",
      size: "medium",
      network,
      // Plain output for the logs, no needless calls home from npm and pip, and no bytecode files in the patch.
      env: {
        CI: "1",
        NO_COLOR: "1",
        NPM_CONFIG_AUDIT: "false",
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      },
      description: "Repo Doctor: clones a public GitHub repository, reproduces its failing tests, and fixes them. Reaches GitHub and the package registries only.",
    },
  };

  return {
    environments,
    app: {
      name: "repo-doctor",
      workingDirectory: here("."),
      script: "dist/server/main.js",
      port: options.port ?? REPO_DOCTOR_PORT,
      healthPath: "/api/health",
    },
  };
}
