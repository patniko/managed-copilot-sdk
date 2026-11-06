import type { StationRole } from "./types.js";

/** Environment names declared by the AppHost fragment (`apphost.mts`); a unit test keeps them in sync. */
export const FACTORY_ENVIRONMENTS: Readonly<Record<StationRole, string>> = {
  planner: "factory-planner",
  builder: "factory-builder",
  reviewer: "factory-reviewer",
  release: "factory-release",
  coordinator: "factory-coordinator",
  developer: "factory-repo",
};

/** Custom agents deployed with each environment's customizations bundle. */
export const ROLE_AGENTS: Readonly<Record<StationRole, string>> = {
  planner: "planner",
  builder: "builder",
  reviewer: "reviewer",
  release: "release",
  coordinator: "coordinator",
  developer: "developer",
};

/** The reviewer's agent for GitHub work orders: it reviews a diff against a repository, not a planned task. */
export const PR_REVIEWER_AGENT = "pr-reviewer";

/** The roles classic work orders use; a deployment needs their environments to run work orders at all. */
export const CLASSIC_ROLES: readonly StationRole[] = ["planner", "builder", "reviewer", "release"];

/** The roles GitHub work orders use. */
export const GITHUB_ROLES: readonly StationRole[] = ["developer", "reviewer"];

/** Every role, including the agent-led coordinator and the GitHub developer. */
export const ROLES: readonly StationRole[] = [...CLASSIC_ROLES, "coordinator", "developer"];

export const SANDBOX_SIZES: Readonly<Record<"small" | "medium" | "large", { readonly cpus: number; readonly memoryGiB: number }>> = {
  small: { cpus: 1, memoryGiB: 2 },
  medium: { cpus: 2, memoryGiB: 4 },
  large: { cpus: 4, memoryGiB: 8 },
};
