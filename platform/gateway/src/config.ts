import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfig, type ManagedCopilotConfig } from "@managed-copilot/protocol";

export interface GatewayConfig {
  readonly port: number;
  readonly host: string;
  /** Base URL clients use to reach this gateway. */
  readonly publicUrl: string;
  readonly mode: "local" | "azure";
  /** Ledger, artifacts, runtime homes, and sealed vault data. */
  readonly dataDir: string;
  readonly deployment: ManagedCopilotConfig;
  /** Shared secret for internal platform services (edge proxy, sandbox agents). Never given to workloads. */
  readonly platformKey: string;
  /** Write `~/.managed-copilot/local.json` so `ManagedCopilot.connect()` finds this gateway. */
  readonly writeDiscovery: boolean;
  readonly version: string;
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

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): GatewayConfig {
  const mode = env.MANAGED_COPILOT_MODE === "azure" ? "azure" : "local";
  const port = Number(env.PORT ?? env.MANAGED_COPILOT_PORT ?? 7400);
  const host = env.HOST ?? (mode === "local" ? "127.0.0.1" : "0.0.0.0");
  return {
    port,
    host,
    publicUrl: (env.MANAGED_COPILOT_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    mode,
    dataDir: resolve(env.MANAGED_COPILOT_DATA_DIR ?? resolve(process.cwd(), ".managed-copilot", "data")),
    deployment: readDeployment(env),
    platformKey: env.MANAGED_COPILOT_PLATFORM_KEY ?? randomBytes(32).toString("base64url"),
    writeDiscovery: (env.MANAGED_COPILOT_WRITE_DISCOVERY ?? (mode === "local" ? "1" : "0")) === "1",
    version: env.MANAGED_COPILOT_VERSION ?? "0.1.0",
    env,
  };
}
