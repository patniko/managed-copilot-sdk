import type { StationRole } from "../shared/types.js";

/**
 * Preferred models per station, best first. The factory picks the first one the signed-in user's Copilot
 * entitlement offers (`client.listModels()`); `FACTORY_MODEL_<ROLE>` overrides it. The reviewer deliberately uses a
 * different model family than the builder so it catches what the builder missed.
 */
export const MODEL_PREFERENCES: Readonly<Record<StationRole, readonly string[]>> = {
  planner: ["claude-haiku-5.5", "claude-haiku-4.5", "gpt-5.6-luna", "claude-sonnet-5"],
  builder: ["claude-sonnet-5", "claude-sonnet-5.5", "gpt-5.6-sol", "claude-opus-5"],
  reviewer: ["gpt-5.6-terra", "gpt-6-luna", "gpt-5.6-sol", "gpt-6-sol", "claude-opus-5"],
  release: ["claude-sonnet-5", "claude-sonnet-5.5", "gpt-5.6-sol", "claude-opus-5"],
  coordinator: ["claude-sonnet-5", "claude-sonnet-5.5", "gpt-5.6-sol", "claude-opus-5"],
  developer: ["claude-sonnet-5", "claude-sonnet-5.5", "gpt-5.6-sol", "claude-opus-5"],
};

export interface AvailableModel {
  readonly id: string;
  readonly policy?: { readonly state?: string };
}

function family(model: string): string {
  return model.split("-")[0] ?? model;
}

function usable(model: AvailableModel): boolean {
  const state = model.policy?.state;
  return state === undefined || state === "enabled";
}

/**
 * Chooses a model per role. With no model list (discovery failed), the first preference is used and the platform
 * reports a clear error if it is not available.
 */
export function chooseModels(
  available: readonly AvailableModel[] | undefined,
  overrides: Partial<Record<StationRole, string>> = {},
): Record<StationRole, string> {
  const ids = available ? new Set(available.filter(usable).map((model) => model.id)) : undefined;
  const pick = (role: StationRole, avoidFamily?: string): string => {
    const override = overrides[role];
    if (override) return override;
    const candidates = MODEL_PREFERENCES[role].filter((id) => !ids || ids.has(id));
    const preferred = avoidFamily ? candidates.find((id) => family(id) !== avoidFamily) : undefined;
    return preferred ?? candidates[0] ?? MODEL_PREFERENCES[role][0]!;
  };
  const builder = pick("builder");
  return {
    planner: pick("planner"),
    builder,
    reviewer: pick("reviewer", family(builder)),
    release: pick("release"),
    coordinator: pick("coordinator"),
    developer: pick("developer"),
  };
}
