/**
 * AppHost fragment for Hack the Harness: a staff assistant that demonstrates six agent deployment architectures, one
 * environment each, so they all run side by side and each chat picks one. Plain data: no Aspire imports.
 *
 * | Environment                   | Type                      | What it's for                                           |
 * | ----------------------------- | ------------------------- | ------------------------------------------------------- |
 * | `hack-the-harness`            | shared                    | 1. Shared: every chat on the shared runtime, no shell   |
 * | `hack-the-harness-isolated`   | isolated                  | 2. Isolated: a sandbox for every chat                   |
 * | `hack-the-harness-promotable` | promotable                | 3. Promotable: moves into a sandbox when it runs code   |
 * | `hack-the-harness-direct`     | orchestrator, direct      | 4. Direct: shared agent, sandboxed shell and files      |
 * | `hack-the-harness-workers`    | orchestrator              | 5. Workers: shared agent, a worker sandbox per job      |
 * | `hack-the-harness-mixed`      | orchestrator, mixed       | 6. Mixed: its own sandbox, plus workers for bigger jobs |
 * | `hack-the-harness-worker`     | isolated                  | the sandboxes the others move into or start             |
 *
 * None has network access. Sandboxes use the image in `sandbox-image`, which has Python and openpyxl.
 *
 * Only erasable TypeScript syntax is used so this file loads under Node's type stripping as well as tsx.
 */
import { fileURLToPath } from "node:url";
import type { EnvironmentConfig } from "@managed-copilot/protocol";

/** Stage 1, Shared: the environment chats are created in unless they pick another stage. */
export const HACK_THE_HARNESS_ENVIRONMENT = "hack-the-harness";

/** The environment promoted chats, direct workspaces, and workers run in. */
export const HACK_THE_HARNESS_WORKER_ENVIRONMENT = "hack-the-harness-worker";

/** Each stage's environment, by stage ID (`src/app/server/stages.ts`). */
export const HACK_THE_HARNESS_STAGE_ENVIRONMENTS = {
  shared: HACK_THE_HARNESS_ENVIRONMENT,
  isolated: "hack-the-harness-isolated",
  promotable: "hack-the-harness-promotable",
  direct: "hack-the-harness-direct",
  workers: "hack-the-harness-workers",
  mixed: "hack-the-harness-mixed",
} as const;

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
  const stages = HACK_THE_HARNESS_STAGE_ENVIRONMENTS;
  const customizations = here("customizations/staff");
  const common = { models: ["claude-sonnet-5"], network: false, customizations };
  const sandbox = { size: "small", image: here("sandbox-image"), network: false, customizations } as const;
  const workers = [HACK_THE_HARNESS_WORKER_ENVIRONMENT];

  return {
    environments: {
      [HACK_THE_HARNESS_WORKER_ENVIRONMENT]: {
        type: "isolated",
        ...sandbox,
        description: "Hack the Harness sandboxes, with Python and openpyxl for spreadsheet work.",
      },
      [stages.shared]: {
        type: "shared",
        // The agent has no shell or file tools here. Turning them on runs its commands on this machine, beside every
        // other chat: the README shows how, for a demo on your own machine only.
        unsafeHostTools: false,
        ...common,
        description: "Hack the Harness, stage 1 (Shared): every chat on the shared runtime.",
      },
      [stages.isolated]: {
        type: "isolated",
        ...sandbox,
        models: [...common.models],
        description: "Hack the Harness, stage 2 (Isolated): a sandbox for every chat.",
      },
      [stages.promotable]: {
        type: "promotable",
        promoteTo: HACK_THE_HARNESS_WORKER_ENVIRONMENT,
        ...common,
        description: "Hack the Harness, stage 3 (Promotable): chats move into a sandbox when they need to run code.",
      },
      [stages.direct]: {
        type: "orchestrator",
        execution: "direct",
        workers,
        ...common,
        description: "Hack the Harness, stage 4 (Direct): a shared agent whose shell and file commands run in a sandbox.",
      },
      [stages.workers]: {
        type: "orchestrator",
        workers,
        maxWorkers: 2,
        ...common,
        description: "Hack the Harness, stage 5 (Workers): a shared agent that hands each job to a worker sandbox.",
      },
      [stages.mixed]: {
        type: "orchestrator",
        execution: "mixed",
        workers,
        // Its own workspace sandbox takes one of these, so it can have two workers beside it.
        maxWorkers: 3,
        ...common,
        description: "Hack the Harness, stage 6 (Mixed): a shared agent with its own sandbox that also starts workers.",
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
