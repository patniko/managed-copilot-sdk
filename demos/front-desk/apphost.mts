/**
 * AppHost fragment for Front Desk (a data descriptor; no Aspire imports): a chat assistant many people use. Each person
 * signs in, gets private conversations and memory, and never sees anyone else's.
 *
 * | Environment  | Type   | Who uses it                     | Model use billed to       |
 * | ------------ | ------ | ------------------------------- | ------------------------- |
 * | `front-desk` | shared | people who sign in with GitHub  | their own Copilot plan    |
 *
 * The root `apphost.mts` merges `environments` into `addManagedCopilot(...)` and runs `app` (after `pnpm build`) with
 * `PORT`, `MANAGED_COPILOT_URL`, and these parameters:
 * - `front-desk-sealing-key` → `FRONT_DESK_SEALING_KEY` (generated): seals the GitHub tokens Front Desk keeps.
 * - `front-desk-github-client-id` / `front-desk-github-client-secret` → `FRONT_DESK_GITHUB_CLIENT_ID` /
 *   `FRONT_DESK_GITHUB_CLIENT_SECRET` (optional): the GitHub OAuth app behind "Continue with GitHub".
 *
 * Front Desk never acts as the person who deployed it: it is published with `githubToken: false`, and every call to
 * Managed Copilot carries the signed-in person's own credential.
 *
 * Erasable TypeScript only, so it runs under Node's type stripping.
 */
import { fileURLToPath } from "node:url";
import type { EnvironmentConfig } from "@managed-copilot/protocol";

/** The environment conversations of people who sign in with GitHub run in. */
export const FRONT_DESK_ENVIRONMENT = "front-desk";
/** Models Front Desk's environments allow; the first is the default. */
export const FRONT_DESK_MODELS = ["claude-sonnet-5", "claude-haiku-5.5"] as const;
/** Fixed and not proxied, so the GitHub OAuth callback stays http://localhost:7450/auth/github/callback. */
export const FRONT_DESK_PORT = 7450;

export interface FrontDeskOptions {
  /** Port for the UI and API. Defaults to 7450. */
  readonly port?: number;
}

export interface FrontDeskApp {
  /** Aspire resource name, and the container app's name in Azure. */
  readonly name: "front-desk";
  readonly workingDirectory: string;
  /** Node entry point relative to `workingDirectory`, built by `pnpm build`. */
  readonly script: string;
  readonly port: number;
  readonly healthPath: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface FrontDeskFragment {
  readonly environments: Readonly<Record<string, EnvironmentConfig>>;
  readonly app: FrontDeskApp;
}

/** Returns Front Desk's environment declarations and its app resource. */
export function frontDesk(options: FrontDeskOptions = {}): FrontDeskFragment {
  const port = options.port ?? FRONT_DESK_PORT;
  return {
    environments: {
      [FRONT_DESK_ENVIRONMENT]: {
        type: "shared",
        description: "Front Desk: private conversations for each person who signs in with GitHub; model use goes to their own Copilot plan",
        models: [...FRONT_DESK_MODELS],
        // The agent needs no Internet access: its memory tools run in the Front Desk server.
        network: false,
      },
    },
    app: {
      name: "front-desk",
      workingDirectory: fileURLToPath(new URL(".", import.meta.url)),
      script: "dist/server/main.js",
      port,
      healthPath: "/api/health",
      env: {
        FRONT_DESK_ENVIRONMENT,
        FRONT_DESK_PUBLIC_URL: `http://localhost:${port}`,
      },
    },
  };
}
