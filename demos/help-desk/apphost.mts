/**
 * AppHost fragment for Help Desk: the shared environment every customer's support session runs in. Plain data: no
 * Aspire imports.
 *
 * | Environment | Type   | Network | What it's for                                                                 |
 * | ----------- | ------ | ------- | ----------------------------------------------------------------------------- |
 * | `help-desk` | shared | off     | one support session per customer, all on the shared runtime; the agent's only hands are the store's tools in Help Desk |
 *
 * Wire it into the root AppHost:
 *
 * ```ts
 * import { helpDesk } from "./demos/help-desk/apphost.mts";
 *
 * const demo = helpDesk();
 * await addManagedCopilot(builder, "copilot", { environments: { ...demo.environments, ...otherEnvironments } });
 * // Run `node <demo.app.script>` in demo.app.workingDirectory (after `pnpm build`) with PORT and MANAGED_COPILOT_URL.
 * ```
 *
 * Only erasable TypeScript syntax is used so this file loads under Node's type stripping as well as tsx.
 */
import { fileURLToPath } from "node:url";
import type { EnvironmentConfig } from "@managed-copilot/protocol";

/** The shared environment each customer's session is created in. */
export const HELP_DESK_ENVIRONMENT = "help-desk";

export const HELP_DESK_PORT = 7440;

export interface HelpDeskOptions {
  /** Port for the UI and API. Defaults to 7440. */
  port?: number;
}

export interface HelpDeskApp {
  /** Aspire resource name. */
  readonly name: "help-desk";
  /** Absolute path of the demo package. */
  readonly workingDirectory: string;
  /** Node entry point relative to `workingDirectory`, built by `pnpm build`. */
  readonly script: string;
  /** HTTP port for the UI and API; the server reads `PORT`, and the gateway URL from `MANAGED_COPILOT_URL`. */
  readonly port: number;
  readonly healthPath: string;
}

export interface HelpDeskFragment {
  readonly environments: Readonly<Record<string, EnvironmentConfig>>;
  readonly app: HelpDeskApp;
}

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url)).replace(/[\\/]+$/, "");

/** Returns Help Desk's environment declaration and its app resource. */
export function helpDesk(options: HelpDeskOptions = {}): HelpDeskFragment {
  return {
    environments: {
      [HELP_DESK_ENVIRONMENT]: {
        type: "shared",
        description: "Help Desk: one support session per customer on the shared runtime, with the store's tools bound to that customer",
        // The agent reads and changes orders only through the app's tools; it needs no Internet access.
        network: false,
      },
    },
    app: {
      name: "help-desk",
      workingDirectory: here("."),
      script: "dist/server/main.js",
      port: options.port ?? HELP_DESK_PORT,
      healthPath: "/api/health",
    },
  };
}
