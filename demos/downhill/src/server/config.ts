import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DownhillConfig {
  readonly port: number;
  readonly host: string;
  /** Serve the game through Vite's dev middleware (when running from TypeScript sources). */
  readonly dev: boolean;
  readonly packageRoot: string;
  /** The built game (`dist/web`). */
  readonly webRoot: string;
  /** The game's version (package.json), sent with support tickets. */
  readonly version: string;
  /** Downhill's records: the launch-day timeline, live sales, deployed storefront versions, and alert state. */
  readonly dataDir: string;
  /** Contoso Outdoors' storefront code as it shipped (read-only): what checkout runs until a fix is deployed. */
  readonly storefrontDir: string;
  /** Help Desk's API, for this server (`HELP_DESK_URL`). Without it, Contact support says support isn't connected. */
  readonly helpDeskUrl?: string;
  /** Help Desk's address for the player's browser (`HELP_DESK_PUBLIC_URL`; defaults to `helpDeskUrl`). */
  readonly helpDeskPublicUrl?: string;
  /** Incident Commander's API (`INCIDENT_URL`), where the shop's alert goes. */
  readonly incidentUrl?: string;
  /** The shared secret Incident Commander requires on alerts (`INCIDENT_ALERT_SECRET`). */
  readonly incidentAlertSecret?: string;
  /** The secret Incident Commander signs approved deploys with (`DOWNHILL_DEPLOY_SECRET`). Without it, deploys are refused. */
  readonly deploySecret?: string;
}

/** A base URL without its trailing slashes, or nothing. */
export function baseUrl(value: string | undefined): string | undefined {
  return value?.trim().replace(/\/+$/, "") || undefined;
}

const nonEmpty = (value: string | undefined): string | undefined => value?.trim() || undefined;

function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "apphost.mts")) && existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Cannot locate the Downhill package directory");
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): DownhillConfig {
  const here = fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(dirname(here));
  const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };
  const helpDeskUrl = baseUrl(env.HELP_DESK_URL);
  const helpDeskPublicUrl = baseUrl(env.HELP_DESK_PUBLIC_URL) ?? helpDeskUrl;
  const incidentUrl = baseUrl(env.INCIDENT_URL);
  const incidentAlertSecret = nonEmpty(env.INCIDENT_ALERT_SECRET);
  const deploySecret = nonEmpty(env.DOWNHILL_DEPLOY_SECRET);
  return {
    port: Number(env.PORT ?? env.DOWNHILL_PORT ?? 7455),
    host: env.HOST ?? "127.0.0.1",
    dev: here.endsWith(".ts") && env.DOWNHILL_DEV !== "0",
    packageRoot,
    webRoot: join(packageRoot, "dist", "web"),
    version,
    dataDir: resolve(env.DOWNHILL_DATA_DIR ?? join(packageRoot, ".data")),
    storefrontDir: resolve(env.DOWNHILL_STOREFRONT_DIR ?? join(packageRoot, "..", "help-desk", "storefront")),
    ...(helpDeskUrl ? { helpDeskUrl, ...(helpDeskPublicUrl ? { helpDeskPublicUrl } : {}) } : {}),
    ...(incidentUrl ? { incidentUrl } : {}),
    ...(incidentAlertSecret ? { incidentAlertSecret } : {}),
    ...(deploySecret ? { deploySecret } : {}),
  };
}
