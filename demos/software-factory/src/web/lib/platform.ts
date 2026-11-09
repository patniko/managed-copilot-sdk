import type { PlatformStatus, WorkOrderMode } from "../../shared/types.js";
import type { Tone } from "./tone.js";

export interface PlatformPill {
  /** `Local` or `Azure`, or the deployment name, or the state when no deployment is known yet. */
  readonly label: string;
  /** The connection state in a word or two, for the accessible name and the popover. */
  readonly status: string;
  readonly tone: Tone;
  readonly pulse: boolean;
}

/** Where the platform runs: `Local` or `Azure` from the deployment mode, else the deployment name. */
export function deploymentLabel(platform: PlatformStatus): string | undefined {
  const deployment = platform.deployment;
  if (!deployment) return undefined;
  if (deployment.mode === "local") return "Local";
  if (deployment.mode === "azure") return "Azure";
  return deployment.name;
}

export function platformPill(platform: PlatformStatus): PlatformPill {
  const where = deploymentLabel(platform);
  switch (platform.state) {
    case "connected":
      return { label: where ?? "Connected", status: "Connected", tone: "success", pulse: false };
    case "connecting":
      return { label: where ?? "Connecting…", status: "Connecting", tone: "active", pulse: true };
    case "reconnecting":
      return { label: where ?? "Reconnecting…", status: "Reconnecting", tone: "active", pulse: true };
    case "misconfigured":
      return { label: where ?? "Misconfigured", status: "Misconfigured", tone: "danger", pulse: false };
    default:
      return { label: where ?? "Unavailable", status: "Unavailable", tone: "danger", pulse: false };
  }
}

/** Why runs can't start right now, or undefined when they can. `github`: a change to a repository that ends in a pull request. */
export function runsBlockedReason(platform: PlatformStatus | undefined, mode: WorkOrderMode | "github" = "classic"): string | undefined {
  if (!platform) return "Waiting for the factory server…";
  if (platform.state === "connecting") return "The factory is still connecting to Managed Copilot.";
  if (platform.state === "reconnecting") return "The factory is reconnecting to Managed Copilot; new work orders can start once it's back.";
  if (platform.state === "unavailable") return "Managed Copilot is unavailable, so the factory can't start runs.";
  if (platform.state === "misconfigured") return "The platform is missing factory environments, so runs can't start.";
  if (!platform.features.runs) return "This deployment doesn't allow the factory to start runs.";
  if (mode === "agent" && !platform.features.agentLed) return platform.agentLedHint ?? "Agent-led work orders need the factory-coordinator orchestrator environment. Choose App-driven or update the deployment.";
  if (mode === "github" && !platform.features.github) return platform.githubHint ?? "GitHub work orders need the factory-repo environment. Update the deployment.";
  return undefined;
}

/** The execution mode as people see it; the API value for App-driven stays `classic`. */
export function modeLabel(mode: WorkOrderMode | undefined): string {
  return mode === "agent" ? "Agent-led" : "App-driven";
}
