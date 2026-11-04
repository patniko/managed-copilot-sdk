/** Local discovery and credential lookup shared by the SDK, CLI, and gateway (spec section 2). */
import { homedir } from "node:os";
import { join } from "node:path";

/** Explicit deployment URL; overrides local discovery. */
export const URL_ENV = "MANAGED_COPILOT_URL";

/** Token environment variables, in lookup order. Explicit `gitHubToken` options always win. */
export const TOKEN_ENVS = ["MANAGED_COPILOT_GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

/** Written by a local gateway so `ManagedCopilot.connect()` finds the running AppHost with no configuration. */
export interface DiscoveryRecord {
  readonly name: string;
  readonly url: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly version: string;
}

export function discoveryDirectory(home: string = homedir()): string {
  return process.env.MANAGED_COPILOT_HOME ?? join(home, ".managed-copilot");
}

export function discoveryFile(home?: string): string {
  return join(discoveryDirectory(home), "local.json");
}
