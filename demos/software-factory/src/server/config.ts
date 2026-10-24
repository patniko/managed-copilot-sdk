import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAttachUrl } from "./attach.js";
import type { StationRole } from "../shared/types.js";

export interface FactoryConfig {
  readonly port: number;
  readonly host: string;
  /** SQLite store and other local state. */
  readonly dataDir: string;
  /** Serve the UI through Vite's dev middleware (when running from TypeScript sources). */
  readonly dev: boolean;
  /** The demo package directory. */
  readonly packageRoot: string;
  /** Built UI (`dist/web`). */
  readonly webRoot: string;
  /** Monorepo root, used as the working directory for `npx managed-copilot attach`. */
  readonly repoRoot: string;
  /** Gateway URL for attach commands when users reach the platform at another address (`FACTORY_ATTACH_URL`). */
  readonly attachUrl?: string;
  readonly modelOverrides: Partial<Record<StationRole, string>>;
  /** Isolated sessions (sandboxes) the factory runs at once, across all work orders. */
  readonly maxSandboxes: number;
  readonly turnTimeoutMs: Readonly<Record<StationRole, number>>;
  readonly publicationTimeoutMs: number;
  /** How often to verify the platform is still reachable. */
  readonly healthIntervalMs: number;
}

function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "apphost.mts")) && existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Cannot locate the software factory package directory");
}

function minutes(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 60_000 : fallback * 60_000;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): FactoryConfig {
  const here = fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(dirname(here));
  const maxSandboxes = Number(env.FACTORY_MAX_SANDBOXES ?? 4);
  const attachUrl = parseAttachUrl(env.FACTORY_ATTACH_URL);
  return {
    port: Number(env.PORT ?? env.FACTORY_PORT ?? 7480),
    host: env.HOST ?? "127.0.0.1",
    dataDir: resolve(env.FACTORY_DATA_DIR ?? join(packageRoot, ".data")),
    dev: here.endsWith(".ts") && env.FACTORY_DEV !== "0",
    packageRoot,
    webRoot: join(packageRoot, "dist", "web"),
    repoRoot: resolve(packageRoot, "..", ".."),
    ...(attachUrl ? { attachUrl } : {}),
    modelOverrides: {
      ...(env.FACTORY_MODEL_PLANNER ? { planner: env.FACTORY_MODEL_PLANNER } : {}),
      ...(env.FACTORY_MODEL_BUILDER ? { builder: env.FACTORY_MODEL_BUILDER } : {}),
      ...(env.FACTORY_MODEL_REVIEWER ? { reviewer: env.FACTORY_MODEL_REVIEWER } : {}),
      ...(env.FACTORY_MODEL_RELEASE ? { release: env.FACTORY_MODEL_RELEASE } : {}),
    },
    maxSandboxes: Number.isInteger(maxSandboxes) && maxSandboxes > 0 ? maxSandboxes : 4,
    turnTimeoutMs: {
      planner: minutes(env.FACTORY_PLAN_TIMEOUT_MINUTES, 5),
      builder: minutes(env.FACTORY_BUILD_TIMEOUT_MINUTES, 20),
      reviewer: minutes(env.FACTORY_REVIEW_TIMEOUT_MINUTES, 6),
      release: minutes(env.FACTORY_RELEASE_TIMEOUT_MINUTES, 20),
    },
    publicationTimeoutMs: 120_000,
    healthIntervalMs: 10_000,
  };
}
