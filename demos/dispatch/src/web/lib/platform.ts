import type { PlatformStatus } from "../../shared/types.js";
import type { Connection } from "./store.js";

export interface PillStatus {
  readonly tone: "success" | "busy" | "danger";
  /** The pill's label: `Local` or `Azure`, else the deployment's name. */
  readonly label: string;
  /** The popover's first line. */
  readonly headline: string;
}

/**
 * The header's platform pill: where the app runs and whether it's connected. A spinner while connecting (to the
 * platform, or the app's own event stream reconnecting), a danger dot when unavailable.
 */
export function pillStatus(platform: PlatformStatus | undefined, connection: Connection): PillStatus {
  const label = platform?.mode === "azure" ? "Azure" : platform?.mode === "local" ? "Local" : (platform?.deployment ?? "Managed Copilot");
  if (!platform || platform.state === "connecting") return { tone: "busy", label, headline: "Connecting to Managed Copilot…" };
  if (platform.state === "reconnecting") return { tone: "busy", label, headline: "Reconnecting to Managed Copilot…" };
  if (platform.state === "unavailable") return { tone: "danger", label, headline: "Managed Copilot isn't available" };
  if (connection === "reconnecting") return { tone: "busy", label, headline: "Reconnecting to Dispatch's server…" };
  return { tone: "success", label, headline: `Connected · ${label}` };
}
