/**
 * AppHost fragment for Dispatch (spec section 17): an orchestrator environment, and the worker environments its
 * coordinator creates sandboxes from. Plain data: no Aspire imports.
 *
 * | Environment       | Type         | Size   | Network                                   | What it's for                          |
 * | ----------------- | ------------ | ------ | ----------------------------------------- | -------------------------------------- |
 * | `dispatch`        | orchestrator | n/a    | the deployment default                    | the coordinator you talk to            |
 * | `dispatch-python` | isolated     | medium | off                                       | calculations, data, simulations, charts |
 * | `dispatch-node`   | isolated     | small  | the npm registry only                     | building and testing JavaScript        |
 * | `dispatch-web`    | isolated     | small  | a short allowlist of documentation sites  | research with sources                  |
 * | `dispatch-writer` | isolated     | small  | off                                       | reports and charts from other workers' files |
 *
 * The coordinator's instructions list the worker environments with their descriptions, so the descriptions below are
 * how it decides which kind of sandbox a part of a request needs.
 *
 * Wire it into the root AppHost:
 *
 * ```ts
 * import { dispatch } from "./demos/dispatch/apphost.mts";
 *
 * const demo = dispatch();
 * await addManagedCopilot(builder, "copilot", { environments: { ...demo.environments, ...otherEnvironments } });
 * // Run `node <demo.app.script>` in demo.app.workingDirectory (after `pnpm build`) with PORT and MANAGED_COPILOT_URL.
 * ```
 *
 * Only erasable TypeScript syntax is used so this file loads under Node's type stripping as well as tsx.
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { EnvironmentConfig } from "@managed-copilot/protocol";

/** The orchestrator environment conversations run in. */
export const DISPATCH_ENVIRONMENT = "dispatch";

/** The worker environments ("blueprints") the coordinator creates sandboxes from, in the order it is told about them. */
export const DISPATCH_BLUEPRINTS = {
  python: "dispatch-python",
  node: "dispatch-node",
  web: "dispatch-web",
  writer: "dispatch-writer",
} as const;

export const DISPATCH_DEFAULT_PORT = 7470;

/** Sites the web research sandboxes may read: documentation and release notes with stable, citable pages. */
export const DISPATCH_WEB_HOSTS = [
  "en.wikipedia.org",
  "api.github.com",
  "raw.githubusercontent.com",
  "nodejs.org",
  "docs.python.org",
  "www.python.org",
  "learn.microsoft.com",
];

export interface DispatchOptions {
  /**
   * npm registry the Node sandboxes install packages from. Defaults to `DISPATCH_NPM_REGISTRY`, then the host's
   * `npm config get registry`. Only its host is used: it is the Node sandboxes' only network destination.
   */
  npmRegistry?: string;
  /** Port for the UI and API. Defaults to 7470. */
  port?: number;
}

export interface DispatchApp {
  /** Aspire resource name. */
  readonly name: "dispatch";
  /** Absolute path of the demo package. */
  readonly workingDirectory: string;
  /** Node entry point relative to `workingDirectory`, built by `pnpm build`. */
  readonly script: string;
  /** HTTP port for the UI and API; the server reads `PORT`, and the gateway URL from `MANAGED_COPILOT_URL`. */
  readonly port: number;
  readonly healthPath: string;
}

export interface DispatchFragment {
  readonly environments: Readonly<Record<string, EnvironmentConfig>>;
  readonly app: DispatchApp;
}

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url)).replace(/[\\/]+$/, "");

function detectNpmRegistry(): string | undefined {
  const fromEnv = process.env.DISPATCH_NPM_REGISTRY ?? process.env.npm_config_registry;
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

/** Returns Dispatch's environment declarations and its app resource. */
export function dispatch(options: DispatchOptions = {}): DispatchFragment {
  const npmHost = registryHost(options.npmRegistry ?? detectNpmRegistry()) ?? "registry.npmjs.org";
  // Keeps tool output plain for the UI; proxy, CA, and registry settings are platform-reserved.
  const sandboxEnv = { CI: "1", NO_COLOR: "1" };

  const environments: Record<string, EnvironmentConfig> = {
    [DISPATCH_ENVIRONMENT]: {
      type: "orchestrator",
      description: "Dispatch: a coordinator that plans each request and creates the sandboxes it needs, or sends work to the ones it has",
      workers: [DISPATCH_BLUEPRINTS.python, DISPATCH_BLUEPRINTS.node, DISPATCH_BLUEPRINTS.web, DISPATCH_BLUEPRINTS.writer],
      maxWorkers: 6,
    },
    [DISPATCH_BLUEPRINTS.python]: {
      type: "isolated",
      size: "medium",
      network: false,
      env: sandboxEnv,
      description:
        "Python lab: Python 3 and its standard library for calculations, simulations, benchmarks, data generation and analysis, and SVG charts. No network, so no package installs.",
    },
    [DISPATCH_BLUEPRINTS.node]: {
      type: "isolated",
      size: "small",
      network: [npmHost],
      env: sandboxEnv,
      description: "Node.js workshop: Node 24 and npm for building, running, benchmarking, and testing JavaScript and TypeScript. Can install npm packages; no other network.",
    },
    [DISPATCH_BLUEPRINTS.web]: {
      type: "isolated",
      size: "small",
      network: DISPATCH_WEB_HOSTS,
      env: sandboxEnv,
      description: `Web research: reads pages and public APIs from ${DISPATCH_WEB_HOSTS.join(", ")} with curl or Python, and reports what it found with links to its sources. No other sites.`,
    },
    [DISPATCH_BLUEPRINTS.writer]: {
      type: "isolated",
      size: "small",
      network: false,
      env: sandboxEnv,
      description:
        "Writer's desk: turns findings, data, and files that other workers produced (copied into it) into a polished Markdown report with tables and SVG charts, published in outputs/. No network.",
    },
  };

  return {
    environments,
    app: {
      name: "dispatch",
      workingDirectory: here("."),
      script: "dist/server/main.js",
      port: options.port ?? DISPATCH_DEFAULT_PORT,
      healthPath: "/api/health",
    },
  };
}
