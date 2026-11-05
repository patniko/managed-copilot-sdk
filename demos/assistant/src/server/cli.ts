import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { OpenCliResponse } from "../shared/protocol.js";
import { DEMO_ROOT } from "./config.js";

/** Session IDs and URLs are interpolated into a console command line, so only plain characters are accepted. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ATTACH_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/;

/** The monorepo root, where the root package links the `managed-copilot` bin. */
const REPO_ROOT = resolve(DEMO_ROOT, "..", "..");

export function cliCommand(sessionId: string, url?: string): string {
  return `npx managed-copilot attach ${sessionId}${url && ATTACH_URL.test(url) ? ` --url ${url.replace(/\/+$/, "")}` : ""}`;
}

/** Copilot CLI is interactive, so it needs its own console window; the assistant can open one on Windows. */
export function canLaunchTerminal(): boolean {
  return process.platform === "win32" && process.env.ASSISTANT_DISABLE_TERMINAL !== "1";
}

/**
 * Opens a console window running `npx managed-copilot attach <sessionId>` from the repository root. The CLI resolves
 * the deployment and the GitHub sign-in itself; no credentials pass through this process's command line.
 */
export async function launchCli(sessionId: string, url?: string): Promise<OpenCliResponse> {
  if (!SESSION_ID.test(sessionId)) return { command: "", launched: false, message: "This conversation can't be opened in Copilot CLI." };
  const command = cliCommand(sessionId, url);
  if (!canLaunchTerminal()) return { command, launched: false, message: "Run this command from the repository root to continue in Copilot CLI." };
  try {
    await new Promise<void>((done, fail) => {
      const child = spawn("cmd.exe", ["/d", "/c", "start", '"Copilot CLI"', "cmd.exe", "/k", command], {
        cwd: REPO_ROOT,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        windowsVerbatimArguments: true,
      });
      child.once("error", fail);
      child.once("spawn", () => {
        child.unref();
        done();
      });
    });
    return { command, launched: true, message: "Opened Copilot CLI in a new console window, attached to this conversation." };
  } catch {
    return { command, launched: false, message: "Couldn't open a console window. Run this command from the repository root instead." };
  }
}
