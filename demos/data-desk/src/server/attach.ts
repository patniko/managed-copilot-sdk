import { spawn } from "node:child_process";
import type { AttachResponse } from "../shared/types.js";

/** Session IDs are interpolated into a console command line, so only plain identifier characters are accepted. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** The gateway URL shown in attach commands is interpolated too: scheme, host, port, and a plain path only. */
const ATTACH_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/;

/** A valid `DATA_DESK_ATTACH_URL` (trailing slash removed), or undefined. */
export function parseAttachUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !ATTACH_URL.test(trimmed)) return undefined;
  return trimmed.replace(/\/+$/, "");
}

/** `{sessionId}` marks where the session goes; `url` is the deployment people attach to, when it isn't their local one. */
export function attachCommandTemplate(url?: string): string {
  return `npx managed-copilot attach {sessionId}${url ? ` --url ${url}` : ""}`;
}

export function attachCommand(sessionId: string, url?: string): string {
  return attachCommandTemplate(url).replace("{sessionId}", sessionId);
}

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID.test(sessionId);
}

/** Copilot CLI is interactive, so it needs its own console window; Data Desk can open one on Windows. */
export function canLaunchTerminal(): boolean {
  return process.platform === "win32" && process.env.DATA_DESK_DISABLE_TERMINAL !== "1";
}

/**
 * Opens a console window running `npx managed-copilot attach <sessionId>` from the repository root, where the root
 * package links the `managed-copilot` bin. The CLI resolves the deployment (`--url`, `MANAGED_COPILOT_URL`, then local
 * discovery) and the GitHub sign-in itself; no credentials pass through this process's command line. When the session
 * moves into its sandbox, the attached CLI reconnects to it by itself.
 */
export async function launchAttach(sessionId: string, repoRoot: string, gatewayUrl: string | undefined, attachUrl?: string): Promise<AttachResponse> {
  const command = attachCommand(sessionId, attachUrl);
  if (!isValidSessionId(sessionId)) return { command, launched: false, message: "That session ID can't be attached." };
  if (!canLaunchTerminal()) {
    return { command, launched: false, message: "Run this from the repository root to open the same session in Copilot CLI." };
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
    return { command, launched: true, message: "Copilot CLI opened in a new window, on the same session." };
  } catch {
    return { command, launched: false, message: "Couldn't open a console window. Run this from the repository root instead." };
  }
}
