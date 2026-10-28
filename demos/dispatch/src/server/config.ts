import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalMode, ExecutionStyle } from "../shared/types.js";
import { parseAttachUrl } from "./attach.js";

export const STYLES: readonly ExecutionStyle[] = ["delegate", "direct", "mixed"];

export function isStyle(value: unknown): value is ExecutionStyle {
  return typeof value === "string" && (STYLES as readonly string[]).includes(value);
}

export interface DispatchConfig {
  readonly port: number;
  readonly host: string;
  /** Dispatch's own records (conversation list and settings). Sessions and sandboxes live in the platform. */
  readonly dataDir: string;
  /** Serve the UI through Vite's dev middleware (when running from TypeScript sources). */
  readonly dev: boolean;
  readonly packageRoot: string;
  /** Built UI (`dist/web`). */
  readonly webRoot: string;
  /** Monorepo root, the working directory for `npx managed-copilot attach`. */
  readonly repoRoot: string;
  /** Gateway URL for attach commands when users reach the platform at another address (`DISPATCH_ATTACH_URL`). */
  readonly attachUrl?: string;
  /** The orchestrator environment conversations run in by default (the delegate style's). */
  readonly environment: string;
  /** The orchestrator environment for each execution style. */
  readonly environments: Readonly<Record<ExecutionStyle, string>>;
  /** New conversations' style, when the person doesn't pick one. */
  readonly style: ExecutionStyle;
  /** The coordinator's model. */
  readonly model: string;
  /** New conversations: ask before each new sandbox, or create them as the coordinator decides. */
  readonly approvals: ApprovalMode;
  /** How often the platform connection is checked. */
  readonly healthIntervalMs: number;
  /** How often working sandboxes' workspaces are listed (live files). */
  readonly filesIntervalMs: number;
}

function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "apphost.mts")) && existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Cannot locate the Dispatch package directory");
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): DispatchConfig {
  const here = fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(dirname(here));
  const attachUrl = parseAttachUrl(env.DISPATCH_ATTACH_URL);
  const environment = env.DISPATCH_ENVIRONMENT?.trim() || "dispatch";
  const style = env.DISPATCH_STYLE?.trim();
  return {
    port: Number(env.PORT ?? env.DISPATCH_PORT ?? 7470),
    host: env.HOST ?? "127.0.0.1",
    dataDir: resolve(env.DISPATCH_DATA_DIR ?? join(packageRoot, ".data")),
    dev: here.endsWith(".ts") && env.DISPATCH_DEV !== "0",
    packageRoot,
    webRoot: join(packageRoot, "dist", "web"),
    repoRoot: resolve(packageRoot, "..", ".."),
    ...(attachUrl ? { attachUrl } : {}),
    environment,
    environments: {
      delegate: environment,
      direct: env.DISPATCH_DIRECT_ENVIRONMENT?.trim() || `${environment}-direct`,
      mixed: env.DISPATCH_MIXED_ENVIRONMENT?.trim() || `${environment}-mixed`,
    },
    style: isStyle(style) ? style : "delegate",
    model: env.DISPATCH_MODEL?.trim() || "claude-sonnet-5",
    approvals: env.DISPATCH_APPROVALS === "auto" ? "auto" : "ask",
    healthIntervalMs: 15_000,
    filesIntervalMs: 4_000,
  };
}
