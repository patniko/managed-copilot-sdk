import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RaceConfig {
  readonly port: number;
  readonly host: string;
  /** Where the last race's result is kept, so the board shows it after a restart. */
  readonly dataDir: string;
  /** Serve the UI through Vite's dev middleware (when running from TypeScript sources). */
  readonly dev: boolean;
  readonly packageRoot: string;
  /** Built UI (`dist/web`). */
  readonly webRoot: string;
  /** The model every lane uses. */
  readonly model: string;
  /** How long one lane may take before it fails. */
  readonly laneTimeoutMs: number;
  /** How often the platform connection is checked. */
  readonly healthIntervalMs: number;
  /** How often a running lane's usage and sandboxes are read. */
  readonly pollIntervalMs: number;
}

function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "apphost.mts")) && existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Cannot locate the Pattern Race package directory");
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): RaceConfig {
  const here = fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(dirname(here));
  return {
    port: Number(env.PORT ?? env.PATTERN_RACE_PORT ?? 7420),
    host: env.HOST ?? "127.0.0.1",
    dataDir: resolve(env.PATTERN_RACE_DATA_DIR ?? join(packageRoot, ".data")),
    dev: here.endsWith(".ts") && env.PATTERN_RACE_DEV !== "0",
    packageRoot,
    webRoot: join(packageRoot, "dist", "web"),
    model: env.PATTERN_RACE_MODEL?.trim() || "claude-sonnet-5",
    laneTimeoutMs: 15 * 60_000,
    healthIntervalMs: 15_000,
    pollIntervalMs: 2_500,
  };
}
