import type { StationRole } from "./types.js";

/** Environment names declared by the AppHost fragment (`apphost.mts`); a unit test keeps them in sync. */
export const FACTORY_ENVIRONMENTS: Readonly<Record<StationRole, string>> = {
  planner: "factory-planner",
  builder: "factory-builder",
  reviewer: "factory-reviewer",
  release: "factory-release",
};

/** Custom agents deployed with each environment's customizations bundle. */
export const ROLE_AGENTS: Readonly<Record<StationRole, string>> = {
  planner: "planner",
  builder: "builder",
  reviewer: "reviewer",
  release: "release",
};

export const ROLES: readonly StationRole[] = ["planner", "builder", "reviewer", "release"];

export const SANDBOX_SIZES: Readonly<Record<"small" | "medium" | "large", { readonly cpus: number; readonly memoryGiB: number }>> = {
  small: { cpus: 1, memoryGiB: 2 },
  medium: { cpus: 2, memoryGiB: 4 },
  large: { cpus: 4, memoryGiB: 8 },
};
