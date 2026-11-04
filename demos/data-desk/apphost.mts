/**
 * AppHost fragment for Data Desk (spec section 9): a promotable environment, and the isolated Python sandbox its
 * sessions move into. Plain data: no Aspire imports.
 *
 * | Environment        | Type       | Size  | Network | What it's for                                                   |
 * | ------------------ | ---------- | ----- | ------- | --------------------------------------------------------------- |
 * | `data-desk`        | promotable | n/a   | off     | the analyst chat: Data Desk's own tools, on the shared runtime  |
 * | `data-desk-python` | isolated   | small | off     | where a session moves for charts and code: Python 3, no network |
 *
 * A session starts on the shared runtime and answers from the app's data tools (describe, filter, aggregate). When a
 * request needs code (a chart, a regression), the agent calls the platform's `request_sandbox` tool, the person
 * approves, and the same session moves once into a `data-desk-python` sandbox, where Data Desk copies the dataset.
 *
 * Wire it into the root AppHost:
 *
 * ```ts
 * import { dataDesk } from "./demos/data-desk/apphost.mts";
 *
 * const demo = dataDesk();
 * await addManagedCopilot(builder, "copilot", { environments: { ...demo.environments, ...otherEnvironments } });
 * // Run `node <demo.app.script>` in demo.app.workingDirectory (after `pnpm build`) with PORT and MANAGED_COPILOT_URL.
 * ```
 *
 * Only erasable TypeScript syntax is used so this file loads under Node's type stripping as well as tsx.
 */
import { fileURLToPath } from "node:url";
import type { EnvironmentConfig } from "@managed-copilot/protocol";

/** The promotable environment Data Desk's sessions start in. */
export const DATA_DESK_ENVIRONMENT = "data-desk";

/** The isolated environment a session moves into: its image, size, and setup. */
export const DATA_DESK_SANDBOX = "data-desk-python";

export const DATA_DESK_DEFAULT_PORT = 7430;

export interface DataDeskOptions {
  /** Port for the UI and API. Defaults to 7430. */
  port?: number;
}

export interface DataDeskApp {
  /** Aspire resource name. */
  readonly name: "data-desk";
  /** Absolute path of the demo package. */
  readonly workingDirectory: string;
  /** Node entry point relative to `workingDirectory`, built by `pnpm build`. */
  readonly script: string;
  /** HTTP port for the UI and API; the server reads `PORT`, and the gateway URL from `MANAGED_COPILOT_URL`. */
  readonly port: number;
  readonly healthPath: string;
}

export interface DataDeskFragment {
  readonly environments: Readonly<Record<string, EnvironmentConfig>>;
  readonly app: DataDeskApp;
}

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url)).replace(/[\\/]+$/, "");

/** Returns Data Desk's environment declarations and its app resource. */
export function dataDesk(options: DataDeskOptions = {}): DataDeskFragment {
  const environments: Record<string, EnvironmentConfig> = {
    [DATA_DESK_ENVIRONMENT]: {
      type: "promotable",
      promoteTo: DATA_DESK_SANDBOX,
      network: false,
      description: "Data Desk: answers from the app's data tools on the shared runtime, and moves once into a Python sandbox for charts and code",
    },
    [DATA_DESK_SANDBOX]: {
      type: "isolated",
      size: "small",
      network: false,
      description: "Data Desk's Python sandbox: Python 3 and its standard library for analysis and SVG charts. No network.",
    },
  };

  return {
    environments,
    app: {
      name: "data-desk",
      workingDirectory: here("."),
      script: "dist/server/main.js",
      port: options.port ?? DATA_DESK_DEFAULT_PORT,
      healthPath: "/api/health",
    },
  };
}
