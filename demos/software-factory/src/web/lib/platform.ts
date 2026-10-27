import type { PlatformStatus, WorkOrderMode } from "../../shared/types.js";
import type { Tone } from "./tone.js";

export interface PlatformPill {
  readonly label: string;
  readonly tone: Tone;
  readonly pulse: boolean;
  readonly mode?: string;
}

export function platformPill(platform: PlatformStatus): PlatformPill {
  switch (platform.state) {
    case "connected":
      return { label: platform.deployment?.name ?? "Connected", tone: "success", pulse: false, mode: platform.deployment?.mode };
    case "connecting":
      return { label: "Connecting…", tone: "warning", pulse: true };
    case "reconnecting":
      return { label: "Reconnecting…", tone: "warning", pulse: true, mode: platform.deployment?.mode };
    case "misconfigured":
      return { label: "Misconfigured", tone: "danger", pulse: false };
    default:
      return { label: "Platform unavailable", tone: "danger", pulse: false };
  }
}

/** Why runs can't start right now, or undefined when they can. */
export function runsBlockedReason(platform: PlatformStatus | undefined, mode: WorkOrderMode = "classic"): string | undefined {
  if (!platform) return "Waiting for the factory server…";
  if (platform.state === "connecting") return "The factory is still connecting to Managed Copilot.";
  if (platform.state === "reconnecting") return "The factory is reconnecting to Managed Copilot; new work orders can start once it's back.";
  if (platform.state === "unavailable") return "Managed Copilot is unavailable, so the factory can't start runs.";
  if (platform.state === "misconfigured") return "The platform is missing factory environments, so runs can't start.";
  if (!platform.features.runs) return "This deployment doesn't allow the factory to start runs.";
  if (mode === "agent" && !platform.features.agentLed) return platform.agentLedHint ?? "Agent-led work orders need the factory-coordinator orchestrator environment. Choose Classic or update the deployment.";
  return undefined;
}
