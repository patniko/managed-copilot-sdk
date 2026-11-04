import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "../shared/types.js";

export interface SwarmConfig {
  readonly port: number;
  readonly host: string;
  /** Research Swarm's own records (finished reports). Sessions and sandboxes live in the platform. */
  readonly dataDir: string;
  /** Serve the UI through Vite's dev middleware (when running from TypeScript sources). */
  readonly dev: boolean;
  readonly packageRoot: string;
  /** Built UI (`dist/web`). */
  readonly webRoot: string;
  /** The orchestrator environment each question runs in. */
  readonly environment: string;
  /** The lead's model. */
  readonly model: string;
  /** The researchers' model. */
  readonly researcherModel: string;
  /** Questions researched at the same time. */
  readonly maxRuns: number;
  /** A run that takes longer is stopped. */
  readonly runTimeoutMs: number;
  /** How often a running question's researchers and their sources are read. */
  readonly pollMs: number;
  /** How often the platform connection is checked. */
  readonly healthIntervalMs: number;
}

function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "apphost.mts")) && existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Cannot locate the Research Swarm package directory");
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): SwarmConfig {
  const here = fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(dirname(here));
  return {
    port: positive(env.PORT ?? env.RESEARCH_SWARM_PORT, DEFAULT_PORT),
    host: env.HOST ?? "127.0.0.1",
    dataDir: resolve(env.RESEARCH_SWARM_DATA_DIR ?? join(packageRoot, ".data")),
    dev: here.endsWith(".ts") && env.RESEARCH_SWARM_DEV !== "0",
    packageRoot,
    webRoot: join(packageRoot, "dist", "web"),
    environment: env.RESEARCH_SWARM_ENVIRONMENT?.trim() || "research-swarm",
    model: env.RESEARCH_SWARM_MODEL?.trim() || "claude-sonnet-5",
    researcherModel: env.RESEARCH_SWARM_RESEARCHER_MODEL?.trim() || "claude-haiku-5.5",
    maxRuns: positive(env.RESEARCH_SWARM_MAX_RUNS, 2),
    runTimeoutMs: 20 * 60_000,
    pollMs: 2_500,
    healthIntervalMs: 15_000,
  };
}
