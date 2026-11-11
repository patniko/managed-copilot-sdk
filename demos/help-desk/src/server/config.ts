import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseUrl } from "./factory.js";

/** Cheap, fast models first: one support answer needs a few tool calls and a short reply (Haiku 4.5: 0.33 premium requests a message). */
export const MODEL_PREFERENCES = ["claude-haiku-4.5", "claude-haiku-5.5", "gpt-5.6-luna", "claude-sonnet-5"] as const;

export interface HelpDeskConfig {
  readonly port: number;
  readonly host: string;
  /** Serve the UI through Vite's dev middleware (when running from TypeScript sources). */
  readonly dev: boolean;
  readonly packageRoot: string;
  /** Built UI (`dist/web`). */
  readonly webRoot: string;
  /** The shared environment every customer's session is created in. */
  readonly environment: string;
  /** The model to use instead of the first of `MODEL_PREFERENCES` the account offers. */
  readonly model?: string;
  /** Delay between starting one customer's session and the next, so the wall fills in a visible wave. */
  readonly staggerMs: number;
  /** How often the platform connection is checked. */
  readonly healthIntervalMs: number;
  /** How often the run's sessions are listed for the counters (placement and sandboxes). */
  readonly countersIntervalMs: number;
  /** Software Factory's API, for this server (`SOFTWARE_FACTORY_URL`). Without it, issues can't be sent. */
  readonly factoryUrl?: string;
  /** Software Factory's address for people, for links (`SOFTWARE_FACTORY_PUBLIC_URL`; defaults to `factoryUrl`). */
  readonly factoryPublicUrl?: string;
  /** The storefront codebase a software issue's work order asks Software Factory to fix. */
  readonly storefrontDir: string;
  /** How often the work orders of sent issues are checked while any is still running. */
  readonly factoryPollMs: number;
}

function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "apphost.mts")) && existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Cannot locate the Help Desk package directory");
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): HelpDeskConfig {
  const here = fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(dirname(here));
  const model = env.HELP_DESK_MODEL?.trim();
  const factoryUrl = baseUrl(env.SOFTWARE_FACTORY_URL);
  const factoryPublicUrl = baseUrl(env.SOFTWARE_FACTORY_PUBLIC_URL) ?? factoryUrl;
  return {
    port: Number(env.PORT ?? env.HELP_DESK_PORT ?? 7440),
    host: env.HOST ?? "127.0.0.1",
    dev: here.endsWith(".ts") && env.HELP_DESK_DEV !== "0",
    packageRoot,
    webRoot: join(packageRoot, "dist", "web"),
    environment: env.HELP_DESK_ENVIRONMENT?.trim() || "help-desk",
    ...(model ? { model } : {}),
    staggerMs: 120,
    healthIntervalMs: 15_000,
    countersIntervalMs: 4_000,
    ...(factoryUrl ? { factoryUrl, ...(factoryPublicUrl ? { factoryPublicUrl } : {}) } : {}),
    storefrontDir: join(packageRoot, "storefront"),
    factoryPollMs: 5_000,
  };
}
