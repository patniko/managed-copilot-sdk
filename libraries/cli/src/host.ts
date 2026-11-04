import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveToken, spawnArguments, findExecutable } from "@managed-copilot/sdk/internal";

/** The local tools `access` and `deploy` drive: the Aspire CLI, the Azure CLI, Docker, and the caller's GitHub sign-in. */
export interface HostTools {
  /** Whether a command is installed (on PATH). */
  has(command: string): boolean;
  /** Runs a command and captures its output. Arguments must never carry secrets; pass them in `env`. */
  capture(command: string, args: readonly string[], options?: { readonly env?: Readonly<Record<string, string>> }): Promise<CommandResult>;
  /** Runs a command with this terminal's input and output, and resolves with its exit code. */
  stream(command: string, args: readonly string[], options?: { readonly env?: Readonly<Record<string, string>> }): Promise<number>;
  /** The caller's GitHub token, found like `ManagedCopilot.connect()` finds it (never from argv). */
  githubToken(): Promise<string>;
  /** The login a GitHub token belongs to. */
  githubLogin(token: string): Promise<string>;
  /** This machine's public IPv4 address as the Internet sees it (the address `aspire deploy` allows by default). */
  publicAddress(): Promise<string | undefined>;
  /** Where the Aspire CLI keeps deployment records (`~/.aspire/deployments`). */
  deploymentsDirectory(): string;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function launch(command: string, args: readonly string[], env: Readonly<Record<string, string>> | undefined, stdio: "pipe" | "inherit") {
  const found = findExecutable(command);
  if (!found) throw Object.assign(new Error(`${command} is not installed.`), { code: "ENOENT" });
  const spec = spawnArguments(found, args);
  return spawn(spec.file, spec.args, {
    stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    windowsHide: stdio === "pipe",
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
}

export const systemHost: HostTools = {
  has: (command) => findExecutable(command) !== undefined,
  capture: (command, args, options) =>
    new Promise((resolve, reject) => {
      const child = launch(command, args, options?.env, "pipe");
      let stdout = "";
      let stderr = "";
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    }),
  stream: (command, args, options) =>
    new Promise((resolve, reject) => {
      const child = launch(command, args, options?.env, "inherit");
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    }),
  githubToken: () => resolveToken(),
  githubLogin: async (token) => {
    const response = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "managed-copilot-cli" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub did not accept your sign-in (HTTP ${response.status}).`);
    const { login } = (await response.json()) as { login?: unknown };
    if (typeof login !== "string" || !login) throw new Error("GitHub did not return your login.");
    return login;
  },
  deploymentsDirectory: () => join(homedir(), ".aspire", "deployments"),
  publicAddress: async () => {
    try {
      const response = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(10_000) });
      const { ip } = (await response.json()) as { ip?: unknown };
      return typeof ip === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : undefined;
    } catch {
      return undefined;
    }
  },
};
