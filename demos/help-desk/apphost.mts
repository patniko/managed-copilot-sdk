/**
 * AppHost fragment for Help Desk: the shared environment every customer's support session runs in. Plain data: no
 * Aspire imports.
 *
 * | Environment | Type   | Network | What it's for                                                                 |
 * | ----------- | ------ | ------- | ----------------------------------------------------------------------------- |
 * | `help-desk` | shared | off     | one support session per customer, all on the shared runtime; the agent's only hands are the store's tools in Help Desk |
 * | `help-desk-triage` | shared | off | optional (`triage`): classifies each customer message with the decision model, through Help Desk's OpenAI-compatible endpoint |
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

/** The optional shared environment that classifies tickets, and the OpenAI-compatible endpoint it's routed to. */
export const HELP_DESK_TRIAGE_ENVIRONMENT = "help-desk-triage";

export const HELP_DESK_PORT = 7440;

export interface HelpDeskOptions {
  /** Port for the UI and API. Defaults to 7440. */
  port?: number;
  /**
   * Classify each customer message with Microsoft-Decision-1 on Microsoft Foundry (README "Ticket classification").
   * Adds the triage environment, routed to Help Desk's own OpenAI-compatible endpoint, which calls the decision API as
   * the signed-in Azure CLI's identity. Local only: a published Help Desk has no Azure identity.
   */
  triage?: {
    /** The Foundry resource's endpoint, as the portal shows it. */
    endpoint: string;
    /** The Microsoft-Decision-1 deployment's name. */
    deployment: string;
    /** The Azure subscription, when it isn't the Azure CLI's default. */
    subscription?: string;
  };
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
  /** Settings for the server (plain values; the triage key is added by the AppHost as a secret parameter). */
  readonly env: Readonly<Record<string, string>>;
}

export interface HelpDeskTriage {
  /** The OpenAI-compatible endpoint's name in the AppHost's `openai`. */
  readonly endpoint: string;
  /** Its declaration, without the key: the AppHost adds a generated secret as `key` and gives the app the same one as `HELP_DESK_TRIAGE_KEY`. */
  readonly declaration: { readonly url: string; readonly models: readonly string[] };
}

export interface HelpDeskFragment {
  readonly environments: Readonly<Record<string, EnvironmentConfig>>;
  readonly app: HelpDeskApp;
  /** With `triage`: the endpoint the triage environment is routed to. */
  readonly triage?: HelpDeskTriage;
}

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url)).replace(/[\\/]+$/, "");

/** Returns Help Desk's environment declaration and its app resource. */
export function helpDesk(options: HelpDeskOptions = {}): HelpDeskFragment {
  const port = options.port ?? HELP_DESK_PORT;
  const triage = options.triage;
  return {
    environments: {
      [HELP_DESK_ENVIRONMENT]: {
        type: "shared",
        description: "Help Desk: one support session per customer on the shared runtime, with the store's tools bound to that customer",
        // The agent reads and changes orders only through the app's tools; it needs no Internet access.
        network: false,
      },
      ...(triage
        ? {
            [HELP_DESK_TRIAGE_ENVIRONMENT]: {
              type: "shared",
              description: "Help Desk's ticket classification: each customer message, classified by Microsoft-Decision-1",
              network: false,
              models: [triage.deployment],
              inference: { openai: HELP_DESK_TRIAGE_ENVIRONMENT },
            },
          }
        : {}),
    },
    app: {
      name: "help-desk",
      workingDirectory: here("."),
      script: "dist/server/main.js",
      port,
      healthPath: "/api/health",
      env: triage
        ? {
            HELP_DESK_TRIAGE_ENVIRONMENT: HELP_DESK_TRIAGE_ENVIRONMENT,
            HELP_DESK_TRIAGE_MODEL: triage.deployment,
            HELP_DESK_DECISION_ENDPOINT: triage.endpoint,
            HELP_DESK_DECISION_DEPLOYMENT: triage.deployment,
            ...(triage.subscription ? { HELP_DESK_DECISION_SUBSCRIPTION: triage.subscription } : {}),
          }
        : {},
    },
    ...(triage
      ? {
          // The platform's runtime runs on this machine with `aspire run`, so it reaches Help Desk on localhost.
          triage: { endpoint: HELP_DESK_TRIAGE_ENVIRONMENT, declaration: { url: `http://localhost:${port}/api/triage/v1`, models: [triage.deployment] } },
        }
      : {}),
  };
}
