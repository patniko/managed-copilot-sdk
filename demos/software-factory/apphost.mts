/**
 * AppHost fragment for the AI software factory demo (spec sections 1, 4-8, 10). Plain data: no Aspire imports.
 *
 * | Environment        | Type     | Customizations | Agent      | Network                          |
 * | ------------------ | -------- | -------------- | ---------- | -------------------------------- |
 * | `factory-planner`  | shared   | `office`       | `planner`  | off                              |
 * | `factory-builder`  | isolated | `workshop`     | `builder`  | package registry and GitHub only |
 * | `factory-reviewer` | shared   | `office`       | `reviewer` | off                              |
 * | `factory-release`  | isolated | `workshop`     | `release`  | package registry and GitHub only |
 *
 * `customizations/office` and `customizations/workshop` are ordinary Copilot customization bundles (`agents/`,
 * `skills/`, `instructions/`) deployed with their environments (spec section 10). The workshop's `factory-check`
 * skill ships the test harness the sandboxes run.
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
} as const;

export const FACTORY_DEFAULT_PORT = 7480;

export interface SoftwareFactoryOptions {
  /**
   * npm registry the sandboxes install packages from. Defaults to `FACTORY_NPM_REGISTRY`, then the host's
   * `npm config get registry`. Only its host is used: it joins GitHub in the sandboxes' network allowlist.
   */
  npmRegistry?: string;
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
  // Proxy, CA, and registry settings are platform-reserved; these only keep tool output plain for the UI.
  const sandboxEnv = { CI: "1", NO_COLOR: "1" };
  const office = here("./customizations/office");
  const workshop = here("./customizations/workshop");

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
