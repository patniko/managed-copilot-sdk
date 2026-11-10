/**
 * AppHost fragment for Hack the Harness: a staff assistant that demonstrates five agent deployment architectures.
 * Plain data: no Aspire imports.
 *
 * | Environment               | Type     | Network | What it's for                                                   |
 * | ------------------------- | -------- | ------- | --------------------------------------------------------------- |
 * | `hack-the-harness`        | shared   | off     | each user's chat, on the shared runtime                         |
 * | `hack-the-harness-worker` | isolated | off     | sandboxes from the image in `sandbox-image`, for later steps    |
 *
 * The README shows how to change these, and the app, for the other architectures.
 *
 * Only erasable TypeScript syntax is used so this file loads under Node's type stripping as well as tsx.
 */
import { fileURLToPath } from "node:url";
import type { EnvironmentConfig } from "@managed-copilot/protocol";

/** The environment each user's chat is created in. */
export const HACK_THE_HARNESS_ENVIRONMENT = "hack-the-harness";

/** The environment the chat's workers run in. */
export const HACK_THE_HARNESS_WORKER_ENVIRONMENT = "hack-the-harness-worker";

export const HACK_THE_HARNESS_PORT = 7415;

export interface HackTheHarnessOptions {
  /** Port for the UI and API. Defaults to 7415. */
  port?: number;
}

export interface HackTheHarnessApp {
  /** Aspire resource name. */
  readonly name: "hack-the-harness";
  /** Absolute path of the demo package. */
  readonly workingDirectory: string;
  /** Node entry point relative to `workingDirectory`, built by `pnpm build`. */
  readonly script: string;
  /** HTTP port for the UI and API; the server reads `PORT`, and the gateway URL from `MANAGED_COPILOT_URL`. */
  readonly port: number;
  readonly healthPath: string;
}

export interface HackTheHarnessFragment {
  readonly environments: Readonly<Record<string, EnvironmentConfig>>;
  readonly app: HackTheHarnessApp;
}

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url)).replace(/[\\/]+$/, "");

/** Returns Hack the Harness's environment declarations and its app resource. */
export function hackTheHarness(options: HackTheHarnessOptions = {}): HackTheHarnessFragment {
  return {
    environments: {
      [HACK_THE_HARNESS_WORKER_ENVIRONMENT]: {
        type: "isolated",
        size: "small",
        image: here("sandbox-image"),
        network: false,
        customizations: here("customizations/staff"),
        description: "Hack the Harness sandboxes, with Python and openpyxl for spreadsheet work.",
      },
      [HACK_THE_HARNESS_ENVIRONMENT]: {
        type: "shared",
        unsafeHostTools: false,
        models: ["claude-sonnet-5"],
        network: false,
        customizations: here("customizations/staff"),
        description: "Hack the Harness staff assistant chats.",
      },
    },
    app: {
      name: "hack-the-harness",
      workingDirectory: here("."),
      script: "dist/server/main.js",
      port: options.port ?? HACK_THE_HARNESS_PORT,
      healthPath: "/api/health",
    },
  };
}
