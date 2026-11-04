/**
 * AppHost fragment for Front Desk (a data descriptor; no Aspire imports): a chat assistant many people use. Each person
 * signs in, gets private conversations and memory, and never sees anyone else's.
 *
 * | Environment          | Type   | Who uses it                     | Model use billed to                |
 * | -------------------- | ------ | ------------------------------- | ---------------------------------- |
 * | `front-desk`         | shared | people who sign in with GitHub  | their own Copilot plan             |
 * | `front-desk-foundry` | shared | everyone else (app users)       | the deployment's Azure AI Foundry  |
 *
 * `front-desk-foundry` exists only when the AppHost names a Foundry account (`foundry`). The app `front-desk` vouches
 * for its own users with the key the AppHost issues it (`apps`, `copilot.appKey("front-desk")`), and admits any GitHub
 * account that signs in through it (`anyGitHubUser`).
 *
 * The root `apphost.mts` merges `environments` and `apps` into `addManagedCopilot(...)` and runs `app` (after
 * `pnpm build`) with `PORT`, `MANAGED_COPILOT_URL`, `MANAGED_COPILOT_APP_KEY`, and these parameters:
 * - `front-desk-sealing-key` → `FRONT_DESK_SEALING_KEY` (generated): seals the GitHub tokens Front Desk keeps.
 * - `front-desk-github-client-id` / `front-desk-github-client-secret` → `FRONT_DESK_GITHUB_CLIENT_ID` /
 *   `FRONT_DESK_GITHUB_CLIENT_SECRET` (optional): the GitHub OAuth app behind "Continue with GitHub".
 *
 * Front Desk never acts as the person who deployed it: it is published with `public: true` (no GitHub token), and every
 * call to Managed Copilot acts for a signed-in person.
 *
 * Erasable TypeScript only, so it runs under Node's type stripping.
 */
import { fileURLToPath } from "node:url";
import type { EnvironmentConfig } from "@managed-copilot/protocol";

/** The app name the AppHost declares in `apps`, and Front Desk's Aspire resource and container app name. */
export const FRONT_DESK_APP = "front-desk";
/** The environment conversations of people who sign in with GitHub run in. */
export const FRONT_DESK_ENVIRONMENT = "front-desk";
/** The environment conversations of everyone else run in: model calls go to the deployment's Azure AI Foundry. */
export const FRONT_DESK_FOUNDRY_ENVIRONMENT = "front-desk-foundry";
/** Models the GitHub users' environment allows; the first is the default. */
export const FRONT_DESK_MODELS = ["claude-sonnet-5", "claude-haiku-5.5"] as const;
/** Fixed and not proxied, so the GitHub OAuth callback stays http://localhost:7450/auth/github/callback. */
export const FRONT_DESK_PORT = 7450;

export interface FrontDeskOptions {
  /** Port for the UI and API. Defaults to 7450. */
  readonly port?: number;
  /**
   * The Azure AI Foundry account (declared in the AppHost's `foundry`) that pays for people without GitHub. Without one,
   * they can sign in but not chat.
   */
  readonly foundry?: string;
}

export interface FrontDeskApp {
  /** Aspire resource name, and the container app's name in Azure. */
  readonly name: typeof FRONT_DESK_APP;
  readonly workingDirectory: string;
  /** Node entry point relative to `workingDirectory`, built by `pnpm build`. */
  readonly script: string;
  readonly port: number;
  readonly healthPath: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface FrontDeskFragment {
  readonly environments: Readonly<Record<string, EnvironmentConfig>>;
  /** Merge into `addManagedCopilot`'s `apps`; pass `copilot.appKey(FRONT_DESK_APP)` to the app. */
  readonly apps: Readonly<Record<string, { readonly environments: string[]; readonly anyGitHubUser: boolean }>>;
  readonly app: FrontDeskApp;
}

/** Returns Front Desk's environments, its app declaration, and its app resource. */
export function frontDesk(options: FrontDeskOptions = {}): FrontDeskFragment {
  const port = options.port ?? FRONT_DESK_PORT;
  const environments: Record<string, EnvironmentConfig> = {
    [FRONT_DESK_ENVIRONMENT]: {
      type: "shared",
      description: "Front Desk: private conversations for each person who signs in with GitHub; model use goes to their own Copilot plan",
      models: [...FRONT_DESK_MODELS],
      // The agent needs no Internet access: its memory tools run in the Front Desk server.
      network: false,
    },
  };
  if (options.foundry) {
    environments[FRONT_DESK_FOUNDRY_ENVIRONMENT] = {
      type: "shared",
      description: "Front Desk: private conversations for each person without GitHub; model use goes to the deployment's Azure AI Foundry",
      inference: { foundry: options.foundry },
      network: false,
    };
  }
  return {
    environments,
    apps: { [FRONT_DESK_APP]: { environments: Object.keys(environments), anyGitHubUser: true } },
    app: {
      name: FRONT_DESK_APP,
      workingDirectory: fileURLToPath(new URL(".", import.meta.url)),
      script: "dist/server/main.js",
      port,
      healthPath: "/api/health",
      env: {
        FRONT_DESK_ENVIRONMENT,
        FRONT_DESK_FOUNDRY_ENVIRONMENT,
        FRONT_DESK_PUBLIC_URL: `http://localhost:${port}`,
      },
    },
  };
}
