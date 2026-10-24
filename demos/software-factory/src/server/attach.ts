import { spawn } from "node:child_process";
import type { AttachResponse } from "../shared/types.js";

/** Session IDs are interpolated into a console command line, so only plain identifier characters are accepted. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export const ATTACH_COMMAND_TEMPLATE = "npx managed-copilot attach {sessionId}";

export function attachCommand(sessionId: string): string {
  return ATTACH_COMMAND_TEMPLATE.replace("{sessionId}", sessionId);
}

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID.test(sessionId);
}

/** Copilot CLI is interactive, so it needs its own console window; the factory can open one on Windows. */
export function canLaunchTerminal(): boolean {
  return process.platform === "win32" && process.env.FACTORY_DISABLE_TERMINAL !== "1";
}

/**
 * Opens a console window running `npx managed-copilot attach <sessionId>` from the repository root, where the
 * root package links the `managed-copilot` bin. The CLI resolves the deployment (`MANAGED_COPILOT_URL`, then local
 * discovery) and the GitHub sign-in itself; no credentials pass through this process's command line.
 */
export async function launchAttach(sessionId: string, repoRoot: string, gatewayUrl: string | undefined): Promise<AttachResponse> {
  const command = attachCommand(sessionId);
  if (!isValidSessionId(sessionId)) return { command, launched: false, message: "That session ID can't be attached." };
  if (!canLaunchTerminal()) {
    return { command, launched: false, message: "Run this command from the repository root to attach Copilot CLI to the session." };
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("cmd.exe", ["/d", "/c", "start", '"Copilot CLI"', "cmd.exe", "/k", command], {
        cwd: repoRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        windowsVerbatimArguments: true,
        env: { ...process.env, ...(gatewayUrl ? { MANAGED_COPILOT_URL: gatewayUrl } : {}) },
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
    return { command, launched: true, message: "Opened Copilot CLI in a new console window, attached to the live session." };
  } catch {
    return { command, launched: false, message: "Couldn't open a console window. Run this command from the repository root instead." };
  }
}
