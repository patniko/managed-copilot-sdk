/**
 * AppHost fragment for Downhill: a painterly mountain-biking game with a shop. Plain data: no Aspire imports. The game
 * runs no agents, so it declares no environments; its server only serves the game and passes the shop's support
 * requests to Help Desk.
 *
 * Wire it into the root AppHost:
 *
 * ```ts
 * import { downhill } from "./demos/downhill/apphost.mts";
 *
 * const demo = downhill();
 * // Run `node <demo.app.script>` in demo.app.workingDirectory (after `pnpm build`) with PORT, HELP_DESK_URL (Help Desk's
 * // API for the server), and HELP_DESK_PUBLIC_URL (Help Desk's address in the player's browser).
 * ```
 *
 * Only erasable TypeScript syntax is used so this file loads under Node's type stripping as well as tsx.
 */
import { fileURLToPath } from "node:url";

export const DOWNHILL_PORT = 7455;

export interface DownhillOptions {
  /** Port for the game and its API. Defaults to 7455. */
  port?: number;
}

export interface DownhillApp {
  /** Aspire resource name. */
  readonly name: "downhill";
  /** Absolute path of the demo package. */
  readonly workingDirectory: string;
  /** Node entry point relative to `workingDirectory`, built by `pnpm build`. */
  readonly script: string;
  /** HTTP port for the game and its API; the server reads `PORT`. */
  readonly port: number;
  readonly healthPath: string;
}

export interface DownhillFragment {
  readonly app: DownhillApp;
}

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url)).replace(/[\\/]+$/, "");

/** Returns Downhill's app resource. */
export function downhill(options: DownhillOptions = {}): DownhillFragment {
  return {
    app: {
      name: "downhill",
      workingDirectory: here("."),
      script: "dist/server/main.js",
      port: options.port ?? DOWNHILL_PORT,
      healthPath: "/api/health",
    },
  };
}
