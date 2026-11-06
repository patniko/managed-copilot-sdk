/**
 * AppHost fragment for the AI software factory demo (spec sections 1, 4-8, 10, 17). Plain data: no Aspire imports.
 *
 * | Environment           | Type         | Customizations | Agent         | Network                          |
 * | --------------------- | ------------ | -------------- | ------------- | -------------------------------- |
 * | `factory-planner`     | shared       | `office`       | `planner`     | off                              |
 * | `factory-builder`     | isolated     | `workshop`     | `builder`     | package registry and GitHub only |
 * | `factory-reviewer`    | shared       | `office`       | `reviewer`    | off                              |
 * | `factory-release`     | isolated     | `workshop`     | `release`     | package registry and GitHub only |
 * | `factory-coordinator` | orchestrator | `coordinator`  | `coordinator` | none of its own (workers have theirs) |
 * | `factory-repo`        | isolated     | `repo`         | `developer`   | GitHub, package registries, extra hosts |
 *
 * `customizations/office`, `customizations/workshop`, and `customizations/coordinator` are ordinary Copilot
 * customization bundles (`agents/`, `skills/`, `instructions/`) deployed with their environments (spec section 10). The
 * workshop's `factory-check` skill ships the test harness the sandboxes run. Agent-led work orders run a coordinator in
 * `factory-coordinator` that starts builder and release workers in `factory-builder` and `factory-release` sandboxes
 * (spec section 17). GitHub work orders change an existing repository in one `factory-repo` sandbox (Chromium, ffmpeg,
 * and Playwright for screenshots and recordings; `customizations/repo`), reviewed by `pr-reviewer` in
 * `factory-reviewer`, and the factory opens the pull request.
 *
 * Wire it into the root AppHost:
 *
 * ```ts
 * import { softwareFactory } from "./demos/software-factory/apphost.mts";
 *
 * const factory = softwareFactory();
 * await addManagedCopilot(builder, "copilot", { environments: { ...factory.environments, ...otherEnvironments } });
 * // Run `node <factory.app.script>` in factory.app.workingDirectory (after `pnpm build`) with PORT and
 * // MANAGED_COPILOT_URL (the gateway URL); wait for the gateway; health check `factory.app.healthPath`.
 * ```
 *
 * Only erasable TypeScript syntax is used so this file loads under Node's type stripping as well as tsx.
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { EnvironmentConfig } from "@managed-copilot/protocol";

export const FACTORY_ENVIRONMENTS = {
  planner: "factory-planner",
  builder: "factory-builder",
  reviewer: "factory-reviewer",
  release: "factory-release",
  coordinator: "factory-coordinator",
  developer: "factory-repo",
} as const;

/**
 * What a `factory-repo` sandbox adds to the base image so the developer can show its work: Chromium and Playwright to
 * screenshot and drive web UIs, ffmpeg to encode recordings, and fonts so pages render like they do on a desktop.
 */
export const FACTORY_REPO_SYSTEM_PACKAGES = ["chromium", "ffmpeg", "fonts-liberation", "fonts-noto-color-emoji"];
export const FACTORY_REPO_NPM_PACKAGES = ["playwright-core@1.64.1"];

/**
 * Workers one agent-led work order's coordinator can have at once: a builder for each of the plan's (at most four)
 * tasks, the release worker, and one replacement.
 */
export const FACTORY_MAX_WORKERS = 6;

export const FACTORY_DEFAULT_PORT = 7480;

export interface SoftwareFactoryOptions {
  /**
   * npm registry the sandboxes install packages from. Defaults to `FACTORY_NPM_REGISTRY`, then the host's
   * `npm config get registry`. Only its host is used: it joins GitHub in the sandboxes' network allowlist.
   */
  npmRegistry?: string;
  /**
   * pip index `factory-repo` sandboxes install Python packages from. Defaults to `FACTORY_PIP_INDEX_URL`, then the
   * platform's `MANAGED_COPILOT_PIP_INDEX_URL`; none means pypi.org.
   */
  pipIndexUrl?: string;
  /** More hosts `factory-repo` sandboxes may reach (a repository's own package sources). Defaults to `FACTORY_REPO_EXTRA_HOSTS`. */
  repoExtraHosts?: readonly string[];
  /** Port for the factory floor (UI and API). Defaults to 7480. */
  port?: number;
}

export interface SoftwareFactoryApp {
  /** Aspire resource name. */
  readonly name: "software-factory";
  /** Absolute path of the demo package. */
  readonly workingDirectory: string;
  /** Node entry point relative to `workingDirectory`, built by `pnpm build`. */
  readonly script: string;
  /** HTTP port for the UI and API; the server reads `PORT`, and the gateway URL from `MANAGED_COPILOT_URL`. */
  readonly port: number;
  readonly healthPath: string;
  /** Extra non-secret environment variables. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface SoftwareFactoryFragment {
  readonly environments: Readonly<Record<string, EnvironmentConfig>>;
  readonly app: SoftwareFactoryApp;
}

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url)).replace(/[\\/]+$/, "");

/** GitHub hosts for cloning public repositories and calling the REST API (`*.` matches subdomains only). */
const GITHUB_HOSTS = ["github.com", "*.github.com", "*.githubusercontent.com"];

/** pip's default index and file hosts, for repositories with Python dependencies when no pip index is configured. */
const PYPI_HOSTS = ["pypi.org", "files.pythonhosted.org"];

function detectNpmRegistry(): string | undefined {
  const fromEnv = process.env.FACTORY_NPM_REGISTRY ?? process.env.npm_config_registry;
  if (fromEnv) return fromEnv;
  try {
    const value = execSync("npm config get registry", { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function registryHost(registry: string | undefined): string | undefined {
  if (!registry) return undefined;
  try {
    return new URL(registry).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** Returns the factory's environment declarations and its app resource. */
export function softwareFactory(options: SoftwareFactoryOptions = {}): SoftwareFactoryFragment {
  const npmHost = registryHost(options.npmRegistry ?? detectNpmRegistry());
  const sandboxNetwork = [...GITHUB_HOSTS, ...(npmHost ? [npmHost] : [])];
  const pipHost = registryHost(options.pipIndexUrl ?? (process.env.FACTORY_PIP_INDEX_URL || process.env.MANAGED_COPILOT_PIP_INDEX_URL || undefined));
  const extraHosts = (options.repoExtraHosts ?? (process.env.FACTORY_REPO_EXTRA_HOSTS ?? "").split(",")).map((host) => host.trim().toLowerCase()).filter(Boolean);
  const repoNetwork = [...new Set([...sandboxNetwork, ...(pipHost ? [pipHost] : PYPI_HOSTS), ...extraHosts])];
  // Proxy, CA, and registry settings are platform-reserved; these only keep tool output plain for the UI.
  const sandboxEnv = { CI: "1", NO_COLOR: "1" };
  const office = here("./customizations/office");
  const workshop = here("./customizations/workshop");
  const coordinator = here("./customizations/coordinator");
  const repo = here("./customizations/repo");

  const environments: Record<string, EnvironmentConfig> = {
    [FACTORY_ENVIRONMENTS.planner]: {
      type: "shared",
      description: "Software factory: turns a work order into a plan of parallel build tasks",
      customizations: office,
      network: false,
    },
    [FACTORY_ENVIRONMENTS.builder]: {
      type: "isolated",
      description: "Software factory: builds and tests one task in a fresh sandbox",
      customizations: workshop,
      size: "small",
      network: sandboxNetwork,
      env: sandboxEnv,
    },
    [FACTORY_ENVIRONMENTS.reviewer]: {
      type: "shared",
      description: "Software factory: reviews each build with a second model",
      customizations: office,
      network: false,
    },
    [FACTORY_ENVIRONMENTS.release]: {
      type: "isolated",
      description: "Software factory: integrates, verifies, and packages the release in a fresh sandbox",
      customizations: workshop,
      size: "small",
      network: sandboxNetwork,
      env: sandboxEnv,
    },
    [FACTORY_ENVIRONMENTS.coordinator]: {
      type: "orchestrator",
      description: "Software factory: a coordinator agent that creates builder and release sandboxes as the plan needs them",
      customizations: coordinator,
      network: false,
      // The first is the default; builders and the release each get their own sandbox from these.
      workers: [FACTORY_ENVIRONMENTS.builder, FACTORY_ENVIRONMENTS.release],
      maxWorkers: FACTORY_MAX_WORKERS,
    },
    [FACTORY_ENVIRONMENTS.developer]: {
      type: "isolated",
      description: "Software factory: changes a checked-out GitHub repository, tests it, and captures screenshots and recordings for its pull request",
      customizations: repo,
      size: "medium",
      network: repoNetwork,
      packages: { system: FACTORY_REPO_SYSTEM_PACKAGES, npm: FACTORY_REPO_NPM_PACKAGES },
      env: {
        ...sandboxEnv,
        // The system Chromium, for Playwright and the pr-media skill (Playwright's own browser downloads are blocked).
        CHROMIUM_PATH: "/usr/bin/chromium",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        NPM_CONFIG_AUDIT: "false",
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    },
  };

  return {
    environments,
    app: {
      name: "software-factory",
      workingDirectory: here("."),
      script: "dist/server/main.js",
      port: options.port ?? FACTORY_DEFAULT_PORT,
      healthPath: "/api/health",
    },
  };
}
