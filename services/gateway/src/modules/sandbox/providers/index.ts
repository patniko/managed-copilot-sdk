// Sandbox provider selection (`MANAGED_COPILOT_SANDBOX_PROVIDER`, default `docker`).
import { createAzureSandboxProvider } from "./azure/index.js";
import { createDockerSandboxProvider } from "./docker/provider.js";
import type { SandboxProvider, SandboxProviderDeps } from "./types.js";

export type { SandboxEndpoint, SandboxImageRef, SandboxOperationOptions, SandboxProvider, SandboxProviderDeps, SandboxSpec, SandboxStartResult } from "./types.js";

const FACTORIES: Record<string, (deps: SandboxProviderDeps) => SandboxProvider> = {
  docker: createDockerSandboxProvider,
  azure: createAzureSandboxProvider,
};

export function createSandboxProvider(kind: string, deps: SandboxProviderDeps): SandboxProvider {
  const factory = FACTORIES[kind];
  if (!factory) throw new Error(`MANAGED_COPILOT_SANDBOX_PROVIDER must be one of ${Object.keys(FACTORIES).join(", ")} (got "${kind}")`);
  return factory(deps);
}
