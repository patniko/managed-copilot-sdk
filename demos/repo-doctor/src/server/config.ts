import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DoctorConfig {
  readonly port: number;
  readonly host: string;
  /** Repo Doctor's own records: each run's steps, logs, tests, and patch. Sandboxes live in the platform. */
  readonly dataDir: string;
  /** Serve the UI through Vite's dev middleware (when running from TypeScript sources). */
  readonly dev: boolean;
  readonly packageRoot: string;
  /** Built UI (`dist/web`). */
  readonly webRoot: string;
  /** The bundled sample project, uploaded into the sandbox for sample runs. */
  readonly sampleDir: string;
  /** The isolated environment each run's session (and sandbox) is created in. */
  readonly environment: string;
  readonly model: string;
  /** Runs that can go at once: each holds a sandbox. */
  readonly maxRuns: number;
  /** Finished runs kept in the history. */
  readonly keepRuns: number;
  readonly timeouts: {
    readonly checkoutMs: number;
    readonly setupMs: number;
    readonly testsMs: number;
    readonly fixMs: number;
    /** How long a finished run's sandbox stays up so the last blocked-request reports arrive. */
    readonly graceMs: number;
    /** Waits before trying again to delete a sandbox while the platform is reachable but the delete failed. */
    readonly deleteRetriesMs: readonly number[];
  };
  /** How often the platform connection is checked. */
  readonly healthIntervalMs: number;
}

function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "apphost.mts")) && existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Cannot locate the Repo Doctor package directory");
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): DoctorConfig {
  const here = fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(dirname(here));
  return {
    port: positive(env.PORT ?? env.REPO_DOCTOR_PORT, 7435),
    host: env.HOST ?? "127.0.0.1",
    dataDir: resolve(env.REPO_DOCTOR_DATA_DIR ?? join(packageRoot, ".data")),
    dev: here.endsWith(".ts") && env.REPO_DOCTOR_DEV !== "0",
    packageRoot,
    webRoot: join(packageRoot, "dist", "web"),
    sampleDir: join(packageRoot, "sample"),
    environment: env.REPO_DOCTOR_ENVIRONMENT?.trim() || "repo-doctor",
    model: env.REPO_DOCTOR_MODEL?.trim() || "claude-sonnet-5",
    maxRuns: positive(env.REPO_DOCTOR_MAX_RUNS, 3),
    keepRuns: 50,
    timeouts: { checkoutMs: 5 * 60_000, setupMs: 15 * 60_000, testsMs: 10 * 60_000, fixMs: 20 * 60_000, graceMs: 1_500, deleteRetriesMs: [5_000, 20_000] },
    healthIntervalMs: 15_000,
  };
}
