import type { PermissionHandler, PermissionRequestResult } from "@github/copilot-sdk";

/**
 * The factory's permission policy. Sandbox stations may run commands, edit files, and fetch from the hosts the
 * environment's network policy allows; office stations may only call the factory's own tools. Everything else is
 * rejected with feedback the agent can act on. The managed platform's own deny rules still apply on top.
 */
export function factoryPermissions(placement: "shared" | "sandbox", onDenied: (kind: string) => void): PermissionHandler {
  const allowed = new Set(placement === "sandbox" ? ["shell", "write", "read", "url", "custom-tool", "memory"] : ["custom-tool", "read"]);
  return (request): PermissionRequestResult => {
    if (request.managedApprovalRequired) return { kind: "no-result" };
    if (allowed.has(request.kind)) return { kind: "approve-once" };
    onDenied(request.kind);
    return { kind: "reject", feedback: `The software factory does not allow "${request.kind}" actions at this station.` };
  };
}
