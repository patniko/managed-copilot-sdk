// Rewrites session.create / session.resume parameters for a sandbox runtime (credential isolation and path mapping).
import { posix, win32 } from "node:path";
import { ManagedCopilotError, SANDBOX_PATHS } from "@managed-copilot/protocol";

/** Fields that would hand a GitHub credential (or a self-fetch of managed policy with one) to the sandbox runtime. */
const TOKEN_FIELDS = ["gitHubToken", "gitHubTokenProviderRegistrationId", "enableManagedSettings"] as const;
const DIRECTORY_FIELDS = ["skillDirectories", "agentDirectories", "instructionDirectories"] as const;

/** The part of `path` below `root` (POSIX separators), "" for `root` itself, or undefined when outside it. */
export function relativeWithin(path: string, root: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const normalize = (value: string) => (platform === "win32" ? win32.resolve(value).split("\\").join("/") : posix.resolve(value));
  const candidate = normalize(path);
  const base = normalize(root).replace(/\/+$/, "");
  const fold = platform === "win32" ? (value: string) => value.toLowerCase() : (value: string) => value;
  if (fold(candidate) === fold(base)) return "";
  if (fold(candidate).startsWith(`${fold(base)}/`)) return candidate.slice(base.length + 1);
  return undefined;
}

/**
 * Strips GitHub credential fields, rejects custom model providers (inference is brokered), defaults the working
 * directory to /workspace, and maps host paths of the pinned customizations bundle to its read-only mount.
 */
export function rewriteSessionParams(params: Record<string, unknown>, customizationsRoot: string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  for (const key of TOKEN_FIELDS) delete out[key];
  if (out["provider"] !== undefined && out["provider"] !== null) {
    throw new ManagedCopilotError(
      "policy_violation",
      "Custom model providers are not available in sandboxes: inference is brokered by the gateway with the session owner's Copilot entitlement.",
    );
  }
  out["workingDirectory"] ??= SANDBOX_PATHS.workspace;
  if (customizationsRoot) {
    for (const key of DIRECTORY_FIELDS) {
      const value = out[key];
      if (!Array.isArray(value)) continue;
      out[key] = value.map((entry: unknown) => {
        if (typeof entry !== "string") return entry;
        const rest = relativeWithin(entry, customizationsRoot);
        if (rest === undefined) return entry;
        return rest ? `${SANDBOX_PATHS.customizations}/${rest}` : SANDBOX_PATHS.customizations;
      });
    }
  }
  return out;
}

/**
 * Takes `agent` out of create/resume parameters. The stock runtime resolves a named agent from `agentDirectories`
 * only when it holds a GitHub credential at construction, and a sandbox runtime receives its brokered credential
 * after construction, so the gateway selects the agent itself once credentials are installed.
 */
export function deferAgentSelection(params: Record<string, unknown>): { params: Record<string, unknown>; agent?: string } {
  const agent = params["agent"];
  if (typeof agent !== "string" || !agent) return { params };
  const { agent: _deferred, ...rest } = params;
  return { params: rest, agent };
}
