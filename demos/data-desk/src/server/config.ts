import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAttachUrl } from "./attach.js";
import { parseFactoryUrl } from "./factory.js";

export interface DeskConfig {
  readonly port: number;
  readonly host: string;
  /** Data Desk's own records and uploaded files. Sessions, sandboxes, and charts live in the platform. */
  readonly dataDir: string;
  /** Serve the UI through Vite's dev middleware (when running from TypeScript sources). */
  readonly dev: boolean;
  readonly packageRoot: string;
  /** Built UI (`dist/web`). */
  readonly webRoot: string;
  /** The bundled sample datasets. */
  readonly samplesDir: string;
  /** Monorepo root, the working directory for `npx managed-copilot attach`. */
  readonly repoRoot: string;
  /** Gateway URL for attach commands when people reach the platform at another address (`DATA_DESK_ATTACH_URL`). */
  readonly attachUrl?: string;
  /** The promotable environment analyses run in. */
  readonly environment: string;
  readonly model: string;
  /** Largest CSV upload. */
  readonly maxUploadBytes: number;
  /** How often the platform connection is checked. */
  readonly healthIntervalMs: number;
  /** Where Data Desk's server reaches Software Factory's API (`SOFTWARE_FACTORY_URL`); unset turns sending off. */
  readonly factoryUrl?: string;
  /** Software Factory's address for people, in links (`SOFTWARE_FACTORY_PUBLIC_URL`, else `factoryUrl`). */
  readonly factoryPublicUrl?: string;
  /** Where Data Desk's server fetches Downhill's shop sales (`DOWNHILL_URL`); unset, that sample isn't offered. */
  readonly downhillUrl?: string;
}

function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "apphost.mts")) && existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Cannot locate the Data Desk package directory");
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): DeskConfig {
  const here = fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(dirname(here));
  const attachUrl = parseAttachUrl(env.DATA_DESK_ATTACH_URL);
  const factoryUrl = parseFactoryUrl(env.SOFTWARE_FACTORY_URL);
  const factoryPublicUrl = factoryUrl ? (parseFactoryUrl(env.SOFTWARE_FACTORY_PUBLIC_URL) ?? factoryUrl) : undefined;
  // The same rules as the factory's address: http or https, no credentials or query, no trailing slash.
  const downhillUrl = parseFactoryUrl(env.DOWNHILL_URL);
  return {
    port: Number(env.PORT ?? env.DATA_DESK_PORT ?? 7430),
    host: env.HOST ?? "127.0.0.1",
    dataDir: resolve(env.DATA_DESK_DATA_DIR ?? join(packageRoot, ".data")),
    dev: here.endsWith(".ts") && env.DATA_DESK_DEV !== "0",
    packageRoot,
    webRoot: join(packageRoot, "dist", "web"),
    samplesDir: join(packageRoot, "datasets"),
    repoRoot: resolve(packageRoot, "..", ".."),
    ...(attachUrl ? { attachUrl } : {}),
    environment: env.DATA_DESK_ENVIRONMENT?.trim() || "data-desk",
    model: env.DATA_DESK_MODEL?.trim() || "claude-sonnet-5",
    maxUploadBytes: 5 * 1024 * 1024,
    healthIntervalMs: 15_000,
    ...(factoryUrl ? { factoryUrl, factoryPublicUrl } : {}),
    ...(downhillUrl ? { downhillUrl } : {}),
  };
}
