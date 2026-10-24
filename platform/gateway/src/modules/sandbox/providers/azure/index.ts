// Owner: azure workstream. Placeholder until the Azure sandbox provider lands; replace this file's body with the
// provider (see ../types.ts for the contract and invariants).
import { ManagedCopilotError } from "@managed-copilot/protocol";
import type { SandboxProvider, SandboxProviderDeps } from "../types.js";

export function createAzureSandboxProvider(_deps: SandboxProviderDeps): SandboxProvider {
  throw new ManagedCopilotError("capability_unavailable", "The Azure sandbox provider is not part of this build yet; use MANAGED_COPILOT_SANDBOX_PROVIDER=docker.");
}
