import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfig, type ManagedCopilotConfig } from "@managed-copilot/protocol";

export interface GatewayConfig {
  readonly port: number;
  readonly host: string;
  /** Base URL clients use to reach this gateway (the actual listening address unless set explicitly). */
  readonly publicUrl: string;
  /** True when `MANAGED_COPILOT_PUBLIC_URL` was set; otherwise the URL follows the listening port. */
  readonly publicUrlExplicit: boolean;
  readonly mode: "local" | "azure";
  /** Ledger, artifacts, runtime homes, and sealed vault data. */
  readonly dataDir: string;
  readonly deployment: ManagedCopilotConfig;
  /** Directory the AppHost configuration's relative paths (e.g. `customizations`) resolve against. */
  readonly appHostDir: string;
  /** Shared secret for internal platform services (edge proxy, sandbox agents). Never given to workloads. */
  readonly platformKey: string;
  /** Write `~/.managed-copilot/local.json` so `ManagedCopilot.connect()` finds this gateway. */
  readonly writeDiscovery: boolean;
  readonly version: string;
  /** GitHub REST API used to verify callers (a loopback stub in tests). */
  readonly githubApiUrl: string;
  /** The stock runtime that hosts shared sessions. */
  readonly sharedRuntime: {
    readonly enabled: boolean;
    /** Override for the runtime binary (defaults to the SDK's headless runtime package). */
    readonly path?: string;
    /** Connect to an already-running runtime (`tcp://host:port`) instead of spawning one. */
    readonly url?: string;
    readonly token?: string;
    readonly logLevel: string;
  };
  /** Process environment, used to resolve `{ secretEnv }` references. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Used when no AppHost configuration is supplied (direct `pnpm dev` runs). */
export const DEV_DEFAULT_CONFIG = {
  name: "copilot",
  environments: {
    chat: { type: "shared", description: "Chat agent with your own tools" },
    coder: { type: "isolated", size: "small", description: "Coding agent in its own sandbox" },
    helper: { type: "promotable", promoteTo: "coder", description: "Starts shared, moves into a sandbox when it needs one" },
  },
  inline: { types: ["shared", "isolated"], sizes: ["small"] },
} as const;

function readDeployment(env: Readonly<Record<string, string | undefined>>): ManagedCopilotConfig {
  if (env.MANAGED_COPILOT_CONFIG) return parseConfig(JSON.parse(env.MANAGED_COPILOT_CONFIG));
  if (env.MANAGED_COPILOT_CONFIG_FILE) return parseConfig(JSON.parse(readFileSync(env.MANAGED_COPILOT_CONFIG_FILE, "utf8")));
  return parseConfig(DEV_DEFAULT_CONFIG);
}

/** Only loopback GitHub API overrides may use plain HTTP (test stubs). */
function githubApiUrl(value: string | undefined): string {
  const url = new URL(value ?? "https://api.github.com");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("MANAGED_COPILOT_GITHUB_API_URL must use https (http is allowed only for loopback test stubs)");
  }
  return url.toString().replace(/\/+$/, "");
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): GatewayConfig {
  const mode = env.MANAGED_COPILOT_MODE === "azure" ? "azure" : "local";
  const port = Number(env.PORT ?? env.MANAGED_COPILOT_PORT ?? 7400);
  const host = env.HOST ?? (mode === "local" ? "127.0.0.1" : "0.0.0.0");
  const configFile = env.MANAGED_COPILOT_CONFIG_FILE;
  return {
    port,
    host,
    publicUrl: (env.MANAGED_COPILOT_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    publicUrlExplicit: env.MANAGED_COPILOT_PUBLIC_URL !== undefined,
    mode,
    dataDir: resolve(env.MANAGED_COPILOT_DATA_DIR ?? resolve(process.cwd(), ".managed-copilot", "data")),
    deployment: readDeployment(env),
    appHostDir: resolve(env.MANAGED_COPILOT_APPHOST_DIR ?? (configFile ? resolve(configFile, "..") : process.cwd())),
    platformKey: env.MANAGED_COPILOT_PLATFORM_KEY || randomBytes(32).toString("base64url"),
    writeDiscovery: (env.MANAGED_COPILOT_WRITE_DISCOVERY ?? (mode === "local" ? "1" : "0")) === "1",
    version: env.MANAGED_COPILOT_VERSION ?? "0.1.0",
    githubApiUrl: githubApiUrl(env.MANAGED_COPILOT_GITHUB_API_URL),
    sharedRuntime: {
      enabled: env.MANAGED_COPILOT_SHARED_RUNTIME !== "0",
      ...(env.MANAGED_COPILOT_RUNTIME_PATH ? { path: env.MANAGED_COPILOT_RUNTIME_PATH } : {}),
      ...(env.MANAGED_COPILOT_RUNTIME_URL ? { url: env.MANAGED_COPILOT_RUNTIME_URL } : {}),
      ...(env.MANAGED_COPILOT_RUNTIME_TOKEN ? { token: env.MANAGED_COPILOT_RUNTIME_TOKEN } : {}),
      logLevel: env.MANAGED_COPILOT_RUNTIME_LOG_LEVEL ?? "info",
    },
    env,
  };
}
